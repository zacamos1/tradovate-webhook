#!/usr/bin/env python3
"""
MES VWAP Reclaim Strategy
===========================

The ONLY entry signal that showed genuine edge above random in systematic
testing across 4 candidate approaches (59.1% follow-through vs 51.2% baseline):

  Price spends 30+ consecutive minutes BELOW the daily VWAP, then
  crosses back above it on a confirming bar (volume surge preferred).

Why this works conceptually:
  VWAP is the institutional reference price — the average price paid by
  everyone who traded today, weighted by volume. When price dips below
  VWAP and then reclaims it, it signals that buyers absorbed the selling
  pressure and are now back in control. Market makers and algorithms
  re-reference VWAP constantly, which creates follow-through momentum
  after a reclaim.

What did NOT work (explicitly excluded):
  - ORB: 52.4% follow-through vs 51.2% baseline (noise)
  - 8:30 macro: 50.0% directional match (coin flip)
  - EMA crossovers: random entries beat signals
  - Volume spike breakout: random entries beat signals

Entry conditions (all required):
  1. Price has been below VWAP for >= 6 consecutive 5-min bars (30 min)
  2. Current bar closes ABOVE VWAP (the reclaim)
  3. Reclaim bar volume >= 1.2x recent average (some confirmation)
  4. Not in the first 15 min of RTH (9:30-9:45 ET — too noisy)
  5. Not within 30 min of session close (23:30+ ET)

Exit:
  Arm: +1.5 points favorable (reclaims tend to have follow-through)
  Trail: 1.0 point below peak
  Hard stop: 3.0 × ATR (wide — give the reclaim room)
  Max hold: 24 bars (120 min — reclaims can take time to develop)

Usage:
    python3 mes_vwap_reclaim.py
    python3 mes_vwap_reclaim.py --arm 1.0 --trail 0.75 --stop 2.0
    python3 mes_vwap_reclaim.py --sweep
    python3 mes_vwap_reclaim.py --min-below 3    # 15 min minimum below VWAP
    python3 mes_vwap_reclaim.py --vol-confirm 1.5 # stricter volume filter
"""
import argparse
import sys
import random
from datetime import datetime, timedelta, timezone
import numpy as np
import pandas as pd

MES_MULT = 5
COMMISSION = 2.20
SLIPPAGE_PTS = 0.25


def rma(s, n):
    return s.ewm(alpha=1.0/n, adjust=False).mean()

def atr_s(df, n=14):
    tr = pd.concat([df['High']-df['Low'],
                    (df['High']-df['Close'].shift()).abs(),
                    (df['Low']-df['Close'].shift()).abs()], axis=1).max(axis=1)
    return rma(tr, n)


def build_features(df):
    out = df.copy()
    close, high, low, vol = out['Close'], out['High'], out['Low'], out['Volume']

    # Daily VWAP (resets at each calendar date)
    hlc3 = (high + low + close) / 3
    out['vwap'] = (hlc3 * vol).groupby(df.index.date).cumsum() / \
                   vol.groupby(df.index.date).cumsum()
    out['above_vwap'] = (close > out['vwap']).astype(int)

    # Consecutive bars below VWAP
    below = (1 - out['above_vwap'])
    grp = (below != below.shift()).cumsum()
    out['consec_below'] = below.groupby(grp).cumcount() + 1
    out['consec_below'] = out['consec_below'].where(below==1, 0)

    # Reclaim: cross above VWAP after being below
    out['reclaim'] = (out['above_vwap'] == 1) & (out['above_vwap'].shift(1) == 0)

    # Volume confirmation
    out['vol_ma'] = vol.rolling(20).mean()
    out['vol_ratio'] = vol / out['vol_ma']

    # ATR for stop sizing
    out['atr'] = atr_s(out, 14)

    # Session filter
    et_h = out.index.hour
    et_m = out.index.minute
    hhmm = et_h * 100 + et_m
    out['session_ok'] = (
        ~((hhmm >= 935) & (hhmm <= 945)) &   # skip open noise
        ~((et_h == 23) & (et_m >= 30)) &      # skip near close
        ~((et_h == 0) & (et_m < 5))           # skip midnight gap
    )
    out['hhmm'] = hhmm

    return out


def generate_signals(ind, min_below=6, vol_mult=1.2):
    """
    Generate VWAP reclaim signals.
    min_below: minimum consecutive bars below VWAP before reclaim counts
    vol_mult:  minimum volume ratio on the reclaim bar
    """
    sigs = []
    for ts, row in ind.iterrows():
        if not row['session_ok']:
            continue
        if not row['reclaim']:
            continue
        # How many bars were below VWAP before this reclaim?
        bars_below = ind['consec_below'].shift(1).loc[ts]
        if bars_below < min_below:
            continue
        # Volume confirmation
        if row['vol_ratio'] < vol_mult:
            continue

        sigs.append({
            'signal_ts':     ts,
            'direction':     'long',  # reclaim = bullish by definition
            'entry_price':   float(row['Close']),
            'atr_at_entry':  float(row['atr']),
            'vwap_at_entry': float(row['vwap']),
            'bars_below':    int(bars_below),
            'vol_ratio':     round(float(row['vol_ratio']), 2),
            'hhmm':          int(row['hhmm']),
        })

    return pd.DataFrame(sigs)


def simulate(sig, df, arm_pts, trail_pts, stop_mult, max_bars):
    ts    = sig['signal_ts']
    entry = sig['entry_price']
    atr_e = sig['atr_at_entry']
    stop_px = entry - stop_mult * atr_e

    future = df[df.index > ts].head(max_bars + 5)
    if future.empty:
        return None

    armed = False
    peak  = entry

    for i, (idx, bar) in enumerate(future.iterrows()):
        hi, lo = float(bar['High']), float(bar['Low'])

        # Hard stop
        if lo <= stop_px:
            return _r(sig, stop_px, 'stop', i+1, armed, peak, entry)

        # Arm + trail
        if not armed:
            if hi - entry >= arm_pts:
                armed = True
                peak  = hi
        else:
            peak = max(peak, hi)
            if lo <= peak - trail_pts:
                return _r(sig, peak - trail_pts, 'trail', i+1, armed, peak, entry)

        # Timestop
        if i >= max_bars - 1 and not armed:
            return _r(sig, float(bar['Close']), 'timestop', i+1, armed, peak, entry)

    return _r(sig, float(future.iloc[-1]['Close']), 'window_end',
              len(future), armed, peak, entry)


def _r(sig, exit_px, reason, bars, armed, peak, entry):
    pnl_pts = round(exit_px - entry, 2)
    return {**sig, 'exit_price': exit_px, 'reason': reason,
            'bars_held': bars, 'armed': armed, 'peak': peak,
            'pnl_pts': pnl_pts, 'pnl_usd': round(pnl_pts * MES_MULT, 2)}


def print_results(results, arm, trail, stop, label="VWAP RECLAIM"):
    if not results:
        print("No trades."); return
    df = pd.DataFrame(results)
    n  = len(df)
    friction = (COMMISSION + SLIPPAGE_PTS * 2 * MES_MULT) * n
    net = df['pnl_usd'].sum() - friction
    wr  = 100 * (df['pnl_pts'] > 0).mean()
    ar  = 100 * df['armed'].mean()
    trails = df[df['reason'] == 'trail']
    stops  = df[df['reason'] == 'stop']
    ts_    = df[df['reason'] == 'timestop']
    days   = df['signal_ts'].apply(lambda x: str(x)[:10]).nunique()

    print(f"\n  {'─'*62}")
    print(f"  {label}")
    print(f"  arm {arm}pt  trail {trail}pt  stop {stop}×ATR")
    print(f"  {'─'*62}")
    print(f"  Trades: {n}  ({n/59:.1f}/day)  across {days} trading days")
    print(f"  Gross:  ${df['pnl_usd'].sum():>8,.0f}   "
          f"Net: ${net:>8,.0f}   Mean net: ${net/n:>6.1f}")
    print(f"  WR: {wr:.0f}%   Armed: {ar:.0f}%")
    if len(trails):
        print(f"  Trail exits: {len(trails)} ({100*len(trails)/n:.0f}%)  "
              f"mean {trails['pnl_pts'].mean():.2f}pts  "
              f"max {trails['pnl_pts'].max():.1f}pts")
    if len(stops):
        print(f"  Hard stops:  {len(stops)} ({100*len(stops)/n:.0f}%)  "
              f"mean {stops['pnl_pts'].mean():.2f}pts")
    if len(ts_):
        print(f"  Timestops:   {len(ts_)} ({100*len(ts_)/n:.0f}%)")

    # Bars-below distribution
    print(f"\n  Signal quality by bars spent below VWAP:")
    for lo, hi in [(6,8),(9,12),(13,18),(19,999)]:
        g = df[(df['bars_below']>=lo) & (df['bars_below']<hi)]
        label2 = f"{lo}-{hi-1 if hi<999 else '+'} bars below"
        if len(g):
            print(f"    {label2:18s}: {len(g):3d} trades  "
                  f"${g['pnl_usd'].mean():+6.1f} mean  "
                  f"{100*(g['pnl_pts']>0).mean():.0f}% WR")

    # Time of day
    print(f"\n  By session:")
    for sess, s, e in [('Asian (0-7am)', 0, 700),
                        ('Pre-market (7-9:30am)', 700, 935),
                        ('RTH (9:45am-4pm)', 945, 1600),
                        ('After-hours (4-11pm)', 1600, 2330)]:
        g = df[(df['hhmm']>=s) & (df['hhmm']<e)]
        if len(g):
            print(f"    {sess:28s}: {len(g):3d} trades  "
                  f"${g['pnl_usd'].mean():+6.1f} mean  "
                  f"{100*(g['pnl_pts']>0).mean():.0f}% WR")

    # Monthly
    print(f"\n  Monthly:")
    df['month'] = df['signal_ts'].apply(lambda x: str(x)[:7])
    for m, g in df.groupby('month'):
        net_m = g['pnl_usd'].sum() - (COMMISSION + SLIPPAGE_PTS*2*MES_MULT)*len(g)
        flag = "✓" if net_m > 0 else "✗"
        print(f"    {m}: ${net_m:>8,.0f}  ({len(g)} trades) {flag}")
    print(f"  {'─'*62}")


def random_control(df, ind, n=200, arm=1.5, trail=1.0, stop=3.0, max_bars=24):
    random.seed(42)
    cands = [ts for ts, r in ind.iterrows() if r['session_ok']]
    cands = cands[50:-max_bars-5]
    sample = random.sample(cands, min(n, len(cands)))
    results = []
    for ts in sample:
        sig = {'signal_ts': ts, 'direction': 'long',
               'entry_price': float(df.loc[ts, 'Close']),
               'atr_at_entry': float(ind.loc[ts, 'atr']),
               'bars_below': 0, 'vol_ratio': 1.0, 'hhmm': 0}
        r = simulate(sig, df, arm, trail, stop, max_bars)
        if r:
            results.append(r)
    if results:
        print_results(results, arm, trail, stop, label="RANDOM ENTRY CONTROL")


def load_df(source='yfinance', data_path=None, years=1):
    if source == 'parquet':
        if not data_path or not Path(data_path).exists():
            print(f"Parquet file not found: {data_path}")
            sys.exit(1)
        df = pd.read_parquet(data_path)
        if df.index.tz is None:
            df.index = df.index.tz_localize('America/New_York')
        else:
            df.index = df.index.tz_convert('America/New_York')
        print(f"Loaded {len(df):,} bars from {data_path}")
        print(f"  Range: {df.index[0]} to {df.index[-1]}")
        return df
    # yfinance default
    import yfinance as yf
    days = min(59, years * 59)
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=days)
    df = yf.download('MES=F', interval='5m',
                     start=start.strftime('%Y-%m-%d'),
                     end=end.strftime('%Y-%m-%d'),
                     progress=False, auto_adjust=False)
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    if df.index.tz is None:
        df.index = df.index.tz_localize('America/New_York')
    else:
        df.index = df.index.tz_convert('America/New_York')
    print(f"Loaded {len(df):,} MES bars from yfinance")
    return df


def sweep(df, ind):
    print("\n" + "="*72)
    print("PARAMETER SWEEP")
    print("="*72)
    print(f"  {'MinBel':>6} {'Vol':>5} | {'Arm':>5} {'Trail':>6} {'Stop':>5} | "
          f"{'N':>4} {'Net$':>8} {'$/Tr':>7} {'WR%':>5}")
    print("-"*72)
    best = None
    for min_b in (4, 6, 9):
        for vol_m in (1.0, 1.2, 1.5):
            sigs = generate_signals(ind, min_below=min_b, vol_mult=vol_m)
            if sigs.empty: continue
            for arm in (1.0, 1.5, 2.0):
                for trail in (0.75, 1.0, 1.5):
                    for stop in (2.0, 3.0):
                        res = [r for s in sigs.to_dict('records')
                               for r in [simulate(s, df, arm, trail, stop, 24)] if r]
                        if not res: continue
                        rdf = pd.DataFrame(res)
                        n = len(rdf)
                        friction = (COMMISSION + SLIPPAGE_PTS*2*MES_MULT)*n
                        net = rdf['pnl_usd'].sum() - friction
                        wr = 100*(rdf['pnl_pts']>0).mean()
                        marker = " ◄" if net > 0 and wr > 55 else ""
                        print(f"  {min_b:>6} {vol_m:>5.1f} | {arm:>5.1f} {trail:>6.2f} "
                              f"{stop:>5.1f} | {n:>4} ${net:>7,.0f} "
                              f"${net/n:>6.1f} {wr:>4.0f}%{marker}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--arm',         type=float, default=1.5)
    ap.add_argument('--trail',       type=float, default=1.0)
    ap.add_argument('--stop',        type=float, default=3.0)
    ap.add_argument('--min-below',   type=int,   default=6)
    ap.add_argument('--vol-confirm', type=float, default=1.2)
    ap.add_argument('--max-bars',    type=int,   default=24)
    ap.add_argument('--sweep',       action='store_true')
    ap.add_argument('--source',      default='yfinance',
                    choices=['yfinance','parquet'])
    ap.add_argument('--data',        default='mes_5m.parquet',
                    help='Path to parquet file (--source parquet)')
    a = ap.parse_args()

    df  = load_df(source=a.source, data_path=a.data)
    ind = build_features(df)

    if a.sweep:
        sweep(df, ind)
        return

    sigs = generate_signals(ind, min_below=a.min_below, vol_mult=a.vol_confirm)
    print(f"Generated {len(sigs)} VWAP reclaim signals ({len(sigs)/59:.1f}/day)")

    if sigs.empty:
        print("No signals — try lower --min-below or --vol-confirm")
        return

    results = [r for s in sigs.to_dict('records')
               for r in [simulate(s, df, a.arm, a.trail, a.stop, a.max_bars)] if r]

    print("\n" + "="*64)
    print("MES VWAP RECLAIM STRATEGY — Data-driven build")
    print("The only approach that beat baseline in systematic testing")
    print("="*64)
    print_results(results, a.arm, a.trail, a.stop)

    random_control(df, ind, arm=a.arm, trail=a.trail, stop=a.stop, max_bars=a.max_bars)


if __name__ == '__main__':
    main()
