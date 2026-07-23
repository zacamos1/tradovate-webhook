from ib_insync import IB, Future
from datetime import datetime, timedelta

ib = IB()
ib.connect('127.0.0.1', 4002, clientId=99, timeout=15)

contract = Future(symbol='MNQ', lastTradeDateOrContractMonth='20260918', exchange='CME', currency='USD')
ib.qualifyContracts(contract)

trades = [
    ('2026-06-15 12:30:00', 'short', 30255.50, 30248.00, 2),
    ('2026-06-23 13:55:00', 'long', 29926.00, 30003.25, 2),
    ('2026-06-30 12:00:00', 'short', 30102.50, 30083.50, 2),
    ('2026-07-07 05:30:00', 'long', 29628.75, 29665.00, 2),
    ('2026-07-13 05:05:00', 'long', 29672.75, 29692.75, 2),
]

for signal_ts_str, direction, entry, exit_px, bars_held in trades:
    signal_ts = datetime.strptime(signal_ts_str, '%Y-%m-%d %H:%M:%S')
    end = signal_ts + timedelta(minutes=5 * (bars_held + 1))
    start_str = signal_ts.strftime('%Y%m%d %H:%M:%S')

    print(f"\n=== {signal_ts_str} {direction} | backtest entry={entry} exit={exit_px} ===")
    try:
        ticks = ib.reqHistoricalTicks(
            contract, startDateTime=start_str, endDateTime='',
            numberOfTicks=1000, whatToShow='TRADES', useRth=False
        )
        window_ticks = [t for t in ticks if signal_ts <= t.time.replace(tzinfo=None) <= end]
        if window_ticks:
            prices = [t.price for t in window_ticks]
            print(f"  REAL tick range: low={min(prices)}, high={max(prices)}, n_ticks={len(window_ticks)}")
            entry_diff = abs(min(prices, key=lambda p: abs(p-entry)) - entry)
            exit_diff = abs(min(prices, key=lambda p: abs(p-exit_px)) - exit_px)
            print(f"  Closest real tick to backtest entry: within {entry_diff:.2f}pts")
            print(f"  Closest real tick to backtest exit:  within {exit_diff:.2f}pts")
        else:
            print("  No ticks found in window")
    except Exception as e:
        print(f"  ERROR: {e}")

ib.disconnect()
