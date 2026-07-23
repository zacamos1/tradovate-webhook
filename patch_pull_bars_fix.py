path = "vwap_signal_sender.py"
with open(path, "r") as f:
    content = f.read()

old = """def pull_bars_ibkr(root, exchange, currency):
    \"\"\"Pull recent 5-min bars from IBKR Gateway.\"\"\"
    try:
        from ib_insync import IB, Future, util
        ib = IB()
        ib.connect('127.0.0.1', 4002, clientId=55, timeout=15)

        # Use continuous front contract
        contract = Future(root, '', exchange, currency=currency)
        ib.qualifyContracts(contract)

        bars = ib.reqHistoricalData(
            contract, endDateTime='', durationStr=DURATION,
            barSizeSetting=BAR_SIZE, whatToShow='TRADES',
            useRTH=False, formatDate=2)

        df = util.df(bars)
        df = df.rename(columns={'open':'Open','high':'High','low':'Low',
                                  'close':'Close','volume':'Volume'})
        df['date'] = pd.to_datetime(df['date'], utc=True)
        df = df.set_index('date')[['Open','High','Low','Close','Volume']]
        df.index = df.index.tz_convert('America/New_York')
        ib.disconnect()
        return df
    except Exception as e:
        log('ibkr_pull_error', root=root, error=str(e))
        return None"""

new = """def pull_bars_ibkr(root, exchange, currency):
    \"\"\"Pull recent 5-min bars from IBKR Gateway.\"\"\"
    from ib_insync import IB, ContFuture, util
    ib = IB()
    try:
        ib.connect('127.0.0.1', 4002, clientId=55, timeout=15)

        # ContFuture resolves to the current front-month contract automatically
        # (the old Future('') with blank expiry was ambiguous across 5 live
        # expiries and threw Error 321 every time)
        contract = ContFuture(root, exchange, currency=currency)
        ib.qualifyContracts(contract)

        bars = ib.reqHistoricalData(
            contract, endDateTime='', durationStr=DURATION,
            barSizeSetting=BAR_SIZE, whatToShow='TRADES',
            useRTH=False, formatDate=2)

        df = util.df(bars)
        df = df.rename(columns={'open':'Open','high':'High','low':'Low',
                                  'close':'Close','volume':'Volume'})
        df['date'] = pd.to_datetime(df['date'], utc=True)
        df = df.set_index('date')[['Open','High','Low','Close','Volume']]
        df.index = df.index.tz_convert('America/New_York')
        return df
    except Exception as e:
        log('ibkr_pull_error', root=root, error=str(e))
        return None
    finally:
        # ALWAYS disconnect, even on failure — the old code only disconnected
        # on success, which left clientId=55 orphaned/connected after any
        # error and caused every subsequent call to fail with
        # "clientId 55 already in use"
        if ib.isConnected():
            ib.disconnect()"""

if old not in content:
    print("ERROR: exact old block not found — aborting, no changes made.")
else:
    content = content.replace(old, new, 1)
    with open(path, "w") as f:
        f.write(content)
    print("Patched successfully: ContFuture + always-disconnect finally block.")
