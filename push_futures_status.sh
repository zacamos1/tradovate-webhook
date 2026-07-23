#!/usr/bin/env bash
# Daily EOD status push for the futures VWAP system via ntfy, including
# dollar P&L (daily and cumulative) computed from tradovate_log.jsonl's
# position_closed events (pnlPts * per-instrument point value).
cd /root/ibkr-webhook
source .env 2>/dev/null

TODAY=$(date -u -d '5 hours ago' +%Y-%m-%d)
EVALS=$(pm2 logs vwap-sender --lines 500 --nostream 2>/dev/null | grep -c "\"event\": \"evaluation_done\"")
SIGNALS=$(pm2 logs vwap-sender --lines 500 --nostream 2>/dev/null | grep "\"event\": \"signal_detected\"" | wc -l)
TRADES=$(grep -c "position_opened\|position_closed" tradovate_log.jsonl 2>/dev/null || echo 0)

PNL_SUMMARY=$(node -e "
const fs = require('fs');
const POINT_VALUE = { MES: 5, MNQ: 2, MYM: 0.5 };
const CT_OFFSET_HOURS = 5;
const today = new Date(Date.now() - CT_OFFSET_HOURS * 60 * 60 * 1000).toISOString().slice(0, 10);

let lines = [];
try {
  lines = fs.readFileSync('tradovate_log.jsonl', 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch(e) { return null; } }).filter(Boolean);
} catch (e) {}

let cumDollar = 0, todayDollar = 0;
for (const l of lines) {
  if (l.event !== 'position_closed') continue;
  const key = l.key || '';
  let pv = null;
  if (key.includes('MES')) pv = POINT_VALUE.MES;
  else if (key.includes('MNQ')) pv = POINT_VALUE.MNQ;
  else if (key.includes('MYM')) pv = POINT_VALUE.MYM;
  if (pv === null) continue;
  const dollarPnl = parseFloat(l.pnlPts || 0) * pv;
  cumDollar += dollarPnl;
  const ts = (l.ts || '').slice(0, 10);
  if (ts === today) todayDollar += dollarPnl;
}
console.log(\`Cumulative P&L: \${cumDollar >= 0 ? '+' : '-'}\$\${Math.abs(cumDollar).toFixed(2)} | Today: \${todayDollar >= 0 ? '+' : '-'}\$\${Math.abs(todayDollar).toFixed(2)}\`);
")

MSG="Eval cycles today: ${EVALS} | Signals detected: ${SIGNALS} | Trades: ${TRADES}
${PNL_SUMMARY}"

echo "$MSG"

if [ -n "$NTFY_TOPIC" ]; then
  curl -s -H "Title: Futures VWAP — daily status" \
       -H "Priority: default" \
       -H "Tags: chart_with_upwards_trend" \
       -d "$MSG" \
       "https://ntfy.sh/$NTFY_TOPIC"
fi
