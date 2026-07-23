from ib_insync import IB, Future

ib = IB()
try:
    ib.connect('127.0.0.1', 4002, clientId=99, timeout=15)
    contract = Future(symbol='MNQ', lastTradeDateOrContractMonth='20260918', exchange='CME', currency='USD')
    ib.qualifyContracts(contract)

    # Try a date far in the past — well before typical 6-month lookback limits
    test_dates = ['20260601 09:30:00', '20260101 09:30:00', '20250701 09:30:00']
    for dt in test_dates:
        try:
            ticks = ib.reqHistoricalTicks(contract, startDateTime=dt, endDateTime='',
                                            numberOfTicks=5, whatToShow='TRADES', useRth=False)
            print(f"{dt}: retrieved {len(ticks)} ticks" + (f", first={ticks[0].time}" if ticks else ""))
        except Exception as e:
            print(f"{dt}: ERROR - {e}")

except Exception as e:
    print(f"Connection ERROR: {e}")
finally:
    ib.disconnect()
