from ib_insync import IB, Future
from datetime import datetime, timedelta

ib = IB()
ib.connect('127.0.0.1', 4002, clientId=99, timeout=15)

contract = Future(symbol='MNQ', lastTradeDateOrContractMonth='20260918', exchange='CME', currency='USD')
ib.qualifyContracts(contract)

trades = [
    ('2026-06-30 12:00:00', 10, 'short', 30102.50, 30083.50),
    ('2026-07-07 05:30:00', 10, 'long', 29628.75, 29665.00),
    ('2026-07-13 05:05:00', 10, 'long', 29672.75, 29692.75),
]

for entry_ts_str, bars_min, direction, entry, exit_px in trades:
    entry_ts = datetime.strptime(entry_ts_str, '%Y-%m-%d %H:%M:%S')
    exit_ts = entry_ts + timedelta(minutes=bars_min)

    print(f"\n=== {entry_ts_str} {direction} | backtest entry={entry} exit={exit_px} ===")
    try:
        # much smaller request: just 100 ticks starting right at entry time
        ticks = ib.reqHistoricalTicks(
            contract, startDateTime=entry_ts.strftime('%Y%m%d %H:%M:%S'),
            endDateTime='', numberOfTicks=100, whatToShow='TRADES', useRth=False
        )
        if not ticks:
            print("  No ticks returned")
            continue

        def closest_tick(target_ts):
            return min(ticks, key=lambda t: abs((t.time.replace(tzinfo=None) - target_ts).total_seconds()))

        entry_tick = closest_tick(entry_ts)
        exit_tick = closest_tick(exit_ts)

        entry_time_gap = abs((entry_tick.time.replace(tzinfo=None) - entry_ts).total_seconds())
        exit_time_gap = abs((exit_tick.time.replace(tzinfo=None) - exit_ts).total_seconds())

        print(f"  Tick range covers: {ticks[0].time} to {ticks[-1].time}")
        print(f"  Closest tick to ENTRY ({entry_time_gap:.0f}s away): price={entry_tick.price} vs backtest {entry} -> diff {abs(entry_tick.price-entry):.2f}pts")
        print(f"  Closest tick to EXIT  ({exit_time_gap:.0f}s away): price={exit_tick.price} vs backtest {exit_px} -> diff {abs(exit_tick.price-exit_px):.2f}pts")
    except Exception as e:
        print(f"  ERROR: {e}")

ib.disconnect()
