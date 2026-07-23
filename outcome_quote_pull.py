#!/usr/bin/env python3
"""
Outcome Quote Pull — scoped option quotes for the backtest trade list
=======================================================================

For each trade in the would-have-traded list, pulls real bid/ask quotes
(cbbo-1m) for the contract the server would have bought, over a ~30-min
window from entry — everything the outcome simulator needs to replay the
trail/arm/timestop rules against real prices.

SCOPING (the lesson from the $43 RUT overpay, baked in):
  - explicit OCC raw symbols only — never stype_in="parent"
  - per trade: the first-OTM strike the server picks, plus one strike
    either side (covers feed-vs-live strike selection wobble) = 3
    contracts, traded side only
  - window: entry bar close -> +30 min (covers armed trades that ran
    past the 15-min timestop; longest live hold observed 16.7 min)
  - expiry per ticker class, matching live behavior: SPY/QQQ/IWM use
    same-day 0DTE; single names use the nearest Friday weekly
  - --estimate-cost SAMPLES real get_cost on a subset of windows and
    extrapolates (764+ individual metadata calls would be slow); the
    estimate prints before anything downloads
  - --confirm-cost required for the actual pull, as always

Usage:
    # 1. free estimate:
    python3 outcome_quote_pull.py --trades would_trade_hold3.csv --estimate-cost
    # 2. pull once the number is acceptable:
    python3 outcome_quote_pull.py --trades would_trade_hold3.csv --confirm-cost
"""
import argparse
import os
import random
import sys
from datetime import datetime, timedelta
from pathlib import Path
import concurrent.futures

import pandas as pd

DATASET = "OPRA.PILLAR"
SCHEMA = "cbbo-1m"
WINDOW_MIN = 30

ETF_SAME_DAY = {"SPY", "QQQ", "IWM"}
STRIKE_INC = {
    "SPY": 1.0, "QQQ": 1.0, "IWM": 1.0,
    "AAPL": 2.5, "AMZN": 2.5, "NVDA": 2.5, "GOOGL": 2.5, "AVGO": 2.5, "TSLA": 2.5,
    "MSFT": 5.0, "META": 5.0,
}


def pick_expiry(sym: str, trade_date):
    if sym in ETF_SAME_DAY:
        return trade_date
    # single names: nearest Friday >= trade date
    return trade_date + timedelta(days=(4 - trade_date.weekday()) % 7)


def pick_strikes(sym: str, side: str, underlying: float):
    inc = STRIKE_INC.get(sym, 2.5)
    import math
    if side == "C":
        first_otm = math.ceil(underlying / inc) * inc
    else:
        first_otm = math.floor(underlying / inc) * inc
    return [round(first_otm - inc, 2), round(first_otm, 2), round(first_otm + inc, 2)]


def occ_symbol(sym: str, expiry, side: str, strike: float):
    root = f"{sym:<6s}"
    return f"{root}{expiry.strftime('%y%m%d')}{side}{int(round(strike * 1000)):08d}"


def build_jobs(trades: pd.DataFrame):
    jobs = []
    for _, t in trades.iterrows():
        ts = datetime.fromisoformat(t["signal_ts_et"])
        d = ts.date()
        expiry = pick_expiry(t["symbol"], d)
        strikes = pick_strikes(t["symbol"], t["side"], float(t["underlying_close"]))
        symbols = [occ_symbol(t["symbol"], expiry, t["side"], k) for k in strikes]
        jobs.append({
            "trade_id": f"{d}_{t['symbol']}_{t['side']}_{ts.strftime('%H%M')}",
            "symbols": symbols,
            "start": ts,
            "end": ts + timedelta(minutes=WINDOW_MIN),
        })
    return jobs


def estimate(jobs, api_key, sample_n=25):
    import databento as db
    client = db.Historical(api_key)
    sample = random.sample(jobs, min(sample_n, len(jobs)))
    total = 0.0
    ok = 0
    print(f"Sampling {len(sample)} of {len(jobs)} trade windows for cost...")
    for j in sample:
        try:
            c = client.metadata.get_cost(
                dataset=DATASET, schema=SCHEMA, symbols=j["symbols"],
                start=j["start"].isoformat(), end=j["end"].isoformat(),
                stype_in="raw_symbol",
            )
            total += c
            ok += 1
        except Exception as ex:
            print(f"  sample {j['trade_id']} failed: {ex}", file=sys.stderr)
    if ok == 0:
        print("All samples failed — cannot estimate.", file=sys.stderr)
        sys.exit(1)
    per_window = total / ok
    est_total = per_window * len(jobs)
    print("\n" + "=" * 60)
    print("SAMPLED COST ESTIMATE (nothing downloaded)")
    print("=" * 60)
    print(f"  Trade windows:       {len(jobs)}")
    print(f"  Contracts/window:    3 (first-OTM ±1, traded side only)")
    print(f"  Window length:       {WINDOW_MIN} min, {SCHEMA}")
    print(f"  Sampled windows:     {ok}")
    print(f"  Mean cost/window:    ${per_window:.4f}")
    print(f"  EXTRAPOLATED TOTAL:  ${est_total:,.2f}")
    print("=" * 60)
    print("Sampling error is real — treat this as ±30%. Re-run --estimate-cost")
    print("for a fresh sample if the number is near a decision boundary.")


def pull_one(args_tuple):
    j, out_dir, api_key = args_tuple
    import databento as db
    of = Path(out_dir) / f"{j['trade_id']}.parquet"
    if of.exists():
        return j["trade_id"], "skip", 0
    try:
        client = db.Historical(api_key)
        data = client.timeseries.get_range(
            dataset=DATASET, schema=SCHEMA, symbols=j["symbols"],
            start=j["start"].isoformat(), end=j["end"].isoformat(),
            stype_in="raw_symbol",
        )
        df = data.to_df()
        if df.empty:
            return j["trade_id"], "empty", 0
        df.to_parquet(of, index=False)
        return j["trade_id"], "ok", len(df)
    except Exception as ex:
        return j["trade_id"], f"fail: {ex}", 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--trades", required=True, help="would_trade_*.csv from trade_list_builder.py")
    ap.add_argument("--out", default="./outcome_quotes")
    ap.add_argument("--api-key", default=os.environ.get("DATABENTO_API_KEY"))
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--estimate-cost", action="store_true")
    ap.add_argument("--confirm-cost", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="print sample jobs, no API calls at all")
    a = ap.parse_args()

    trades = pd.read_csv(a.trades)
    jobs = build_jobs(trades)
    print(f"{len(jobs)} trade windows built from {a.trades}")

    if a.dry_run:
        for j in jobs[:5]:
            print(f"  {j['trade_id']}: {j['symbols']}  {j['start'].strftime('%H:%M')}-{j['end'].strftime('%H:%M')}")
        print(f"  ... ({len(jobs)} total)")
        return

    if not a.api_key:
        print("No API key. Set DATABENTO_API_KEY or pass --api-key.", file=sys.stderr)
        sys.exit(1)

    if a.estimate_cost:
        estimate(jobs, a.api_key)
        return

    if not a.confirm_cost:
        print("Refusing to pull without --confirm-cost. Run --estimate-cost first.", file=sys.stderr)
        sys.exit(1)

    Path(a.out).mkdir(parents=True, exist_ok=True)
    pulled = skipped = failed = empty = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as ex:
        futures = [ex.submit(pull_one, (j, a.out, a.api_key)) for j in jobs]
        for f in concurrent.futures.as_completed(futures):
            tid, status, rows = f.result()
            if status == "ok":
                pulled += 1
            elif status == "skip":
                skipped += 1
            elif status == "empty":
                empty += 1
            else:
                failed += 1
                print(f"  [{tid}] {status}")
    print(f"\ndone pulled={pulled} skipped={skipped} empty={empty} failed={failed}")
    print(f"Files in {a.out}/ — one parquet per trade, named {{date}}_{{sym}}_{{side}}_{{HHMM}}.parquet")


if __name__ == "__main__":
    main()
