from ib_insync import IB, Future

ib = IB()
ib.connect('127.0.0.1', 4002, clientId=99, timeout=15)

# Try the contracts CME lists for MNQ: current + next few in the quarterly cycle
candidate_expiries = ['20260618', '20260918', '20261218', '20270319']

for expiry in candidate_expiries:
    contract = Future(symbol='MNQ', lastTradeDateOrContractMonth=expiry, exchange='CME', currency='USD')
    try:
        ib.qualifyContracts(contract)
        print(f"Expiry {expiry}: QUERYABLE, localSymbol={contract.localSymbol}, conId={contract.conId}")
    except Exception as e:
        print(f"Expiry {expiry}: NOT queryable - {e}")

ib.disconnect()
