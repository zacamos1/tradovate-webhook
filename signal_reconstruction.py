#!/usr/bin/env python3
"""
Signal Reconstruction — join mfe.jsonl outcomes to Pine component states
==========================================================================

For every historical signal in mfe.jsonl, reconstructs what the Index
0DTE Scout's components (EMA stack, VWAP bounce/rejection, OR
bounce/rejection, squeeze momentum, RSI zone, volume surge, ATR/OR env
filters) evaluated to at fire time — recomputed from free 15-minute bars
(yfinance) using the same math as the Pine source. Then tests which
conditions separate ARMED signals (moved +10%, 95% of them won) from
DEAD signals (never moved, the -$835 bleed).

Key hypotheses tested:
  H1: "State-only" signals (score >= threshold with NO event component —
      no VWAP bounce/rejection, no OR bounce/rejection) are dead more often.
      State components (EMA stack, squeeze, RSI, volume) persist bar after
      bar and re-fire; event components require an actual crossing.
  H2: Later same-day fires on the same ticker+side (fire rank 2, 3...)
      are dead more often than first fires.
  H3: Higher reconstructed score => higher armed rate.
  H4: Time-of-day effects.

Data note: bars come from Yahoo, TradingView runs its own feed — small
differences are expected, so reconstructed scores can differ from what
actually fired. The script reports a feed-mismatch measure (%% of signals
whose reconstructed score falls below the 45 threshold) so you know how
much to trust the component attribution.

Usage (anywhere with internet + the mfe file):
    pip install yfinance pandas --break-system-packages
    python3 signal_reconstruction.py --file mfe.jsonl --out signal_recon.csv
"""
import argparse
import json
import sys
from datetime import datetime, timezone, timedelta
from statistics import mean

import numpy as np
import pandas as pd

SCORE_THRESHOLD = 45
OR_MINUTES = 30
VWAP_BARS = 3
OR_ZONE_PCT = 0.003
ATR_MIN_PCT = 0.15
OR_MIN_PCT = 0.20


# ---------------------------------------------------------------------
# Indicator math — mirrors the Pine source
# ---------------------------------------------------------------------

def ema(s, n):
    return s.ewm(span=n, adjust=False).mean()


def rma(s, n):
    return s.ewm(alpha=1.0 / n, adjust=False).mean()


def rsi(close, n=14):
    delta = close.diff()
    up = delta.clip(lower=0)
    down = -delta.clip(upper=0)
    rs = rma(up, n) / rma(down, n)
    return 100 - 100 / (1 + rs)


def atr(df, n=14):
    tr = pd.concat([
        df["High"] - df["Low"],
        (df["High"] - df["Close"].shift()).abs(),
        (df["Low"] - df["Close"].shift()).abs(),
    ], axis=1).max(axis=1)
    return rma(tr, n)


def linreg_endpoint(s, n=20):
    """Pine ta.linreg(series, n, 0): value of the least-squares line at the
    most recent bar of each n-bar window."""
    x = np.arange(n)
    x_mean = x.mean()
    denom = ((x - x_mean) ** 2).sum()

    def f(window):
        y = np.asarray(window)
        b = ((x - x_mean) * (y - y.mean())).sum() / denom
        a = y.mean() - b * x_mean
        return a + b * (n - 1)

    return s.rolling(n).apply(f, raw=True)


def build_indicators(df):
    """df: 15m bars indexed by tz-aware ET timestamps (bar START times)."""
    out = df.copy()
    close, high, low, vol = out["Close"], out["High"], out["Low"], out["Volume"]

    out["ema9"] = ema(close, 9)
    out["ema21"] = ema(close, 21)
    out["ema50"] = ema(close, 50)
    out["trend_bull"] = (out["ema9"] > out["ema21"]) & (out["ema21"] > out["ema50"])
    out["trend_bear"] = (out["ema9"] < out["ema21"]) & (out["ema21"] < out["ema50"])

    # Puts-side 30m HTF proxy, exactly as the Pine does it (18/42 on chart TF)
    out["ema18"] = ema(close, 18)
    out["ema42"] = ema(close, 42)
    out["htf_bullish"] = out["ema18"] > out["ema42"]

    out["rsi"] = rsi(close, 14)
    out["rsi_bull"] = (out["rsi"] >= 32) & (out["rsi"] <= 55)
    out["rsi_bear"] = (out["rsi"] >= 45) & (out["rsi"] <= 68)

    out["vol_ma"] = vol.rolling(20).mean()
    out["vol_surge"] = vol > out["vol_ma"] * 1.5

    out["atr"] = atr(out, 14)
    out["atr_pct"] = out["atr"] / close * 100
    out["atr_ok"] = out["atr_pct"] >= ATR_MIN_PCT

    # Squeeze momentum value (the component actually used for scoring)
    hh = high.rolling(20).max()
    ll = low.rolling(20).min()
    sma20 = close.rolling(20).mean()
    sq_src = close - ((hh + ll) / 2 + sma20) / 2
    out["sq_val"] = linreg_endpoint(sq_src, 20)
    out["sq_bull"] = (out["sq_val"] > 0) & (out["sq_val"] > out["sq_val"].shift())
    out["sq_bear"] = (out["sq_val"] < 0) & (out["sq_val"] < out["sq_val"].shift())

    # Session VWAP (daily reset, hlc3-weighted) + opening range
    dates = out.index.date
    hlc3 = (high + low + close) / 3
    pv = hlc3 * vol
    out["vwap"] = pv.groupby(dates).cumsum() / vol.groupby(dates).cumsum()

    et_minutes = out.index.hour * 60 + out.index.minute
    in_or = (et_minutes >= 9 * 60 + 30) & (et_minutes < 9 * 60 + 30 + OR_MINUTES)
    or_high = high.where(in_or).groupby(dates).cummax()
    or_low = low.where(in_or).groupby(dates).cummin()
    out["or_high"] = or_high.groupby(dates).ffill()
    out["or_low"] = or_low.groupby(dates).ffill()
    out["or_set"] = et_minutes >= 9 * 60 + 30 + OR_MINUTES
    out["or_range_pct"] = (out["or_high"] - out["or_low"]) / out["or_low"] * 100
    out["or_range_ok"] = out["or_range_pct"] >= OR_MIN_PCT

    # Event components — require crossings, per the Pine
    below = (close < out["vwap"])
    above = (close > out["vwap"])
    bars_below_prev = sum(below.shift(i).fillna(False).astype(int) for i in range(1, VWAP_BARS + 1))
    bars_above_prev = sum(above.shift(i).fillna(False).astype(int) for i in range(1, VWAP_BARS + 1))
    out["vwap_bounce"] = (bars_below_prev >= VWAP_BARS) & (close > out["vwap"])
    out["vwap_rejection"] = (bars_above_prev >= VWAP_BARS) & (close < out["vwap"])

    out["or_bounce"] = (low <= out["or_low"] * (1 + OR_ZONE_PCT)) & (close > out["or_low"])
    out["or_rejection"] = (high >= out["or_high"] * (1 - OR_ZONE_PCT)) & (close < out["or_high"])

    return out


def score_row(row, right):
    if right == "C":
        comps = {
            "trend": bool(row["trend_bull"]), "vwap_evt": bool(row["vwap_bounce"]),
            "or_evt": bool(row["or_bounce"]), "squeeze": bool(row["sq_bull"]),
            "rsi": bool(row["rsi_bull"]), "vol": bool(row["vol_surge"]),
        }
    else:
        comps = {
            "trend": bool(row["trend_bear"]), "vwap_evt": bool(row["vwap_rejection"]),
            "or_evt": bool(row["or_rejection"]), "squeeze": bool(row["sq_bear"]),
            "rsi": bool(row["rsi_bear"]), "vol": bool(row["vol_surge"]),
        }
    score = (25 * comps["trend"] + 20 * comps["vwap_evt"] + 15 * comps["or_evt"]
              + 20 * comps["squeeze"] + 10 * comps["rsi"] + 10 * comps["vol"])
    return score, comps


# ---------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------

def dollars(row):
    e, x = row.get("entryPrice"), row.get("exitPriceApprox")
    q = row.get("qty", 1) or 1
    return round((x - e) * 100 * q, 2) if (e is not None and x is not None) else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True)
    ap.add_argument("--out", default="signal_recon.csv")
    args = ap.parse_args()

    try:
        import yfinance as yf
    except ImportError:
        print("pip install yfinance --break-system-packages", file=sys.stderr)
        sys.exit(1)

    rows = []
    with open(args.file) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            # Skip fill-correction rows (post-patch duplicates)
            if str(r.get("reason", "")).endswith("_fill"):
                continue
            rows.append(r)

    if not rows:
        print("No usable rows in mfe file.", file=sys.stderr)
        sys.exit(1)

    for r in rows:
        exit_ts = datetime.fromisoformat(r["ts"].replace("Z", "+00:00"))
        mins_held = r.get("minsHeld") or 0
        entry_utc = exit_ts - timedelta(minutes=mins_held)
        # Signals fire seconds after a 15m bar close — snap to nearest grid point
        grid = round(entry_utc.timestamp() / 900) * 900
        r["_entry_close_utc"] = datetime.fromtimestamp(grid, tz=timezone.utc)
        r["_dollars"] = dollars(r)

    symbols = sorted({r["symbol"] for r in rows})
    earliest = min(r["_entry_close_utc"] for r in rows) - timedelta(days=10)  # warmup
    latest = max(r["_entry_close_utc"] for r in rows) + timedelta(days=1)

    print(f"{len(rows)} signals | {len(symbols)} symbols: {', '.join(symbols)}")
    print(f"Fetching 15m bars {earliest.date()} -> {latest.date()} (includes warmup)...")

    bars = {}
    for sym in symbols:
        df = yf.download(sym, interval="15m", start=earliest.date().isoformat(),
                          end=latest.date().isoformat(), progress=False, prepost=False,
                          auto_adjust=False)
        if df.empty:
            print(f"  WARNING: no bars for {sym} — its signals will be skipped", file=sys.stderr)
            continue
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)
        df.index = df.index.tz_convert("America/New_York")
        bars[sym] = build_indicators(df)
        print(f"  {sym}: {len(df)} bars")

    results = []
    fire_counter = {}
    unmatched = 0

    for r in sorted(rows, key=lambda x: x["_entry_close_utc"]):
        sym = r["symbol"]
        if sym not in bars:
            continue
        b = bars[sym]
        close_et = r["_entry_close_utc"].astimezone(b.index.tz)
        bar_start = close_et - timedelta(minutes=15)
        if bar_start not in b.index:
            unmatched += 1
            continue
        row = b.loc[bar_start]
        right = r.get("right", "C")
        score, comps = score_row(row, right)

        day_key = (close_et.date(), sym, right)
        fire_counter[day_key] = fire_counter.get(day_key, 0) + 1

        env_ok = bool(row["atr_ok"]) and bool(row["or_range_ok"]) and (
            right == "C" or not bool(row["htf_bullish"]))

        results.append({
            "date": close_et.strftime("%Y-%m-%d"),
            "time_et": close_et.strftime("%H:%M"),
            "hour_et": close_et.hour,
            "symbol": sym, "right": right,
            "entryPrice": r.get("entryPrice"),
            "armed": bool(r.get("armed")),
            "reason": r.get("reason"),
            "pnl_dollars": r["_dollars"],
            "recon_score": score,
            "c_trend": comps["trend"], "c_vwap_evt": comps["vwap_evt"],
            "c_or_evt": comps["or_evt"], "c_squeeze": comps["squeeze"],
            "c_rsi": comps["rsi"], "c_vol": comps["vol"],
            "has_event_comp": comps["vwap_evt"] or comps["or_evt"],
            "state_only": (score >= SCORE_THRESHOLD) and not (comps["vwap_evt"] or comps["or_evt"]),
            "fire_rank": fire_counter[day_key],
            "recon_env_ok": env_ok,
            "atr_pct": round(float(row["atr_pct"]), 3),
            "or_range_pct": round(float(row["or_range_pct"]), 3) if pd.notna(row["or_range_pct"]) else None,
        })

    df_out = pd.DataFrame(results)
    df_out.to_csv(args.out, index=False)
    print(f"\nWrote {len(df_out)} reconstructed signals to {args.out} ({unmatched} unmatched to bars)")

    # Feed-mismatch check
    below_thresh = (df_out["recon_score"] < SCORE_THRESHOLD).sum()
    print(f"Feed-mismatch measure: {below_thresh}/{len(df_out)} signals reconstruct below the {SCORE_THRESHOLD} threshold "
          f"({100*below_thresh/len(df_out):.0f}%) — Yahoo vs TradingView bar differences; treat component attribution accordingly.\n")

    def seg(label, mask):
        g = df_out[mask]
        if len(g) == 0:
            print(f"  {label:34s} n=0")
            return
        armed_pct = 100 * g["armed"].mean()
        pnl = g["pnl_dollars"].dropna()
        print(f"  {label:34s} n={len(g):3d}  armed={armed_pct:5.1f}%  mean$={pnl.mean():+7.1f}  total$={pnl.sum():+8.0f}")

    print("=" * 78)
    print("H1 — EVENT-TRIGGERED vs STATE-ONLY")
    print("=" * 78)
    seg("Has event component (VWAP/OR evt)", df_out["has_event_comp"])
    seg("State-only (no event component)", ~df_out["has_event_comp"])

    print("\n" + "=" * 78)
    print("H2 — FIRE RANK (same day+ticker+side)")
    print("=" * 78)
    seg("1st fire of day", df_out["fire_rank"] == 1)
    seg("2nd fire", df_out["fire_rank"] == 2)
    seg("3rd+ fire", df_out["fire_rank"] >= 3)

    print("\n" + "=" * 78)
    print("H3 — RECONSTRUCTED SCORE BUCKETS")
    print("=" * 78)
    seg("Score < 45 (feed mismatch bucket)", df_out["recon_score"] < 45)
    seg("Score 45-59", (df_out["recon_score"] >= 45) & (df_out["recon_score"] < 60))
    seg("Score 60-74", (df_out["recon_score"] >= 60) & (df_out["recon_score"] < 75))
    seg("Score 75+", df_out["recon_score"] >= 75)

    print("\n" + "=" * 78)
    print("H4 — TIME OF DAY (ET)")
    print("=" * 78)
    for h in sorted(df_out["hour_et"].unique()):
        seg(f"{h:02d}:xx", df_out["hour_et"] == h)

    print("\n" + "=" * 78)
    print("PER-COMPONENT: armed rate when component TRUE vs FALSE")
    print("=" * 78)
    for c in ["c_trend", "c_vwap_evt", "c_or_evt", "c_squeeze", "c_rsi", "c_vol"]:
        seg(f"{c} = True", df_out[c])
        seg(f"{c} = False", ~df_out[c])
        print()

    print("=" * 78)
    print("Reference baseline: overall armed rate should be ~53%; armed cohort")
    print("won 95% (+$3,084), never-armed lost -$835. The question is which")
    print("segments concentrate the dead signals.")
    print("=" * 78)


if __name__ == "__main__":
    main()
