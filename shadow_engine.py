#!/usr/bin/env python3
"""
Shadow Engine — the TradingView-replacement proving phase
===========================================================

Runs the ported signal engines (live assignment: Scout on SPY/QQQ/IWM,
Options Prime autocal on single names) against fresh bars every 15
minutes, and appends every would-be signal to shadow_signals.jsonl.
It places NO orders and sends NO webhooks — pure observation, so it can
run alongside the live TradingView pipeline indefinitely.

After ~2 weeks, comparing shadow_signals.jsonl against mfe.jsonl (and
the TV alert log) measures real-feed agreement — the go/no-go number
for retiring TradingView. Yahoo-feed fidelity ceiling was ~82%; IBKR
bars should land meaningfully higher.

Data source:
  --source ibkr     (default) 15-min TRADES bars from the local IB
                     Gateway, clientId 42, read-only historical requests
  --source yfinance fallback for testing the loop without touching IBKR

Modes:
  --once   run one evaluation cycle now and exit (testing)
  --loop   run forever: wake ~25s after each quarter-hour close during
           RTH, evaluate, sleep. Intended to live under pm2:
           pm2 start "python3 shadow_engine.py --loop" --name shadow-engine

Reuses the exact engine code from signal_backtest.py (same directory) —
one implementation, zero drift between backtest and shadow.
"""
import argparse
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import signal_backtest as sb

# Deployed chart configs (matched during fidelity work)
sb.OR_MINUTES = 15
sb.SESSION_START = 945
sb.SCORE_THRESHOLD = 45
sb.DAILY_MAX = {"C": 4, "P": 5}

ET = ZoneInfo("America/New_York")
TICKERS = ["SPY", "QQQ", "IWM", "AAPL", "AMZN", "MSFT", "META", "NVDA", "GOOGL", "AVGO", "TSLA"]
ETFS = {"SPY", "QQQ", "IWM"}
SHADOW_LOG = "shadow_signals.jsonl"
IBKR_HOST, IBKR_PORT, IBKR_CLIENT_ID = "127.0.0.1", 4002, 42


def fetch_bars_yf(tickers, days=15):
    import yfinance as yf
    end = datetime.now(timezone.utc) + timedelta(days=1)
    start = end - timedelta(days=days)
    bars = {}
    for t in tickers:
        df = yf.download(t, interval="15m", start=start.date().isoformat(),
                          end=end.date().isoformat(), progress=False,
                          prepost=False, auto_adjust=False)
        if df.empty:
            continue
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)
        df.index = df.index.tz_convert("America/New_York")
        bars[t] = df
    return bars


def fetch_bars_ibkr(tickers, days=15):
    from ib_insync import IB, Stock, util
    ib = IB()
    ib.connect(IBKR_HOST, IBKR_PORT, clientId=IBKR_CLIENT_ID, timeout=20)
    bars = {}
    try:
        for t in tickers:
            contract = Stock(t, "SMART", "USD")
            raw = ib.reqHistoricalData(
                contract, endDateTime="", durationStr=f"{days} D",
                barSizeSetting="15 mins", whatToShow="TRADES",
                useRTH=True, formatDate=2)
            if not raw:
                continue
            df = util.df(raw)
            df = df.rename(columns={"open": "Open", "high": "High", "low": "Low",
                                     "close": "Close", "volume": "Volume"})
            df["date"] = pd.to_datetime(df["date"], utc=True)
            df = df.set_index("date")[["Open", "High", "Low", "Close", "Volume"]]
            df.index = df.index.tz_convert("America/New_York")
            bars[t] = df
    finally:
        ib.disconnect()
    return bars


def load_seen():
    seen = set()
    p = Path(SHADOW_LOG)
    if p.exists():
        for line in p.open():
            try:
                r = json.loads(line)
                seen.add((r["signal_ts_et"], r["symbol"], r["side"]))
            except Exception:
                continue
    return seen


def evaluate_cycle(source):
    fetch = fetch_bars_ibkr if source == "ibkr" else fetch_bars_yf
    try:
        bars = fetch(TICKERS)
    except Exception as ex:
        print(f"[{datetime.now(ET).isoformat()}] bar fetch FAILED ({source}): {ex}", flush=True)
        return

    etf_bars = {s: b for s, b in bars.items() if s in ETFS}
    stock_bars = {s: b for s, b in bars.items() if s not in ETFS}

    frames = []
    if etf_bars:
        g = sb.generate_signals(etf_bars)
        if len(g):
            g["engine"] = "scout"
            frames.append(g)
    if stock_bars:
        g = sb.generate_signals_prime(stock_bars)
        if len(g):
            frames.append(g)
    if not frames:
        print(f"[{datetime.now(ET).isoformat()}] cycle done — no signals in window", flush=True)
        return

    gen = pd.concat(frames)
    # Only emit signals from the most recent bar close (fresh this cycle)
    now_et = datetime.now(ET)
    cutoff = now_et - timedelta(minutes=16)
    seen = load_seen()
    emitted = 0
    with open(SHADOW_LOG, "a") as f:
        for _, s in gen.iterrows():
            ts = datetime.fromisoformat(s["signal_ts_et"])
            if ts < cutoff:
                continue
            key = (s["signal_ts_et"], s["symbol"], s["side"])
            if key in seen:
                continue
            rec = {
                "logged_at": now_et.isoformat(),
                "signal_ts_et": s["signal_ts_et"],
                "symbol": s["symbol"], "side": s["side"],
                "engine": s.get("engine", "prime"),
                "score": int(s["score"]),
                "underlying_close": float(s["underlying_close"]),
                "source": source,
            }
            f.write(json.dumps(rec) + "\n")
            emitted += 1
    print(f"[{now_et.isoformat()}] cycle done — {emitted} new shadow signal(s)", flush=True)


def next_wake(now_et):
    """~25s after the next quarter-hour, RTH only (9:45-16:00 ET weekdays)."""
    q = (now_et.minute // 15 + 1) * 15
    nxt = now_et.replace(minute=0, second=25, microsecond=0) + timedelta(minutes=q)
    # Outside RTH -> next trading morning 10:00:25 ET (first bar close after 9:45 open)
    if nxt.hour >= 16 or now_et.weekday() >= 5 or (nxt.hour < 10 and not (nxt.hour == 10 and nxt.minute == 0)):
        d = now_et.date()
        add = 1
        while True:
            cand = d + timedelta(days=add)
            if cand.weekday() < 5:
                break
            add += 1
        if now_et.weekday() < 5 and now_et.hour < 10:
            cand = d
        nxt = datetime(cand.year, cand.month, cand.day, 10, 0, 25, tzinfo=ET)
    return nxt


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["ibkr", "yfinance"], default="ibkr")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--loop", action="store_true")
    a = ap.parse_args()

    if a.once:
        evaluate_cycle(a.source)
        return
    if not a.loop:
        print("Pass --once (test) or --loop (daemon).", file=sys.stderr)
        sys.exit(1)

    print(f"Shadow engine starting — source={a.source}, log={SHADOW_LOG}", flush=True)
    while True:
        now = datetime.now(ET)
        wake = next_wake(now)
        sleep_s = max(5, (wake - now).total_seconds())
        time.sleep(sleep_s)
        evaluate_cycle(a.source)


if __name__ == "__main__":
    main()
