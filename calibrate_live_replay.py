#!/usr/bin/env python3
"""
Calibration Replay — measure the simulator against the 114 real trades
========================================================================

The outcome simulator's absolute numbers carry known pessimism (ask-in/
bid-out fills, 1-minute trail resolution). This measures that bias
directly: for every LIVE trade in mfe.jsonl (exact contract known —
symbol/right/strike/expiry, actual entry fill, actual exit), it pulls
quotes for that exact contract, replays the sim's rules, and compares:

  - ARM agreement:  did sim arm when live armed?
  - EXIT agreement: same exit reason (trail vs timestop)?
  - ENTRY-FILL gap: live fill price vs sim's first-minute ask
  - P&L gap:        sim P&L (from live entry price) vs live P&L

The resulting gap numbers convert every future sim result into honest
expectations.

Cost gate: estimates first via sampling; auto-proceeds if the
extrapolated total is under $30 (standing rule), otherwise stops and
prints the number.

Usage (trading VPS, ~/ibkr-webhook):
    python3 calibrate_live_replay.py --mfe mfe.jsonl
    # add --pull-only or --replay-only to run stages separately
"""
import argparse
import json
import os
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
import concurrent.futures

import numpy as np
import pandas as pd

DATASET = "OPRA.PILLAR"
SCHEMA = "cbbo-1m"
WINDOW_MIN = 30
ARM_PCT = 0.10
TRAIL_PCT = 0.15
TIMESTOP_MIN = 15.0
AUTO_THRESHOLD = 30.0  # standing rule: auto-proceed under $30

QUOTES_DIR = "./calibration_quotes"


def load_live_trades(path):
    trades = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if str(r.get("reason", "")).endswith("_fill"):
                continue
            if not all(r.get(k) is not None for k in ("symbol", "right", "strike", "expiry", "entryPrice", "ts")):
                continue
            exit_ts = datetime.fromisoformat(r["ts"].replace("Z", "+00:00"))
            entry_ts = exit_ts - timedelta(minutes=(r.get("minsHeld") or 0))
            e, x = r.get("entryPrice"), r.get("exitPriceApprox")
            trades.append({
                "symbol": r["symbol"], "right": r["right"],
                "strike": float(r["strike"]), "expiry": str(r["expiry"]),
                "entry_ts": entry_ts.replace(second=0, microsecond=0),
                "live_entry": float(e),
                "live_exit": float(x) if x is not None else None,
                "live_reason": r.get("reason"),
                "live_armed": bool(r.get("armed")),
                "live_pnl": round((x - e) * 100, 2) if (e is not None and x is not None) else None,
            })
    return trades


def occ(t):
    exp = datetime.strptime(t["expiry"], "%Y%m%d").strftime("%y%m%d")
    return f"{t['symbol']:<6s}{exp}{t['right']}{int(round(t['strike'] * 1000)):08d}"


def trade_id(t):
    return f"{t['entry_ts'].strftime('%Y-%m-%d_%H%M')}_{t['symbol']}_{t['right']}_{int(t['strike']*1000)}"


def estimate(trades, api_key):
    import databento as db
    client = db.Historical(api_key)
    sample = random.sample(trades, min(20, len(trades)))
    total, ok = 0.0, 0
    for t in sample:
        try:
            total += client.metadata.get_cost(
                dataset=DATASET, schema=SCHEMA, symbols=[occ(t)],
                start=t["entry_ts"].isoformat(),
                end=(t["entry_ts"] + timedelta(minutes=WINDOW_MIN)).isoformat(),
                stype_in="raw_symbol")
            ok += 1
        except Exception as ex:
            print(f"  sample failed: {ex}", file=sys.stderr)
    if not ok:
        print("Cost estimate failed entirely.", file=sys.stderr)
        sys.exit(1)
    est = total / ok * len(trades)
    print(f"Estimated pull cost for {len(trades)} exact-contract windows: ${est:,.2f}")
    return est


def pull(trades, api_key, workers=4):
    import databento as db
    Path(QUOTES_DIR).mkdir(exist_ok=True)

    def one(t):
        of = Path(QUOTES_DIR) / f"{trade_id(t)}.parquet"
        if of.exists():
            return "skip"
        try:
            client = db.Historical(api_key)
            df = client.timeseries.get_range(
                dataset=DATASET, schema=SCHEMA, symbols=[occ(t)],
                start=t["entry_ts"].isoformat(),
                end=(t["entry_ts"] + timedelta(minutes=WINDOW_MIN)).isoformat(),
                stype_in="raw_symbol").to_df()
            if df.empty:
                return "empty"
            df.to_parquet(of, index=False)
            return "ok"
        except Exception as ex:
            return f"fail: {ex}"

    counts = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        for res in ex.map(one, trades):
            key = res.split(":")[0]
            counts[key] = counts.get(key, 0) + 1
            if res.startswith("fail"):
                print(f"  {res}", file=sys.stderr)
    print(f"Pull done: {counts}")


def replay(trades):
    rows = []
    for t in trades:
        f = Path(QUOTES_DIR) / f"{trade_id(t)}.parquet"
        if not f.exists():
            continue
        df = pd.read_parquet(f)
        bcol = "bid_px_00" if "bid_px_00" in df.columns else None
        acol = "ask_px_00" if "ask_px_00" in df.columns else None
        if df.empty or bcol is None:
            continue
        ts_col = "ts_event" if "ts_event" in df.columns else df.columns[0]
        df[ts_col] = pd.to_datetime(df[ts_col], utc=True)
        df = df.sort_values(ts_col).reset_index(drop=True)

        sim_entry_ask = float(df.iloc[0][acol]) if df.iloc[0][acol] > 0 else None
        entry_price = t["live_entry"]  # use REAL fill to isolate exit-rule fidelity

        bids = df[bcol].fillna(0.0).astype(float).values
        times = df[ts_col].values
        arm_level = entry_price * (1 + ARM_PCT)
        armed, peak = False, bids[0] if len(bids) else 0.0
        exit_price, exit_reason = None, None
        for i in range(len(bids)):
            mins = (times[i] - times[0]) / np.timedelta64(60, "s")
            b = bids[i]
            peak = max(peak, b)
            if not armed and b >= arm_level:
                armed = True
            if armed and b <= peak * (1 - TRAIL_PCT):
                exit_price, exit_reason = b, "trail"
                break
            if not armed and mins >= TIMESTOP_MIN:
                exit_price, exit_reason = b, "timestop"
                break
        if exit_price is None:
            exit_price, exit_reason = (bids[-1] if len(bids) else 0.0), "window_end"

        sim_pnl = round((float(exit_price) - entry_price) * 100, 2)
        rows.append({
            "trade_id": trade_id(t), "symbol": t["symbol"],
            "live_reason": t["live_reason"], "sim_reason": exit_reason,
            "live_armed": t["live_armed"], "sim_armed": armed,
            "live_pnl": t["live_pnl"], "sim_pnl": sim_pnl,
            "pnl_gap": round(sim_pnl - t["live_pnl"], 2) if t["live_pnl"] is not None else None,
            "live_entry": t["live_entry"], "sim_entry_ask": sim_entry_ask,
            "entry_fill_gap": round(sim_entry_ask - t["live_entry"], 2) if sim_entry_ask else None,
        })

    df = pd.DataFrame(rows)
    df.to_csv("calibration_results.csv", index=False)
    print(f"\nReplayed {len(df)} live trades -> calibration_results.csv")

    if df.empty:
        return
    print("\n" + "=" * 64)
    print("CALIBRATION — simulator vs the real 114 trades")
    print("=" * 64)
    arm_agree = (df["live_armed"] == df["sim_armed"]).mean()
    print(f"  ARM agreement:            {100*arm_agree:.0f}%")
    reason_agree = (df["live_reason"] == df["sim_reason"]).mean()
    print(f"  Exit-reason agreement:    {100*reason_agree:.0f}%  (live eod/window_end mismatches expected)")
    g = df["pnl_gap"].dropna()
    if len(g):
        print(f"  P&L gap (sim - live):     mean ${g.mean():+.1f}/trade  median ${g.median():+.1f}")
        print(f"  Total sim vs total live:  ${df['sim_pnl'].sum():+,.0f} vs ${df['live_pnl'].sum():+,.0f}")
    eg = df["entry_fill_gap"].dropna()
    if len(eg):
        print(f"  Entry-fill gap (ask-live): mean ${eg.mean():+.3f}  (positive = sim entry pessimistic)")
    print("-" * 64)
    print("  Disagreement rows (sim armed differently than live):")
    dis = df[df["live_armed"] != df["sim_armed"]]
    for _, r in dis.head(8).iterrows():
        print(f"    {r['trade_id']}: live {r['live_reason']}/armed={r['live_armed']} "
              f"sim {r['sim_reason']}/armed={r['sim_armed']} pnl {r['live_pnl']} vs {r['sim_pnl']}")
    if len(dis) > 8:
        print(f"    ... and {len(dis)-8} more (see CSV)")
    print("=" * 64)
    print("Read: mean P&L gap = the sim's systematic bias per trade. Apply it")
    print("mentally to every backtest number (e.g., sim -$13/trade with a -$10")
    print("bias reads as roughly -$3 real).")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mfe", default="mfe.jsonl")
    ap.add_argument("--api-key", default=os.environ.get("DATABENTO_API_KEY"))
    ap.add_argument("--pull-only", action="store_true")
    ap.add_argument("--replay-only", action="store_true")
    a = ap.parse_args()

    trades = load_live_trades(a.mfe)
    print(f"{len(trades)} live trades loaded from {a.mfe}")

    if not a.replay_only:
        if not a.api_key:
            print("No API key for the pull stage.", file=sys.stderr)
            sys.exit(1)
        est = estimate(trades, a.api_key)
        if est >= AUTO_THRESHOLD:
            print(f"Estimate ${est:,.2f} >= ${AUTO_THRESHOLD} — stopping for explicit approval.")
            sys.exit(0)
        print(f"Under ${AUTO_THRESHOLD} threshold — proceeding with pull automatically.")
        pull(trades, a.api_key)

    if not a.pull_only:
        replay(trades)


if __name__ == "__main__":
    main()
