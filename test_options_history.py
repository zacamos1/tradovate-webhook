from ib_insync import IB, Option

ib = IB()
ib.connect('127.0.0.1', 4002, clientId=98, timeout=15)

try:
    # SPY 740 Call, expiry 2026-06-29 (from mfe.jsonl trade 0)
    contract = Option(symbol='SPY', lastTradeDateOrContractMonth='20260629',
                       strike=740, right='C', exchange='SMART', currency='USD')
    ib.qualifyContracts(contract)
    print(f"Qualified contract: {contract}")

    bars = ib.reqHistoricalData(
        contract,
        endDateTime='20260629 23:59:59',
        durationStr='1 D',
        barSizeSetting='1 min',
        whatToShow='TRADES',
        useRTH=False
    )
    print(f"Retrieved {len(bars)} 1-min bars.")
    if bars:
        print("First bar:", bars[0])
        print("Last bar:", bars[-1])
except Exception as e:
    print(f"ERROR: {e}")
finally:
    ib.disconnect()
