from ib_insync import IB, Future
from datetime import datetime, timedelta

ib = IB()
ib.connect('127.0.0.1', 4002, clientId=99, timeout=15)

contract = Future(symbol='MNQ', lastTradeDateOrContractMonth='20260918', exchange='CME', currency='USD')
ib.qualifyContracts(contract)

# Trades to check: (signal_ts UTC, direction, entry_price, exit_price, bars_held)
trades = [
    ('2026-01-15 01:30:00', 'short', 25575.50, 25571.75, 2),
    ('2026-02-19 01:00:00', 'long', 24976.00, 24994.00, 2),
    ('2026-04-06 22:20:00', 'short', 24313.75, 24302.75, 2),
    ('2026-05-04 00:05:00', 'long', 27863.75, 27865.25, 2),
    ('2026-06-08 19:10:00', 'short', 29429.00, 29387.25, 2),
]

for signal_ts_str, direction, entry, exit_px, bars_held in trades:
    signal_ts = datetime.strptime(signal_ts_str, '%Y-%m-%d %H:%M:%S')
    # trade window: from signal bar through however many 5-min bars it held
    start = signal_ts
    end = signal_ts + timedelta(minutes=5 * (bars_held + 1))

    start_str = start.strftime('%Y%m%d %H:%M:%S')
    print(f"\n=== {signal_ts_str} {direction} entry={entry} exit={exit_px} ===")
    try:
        ticks = ib.reqHistoricalTicks(
            contract, startDateTime=start_str, endDateTime='',
            numberOfTicks=1000, whatToShow='TRADES', useRth=False
        )
        # filter to just the trade window
        window_ticks = [t for t in ticks if start <= t.time.replace(tzinfo=None) <= end]
        if window_ticks:
            prices = [t.price for t in window_ticks]
            print(f"  Real tick range in window: low={min(prices)}, high={max(prices)}, n_ticks={len(window_ticks)}")
            print(f"  Backtest assumed: entry={entry}, exit={exit_px}")
        else:
            print("  No ticks found in window (may be outside available history or a quiet period)")
    except Exception as e:
        print(f"  ERROR: {e}")

ib.disconnect()
