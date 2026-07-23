#!/usr/bin/env node
/* health_digest.js — read-only failure alerting for the fly system.
 *
 * Observes, never touches: reads logs and jsonl files, checks the Gateway port,
 * and pushes a digest to your phone via ntfy.sh. Zero changes to trading code.
 *
 * Run by cron at the two moments that matter (all times UTC):
 *   13:58 (9:58 ET)  MORNING digest — did feeds/verify/autotest all run, what
 *                    happened, what's the honesty ratio, is a fly riding?
 *   20:35 (16:35 ET) EOD digest — settler rows, flatten errors, ledger state.
 * Any RED condition sends with high priority (phone buzzes urgently).
 *
 * SETUP (one time):
 *   1. Pick a secret topic name (unguessable — it's the only auth):
 *      edit NTFY_TOPIC below or set in ~/ibkr-webhook/.env as NTFY_TOPIC=...
 *   2. Install the "ntfy" app (iOS/Android), subscribe to that exact topic.
 *   3. Test:  node health_digest.js test   -> phone should buzz.
 *
 * Cron:
 *   58 13 * * 1-5 cd /root/ibkr-webhook && /usr/bin/node health_digest.js morning >> health_digest.out 2>&1
 *   35 20 * * 1-5 cd /root/ibkr-webhook && /usr/bin/node health_digest.js eod     >> health_digest.out 2>&1
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const net = require('net');
const { execSync } = require('child_process');

const NTFY_TOPIC = process.env.NTFY_TOPIC || 'CHANGE-ME-zac-fly-8k3n2p';
const DIR = __dirname;
const WEBHOOK_LOG = '/root/.pm2/logs/ibkr-webhook-out.log';
const AUTOTEST_LOG = '/root/.pm2/logs/fly-autotest-out.log';
const mode = process.argv[2] || 'morning';

function todayUTC() {
  const n = new Date();
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}-${String(n.getUTCDate()).padStart(2, '0')}`;
}
function readLines(p) { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean); } catch (e) { return []; } }
function jsonl(p) { return readLines(path.join(DIR, p)).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); }
function todayLines(p) { return readLines(p).filter((l) => l.includes(`[${todayUTC()}`)); }

function portOpen(port) {
  return new Promise((res) => {
    const s = net.createConnection({ host: '127.0.0.1', port, timeout: 3000 });
    s.on('connect', () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
    s.on('timeout', () => { s.destroy(); res(false); });
  });
}

async function main() {
  const green = [], red = [], info = [];
  const today = todayUTC();

  // 1. Gateway port
  (await portOpen(4002)) ? green.push('gateway port up') : red.push('GATEWAY PORT 4002 DOWN');

  // 2. Webhook connection state (last connect vs last drop today)
  const wl = todayLines(WEBHOOK_LOG);
  const lastConn = wl.filter((l) => l.includes('Connected to TWS')).pop();
  const lastDrop = wl.filter((l) => l.includes('TWS unavailable')).pop();
  if (lastConn && (!lastDrop || wl.indexOf(lastDrop) < wl.indexOf(lastConn))) green.push('webhook connected');
  else red.push('WEBHOOK NOT CONNECTED (no fresh Connected-to-TWS today)');

  // 3. Feeds ran (today's tracker rows)
  const rows = jsonl('pmtracker_multi_log.jsonl').filter((r) => r.date === today);
  rows.length ? green.push(`feeds ok (${rows.length} rows)`) : red.push('NO FEED ROWS TODAY');

  if (mode === 'morning' || mode === 'test') {
    // 4. verify-credits: today's honesty ratios
    const vc = jsonl('credit_verification.jsonl').filter((r) => r.date === today && r.ratio != null);
    if (vc.length) {
      const avg = vc.reduce((a, r) => a + r.ratio, 0) / vc.length;
      info.push(`honesty ratio avg ${avg.toFixed(3)} (${vc.length} flies)`);
      if (avg < 0.7) red.push(`HONESTY RATIO LOW: ${avg.toFixed(2)}`);
    } else red.push('NO CREDIT VERIFICATION TODAY (verify-credits ran?)');

    // 5. autotest outcome
    const al = todayLines(AUTOTEST_LOG);
    const terminal = al.filter((l) => /FLY ON|NO-GO|standing down|MANUAL CHECK|orphan/i.test(l)).pop();
    if (terminal) {
      const msg = terminal.replace(/^\[[^\]]+\]\s*/, '').slice(0, 140);
      /FLY ON/.test(terminal) ? info.push(`🪰 ${msg}`) : info.push(`autotest: ${msg}`);
      if (/MANUAL CHECK|unresolved/i.test(terminal)) red.push('AUTOTEST NEEDS MANUAL CHECK');
    } else if (al.length) info.push('autotest ran, no terminal line yet');
    else red.push('AUTOTEST DID NOT RUN');
  }

  if (mode === 'eod' || mode === 'test') {
    // 6. settled rows + flatten errors
    const settled = jsonl('pmtracker_multi_log.jsonl').filter((r) => r.date === today && r.real_pl != null);
    settled.length ? info.push(`settler: ${settled.length} rows graded`) : info.push('settler not yet run (or holiday)');
    const flatErr = todayLines(WEBHOOK_LOG).filter((l) => l.includes('EOD-flatten') && /(\[201\]|\[321\]|error)/i.test(l));
    flatErr.length ? red.push(`FLATTEN ERRORS: ${flatErr.length}`) : green.push('flatten clean');
    // live-book quick take
    const lb = settled.filter((r) => r.variant === 'vol_wide' && ['XSP', 'IWM'].includes(r.symbol));
    if (lb.length) info.push(`live book (vol_wide XSP+IWM): $${lb.reduce((a, r) => a + r.real_pl, 0).toFixed(0)}`);
  }

  // 7. fly ledger unresolved check (both digests)
  const led = jsonl('fly_ledger.jsonl').filter((r) => (r.ts || '').startsWith(today));
  const byFly = {};
  for (const e of led) byFly[e.flyId] = e.event;
  for (const [id, ev] of Object.entries(byFly)) {
    if (ev === 'orphan_unresolved') red.push(`LEDGER: ${id} UNRESOLVED`);
    if (ev === 'filled') info.push(`ledger: ${id} riding`);
  }

  const title = red.length ? `FLY SYSTEM: ${red.length} ISSUE${red.length > 1 ? 'S' : ''}` : `fly system ${mode}: all green`;
  const body = [...red.map((r) => '🔴 ' + r), ...info.map((i) => 'ℹ️ ' + i), ...green.map((g) => '✅ ' + g)].join('\n');
  const priority = red.length ? 'high' : 'default';
  const tags = red.length ? 'rotating_light' : 'white_check_mark';

  console.log(`[${new Date().toISOString()}] ${title}\n${body}`);
  try {
    execSync(`curl -s -H "Title: ${title}" -H "Priority: ${priority}" -H "Tags: ${tags}" -d "${body.replace(/"/g, "'")}" https://ntfy.sh/${NTFY_TOPIC}`, { timeout: 15000 });
    console.log('pushed to ntfy topic: ' + NTFY_TOPIC);
  } catch (e) { console.log('ntfy push failed: ' + e.message); }
}

main();
