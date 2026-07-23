#!/usr/bin/env python3
"""
Re-entry / chase analysis on mfe.jsonl history.

Hypothesis (from Jul 15-16 observation): first entries on a ticker/strike
win; re-entries at progressively higher premiums after the move has run
tend to timestop out for losses. This tests that against the full history
and simulates what two candidate guards would have done:

  GUARD A: no re-entry on the same ticker within N minutes of a timestop
           exit on that ticker (default 30 min)
  GUARD B: no re-entry on the same ticker+strike at an entry premium more
           than X times the day's first entry premium on that strike
           (default 1.5x)

Usage (on the trading VPS):
    python3 reentry_analysis.py --file ~/ibkr-webhook/mfe.jsonl
    python3 reentry_analysis.py --file ~/ibkr-webhook/mfe.jsonl --guard-a-mins 30 --guard-b-mult 1.5
"""
import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime
from statistics import mean, median


def load(path):
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def dollars(row):
    """Approx per-contract P&L in dollars from entry/exit prices (x100 multiplier)."""
    entry = row.get("entryPrice")
    exitp = row.get("exitPriceApprox")
    qty = row.get("qty", 1) or 1
    if entry is None or exitp is None:
        return None
    return round((exitp - entry) * 100 * qty, 2)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--file", required=True)
    p.add_argument("--guard-a-mins", type=float, default=30.0)
    p.add_argument("--guard-b-mult", type=float, default=1.5)
    args = p.parse_args()

    rows = load(args.file)
    if not rows:
        print("No rows loaded.", file=sys.stderr)
        sys.exit(1)

    for r in rows:
        r["_ts"] = datetime.fromisoformat(r["ts"].replace("Z", "+00:00"))
        r["_date"] = r["_ts"].strftime("%Y-%m-%d")
        r["_dollars"] = dollars(r)
        # entry time approx = exit ts minus minsHeld
        mins_held = r.get("minsHeld") or 0
        r["_entry_ts"] = r["_ts"].timestamp() - mins_held * 60

    rows.sort(key=lambda r: r["_entry_ts"])

    # ---------------------------------------------------------------
    # 1) First entry vs re-entry, per (date, symbol, right, strike)
    # ---------------------------------------------------------------
    seen = {}
    firsts, reentries = [], []
    for r in rows:
        key = (r["_date"], r["symbol"], r.get("right"), r.get("strike"))
        if key not in seen:
            seen[key] = r
            r["_entry_rank"] = 1
            firsts.append(r)
        else:
            r["_entry_rank"] = seen[key].get("_count", 1) + 1
            seen[key]["_count"] = r["_entry_rank"]
            r["_first_entry_price"] = seen[key].get("entryPrice")
            reentries.append(r)

    def summarize(label, group):
        ds = [r["_dollars"] for r in group if r["_dollars"] is not None]
        if not ds:
            print(f"{label}: no data")
            return
        wins = sum(1 for d in ds if d > 0)
        print(f"{label}: n={len(ds)}  total=${sum(ds):+,.0f}  mean=${mean(ds):+.0f}  median=${median(ds):+.0f}  win%={100*wins/len(ds):.0f}%")

    print("=" * 74)
    print("FIRST ENTRY vs RE-ENTRY (same date+ticker+right+strike)")
    print("=" * 74)
    summarize("First entries ", firsts)
    summarize("Re-entries    ", reentries)

    # Re-entries split by whether entry premium exceeded first entry
    re_higher = [r for r in reentries if r.get("_first_entry_price") and r["entryPrice"] > r["_first_entry_price"]]
    re_lower = [r for r in reentries if r.get("_first_entry_price") and r["entryPrice"] <= r["_first_entry_price"]]
    print()
    summarize("Re-entries at HIGHER premium than first", re_higher)
    summarize("Re-entries at SAME/LOWER premium       ", re_lower)

    # ---------------------------------------------------------------
    # 2) Exit-reason breakdown overall
    # ---------------------------------------------------------------
    print("\n" + "=" * 74)
    print("BY EXIT REASON")
    print("=" * 74)
    by_reason = defaultdict(list)
    for r in rows:
        by_reason[r.get("reason", "?")].append(r)
    for reason, group in sorted(by_reason.items()):
        summarize(f"{reason:9s}", group)

    # ---------------------------------------------------------------
    # 3) GUARD A simulation: block entries within N min after a timestop
    #    exit on the same ticker (same day)
    # ---------------------------------------------------------------
    guard_a_blocked = []
    timestop_exits = defaultdict(list)  # (date, symbol) -> list of exit ts
    for r in rows:
        if r.get("reason") == "timestop":
            timestop_exits[(r["_date"], r["symbol"])].append(r["_ts"].timestamp())

    for r in rows:
        key = (r["_date"], r["symbol"])
        for ts_exit in timestop_exits[key]:
            if 0 < r["_entry_ts"] - ts_exit <= args.guard_a_mins * 60:
                guard_a_blocked.append(r)
                break

    print("\n" + "=" * 74)
    print(f"GUARD A — block entry within {args.guard_a_mins:.0f} min after a timestop on same ticker")
    print("=" * 74)
    summarize("Trades it would have BLOCKED", guard_a_blocked)
    kept = [r for r in rows if r not in guard_a_blocked]
    summarize("Remaining trades            ", kept)

    # ---------------------------------------------------------------
    # 4) GUARD B simulation: block re-entry above X times first entry premium
    # ---------------------------------------------------------------
    guard_b_blocked = [r for r in reentries
                        if r.get("_first_entry_price")
                        and r["entryPrice"] > args.guard_b_mult * r["_first_entry_price"]]

    print("\n" + "=" * 74)
    print(f"GUARD B — block re-entry above {args.guard_b_mult}x the day's first entry premium (same strike)")
    print("=" * 74)
    summarize("Trades it would have BLOCKED", guard_b_blocked)
    kept_b = [r for r in rows if r not in guard_b_blocked]
    summarize("Remaining trades            ", kept_b)

    # ---------------------------------------------------------------
    # 5) The armed-vs-never-armed structural view
    # ---------------------------------------------------------------
    print("\n" + "=" * 74)
    print("ARMED (moved +10% at some point) vs NEVER ARMED")
    print("=" * 74)
    armed = [r for r in rows if r.get("armed")]
    unarmed = [r for r in rows if not r.get("armed")]
    summarize("Armed      ", armed)
    summarize("Never armed", unarmed)

    print("\nNOTE: exitPriceApprox is the last observed quote at close-submit, not")
    print("the true market-order fill — real timestop losses run slightly worse.")
    print("Guard simulations assume blocking a trade has no knock-on effects on")
    print("later entries (approximation).")


if __name__ == "__main__":
    main()
