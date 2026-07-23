from ib_insync import IB, Future

ib = IB()
try:
    ib.connect('127.0.0.1', 4002, clientId=99, timeout=15)
    print("Connected to IBKR Gateway successfully.")

    # Use the specific front-month contract found in the ambiguity error: MNQU6 (Sept 2026)
    contract = Future(symbol='MNQ', lastTradeDateOrContractMonth='20260918', exchange='CME', currency='USD')
    ib.qualifyContracts(contract)
    print(f"Qualified contract: {contract}")

    ticks = ib.reqHistoricalTicks(
        contract,
        startDateTime='20260701 09:30:00',
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
