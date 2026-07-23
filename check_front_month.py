from ib_insync import IB, Future
from datetime import datetime

ib = IB()
ib.connect('127.0.0.1', 4002, clientId=99, timeout=15)

# CME MNQ quarterly cycle: Mar, Jun, Sep, Dec
# Check which contract was likely front-month for our test dates
test_dates_and_expiries = [
    ('2026-01-15', '20260320'),  # March 2026 contract likely front-month in Jan
    ('2026-02-19', '20260320'),
    ('2026-04-06', '20260618'),  # June 2026 contract likely front-month in April
    ('2026-05-04', '20260618'),
    ('2026-06-08', '20260618'),
]

for date_str, expiry in test_dates_and_expiries:
    contract = Future(symbol='MNQ', lastTradeDateOrContractMonth=expiry, exchange='CME', currency='USD')
    try:
        ib.qualifyContracts(contract)
        # pull just 1 tick near that date to see the price level
        ticks = ib.reqHistoricalTicks(
            contract, startDateTime=date_str.replace('-','') + ' 12:00:00',
            endDateTime='', numberOfTicks=2, whatToShow='TRADES', useRth=False
        )
        price = ticks[0].price if ticks else None
        print(f"{date_str} using expiry {expiry}: contract={contract.localSymbol}, sample price={price}")
    except Exception as e:
        print(f"{date_str} using expiry {expiry}: ERROR - {e}")

ib.disconnect()
