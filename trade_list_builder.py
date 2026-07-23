#!/usr/bin/env python3
"""
Trade List Builder — collapse generated signals into "would-have-traded"
==========================================================================

Takes the signal backtester's output (all signals the Pine logic fires)
and applies the SERVER's entry rules to produce the honest list of trades
the webhook would actually have entered:

  1. ONE POSITION PER TICKER — a signal is skipped if that ticker already
     has an open position (either side), exactly like server.js
     ("SKIP: already holding ...").
  2. SAME-BAR C/P CONFLICT — live, both sides can fire on the same ticker
     within seconds and the winner is webhook arrival order (a race). In
     backtest that's unknowable, so the deterministic rule here is:
     higher score wins, tie -> call. Conflicted bars are flagged so you
     know how many trades hinge on the race.
  3. TICKER OCCUPANCY — how long a position blocks its ticker depends on
     the exit (trail exits ~1-5 min, timestops 15 min), which we can't
     know without the outcome simulator. So this brackets it: the trade
     list is built under BOTH a fast-exit assumption (3 min) and a
     slow-exit assumption (15 min). Reality is between; the outcome
     simulator replaces this with computed exits later.

Outputs:
  would_trade_hold3.csv, would_trade_hold15.csv — the two bracketed lists
  Summary comparing both, plus the Databento sizing numbers (distinct
  trades needing an option-quote window).

Usage:
    python3 trade_list_builder.py --signals generated_signals.csv
"""
import argparse
import sys
from datetime import datetime, timedelta

import pandas as pd


def build_trade_list(sig: pd.DataFrame, hold_mins: float):
    sig = sig.sort_values("signal_ts_et").reset_index(drop=True)
    busy_until = {}          # ticker -> datetime it frees up
    trades, skipped_busy = [], 0
    conflicts = 0

    # Group by bar so same-bar conflicts resolve before occupancy updates
    for ts_str, bar_group in sig.groupby("signal_ts_et", sort=True):
        ts = datetime.fromisoformat(ts_str)
        # Resolve same-bar same-ticker C/P conflicts: higher score wins, tie -> C
        chosen = []
        for sym, g in bar_group.groupby("symbol"):
            if len(g) > 1:
                conflicts += 1
                g = g.sort_values(["score", "side"], ascending=[False, True])
                row = g.iloc[0].copy()
                row["conflict_bar"] = True
            else:
                row = g.iloc[0].copy()
                row["conflict_bar"] = False
            chosen.append(row)

        for row in chosen:
            sym = row["symbol"]
            if sym in busy_until and ts < busy_until[sym]:
                skipped_busy += 1
                continue
            busy_until[sym] = ts + timedelta(minutes=hold_mins)
            trades.append(row)

    out = pd.DataFrame(trades)
    return out, skipped_busy, conflicts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--signals", required=True, help="CSV from signal_backtest.py (run WITH daily caps on)")
    a = ap.parse_args()

    sig = pd.read_csv(a.signals)
    required = {"signal_ts_et", "symbol", "side", "score"}
    if not required.issubset(sig.columns):
        print(f"Missing columns; need {required}", file=sys.stderr)
        sys.exit(1)

    print(f"Input: {len(sig)} generated signals, "
          f"{sig['date'].nunique()} trading days, {sig['symbol'].nunique()} tickers\n")

    summaries = {}
    for hold in (3, 16):
        trades, skipped, conflicts = build_trade_list(sig, hold)
        fname = f"would_trade_hold{hold}.csv"
        trades.to_csv(fname, index=False)
        summaries[hold] = (trades, skipped, conflicts)
        print(f"HOLD ASSUMPTION {hold} min  ->  {fname}")
        print(f"  Trades entered:        {len(trades)}")
        print(f"  Skipped (ticker busy): {skipped}")
        print(f"  Same-bar C/P conflicts resolved: {conflicts}")
        print(f"  Per day (mean):        {len(trades)/max(1, sig['date'].nunique()):.1f}")
        print()

    t3, t15 = summaries[3][0], summaries[16][0]
    print("=" * 66)
    print("BRACKETED TRADE COUNT (true value lies between)")
    print("=" * 66)
    print(f"  Fast exits (3 min):  {len(t3)} trades")
    print(f"  Slow exits (16 min): {len(t15)} trades")
    both = set(zip(t3["signal_ts_et"], t3["symbol"])) & set(zip(t15["signal_ts_et"], t15["symbol"]))
    print(f"  In BOTH lists (occupancy-insensitive core): {len(both)}")
    print("=" * 66)

    # Databento sizing: each trade needs one option contract's quotes for a
    # ~25-min window (entry through trail/timestop). Use the slow list (superset-ish).
    days = t15["date"].nunique()
    print("\nDATABENTO SIZING (for the outcome simulator)")
    print(f"  Option-quote windows needed: {len(t15)} (one contract each, ~25 min each)")
    print(f"  Across {days} trading days, {t15['symbol'].nunique()} tickers")
    print("  Next step: estimate that pull's cost (scoped raw symbols, cbbo-1m)")
    print("  before purchasing — same gate as always.")


if __name__ == "__main__":
    main()
