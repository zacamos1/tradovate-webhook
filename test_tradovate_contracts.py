#!/usr/bin/env python3

import os
import sys
import requests
from dotenv import load_dotenv

load_dotenv()

AUTH_URL = "https://live.tradovateapi.com/v1/auth/accesstokenrequest"
API_URL = "https://live.tradovateapi.com/v1"

USERNAME = os.getenv("TRADOVATE_USERNAME")
PASSWORD = os.getenv("TRADOVATE_PASSWORD")
CID = os.getenv("TRADOVATE_CID")
SECRET = os.getenv("TRADOVATE_SECRET")

APP_ID = "claude future strategy"
APP_VERSION = "1.0.0"
DEVICE_ID = "a9314bdd-c565-c1a0-2c7d-b8a26ce0cbc1"

missing = [
    name
    for name, value in {
        "TRADOVATE_USERNAME": USERNAME,
        "TRADOVATE_PASSWORD": PASSWORD,
        "TRADOVATE_CID": CID,
        "TRADOVATE_SECRET": SECRET,
    }.items()
    if not value
]

if missing:
    print("[FAIL] Missing variables in .env:")
    for name in missing:
        print(f"  - {name}")
    sys.exit(1)

print("[1] Authenticating...")

auth_response = requests.post(
    AUTH_URL,
    json={
        "name": USERNAME,
        "password": PASSWORD,
        "appId": APP_ID,
        "appVersion": APP_VERSION,
        "deviceId": DEVICE_ID,
        "cid": int(CID),
        "sec": SECRET,
    },
    timeout=20,
)

print("Auth HTTP status:", auth_response.status_code)

try:
    auth = auth_response.json()
except Exception:
    print("Non-JSON response:")
    print(auth_response.text[:1000])
    sys.exit(1)

if auth.get("errorText"):
    print("[FAIL] Authentication error:")
    print(auth)
    sys.exit(1)

access_token = auth.get("accessToken")
md_access_token = auth.get("mdAccessToken")

print("[OK] Trading access token:", bool(access_token))
print("[OK] Market-data token:", bool(md_access_token))
print("[INFO] User ID:", auth.get("userId"))
print("[INFO] Expiration:", auth.get("expirationTime"))

if not access_token:
    print("[FAIL] No normal accessToken returned.")
    sys.exit(1)

headers = {
    "Authorization": f"Bearer {access_token}",
    "Accept": "application/json",
}

symbols = [
    "MESU6",
    "MNQU6",
    "MYMU6",
    "ESU6",
    "NQU6",
    "YMU6",
]

print()
print("[2] Looking up current September 2026 contracts...")

for symbol in symbols:
    try:
        response = requests.get(
            f"{API_URL}/contract/find",
            params={"name": symbol},
            headers=headers,
            timeout=15,
        )

        print()
        print("=" * 70)
        print("Symbol:", symbol)
        print("HTTP status:", response.status_code)

        try:
            data = response.json()
        except Exception:
            print("Response text:", response.text[:500])
            continue

        if isinstance(data, dict):
            safe_data = {
                "id": data.get("id"),
                "name": data.get("name"),
                "contractMaturityId": data.get("contractMaturityId"),
                "status": data.get("status"),
                "providerTickSize": data.get("providerTickSize"),
                "errorText": data.get("errorText"),
                "errorCode": data.get("errorCode"),
            }
            print(safe_data)
        else:
            print(data)

    except Exception as exc:
        print(f"[ERROR] {symbol}: {type(exc).__name__}: {exc}")

print()
print("[3] Testing product discovery...")

for product in ["MES", "MNQ", "MYM"]:
    try:
        response = requests.get(
            f"{API_URL}/product/find",
            params={"name": product},
            headers=headers,
            timeout=15,
        )

        print()
        print("Product:", product)
        print("HTTP status:", response.status_code)

        try:
            data = response.json()
            if isinstance(data, dict):
                print({
                    "id": data.get("id"),
                    "name": data.get("name"),
                    "description": data.get("description"),
                    "exchangeId": data.get("exchangeId"),
                    "contractGroupId": data.get("contractGroupId"),
                    "status": data.get("status"),
                    "errorText": data.get("errorText"),
                })
            else:
                print(data)
        except Exception:
            print(response.text[:500])

    except Exception as exc:
        print(f"[ERROR] {product}: {type(exc).__name__}: {exc}")
