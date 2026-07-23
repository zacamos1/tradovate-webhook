#!/usr/bin/env bash
# Runs the directional options dashboard and pushes a summary via ntfy.
cd /root/ibkr-webhook
OUTPUT=$(/usr/bin/node directional_dashboard_html_v2.js 2>&1)
echo "$OUTPUT"

SUMMARY=$(echo "$OUTPUT" | grep "Total trades:")

source .env 2>/dev/null
if [ -n "$NTFY_TOPIC" ] && [ -n "$SUMMARY" ]; then
  curl -s -H "Title: Directional options — daily dashboard" \
       -H "Priority: default" \
       -H "Tags: bar_chart" \
       -d "$SUMMARY" \
       "https://ntfy.sh/$NTFY_TOPIC"
fi
