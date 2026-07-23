#!/usr/bin/env python3
"""
Outcome Simulator — replay the live exit rules against pulled option quotes
=============================================================================

Consumes the per-trade parquet files from outcome_quote_pull.py and replays
the SERVER's exit machinery for every backtest trade, minute by minute:

  ENTRY   : buy at the ASK of the first-OTM contract at the entry minute
            (honest worst-case fill, same discipline as the honesty-ratio
            work; the ±1 neighborhood strikes are fallbacks if the exact
            first-OTM has no quote)
  ARM     : premium reaches entry * (1 + ARM_PCT) — checked on bid
  TRAIL   : once armed, exit when bid <= peak_bid * (1 - TRAIL_PCT)
  TIMESTOP: if never armed by TIMESTOP_MIN minutes, exit at bid
  EOD     : force exit at end of quote window if still open

Resolution caveat, stated upfront: quotes are 1-minute snapshots; the live
system trails on ticks. Trail exits here are approximate (a fast spike-and-
reverse inside one minute is invisible). Results are for RELATIVE questions
— rule A vs rule B on identical data — not absolute P&L prediction.

After the base replay, it answers the ranked hypotheses:
  1. MICRO-TIMESTOP ("winners win fast"): recovery rate of trades flat at
     minute N, and P&L of killing zero-MFE trades at 3/5/8 min vs 15.
  2. Commission impact per ticker (--commission, default $1.30/contract
     round trip) — the SPY question.
  3. Per-ticker viability at backtest sample sizes — the AAPL/TSLA question.
  (The RSI gate joins from generated_signals.csv component columns if the
   trades CSV carries c_rsi — trade_list_builder preserves signal columns.)

Usage:
    python3 outcome_simulator.py --trades would_trade_hold3.csv \
        --quotes-dir ./outcome_quotes --commission 1.30
"""
import argparse
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path
from statistics import mean, median

import numpy as np
import pandas as pd

ARM_PCT = 0.10
TRAIL_PCT = 0.15
TIMESTOP_MIN = 15.0

SYMBOL_RE = re.compile(r"^([A-Z]+)\s*(\d{6})([CP])(\d{8})$")


def parse_occ(sym: str):
    m = SYMBOL_RE.match(sym.strip())
    if not m:
        return None
    root, exp, cp, strike = m.groups()
    return root, exp, cp, int(strike) / 1000.0


def pick_bid_ask_cols(df):
    for b, a in (("bid_px_00", "ask_px_00"), ("bid_px", "ask_px")):
        if b in df.columns and a in df.columns:
            return b, a
    return None, None


def simulate_trade(trade, qfile: Path):
    """Replay one trade. Returns dict or None if unusable."""
    if not qfile.exists():
        return None
    df = pd.read_parquet(qfile)
    if df.empty or "symbol" not in df.columns:
        return None
    bcol, acol = pick_bid_ask_cols(df)
    if bcol is None:
        return None

    parsed = df["symbol"].apply(parse_occ)
    df = df[parsed.notna()].copy()
    if df.empty:
        return None
    df["strike"] = [p[3] for p in parsed[parsed.notna()]]

    ts_col = "ts_event" if "ts_event" in df.columns else df.columns[0]
    df[ts_col] = pd.to_datetime(df[ts_col], utc=True)
    df = df.sort_values(ts_col)

    entry_ts = pd.Timestamp(datetime.fromisoformat(trade["signal_ts_et"])).tz_convert("UTC")

    # choose the contract: middle strike of the neighborhood with a usable
    # first-minute ask; fall back to neighbors
    strikes = sorted(df["strike"].unique())
    if not strikes:
        return None
    order = sorted(strikes, key=lambda k: abs(k - strikes[len(strikes) // 2]))

    for strike in order:
        c = df[df["strike"] == strike].copy()
        c = c[(c[acol] > 0)]
        if c.empty:
            continue
        first = c[c[ts_col] >= entry_ts]
        if first.empty:
            continue
        entry_row = first.iloc[0]
        entry_price = float(entry_row[acol])
        if entry_price <= 0.01:
            continue

        path = c[c[ts_col] >= entry_row[ts_col]].reset_index(drop=True)
        bids = path[bcol].fillna(0.0).astype(float).values
        times = path[ts_col].values

        arm_level = entry_price * (1 + ARM_PCT)
        armed = False
        peak = bids[0] if len(bids) else 0.0
        exit_price, exit_reason, exit_min = None, None, None
        mfe_minutes_to_first_up = None

        for i in range(len(bids)):
            mins = (times[i] - times[0]) / np.timedelta64(60, "s")
            b = bids[i]
            if b > peak:
                peak = b
            if mfe_minutes_to_first_up is None and b > entry_price:
                mfe_minutes_to_first_up = float(mins)
            if not armed and b >= arm_level:
                armed = True
            if armed and b <= peak * (1 - TRAIL_PCT):
                exit_price, exit_reason, exit_min = b, "trail", float(mins)
                break
            if not armed and mins >= TIMESTOP_MIN:
                exit_price, exit_reason, exit_min = b, "timestop", float(mins)
                break

        if exit_price is None:
            exit_price = bids[-1] if len(bids) else 0.0
            exit_reason = "window_end"
            exit_min = float((times[-1] - times[0]) / np.timedelta64(60, "s")) if len(bids) else 0.0

        mfe_pct = (peak / entry_price - 1) * 100 if entry_price else 0.0

        return {
            "trade_id": qfile.stem,
            "date": trade["date"], "symbol": trade["symbol"], "side": trade["side"],
            "engine": trade.get("engine"),
            "score": trade.get("score"), "c_rsi": trade.get("c_rsi"),
            "c_vwap_evt": trade.get("c_vwap_evt"), "c_trend": trade.get("c_trend"),
            "strike": strike, "entry_price": round(entry_price, 2),
            "exit_price": round(float(exit_price), 2), "exit_reason": exit_reason,
            "exit_min": round(exit_min, 1) if exit_min is not None else None,
            "armed": armed, "mfe_pct": round(mfe_pct, 1),
            "mins_to_first_uptick": round(mfe_minutes_to_first_up, 1) if mfe_minutes_to_first_up is not None else None,
            "pnl": round((float(exit_price) - entry_price) * 100, 2),
            "bids_path": list(np.round(bids[:31], 3)),  # minute-by-minute for micro-timestop sweep
        }
    return None


def micro_timestop_sweep(results: pd.DataFrame, kill_minutes=(3, 5, 8)):
    """Re-price every trade under earlier zero-MFE kills, using stored bid paths."""
    print("\n" + "=" * 72)
    print("MICRO-TIMESTOP SWEEP — 'winners win fast'")
    print("=" * 72)

    # Recovery question first: of trades with NO uptick by minute N, how many armed later?
    for n in kill_minutes:
        late = results[(results["mins_to_first_uptick"].isna()) | (results["mins_to_first_uptick"] > n)]
        recovered = late[late["armed"]]
        print(f"  Flat at minute {n}: {len(late):4d} trades | later armed anyway: {len(recovered):3d} "
              f"({100*len(recovered)/max(1,len(late)):.1f}%) | their P&L if killed at {n}m vs actual: see below")

    print("-" * 72)
    base_pnl = results["pnl"].sum()
    print(f"  Baseline (15-min timestop, as live): total ${base_pnl:+,.0f}")

    for n in kill_minutes:
        total = 0.0
        for _, r in results.iterrows():
            path = r["bids_path"]
            first_up = r["mins_to_first_uptick"]
            if (first_up is None or (isinstance(first_up, float) and np.isnan(first_up)) or first_up > n) and len(path) > n:
                # killed at minute n at that minute's bid
                total += (path[int(n)] - r["entry_price"]) * 100
            else:
                total += r["pnl"]
        print(f"  Kill zero-MFE trades at {n:2d} min:      total ${total:+,.0f}  (delta ${total-base_pnl:+,.0f})")
    print("=" * 72)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--trades", required=True)
    ap.add_argument("--quotes-dir", default="./outcome_quotes")
    ap.add_argument("--commission", type=float, default=1.30, help="round-trip $ per contract")
    ap.add_argument("--out", default="simulated_outcomes.csv")
    a = ap.parse_args()

    trades = pd.read_csv(a.trades)
    qdir = Path(a.quotes_dir)

    results, missing = [], 0
    for _, t in trades.iterrows():
        ts = datetime.fromisoformat(t["signal_ts_et"])
        tid = f"{t['date']}_{t['symbol']}_{t['side']}_{ts.strftime('%H%M')}"
        r = simulate_trade(t, qdir / f"{tid}.parquet")
        if r is None:
            missing += 1
            continue
        results.append(r)

    if not results:
        print("No simulatable trades — check quotes dir.", file=sys.stderr)
        sys.exit(1)

    df = pd.DataFrame(results)
    df_out = df.drop(columns=["bids_path"])
    df_out.to_csv(a.out, index=False)
    print(f"Simulated {len(df)} trades ({missing} skipped: no usable quotes) -> {a.out}")

    print("\n" + "=" * 72)
    print("BASE REPLAY (live rules: arm +10%, trail 15%, timestop 15 min)")
    print("=" * 72)
    print(f"  Total P&L (no commissions): ${df['pnl'].sum():+,.0f}   mean ${df['pnl'].mean():+.1f}/trade")
    net = df["pnl"].sum() - a.commission * len(df)
    print(f"  After ${a.commission:.2f}/trade commission:  ${net:+,.0f}   mean ${net/len(df):+.1f}/trade")
    armed = df[df["armed"]]
    dead = df[~df["armed"]]
    print(f"  Armed: {len(armed)} ({100*len(armed)/len(df):.0f}%)  P&L ${armed['pnl'].sum():+,.0f}")
    print(f"  Dead:  {len(dead)} ({100*len(dead)/len(df):.0f}%)  P&L ${dead['pnl'].sum():+,.0f}")
    print(f"  Exit reasons: {df['exit_reason'].value_counts().to_dict()}")

    micro_timestop_sweep(df)

    print("\n" + "=" * 72)
    print(f"PER-TICKER (after ${a.commission:.2f} commission)")
    print("=" * 72)
    print(f"  {'SYM':6s}{'N':>5s}{'TOTAL':>10s}{'MEAN':>8s}{'ARM%':>6s}")
    for sym, g in sorted(df.groupby("symbol"), key=lambda kv: kv[1]["pnl"].sum()):
        tot = g["pnl"].sum() - a.commission * len(g)
        print(f"  {sym:6s}{len(g):5d}{tot:10.0f}{tot/len(g):8.1f}{100*g['armed'].mean():5.0f}%")

    if "engine" in df.columns and df["engine"].notna().any():
        print("\n" + "=" * 72)
        print(f"PER-ENGINE (after ${a.commission:.2f} commission)")
        print("=" * 72)
        for eng, g in df.groupby("engine"):
            tot = g["pnl"].sum() - a.commission * len(g)
            print(f"  {str(eng):8s} n={len(g):5d}  total ${tot:+,.0f}  mean ${tot/len(g):+.1f}  arm {100*g['armed'].mean():.0f}%")

    if "c_rsi" in df.columns and df["c_rsi"].notna().any():
        print("\n" + "=" * 72)
        print("RSI COMPONENT (out-of-sample check of the live-data finding)")
        print("=" * 72)
        for val, label in ((True, "RSI in zone (component TRUE)"), (False, "RSI out of zone (FALSE)")):
            g = df[df["c_rsi"] == val]
            if len(g):
                print(f"  {label:34s} n={len(g):4d}  total ${g['pnl'].sum():+,.0f}  mean ${g['pnl'].mean():+.1f}  arm {100*g['armed'].mean():.0f}%")

    print("\nCaveat: 1-minute quote resolution — trail exits approximate; use for")
    print("relative comparisons (rule vs rule, ticker vs ticker), not absolutes.")


if __name__ == "__main__":
    main()
