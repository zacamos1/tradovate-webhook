#!/usr/bin/env python3
"""
Signal Backtester — server-side port of the Index 0DTE Scout (calls + puts)
=============================================================================

Generates every signal the two Pine scripts WOULD have fired over
historical 15-minute bars, per ticker, with full component fingerprints.
This is simultaneously:
  (a) the signal-generation half of the TradingView-replacement port, and
  (b) the engine for deep backtesting (200+ signals) once fed more history.

FIDELITY CHECK: with --compare-mfe, generated signals are matched against
the live system's actual entries (mfe.jsonl) over the overlapping window —
measuring how faithfully this port reproduces what TradingView fired.
That match rate is the go/no-go number for the eventual TV replacement.

Pine semantics preserved:
  - conditions evaluated on bar close; session gates use bar OPEN time
    (Pine's `time`), so entry window 9:45-14:00 on open = signals landing
    9:45 through 14:15 ET, matching the live logs
  - opening range built from 9:30-10:00 bars; or_set from 10:00
  - env filters: ATR >= 0.15%, OR range >= 0.20%, puts also blocked when
    the 18/42 EMA proxy is bullish
  - daily max per (ticker, side): calls 4, puts 3
  - score >= 45 with the exact component weights

Data sources:
  --source yfinance  : free, last ~60 days only (Yahoo hard cap)
  --parquet-dir DIR  : local Databento parquet files named
                       {YYYY-MM-DD}_{TICKER}_underlying.parquet with
                       ts_event/open/high/low/close/volume 1m bars
                       (the pull_nvda_spy_3mo_fixed.py format) —
                       resampled to 15m here. Use for Feb-Apr depth.

Usage:
    # Free window, all tickers, with fidelity check against live signals:
    python3 signal_backtest.py --source yfinance --days 59 \
        --tickers SPY,QQQ,IWM,AAPL,AMZN,MSFT,META,NVDA,GOOGL,AVGO,TSLA \
        --compare-mfe mfe.jsonl --out generated_signals.csv
"""
import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

SCORE_THRESHOLD = 45
OR_MINUTES = 30
VWAP_BARS = 3
OR_ZONE_PCT = 0.003
ATR_MIN_PCT = 0.15
OR_MIN_PCT = 0.20
DAILY_MAX = {"C": 4, "P": 5}  # deployed chart values (source file said P:3 — live charts run 5)
SESSION_START = 945   # bar OPEN hhmm, per Pine
SESSION_END = 1400


# ---- indicator math (same as signal_reconstruction.py, kept in sync) ----

def ema(s, n):
    return s.ewm(span=n, adjust=False).mean()

def rma(s, n):
    return s.ewm(alpha=1.0 / n, adjust=False).mean()

def rsi(close, n=14):
    d = close.diff()
    rs = rma(d.clip(lower=0), n) / rma(-d.clip(upper=0), n)
    return 100 - 100 / (1 + rs)

def atr(df, n=14):
    tr = pd.concat([
        df["High"] - df["Low"],
        (df["High"] - df["Close"].shift()).abs(),
        (df["Low"] - df["Close"].shift()).abs(),
    ], axis=1).max(axis=1)
    return rma(tr, n)

def linreg_endpoint(s, n=20):
    x = np.arange(n); xm = x.mean()
    den = ((x - xm) ** 2).sum()
    def f(w):
        y = np.asarray(w)
        b = ((x - xm) * (y - y.mean())).sum() / den
        return (y.mean() - b * xm) + b * (n - 1)
    return s.rolling(n).apply(f, raw=True)


def build_indicators(df):
    out = df.copy()
    close, high, low, vol = out["Close"], out["High"], out["Low"], out["Volume"]

    out["ema9"], out["ema21"], out["ema50"] = ema(close, 9), ema(close, 21), ema(close, 50)
    out["trend_bull"] = (out["ema9"] > out["ema21"]) & (out["ema21"] > out["ema50"])
    out["trend_bear"] = (out["ema9"] < out["ema21"]) & (out["ema21"] < out["ema50"])
    out["htf_bullish"] = ema(close, 18) > ema(close, 42)

    out["rsi"] = rsi(close, 14)
    out["rsi_bull"] = (out["rsi"] >= 32) & (out["rsi"] <= 55)
    out["rsi_bear"] = (out["rsi"] >= 45) & (out["rsi"] <= 68)

    out["vol_surge"] = vol > vol.rolling(20).mean() * 1.5

    out["atr_pct"] = atr(out, 14) / close * 100
    out["atr_ok"] = out["atr_pct"] >= ATR_MIN_PCT

    hh, ll = high.rolling(20).max(), low.rolling(20).min()
    sq_src = close - ((hh + ll) / 2 + close.rolling(20).mean()) / 2
    out["sq_val"] = linreg_endpoint(sq_src, 20)
    out["sq_bull"] = (out["sq_val"] > 0) & (out["sq_val"] > out["sq_val"].shift())
    out["sq_bear"] = (out["sq_val"] < 0) & (out["sq_val"] < out["sq_val"].shift())

    dates = out.index.date
    hlc3 = (high + low + close) / 3
    out["vwap"] = (hlc3 * vol).groupby(dates).cumsum() / vol.groupby(dates).cumsum()

    et_min = out.index.hour * 60 + out.index.minute
    in_or = (et_min >= 570) & (et_min < 570 + OR_MINUTES)
    out["or_high"] = high.where(in_or).groupby(dates).cummax().groupby(dates).ffill()
    out["or_low"] = low.where(in_or).groupby(dates).cummin().groupby(dates).ffill()
    out["or_set"] = et_min >= 570 + OR_MINUTES
    out["or_range_pct"] = (out["or_high"] - out["or_low"]) / out["or_low"] * 100
    out["or_ok"] = out["or_range_pct"] >= OR_MIN_PCT

    below, above = close < out["vwap"], close > out["vwap"]
    bb = sum(below.shift(i).fillna(False).astype(int) for i in range(1, VWAP_BARS + 1))
    ba = sum(above.shift(i).fillna(False).astype(int) for i in range(1, VWAP_BARS + 1))
    out["vwap_bounce"] = (bb >= VWAP_BARS) & above
    out["vwap_rejection"] = (ba >= VWAP_BARS) & below

    out["or_bounce"] = (low <= out["or_low"] * (1 + OR_ZONE_PCT)) & (close > out["or_low"])
    out["or_rejection"] = (high >= out["or_high"] * (1 - OR_ZONE_PCT)) & (close < out["or_high"])

    out["hhmm"] = out.index.hour * 100 + out.index.minute
    return out


# ---- Options Prime v7 Auto-Calibrated engine (the LIVE alert engine) ----
# Ported from "Options Prime v7 — Auto-Calibrated Single Stock" — this is
# what actually fires the single-name webhooks. Differs from the v4 Tracker:
# no VWAP/squeeze in score; candles +5 and vol_surge +10 ARE scored; MACD
# zone/hist at 10; near_sup/res 10; hv_cheap 10; deadband referee (side must
# lead by >=10 or neither fires); per-ticker calibrated thresholds.

PRIME_THRESHOLDS = {"NVDA": 45, "TSLA": 45, "AAPL": 15, "MSFT": 35,
                     "META": 45, "GOOGL": 55, "AVGO": 55}
PRIME_DEFAULT_THRESHOLD = 5      # any uncalibrated ticker (e.g. AMZN)
PRIME_DEADBAND = 10
PRIME_SESSION_START = 945        # bar OPEN hhmm, inclusive
PRIME_SESSION_END = 1430         # inclusive (<=), per source
PRIME_ADX_THRESH = 20
PRIME_MAX_EXT = 0.02


def dmi_adx(df, n=14):
    """Wilder DMI/ADX matching Pine ta.dmi."""
    high, low, close = df["High"], df["Low"], df["Close"]
    up = high.diff()
    dn = -low.diff()
    plus_dm = pd.Series(np.where((up > dn) & (up > 0), up, 0.0), index=df.index)
    minus_dm = pd.Series(np.where((dn > up) & (dn > 0), dn, 0.0), index=df.index)
    tr = pd.concat([high - low, (high - close.shift()).abs(), (low - close.shift()).abs()], axis=1).max(axis=1)
    atr_ = rma(tr, n)
    plus_di = 100 * rma(plus_dm, n) / atr_
    minus_di = 100 * rma(minus_dm, n) / atr_
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di)
    return rma(dx, n)


def pivot_levels(df, left=5, right=5):
    """Last confirmed pivot high/low carried forward (confirmed `right` bars later)."""
    high, low = df["High"], df["Low"]
    n = len(df)
    res = np.full(n, np.nan)
    sup = np.full(n, np.nan)
    cur_res, cur_sup = np.nan, np.nan
    hv = high.values
    lv = low.values
    for i in range(n):
        j = i - right  # candidate pivot bar, confirmed at i
        if j - left >= 0:
            window_h = hv[j - left: j + right + 1]
            if hv[j] == window_h.max() and (window_h == hv[j]).sum() == 1:
                cur_res = hv[j]
            window_l = lv[j - left: j + right + 1]
            if lv[j] == window_l.min() and (window_l == lv[j]).sum() == 1:
                cur_sup = lv[j]
        res[i] = cur_res
        sup[i] = cur_sup
    return pd.Series(res, index=df.index), pd.Series(sup, index=df.index)


def build_indicators_prime(df):
    out = df.copy()
    close, high, low, vol, opn = out["Close"], out["High"], out["Low"], out["Volume"], out["Open"]

    out["ema9"], out["ema21"], out["ema50"] = ema(close, 9), ema(close, 21), ema(close, 50)
    out["bull_trend"] = (out["ema9"] > out["ema21"]) & (out["ema21"] > out["ema50"]) & (close > out["ema50"])
    out["bear_trend"] = (out["ema9"] < out["ema21"]) & (out["ema21"] < out["ema50"]) & (close < out["ema50"])

    out["adx"] = dmi_adx(out, 14)
    out["is_trending"] = out["adx"] >= PRIME_ADX_THRESH

    r = rsi(close, 14)
    rsi_rising = (r > r.shift(1)) & (r > r.shift(2))
    rsi_falling = (r < r.shift(1)) & (r < r.shift(2))
    out["rsi_bull"] = (((r > 50) & (r < 68) & rsi_rising)
                        | ((r > 40) & (r.shift(1) <= 40) & rsi_rising))
    out["rsi_bear"] = (((r < 50) & (r > 32) & rsi_falling)
                        | ((r < 60) & (r.shift(1) >= 60) & rsi_falling))

    macd = ema(close, 12) - ema(close, 26)
    sig = ema(macd, 9)
    hist = macd - sig
    out["macd_bull_zone"] = macd > sig
    out["macd_bear_zone"] = macd < sig
    out["macd_bull_cross"] = (macd > sig) & (macd.shift(1) <= sig.shift(1))
    out["macd_bear_cross"] = (macd < sig) & (macd.shift(1) >= sig.shift(1))
    out["hist_up"] = (hist > hist.shift(1)) & (hist > 0)
    out["hist_down"] = (hist < hist.shift(1)) & (hist < 0)

    log_ret = np.log(close / close.shift(1))
    hv_raw = log_ret.rolling(20).std() * np.sqrt(252) * 100
    hv_lo = hv_raw.rolling(252).min()
    hv_hi = hv_raw.rolling(252).max()
    hv_rank = ((hv_raw - hv_lo) / (hv_hi - hv_lo) * 100).where((hv_hi - hv_lo) != 0, 50)
    out["hv_cheap"] = hv_rank <= 35
    out["hv_spike"] = hv_rank >= 65

    out["vol_surge"] = vol > vol.rolling(20).mean() * 1.5

    res_lvl, sup_lvl = pivot_levels(out)
    out["near_res"] = res_lvl.notna() & (close >= res_lvl * 0.985) & (close <= res_lvl * 1.015)
    out["near_sup"] = sup_lvl.notna() & (close <= sup_lvl * 1.015) & (close >= sup_lvl * 0.985)

    body = (close - opn).abs()
    upper_wick = high - pd.concat([close, opn], axis=1).max(axis=1)
    lower_wick = pd.concat([close, opn], axis=1).min(axis=1) - low
    bull_engulf = (close > opn) & (close > opn.shift(1)) & (opn < close.shift(1))
    bear_engulf = (close < opn) & (close < opn.shift(1)) & (opn > close.shift(1))
    hammer = (close > opn) & (body > 0) & (lower_wick > 2.0 * body) & (upper_wick < 0.5 * body)
    shoot = (close < opn) & (body > 0) & (upper_wick > 2.0 * body) & (lower_wick < 0.5 * body)
    out["bull_candle"] = bull_engulf | hammer
    out["bear_candle"] = bear_engulf | shoot

    hh, ll = high.rolling(20).max(), low.rolling(20).min()
    sq_src = close - ((hh + ll) / 2 + close.rolling(20).mean()) / 2
    out["sq_val"] = linreg_endpoint(sq_src, 20)
    out["sq_bull"] = (out["sq_val"] > 0) & (out["sq_val"] > out["sq_val"].shift())
    out["sq_bear"] = (out["sq_val"] < 0) & (out["sq_val"] < out["sq_val"].shift())

    dates = out.index.date
    hlc3 = (high + low + close) / 3
    out["vwap"] = (hlc3 * vol).groupby(dates).cumsum() / vol.groupby(dates).cumsum()
    below, above = close < out["vwap"], close > out["vwap"]
    bb = sum(below.shift(i).fillna(False).astype(int) for i in range(1, 4))
    ba = sum(above.shift(i).fillna(False).astype(int) for i in range(1, 4))
    out["vwap_bounce"] = (bb >= 3) & above
    out["vwap_rejection"] = (ba >= 3) & below

    out["call_not_ext"] = close <= out["ema9"] * (1 + PRIME_MAX_EXT)
    out["put_not_ext"] = close >= out["ema9"] * (1 - PRIME_MAX_EXT)

    out["hhmm"] = out.index.hour * 100 + out.index.minute
    return out


def prime_scores(row):
    """Auto-Calibrated v6 weights — the live alert engine's scoring."""
    call = (25 * row["bull_trend"] + 15 * row["rsi_bull"] + 10 * row["macd_bull_zone"]
             + 15 * row["macd_bull_cross"] + 10 * row["hist_up"] + 10 * row["vol_surge"]
             + 5 * row["bull_candle"] + 10 * row["near_sup"] + 10 * row["hv_cheap"]
             - 20 * row["hv_spike"])
    put = (25 * row["bear_trend"] + 15 * row["rsi_bear"] + 10 * row["macd_bear_zone"]
            + 15 * row["macd_bear_cross"] + 10 * row["hist_down"] + 10 * row["vol_surge"]
            + 5 * row["bear_candle"] + 10 * row["near_res"] + 10 * row["hv_cheap"]
            - 20 * row["hv_spike"])
    return int(max(0, min(100, call))), int(max(0, min(100, put)))


def generate_signals_prime(bars):
    """Live Auto-Calibrated engine: edge-triggered, deadband referee, per-ticker thresholds."""
    signals = []
    for sym, df in bars.items():
        threshold = PRIME_THRESHOLDS.get(sym, PRIME_DEFAULT_THRESHOLD)
        ind = build_indicators_prime(df)
        prev_setup = {"C": False, "P": False}
        for ts, row in ind.iterrows():
            in_window = PRIME_SESSION_START <= row["hhmm"] <= PRIME_SESSION_END
            call_score, put_score = prime_scores(row)
            gap = abs(call_score - put_score)
            call_leads = call_score > put_score and gap >= PRIME_DEADBAND
            put_leads = put_score > call_score and gap >= PRIME_DEADBAND
            for side, score, not_ext, leads in (
                    ("C", call_score, row["call_not_ext"], call_leads),
                    ("P", put_score, row["put_not_ext"], put_leads)):
                setup = (in_window and bool(row["is_trending"]) and score >= threshold
                          and bool(not_ext) and bool(row["vol_surge"]) and leads)
                fired = setup and not prev_setup[side]
                prev_setup[side] = setup
                if not fired:
                    continue
                close_time = ts + timedelta(minutes=15)
                signals.append({
                    "signal_ts_et": close_time.isoformat(),
                    "date": str(ts.date()), "time_et": close_time.strftime("%H:%M"),
                    "symbol": sym, "side": side, "score": score,
                    "underlying_close": round(float(row["Close"]), 2),
                    "fire_rank": 1, "engine": "prime",
                })
    return pd.DataFrame(signals).sort_values("signal_ts_et").reset_index(drop=True) if signals else pd.DataFrame()


def load_yfinance(tickers, days):
    import yfinance as yf
    end = datetime.now(timezone.utc) + timedelta(days=1)
    start = end - timedelta(days=days)
    bars = {}
    for t in tickers:
        df = yf.download(t, interval="15m", start=start.date().isoformat(),
                          end=end.date().isoformat(), progress=False,
                          prepost=False, auto_adjust=False)
        if df.empty:
            print(f"  WARNING: no bars for {t}", file=sys.stderr)
            continue
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)
        df.index = df.index.tz_convert("America/New_York")
        bars[t] = df
        print(f"  {t}: {len(df)} bars (yfinance)")
    return bars


def load_parquet_dir(dirpath, tickers):
    """Load {date}_{TICKER}_underlying.parquet 1m files, resample to 15m."""
    bars = {}
    for t in tickers:
        files = sorted(Path(dirpath).glob(f"*_{t}_underlying.parquet"))
        if not files:
            continue
        frames = []
        for f in files:
            df = pd.read_parquet(f)
            cols = {c.lower(): c for c in df.columns}
            df = df.rename(columns={cols.get("open", "open"): "Open", cols.get("high", "high"): "High",
                                     cols.get("low", "low"): "Low", cols.get("close", "close"): "Close",
                                     cols.get("volume", "volume"): "Volume"})
            ts_col = cols.get("ts_event", "ts_event")
            df[ts_col] = pd.to_datetime(df[ts_col], utc=True)
            df = df.set_index(ts_col)[["Open", "High", "Low", "Close", "Volume"]]
            frames.append(df)
        full = pd.concat(frames).sort_index()
        full.index = full.index.tz_convert("America/New_York")
        r = full.resample("15min", label="left", closed="left").agg(
            {"Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum"}).dropna()
        # keep regular session bars only
        et_min = r.index.hour * 60 + r.index.minute
        r = r[(et_min >= 570) & (et_min < 960)]
        bars[t] = r
        print(f"  {t}: {len(r)} bars (parquet, {len(files)} files)")
    return bars


def generate_signals(bars):
    signals = []
    for sym, df in bars.items():
        ind = build_indicators(df)
        counters = {}
        for ts, row in ind.iterrows():
            if not (SESSION_START <= row["hhmm"] <= SESSION_END):
                continue
            if not row["or_set"] or not row["atr_ok"] or not row["or_ok"]:
                continue
            if pd.isna(row["or_range_pct"]):
                continue
            day = ts.date()
            for side in ("C", "P"):
                if side == "C":
                    comps = {"trend": row["trend_bull"], "vwap_evt": row["vwap_bounce"],
                              "or_evt": row["or_bounce"], "squeeze": row["sq_bull"],
                              "rsi": row["rsi_bull"], "vol": row["vol_surge"]}
                    env_extra = True
                else:
                    comps = {"trend": row["trend_bear"], "vwap_evt": row["vwap_rejection"],
                              "or_evt": row["or_rejection"], "squeeze": row["sq_bear"],
                              "rsi": row["rsi_bear"], "vol": row["vol_surge"]}
                    env_extra = not bool(row["htf_bullish"])
                comps = {k: bool(v) for k, v in comps.items()}
                score = (25 * comps["trend"] + 20 * comps["vwap_evt"] + 15 * comps["or_evt"]
                          + 20 * comps["squeeze"] + 10 * comps["rsi"] + 10 * comps["vol"])
                if score < SCORE_THRESHOLD or not env_extra:
                    continue
                key = (day, sym, side)
                counters[key] = counters.get(key, 0) + 1
                if counters[key] > DAILY_MAX[side]:
                    continue
                close_time = ts + timedelta(minutes=15)
                signals.append({
                    "signal_ts_et": close_time.isoformat(),
                    "date": str(day), "time_et": close_time.strftime("%H:%M"),
                    "symbol": sym, "side": side, "score": score,
                    "underlying_close": round(float(row["Close"]), 2),
                    "fire_rank": counters[key],
                    **{f"c_{k}": v for k, v in comps.items()},
                })
    return pd.DataFrame(signals).sort_values("signal_ts_et").reset_index(drop=True)


def compare_to_mfe(gen: pd.DataFrame, mfe_path: str):
    live = []
    with open(mfe_path) as f:
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
            exit_ts = datetime.fromisoformat(r["ts"].replace("Z", "+00:00"))
            entry = exit_ts - timedelta(minutes=(r.get("minsHeld") or 0))
            grid = round(entry.timestamp() / 900) * 900
            live.append({
                "entry_utc": datetime.fromtimestamp(grid, tz=timezone.utc),
                "symbol": r["symbol"], "side": r.get("right", "C"),
            })
    if not live:
        print("No live signals parsed for comparison.", file=sys.stderr)
        return

    gen_keys = set()
    for _, g in gen.iterrows():
        ts = datetime.fromisoformat(g["signal_ts_et"])
        gen_keys.add((ts.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M"), g["symbol"], g["side"]))

    window_start = min(x["entry_utc"] for x in live)
    window_end = max(x["entry_utc"] for x in live)
    in_window = [x for x in live
                  if window_start <= x["entry_utc"] <= window_end]

    matched = 0
    misses = []
    per_ticker = {}
    for x in in_window:
        k = (x["entry_utc"].strftime("%Y-%m-%d %H:%M"), x["symbol"], x["side"])
        pt = per_ticker.setdefault(x["symbol"], {"n": 0, "hit": 0})
        pt["n"] += 1
        if k in gen_keys:
            matched += 1
            pt["hit"] += 1
        else:
            misses.append(k)

    print("\n" + "=" * 70)
    print("FIDELITY CHECK — port-generated signals vs live TradingView fires")
    print("=" * 70)
    print(f"Live signals in overlap window: {len(in_window)}")
    print(f"Matched by port (same bar/ticker/side): {matched} ({100*matched/len(in_window):.0f}%)")
    print(f"Missed: {len(misses)}")
    print("\nPer-ticker match rate (low outliers = likely per-chart config drift):")
    for sym, pt in sorted(per_ticker.items(), key=lambda kv: kv[1]["hit"] / max(1, kv[1]["n"])):
        print(f"  {sym:6s} {pt['hit']:3d}/{pt['n']:<3d} ({100*pt['hit']/max(1,pt['n']):.0f}%)")
    if misses:
        print("Sample misses (first 10):")
        for m in misses[:10]:
            print(f"  {m[0]} UTC  {m[1]} {m[2]}")
    # Over-generation measure: port signals on days/tickers the live system traded
    print("-" * 70)
    print(f"Total port-generated signals in same period: "
          f"{len(gen)} (live system entered {len(in_window)}; port count runs higher by design — "
          f"the server's one-position-per-ticker rule and TP-config gaps drop some fires)")
    print("=" * 70)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["yfinance", "parquet"], default="yfinance")
    ap.add_argument("--days", type=int, default=59, help="yfinance lookback (max ~60)")
    ap.add_argument("--parquet-dir", help="dir of {date}_{TICKER}_underlying.parquet files")
    ap.add_argument("--tickers", default="SPY,QQQ,IWM,AAPL,AMZN,MSFT,META,NVDA,GOOGL,AVGO,TSLA")
    ap.add_argument("--compare-mfe", help="path to mfe.jsonl for fidelity check")
    ap.add_argument("--out", default="generated_signals.csv")
    ap.add_argument("--or-minutes", type=int, default=30,
                     help="Opening Range minutes as set on the DEPLOYED charts (source default 30; live fires at 10:00 ET suggest 15)")
    ap.add_argument("--session-start", type=int, default=945,
                     help="Entry window start hhmm on bar OPEN, as deployed (source default 945)")
    ap.add_argument("--score-threshold", type=int, default=45,
                     help="Min score, as deployed (source default 45)")
    ap.add_argument("--no-daily-max", action="store_true",
                     help="Disable the per-day trade caps. Use for fidelity checks: the caps entangle "
                          "the comparison (a marginal extra fire early in the day exhausts the counter "
                          "and blocks matching a later genuine fire). For outcome backtests, leave caps ON.")
    ap.add_argument("--engine", choices=["scout", "prime", "both", "live"], default="scout",
                     help="scout / prime (all tickers), both (union), or live: the real deployed "
                          "architecture — Scout on SPY/QQQ/IWM, Prime autocal on single names.")
    a = ap.parse_args()

    global OR_MINUTES, SESSION_START, SCORE_THRESHOLD, DAILY_MAX
    OR_MINUTES = a.or_minutes
    SESSION_START = a.session_start
    SCORE_THRESHOLD = a.score_threshold
    if a.no_daily_max:
        DAILY_MAX = {"C": 10**9, "P": 10**9}

    tickers = [t.strip().upper() for t in a.tickers.split(",")]
    print(f"Loading bars for {len(tickers)} tickers...")
    if a.source == "yfinance":
        bars = load_yfinance(tickers, a.days)
    else:
        if not a.parquet_dir:
            print("--parquet-dir required with --source parquet", file=sys.stderr)
            sys.exit(1)
        bars = load_parquet_dir(a.parquet_dir, tickers)

    if not bars:
        print("No bar data loaded.", file=sys.stderr)
        sys.exit(1)

    ETFS = {"SPY", "QQQ", "IWM"}
    frames = []
    if a.engine == "live":
        etf_bars = {s: b for s, b in bars.items() if s in ETFS}
        stock_bars = {s: b for s, b in bars.items() if s not in ETFS}
        if etf_bars:
            g = generate_signals(etf_bars)
            if len(g):
                g["engine"] = "scout"
                frames.append(g)
        if stock_bars:
            g = generate_signals_prime(stock_bars)
            if len(g):
                frames.append(g)
    else:
        if a.engine in ("scout", "both"):
            g = generate_signals(bars)
            if len(g):
                g["engine"] = "scout"
                frames.append(g)
        if a.engine in ("prime", "both"):
            g = generate_signals_prime(bars)
            if len(g):
                frames.append(g)
    gen = pd.concat(frames).sort_values("signal_ts_et").reset_index(drop=True) if frames else pd.DataFrame()
    gen.to_csv(a.out, index=False)
    print(f"\nGenerated {len(gen)} signals -> {a.out}")
    print(gen.groupby(["symbol", "side"]).size().unstack(fill_value=0))

    if a.compare_mfe:
        compare_to_mfe(gen, a.compare_mfe)


if __name__ == "__main__":
    main()
