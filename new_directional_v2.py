#!/usr/bin/env python3
"""
New Directional Engine v2 — Score 50 (more volume)
"""
import argparse
import pandas as pd
import yfinance as yf
import numpy as np

def ema(s, n):
    return s.ewm(span=n, adjust=False).mean()

def rma(s, n):
    return s.ewm(alpha=1.0 / n, adjust=False).mean()

def atr(df, n=14):
    tr = pd.concat([df["High"] - df["Low"], (df["High"] - df["Close"].shift()).abs(), (df["Low"] - df["Close"].shift()).abs()], axis=1).max(axis=1)
    return rma(tr, n)

def build_indicators(df):
    out = df.copy()
    close = out["Close"]
    out["ema9"] = ema(close, 9)
    out["ema21"] = ema(close, 21)
    out["ema50"] = ema(close, 50)
    out["atr"] = atr(out)
    out["atr_pct"] = out["atr"] / close * 100
    out["trend_bull"] = (out["ema9"] > out["ema21"]) & (out["ema21"] > out["ema50"])
    out["htf_bull"] = ema(close, 18) > ema(close, 42)
    return out

def generate_signals(df, ticker):
    signals = []
    df = build_indicators(df)
    daily_counts = {"C": 0, "P": 0}
    current_day = None

    for i in range(50, len(df)):
        row = df.iloc[i]
        ts = df.index[i]
        day = ts.date()
        hhmm = int(ts.strftime("%H%M"))

        if day != current_day:
            daily_counts = {"C": 0, "P": 0}
            current_day = day

        if hhmm < 945 or hhmm > 1400:
            continue
        if row["atr_pct"] < 0.20:
            continue

        score = 0
        if row["trend_bull"]: score += 25
        if row["htf_bull"]: score += 20
        if row["Close"] > row["ema9"]: score += 15
        if row["atr_pct"] > 0.3: score += 10
        if score < 50: continue   # loosened

        side = None
        if row["Close"] > df["High"].iloc[i-1] and row["trend_bull"] and daily_counts["C"] < 4:
            side = "C"
        elif row["Close"] < df["Low"].iloc[i-1] and not row["trend_bull"] and daily_counts["P"] < 5:
            side = "P"

        if side:
            signals.append({
                "signal_ts_et": ts,
                "symbol": ticker,
                "right": side,
                "score": score
            })
            daily_counts[side] += 1

    return signals

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--out", default="new_v2_signals.csv")
    args = parser.parse_args()

    all_signals = []
    print(f"Generating new_v2 signals for last {args.days} days (score 50)...")

    tickers = ["SPY", "QQQ", "IWM", "AAPL", "AMZN", "MSFT", "META", "NVDA", "GOOGL", "AVGO", "TSLA"]
    for ticker in tickers:
        try:
            df = yf.download(ticker, period=f"{args.days}d", interval="15m", progress=False)
            if df.empty: continue
            if isinstance(df.columns, pd.MultiIndex):
                df.columns = df.columns.get_level_values(0)
            sigs = generate_signals(df, ticker)
            all_signals.extend(sigs)
            print(f"  {ticker}: {len(sigs)} signals")
        except Exception as e:
            print(f"  {ticker}: error")

    df_out = pd.DataFrame(all_signals)
    df_out.to_csv(args.out, index=False)
    print(f"\nSaved {len(df_out)} signals → {args.out}")

if __name__ == "__main__":
    main()
