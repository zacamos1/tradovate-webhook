#!/usr/bin/env python3
"""
Retry Pull — recover trade windows lost to phantom strikes / holiday expiries
==============================================================================

The main pull failed on two systematic issues:
  1. Strike-increment guesses wrong for some tickers/price levels — a
     batch containing any unresolvable symbol failed entirely.
  2. Holiday weeks: "next Friday" expiry doesn't exist when Friday is a
     market holiday (e.g. Jul 3 2026); that week's weeklies expired Thursday.

This script finds every trade in the list with no parquet on disk and
probes candidate contracts ONE SYMBOL AT A TIME (no batch poisoning):
  expiry candidates : Friday, then the Thursday before it
  strike candidates : first-OTM under each increment in {guess, 5, 2.5, 10},
                       then one strike further OTM
First candidate returning data gets saved as that trade's file. Costs are
trivial (single tiny windows) but the standing gate still applies.

Usage:
    python3 retry_pull.py --trades would_trade_hold3.csv --quotes-dir ./outcome_quotes
"""
import argparse
import math
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
import concurrent.futures

import pandas as pd

DATASET = "OPRA.PILLAR"
SCHEMA = "cbbo-1m"
WINDOW_MIN = 30
ETF_SAME_DAY = {"SPY", "QQQ", "IWM"}
GUESS_INC = {"SPY": 1.0, "QQQ": 1.0, "IWM": 1.0,
              "AAPL": 2.5, "AMZN": 2.5, "NVDA": 2.5, "GOOGL": 2.5, "AVGO": 2.5, "TSLA": 2.5,
              "MSFT": 5.0, "META": 5.0}


def occ(sym, expiry, side, strike):
    return f"{sym:<6s}{expiry.strftime('%y%m%d')}{side}{int(round(strike * 1000)):08d}"


def expiry_candidates(sym, d):
    if sym in ETF_SAME_DAY:
        return [d]
    fri = d + timedelta(days=(4 - d.weekday()) % 7)
    return [fri, fri - timedelta(days=1)]  # holiday weeks -> Thursday


def strike_candidates(sym, side, u):
    incs = []
    g = GUESS_INC.get(sym, 2.5)
    for inc in [g, 5.0, 2.5, 10.0]:
        if inc not in incs:
            incs.append(inc)
    out = []
    for inc in incs:
        first = math.ceil(u / inc) * inc if side == "C" else math.floor(u / inc) * inc
        for k in (first, first + inc if side == "C" else first - inc):
            k = round(k, 2)
            if k not in out:
                out.append(k)
    return out


def probe(args_tuple):
    t, out_dir, api_key = args_tuple
    import databento as db
    ts = datetime.fromisoformat(t["signal_ts_et"])
    tid = f"{t['date']}_{t['symbol']}_{t['side']}_{ts.strftime('%H%M')}"
    of = Path(out_dir) / f"{tid}.parquet"
    if of.exists():
        return tid, "have"
    client = db.Historical(api_key)
    s = ts.isoformat()
    e = (ts + timedelta(minutes=WINDOW_MIN)).isoformat()
    d = ts.date()
    for expiry in expiry_candidates(t["symbol"], d):
        for strike in strike_candidates(t["symbol"], t["side"], float(t["underlying_close"])):
            sym = occ(t["symbol"], expiry, t["side"], strike)
            try:
                df = client.timeseries.get_range(
                    dataset=DATASET, schema=SCHEMA, symbols=[sym],
                    start=s, end=e, stype_in="raw_symbol").to_df()
            except Exception:
                continue
            if df is not None and not df.empty:
                df.to_parquet(of, index=False)
                return tid, f"ok:{expiry.strftime('%y%m%d')}@{strike}"
    return tid, "unresolved"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--trades", required=True)
    ap.add_argument("--quotes-dir", default="./outcome_quotes")
    ap.add_argument("--api-key", default=os.environ.get("DATABENTO_API_KEY"))
    ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()

    if not a.api_key:
        print("No API key.", file=sys.stderr)
        sys.exit(1)

    trades = pd.read_csv(a.trades)
    missing = []
    for _, t in trades.iterrows():
        ts = datetime.fromisoformat(t["signal_ts_et"])
        tid = f"{t['date']}_{t['symbol']}_{t['side']}_{ts.strftime('%H%M')}"
        if not (Path(a.quotes_dir) / f"{tid}.parquet").exists():
            missing.append(t)
    print(f"{len(missing)} missing trade windows to retry (of {len(trades)})")
    if not missing:
        return

    counts = {"ok": 0, "unresolved": 0, "have": 0}
    fixes = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as ex:
        for tid, status in ex.map(probe, [(t, a.quotes_dir, a.api_key) for t in missing]):
            if status.startswith("ok"):
                counts["ok"] += 1
                sym = tid.split("_")[1]
                fixes[sym] = fixes.get(sym, 0) + 1
            else:
                counts[status] = counts.get(status, 0) + 1

    print(f"\nRecovered: {counts['ok']}  Still unresolved: {counts.get('unresolved', 0)}")
    if fixes:
        print("Recovered per ticker:", dict(sorted(fixes.items(), key=lambda kv: -kv[1])))
    print("\nRe-run the simulator to fold these in:")
    print("  python3 outcome_simulator.py --trades would_trade_hold3.csv --quotes-dir ./outcome_quotes --commission 1.30")


if __name__ == "__main__":
    main()
