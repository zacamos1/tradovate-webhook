#!/usr/bin/env python3
"""
probe_ibkr_mrut.py

Checks whether IBKR Gateway can serve historical bars for MRUT
(Cboe Micro Russell 2000 Index) using the existing ib_insync connection.
Run on the trading VPS where the Gateway is already running.

Usage:
    python3 probe_ibkr_mrut.py
"""
from ib_insync import IB, Index, Stock, CFD, util
import pandas as pd

IBKR_HOST = '127.0.0.1'
IBKR_PORT = 4002  # paper gateway — adjust if different
CLIENT_ID = 43    # different from shadow engine (42) to avoid conflict

def try_contract(ib, contract, desc):
    try:
        bars = ib.reqHistoricalData(
            contract, endDateTime='', durationStr='5 D',
            barSizeSetting='15 mins', whatToShow='TRADES',
            useRTH=True, formatDate=2)
        if bars:
            df = util.df(bars)
            print(f"  {desc}: ✓ {len(df)} bars, last close ${float(df['close'].iloc[-1]):.2f}")
            return True
        else:
            print(f"  {desc}: no data returned")
            return False
    except Exception as ex:
        print(f"  {desc}: FAILED — {ex}")
        return False

def main():
    ib = IB()
    try:
        ib.connect(IBKR_HOST, IBKR_PORT, clientId=CLIENT_ID, timeout=15)
        print(f"Connected to IBKR Gateway\n")
    except Exception as ex:
        print(f"Connection failed: {ex}")
        print("Make sure the Gateway is running and port is correct.")
        print("Check server.js for the port: grep -n 'port\\|4002\\|4001' ~/ibkr-webhook/server.js | head -5")
        return

    print("Probing MRUT data availability:")

    # Try MRUT as an index
    try_contract(ib, Index('MRUT', 'CBOE', 'USD'), "MRUT Index (CBOE)")

    # Try RUT as comparison (known to work)
    try_contract(ib, Index('RUT', 'CBOE', 'USD'), "RUT Index (CBOE) — reference")

    # Try IWM as ETF comparison
    try_contract(ib, Stock('IWM', 'SMART', 'USD'), "IWM ETF — reference")

    print("\nIf MRUT shows bars: the Scout engine can use IBKR bars for MRUT signals.")
    print("If not: MRUT may need a different contract spec (check IBKR contract search).")

    ib.disconnect()

if __name__ == '__main__':
    main()
