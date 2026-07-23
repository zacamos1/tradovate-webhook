from ib_insync import IB, Future
import sys

ib = IB()
try:
    ib.connect('127.0.0.1', 4002, clientId=99, timeout=15)
    print("Connected to IBKR Gateway successfully.")

    # Test with MNQ continuous front-month
    contract = Future('MNQ', exchange='CME')
    ib.qualifyContracts(contract)
    print(f"Qualified contract: {contract}")

    # Pull a small sample of historical ticks — just 100 ticks from a recent date
    ticks = ib.reqHistoricalTicks(
        contract,
        startDateTime='20260501 09:30:00',
        endDateTime='',
        numberOfTicks=100,
        whatToShow='TRADES',
        useRth=False
    )
    print(f"Retrieved {len(ticks)} ticks.")
    if ticks:
        print("First tick:", ticks[0])
        print("Last tick:", ticks[-1])

except Exception as e:
    print(f"ERROR: {e}")
finally:
    ib.disconnect()
    print("Disconnected.")
