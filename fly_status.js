#!/usr/bin/env node
/* fly_status.js — the fly blotter. Reads fly_ledger.jsonl and prints every fly's
 * lifecycle and current status. No arguments = all flies, newest first.
 *   node fly_status.js            all flies
 *   node fly_status.js today      today's flies only
 *   node fly_status.js <flyId>    full event timeline for one fly
 */
const fs = require('fs');
const path = require('path');

const LEDGER = path.join(__dirname, 'fly_ledger.jsonl');
if (!fs.existsSync(LEDGER)) { console.log('(no fly_ledger.jsonl yet — ledger starts with the next placeFly call)'); process.exit(0); }

const events = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch (e) { return null; }
}).filter(Boolean);

const arg = process.argv[2];
const todayUTC = new Date().toISOString().slice(0, 10).replace(/-/g, '');

const byFly = {};
for (const e of events) (byFly[e.flyId] = byFly[e.flyId] || []).push(e);

const STATUS_ICON = {
  legs_resolved: '…', submitted: '…', filled: '✓ FILLED',
  no_fill: '· no-fill', orphaned: '! ORPHANED',
  orphan_flattened: '✓ flattened', orphan_unresolved: '✗ UNRESOLVED',
};

if (arg && arg !== 'today' && byFly[arg]) {
  console.log(`\n${arg} — full timeline:`);
  for (const e of byFly[arg]) {
    const { ts, flyId, symbol, expiry, event, ...rest } = e;
    console.log(`  ${ts}  ${event.padEnd(18)} ${Object.keys(rest).length ? JSON.stringify(rest) : ''}`);
  }
  process.exit(0);
}

const ids = Object.keys(byFly).sort((a, b) => (byFly[b][0].ts < byFly[a][0].ts ? -1 : 1));
console.log(`flyId                          sym   c/w        credits        status`);
console.log('-'.repeat(88));
let shown = 0;
for (const id of ids) {
  const evs = byFly[id];
  if (arg === 'today' && !id.includes(todayUTC)) continue;
  const last = evs[evs.length - 1];
  const legs = evs.find((e) => e.event === 'legs_resolved') || {};
  const sub = evs.find((e) => e.event === 'submitted') || {};
  const geo = legs.center ? `${legs.center}±${legs.wing}` : '?';
  const cr = sub.callCredit != null ? `${sub.callCredit}/${sub.putCredit}` : '?';
  const status = STATUS_ICON[last.event] || last.event;
  let extra = '';
  if (last.event === 'filled' && last.fills) extra = ` @ ${last.fills.CALL}+${last.fills.PUT}`;
  if (last.event === 'orphan_flattened') extra = ` P/L $${last.pl_dollars}`;
  if (last.event === 'orphan_unresolved') extra = ` OPEN: ${last.openSide} — CHECK IBKR`;
  console.log(`${id.padEnd(30)} ${(evs[0].symbol || '?').padEnd(5)} ${geo.padEnd(10)} ${cr.padEnd(14)} ${status}${extra}`);
  shown++;
}
if (!shown) console.log(arg === 'today' ? '(no flies today)' : '(ledger empty)');
