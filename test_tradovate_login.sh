#!/usr/bin/env bash
set -euo pipefail

echo "Tradovate DEMO API login test"
echo

read -rp "Tradovate username: " TV_USERNAME
read -rsp "New API password: " TV_PASSWORD
echo
read -rp "API key CID: " TV_CID
read -rsp "API secret: " TV_SECRET
echo
read -rp "App ID/key name: " TV_APP_ID
echo

RESPONSE=$(curl -sS \
  -X POST "https://demo.tradovateapi.com/v1/auth/accessTokenRequest" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  --data "$(jq -n \
    --arg name "$TV_USERNAME" \
    --arg password "$TV_PASSWORD" \
    --arg appId "$TV_APP_ID" \
    --arg appVersion "1.0" \
    --argjson cid "$TV_CID" \
    --arg sec "$TV_SECRET" \
    '{
      name: $name,
      password: $password,
      appId: $appId,
      appVersion: $appVersion,
      cid: $cid,
      sec: $sec
    }')")

echo
echo "Tradovate response:"
echo "$RESPONSE" | jq .

if echo "$RESPONSE" | jq -e '.accessToken' >/dev/null 2>&1; then
    echo
    echo "SUCCESS: The server logged into Tradovate."
else
    echo
    echo "LOGIN FAILED: Copy the response shown above back here."
fi

unset TV_USERNAME TV_PASSWORD TV_CID TV_SECRET TV_APP_ID RESPONSE
