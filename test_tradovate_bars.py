#!/usr/bin/env python3
"""
test_tradovate_bars.py — STANDALONE test script for pulling historical price
bars from Tradovate's WebSocket market-data API (md/getChart).

This is a completely separate, independent script from vwap_signal_sender.py —
it does NOT touch the live, currently-running signal detection at all. Its only
purpose is to validate that we CAN pull equivalent 5-min bars from Tradovate,
and compare them against pull_bars_ibkr()'s known-good output, before ever
considering wiring this into the live sender.

Usage: python3 test_tradovate_bars.py
"""
import asyncio
import json
import os
import ssl
import time
import requests
import websockets
import pandas as pd
from dotenv import load_dotenv

load_dotenv()

CID = os.environ.get('TRADOVATE_CID')
SECRET = os.environ.get('TRADOVATE_SECRET')
USERNAME = os.environ.get('TRADOVATE_USERNAME')
PASSWORD = os.environ.get('TRADOVATE_PASSWORD')
APP_ID = 'claude future strategy'
APP_VERSION = '1.0.0'
DEVICE_ID = 'a9314bdd-c565-c1a0-2c7d-b8a26ce0cbc1'  # reused from the confirmed-working curl test earlier tonight

AUTH_URL = 'https://live.tradovateapi.com/v1/auth/accesstokenrequest'
MD_WS_URL = 'wss://md.tradovateapi.com/v1/websocket'


def get_access_token():
    """Reuse the REST auth flow already confirmed working tonight."""
    resp = requests.post(AUTH_URL, json={
        'name': USERNAME,
        'password': PASSWORD,
        'appId': APP_ID,
        'appVersion': APP_VERSION,
        'deviceId': DEVICE_ID,
        'cid': int(CID),
        'sec': SECRET,
    })
    data = resp.json()
    if 'errorText' in data:
        raise RuntimeError(f"Auth failed: {data['errorText']}")
    return data['mdAccessToken']


async def pull_bars_tradovate(symbol='MNQU6', num_bars=200, bar_minutes=5):
    """
    Pull historical bars from Tradovate's md/getChart WebSocket endpoint.
    Returns a DataFrame in the SAME format as pull_bars_ibkr() in
    vwap_signal_sender.py: index=timestamp, columns=[Open,High,Low,Close,Volume].
    """
    token = get_access_token()
    print(f"[test] Got market data access token, length {len(token)}")

    ssl_ctx = ssl.create_default_context()
    async with websockets.connect(MD_WS_URL, ssl=ssl_ctx) as ws:
        # Tradovate's WS protocol: first frame is the "open" frame (server sends 'o')
        greeting = await ws.recv()
        print(f"[test] Greeting: {greeting[:100]}")

        # Authorize the WS connection with the md access token
        auth_frame = f"authorize\n1\n\n{token}"
        await ws.send(auth_frame)
        auth_resp = await ws.recv()
        print(f"[test] Auth response: {auth_resp[:200]}")

        # Request the chart
        chart_body = {
            "symbol": symbol,
            "chartDescription": {
                "underlyingType": "MinuteBar",
                "elementSize": bar_minutes,
                "elementSizeUnit": "UnderlyingUnits",
                "withHistogram": False,
            },
            "timeRange": {
                "asMuchAsElements": num_bars,
            },
        }
        chart_frame = f"md/getchart\n2\n\n{json.dumps(chart_body)}"
        await ws.send(chart_frame)

        bars = []
        eoh = False
        timeout_at = time.time() + 20
        while not eoh and time.time() < timeout_at:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=5)
            except asyncio.TimeoutError:
                break
            print(f"[test] Frame received: {msg[:150]}")
            # Tradovate frames are prefixed with a letter (a=array of events, etc.)
            if msg.startswith('a'):
                payload = json.loads(msg[1:])
                for event in payload:
                    if event.get('e') == 'chart':
                        charts = event.get('d', {}).get('charts', [])
                        for chart in charts:
                            if chart.get('eoh'):
                                eoh = True
                            for bar in chart.get('bars', []):
                                bars.append(bar)

        print(f"[test] Total bars collected: {len(bars)}")
        return bars


if __name__ == '__main__':
    import sys

    symbols = sys.argv[1:] or ['MESU6', 'MNQU6', 'MYMU6']

    for symbol in symbols:
        print()
        print('=' * 80)
        print(f'TESTING {symbol}')
        print('=' * 80)

        try:
            result = asyncio.run(
                pull_bars_tradovate(
                    symbol=symbol,
                    num_bars=20,
                    bar_minutes=1,
                )
            )

            if result:
                df = pd.DataFrame(result)
                print(df.head(10).to_string(index=False))
                print(df.tail(5).to_string(index=False))
            else:
                print(f'[test] No bars returned for {symbol}.')
        except Exception as exc:
            print(
                f'[test] {symbol} failed: '
                f'{type(exc).__name__}: {exc}'
            )
