from ib_insync import IB, Option

ib = IB()
ib.connect('127.0.0.1', 4002, clientId=98, timeout=15)

try:
    for exch in ['CBOE', 'AMEX', 'ARCA', 'PHLX', 'BOX']:
        contract = Option(symbol='SPY', lastTradeDateOrContractMonth='20260629',
                           strike=740, right='C', exchange=exch, currency='USD')
        try:
            qualified = ib.qualifyContracts(contract)
            if qualified and qualified[0].conId:
                print(f"SUCCESS with exchange={exch}: {qualified[0]}")
                break
            else:
                print(f"exchange={exch}: qualified but no conId")
        except Exception as e:
            print(f"exchange={exch}: FAILED - {e}")
finally:
    ib.disconnect()
