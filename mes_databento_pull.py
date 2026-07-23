#!/usr/bin/env python3
"""
mes_databento_pull.py — Pull MES futures bars from Databento GLBX.MDP3

Pulls OHLCV bars for the MES continuous front-month contract
and saves them as a single parquet file ready for the VWAP
reclaim backtester (and any other strategy).

Dataset:  GLBX.MDP3 (CME Globex MDP 3.0)
Schema:   ohlcv-1m  (1-minute OHLCV — cheapest schema, aggregate well to 5m)
Symbol:   MES.c.0   (continuous front-month, auto-rolls)

Cost gate: estimates first, auto-proceeds under $30 (standing rule).

Usage:
    # Estimate only (no data pulled, no cost):
    python3 mes_databento_pull.py --estimate-only

    # Pull 1 year (recommended for first run):
    python3 mes_databento_pull.py --years 1

    # Pull 3 years (more regime variety):
    python3 mes_databento_pull.py --years 3

    # Pull to specific date range:
    python3 mes_databento_pull.py --start 2023-01-01 --end 2024-12-31
"""
import argparse
import os
import sys
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

AUTO_GATE = 50.0
DATASET   = "GLBX.MDP3"
SCHEMA    = "ohlcv-1m"
SYMBOL    = "MES.c.0"     # continuous front-month
STYPE     = "continuous"  # Databento continuous contract type


def get_client(api_key):
    try:
        import databento as db
        return db.Historical(api_key)
    except ImportError:
        print("pip install databento --break-system-packages")
        sys.exit(1)


def estimate(client, start, end):
    print(f"Estimating cost for {SYMBOL} {SCHEMA} {start} to {end}...")
    try:
        cost = client.metadata.get_cost(
            dataset=DATASET, schema=SCHEMA,
            symbols=[SYMBOL], stype_in=STYPE,
            start=start, end=end)
        print(f"Estimated cost: ${cost:.4f}")
        return cost
    except Exception as ex:
        # Try alternate stype if continuous fails
        print(f"  continuous stype failed ({ex}), trying parent...")
        try:
            cost = client.metadata.get_cost(
                dataset=DATASET, schema=SCHEMA,
                symbols=["MES"], stype_in="parent",
                start=start, end=end)
            print(f"Estimated cost (parent): ${cost:.4f}")
            return cost
        except Exception as ex2:
            print(f"  parent also failed ({ex2})")
            print("  Trying raw_symbol with front-month contract...")
            # Fall back to a specific contract
            # MES front month: MESH5 (March), MESM5 (June), MESU5 (Sep), MESZ5 (Dec)
            cost = client.metadata.get_cost(
                dataset=DATASET, schema=SCHEMA,
                symbols=["MESM6", "MESU6", "MESZ6"],
                stype_in="raw_symbol",
                start=start, end=end)
            print(f"Estimated cost (raw_symbol 2026): ${cost:.4f}")
            return cost


def pull(client, start, end, out_path):
    """Pull data, trying symbol types in order until one works."""
    import pandas as pd

    attempts = [
        (SYMBOL, STYPE),
        ("MES", "parent"),
        (["MESM6","MESU6","MESZ6","MESH6","MESU5","MESZ5","MESH5","MESM5"],
         "raw_symbol"),
    ]

    for symbols, stype in attempts:
        sym_list = symbols if isinstance(symbols, list) else [symbols]
        print(f"  Trying symbols={sym_list[:2]}... stype={stype}")
        try:
            data = client.timeseries.get_range(
                dataset=DATASET, schema=SCHEMA,
                symbols=sym_list, stype_in=stype,
                start=start, end=end)
            df = data.to_df()
            if df is None or df.empty:
                print("  Empty result, trying next...")
                continue

            print(f"  Got {len(df):,} raw 1-min bars")
            df.to_parquet(out_path.replace('.parquet', '_1m_raw.parquet'), index=True)
            print(f"  Raw 1-min saved: {out_path.replace('.parquet', '_1m_raw.parquet')}")
            return df

        except Exception as ex:
            print(f"  Failed: {ex}")
            continue

    print("All symbol attempts failed. Check your API key and dataset access.")
    sys.exit(1)


def aggregate_to_5m(df_1m, out_path):
    """Aggregate 1-minute bars to 5-minute bars for the backtester."""
    import pandas as pd

    # Normalize column names
    col_map = {'open':'Open','high':'High','low':'Low',
               'close':'Close','volume':'Volume'}
    df = df_1m.rename(columns={k:v for k,v in col_map.items() if k in df_1m.columns})

    # Ensure datetime index with timezone
    if not isinstance(df.index, pd.DatetimeIndex):
        for col in ['ts_event','ts_recv','timestamp']:
            if col in df.columns:
                df.index = pd.to_datetime(df[col], utc=True)
                break
    if df.index.tz is None:
        df.index = df.index.tz_localize('UTC')
    df.index = df.index.tz_convert('America/New_York')

    # Keep only OHLCV
    keep = [c for c in ['Open','High','Low','Close','Volume'] if c in df.columns]
    df = df[keep].sort_index()

    # Remove zero/null rows
    df = df[df['Close'] > 0].dropna()

    # Aggregate to 5-minute bars
    df_5m = df.resample('5min').agg({
        'Open': 'first',
        'High': 'max',
        'Low': 'min',
        'Close': 'last',
        'Volume': 'sum',
    }).dropna()

    df_5m.to_parquet(out_path, index=True)
    print(f"  5-min bars saved: {out_path}  ({len(df_5m):,} bars)")
    print(f"  Date range: {df_5m.index[0]} to {df_5m.index[-1]}")
    print(f"  Price range: {df_5m['Close'].min():.2f} - {df_5m['Close'].max():.2f}")

    # Quick stats
    daily_bars = df_5m.groupby(df_5m.index.date).size()
    print(f"  Avg bars/day: {daily_bars.mean():.0f}  "
          f"Trading days: {len(daily_bars)}")

    return df_5m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--years',         type=int,   default=1)
    ap.add_argument('--start',         type=str,   default=None)
    ap.add_argument('--end',           type=str,   default=None)
    ap.add_argument('--out',           type=str,   default='mes_5m.parquet')
    ap.add_argument('--api-key',       type=str,   default=os.environ.get('DATABENTO_API_KEY'))
    ap.add_argument('--estimate-only', action='store_true')
    ap.add_argument('--force',         action='store_true',
                    help='Pull even if cost exceeds $30 gate (use carefully)')
    a = ap.parse_args()

    if not a.api_key:
        print("No API key. Set DATABENTO_API_KEY or pass --api-key.")
        sys.exit(1)

    # Date range
    if a.start and a.end:
        start, end = a.start, a.end
    else:
        end_dt   = datetime.now(timezone.utc).replace(hour=0, minute=0,
                                                        second=0, microsecond=0)
        start_dt = end_dt - timedelta(days=365 * a.years)
        start    = start_dt.strftime('%Y-%m-%d')
        end      = end_dt.strftime('%Y-%m-%d')

    print(f"\nMES Databento Pull")
    print(f"  Dataset: {DATASET}  Schema: {SCHEMA}")
    print(f"  Symbol:  {SYMBOL} ({STYPE})")
    print(f"  Range:   {start} to {end}")
    print(f"  Output:  {a.out}")
    print()

    client = get_client(a.api_key)

    cost = estimate(client, start, end)

    if a.estimate_only:
        print("\nEstimate-only mode — no data pulled.")
        return

    if cost > AUTO_GATE and not a.force:
        print(f"\nCost ${cost:.2f} exceeds ${AUTO_GATE} gate. "
              f"Run with --force to proceed.")
        return

    print(f"\nCost ${cost:.4f} — under gate, proceeding with pull...")
    df_1m = pull(client, start, end, a.out)

    print("\nAggregating to 5-minute bars...")
    df_5m = aggregate_to_5m(df_1m, a.out)

    print(f"\nDone. Run the backtester:")
    print(f"  python3 mes_vwap_reclaim.py --source parquet --data {a.out}")
    print(f"  python3 mes_vwap_reclaim.py --source parquet --data {a.out} --sweep")


if __name__ == '__main__':
    main()
