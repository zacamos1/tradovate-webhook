#!/usr/bin/env node
/* fly_resolve.js — STAGE 1 of the premium execution module.
 *
 * PURPOSE: prove we can turn an intended iron fly (symbol, center strike, wing width)
 * into FOUR real, combinable IBKR option contracts (conIds). PLACES NOTHING.
 *
 * The iron fly has 4 legs:
 *    SHORT call @ center       (sell)
 *    SHORT put  @ center       (sell)
 *    LONG  call @ center + wing (buy, protection)
 *    LONG  put  @ center - wing (buy, protection)
 *
 * CRITICAL GUARD (the bug from prior sessions): equity options can have alternate
 * trading classes (e.g. "2SPY" alongside "SPY"). Legs on different trading classes
 * WILL NOT COMBINE into a BAG order. This script REJECTS any leg whose tradingClass
 * does not exactly equal the root symbol, so we never silently build an uncombinable fly.
 *
 * USAGE (during market hours, on the VPS, IB Gateway up):
 *    node /tmp/fly_resolve.js SPY 743 6
 *    node /tmp/fly_resolve.js XSP 748 6
 */

const { IBApi, EventName, SecType } = require('@stoqey/ib');

const SYMBOL = process.argv[2];
const CENTER = parseInt(process.argv[3], 10);
const WING   = parseInt(process.argv[4], 10);

if (!SYMBOL || !CENTER || !WING) {
  console.error('usage: node fly_resolve.js <SYMBOL> <CENTER_STRIKE> <WING_PTS>');
  console.error('  e.g. node fly_resolve.js SPY 743 6');
  process.exit(1);
}

// today's expiry in YYYYMMDD (UTC) — 0DTE
const now = new Date();
const EXPIRY = now.getUTCFullYear().toString()
  + String(now.getUTCMonth() + 1).padStart(2, '0')
  + String(now.getUTCDate()).padStart(2, '0');

// the four legs we need to resolve
const legs = [
  { tag: 'SHORT_CALL', right: 'C', strike: CENTER,        action: 'SELL' },
  { tag: 'SHORT_PUT',  right: 'P', strike: CENTER,        action: 'SELL' },
  { tag: 'LONG_CALL',  right: 'C', strike: CENTER + WING, action: 'BUY'  },
  { tag: 'LONG_PUT',   right: 'P', strike: CENTER - WING, action: 'BUY'  },
];

console.log(`\n=== Stage 1 resolver: ${SYMBOL} fly, center ${CENTER}, wings ±${WING}, expiry ${EXPIRY} ===`);
console.log(`Legs wanted: ${SYMBOL} ${CENTER}C/${CENTER}P (short), ${CENTER + WING}C/${CENTER - WING}P (long)\n`);

const PORT = parseInt(process.env.IB_PORT || '4002', 10);
const HOST = process.env.IB_HOST || '127.0.0.1';
const ib = new IBApi({ host: HOST, port: PORT, clientId: 77 }); // distinct clientId so we don't collide with server.js

const results = {};   // tag -> { conId, tradingClass, ok, reason }
let pending = legs.length;
let nextReq = 9000;
const reqToLeg = {};

function done() {
  console.log('\n=== RESULTS ===');
  let allOk = true;
  const roots = new Set();
  for (const leg of legs) {
    const r = results[leg.tag];
    if (!r) {
      console.log(`  ${leg.tag.padEnd(11)} ${leg.right} ${leg.strike}  ->  NO RESPONSE (leg failed to resolve)`);
      allOk = false;
      continue;
    }
    if (!r.ok) {
      console.log(`  ${leg.tag.padEnd(11)} ${leg.right} ${leg.strike}  ->  REJECTED: ${r.reason}`);
      allOk = false;
      continue;
    }
    console.log(`  ${leg.tag.padEnd(11)} ${leg.right} ${leg.strike}  ->  conId ${r.conId}  tradingClass ${r.tradingClass}  action ${leg.action}`);
    roots.add(r.tradingClass);
  }

  // the combinability guard: every leg must share the same trading class == root symbol
  console.log('');
  if (allOk && roots.size === 1 && roots.has(SYMBOL)) {
    console.log(`✓ ALL FOUR LEGS RESOLVED on trading class "${SYMBOL}" — combinable. Stage 1 PASS.`);
    console.log(`  conIds: ` + legs.map(l => `${l.tag}=${results[l.tag].conId}`).join('  '));
  } else if (allOk && roots.size > 1) {
    console.log(`✗ LEGS SPAN MULTIPLE TRADING CLASSES: ${[...roots].join(', ')} — these will NOT combine. Stage 1 FAIL.`);
  } else if (allOk && !roots.has(SYMBOL)) {
    console.log(`✗ Legs resolved on "${[...roots].join(',')}" not "${SYMBOL}" — wrong class. Stage 1 FAIL.`);
  } else {
    console.log(`✗ One or more legs failed to resolve. Stage 1 FAIL — see above.`);
  }
  try { ib.disconnect(); } catch (e) {}
  process.exit(allOk ? 0 : 1);
}

ib.on(EventName.error, (err, code, reqId) => {
  // 200 = no security definition found (bad strike/expiry); 354 = not subscribed; ignore benign farm msgs
  if (reqId && reqToLeg[reqId]) {
    const leg = reqToLeg[reqId];
    if (!results[leg.tag]) {
      results[leg.tag] = { ok: false, reason: `error ${code}: ${err.message || err}` };
      if (--pending === 0) done();
    }
  }
});

ib.on(EventName.connected, () => {
  console.log(`Connected to IB Gateway ${HOST}:${PORT} (clientId 77). Resolving legs...`);
  for (const leg of legs) {
    const reqId = nextReq++;
    reqToLeg[reqId] = leg;
    ib.reqContractDetails(reqId, {
      symbol: SYMBOL,
      secType: SecType.OPT,
      exchange: 'SMART',
      currency: 'USD',
      lastTradeDateOrContractMonth: EXPIRY,
      strike: leg.strike,
      right: leg.right,
      // NOTE: deliberately NOT specifying tradingClass — we want to SEE what comes back
      // and apply the guard ourselves, so we detect the 2SPY-type problem rather than hide it.
    });
  }
});

ib.on(EventName.contractDetails, (reqId, details) => {
  const leg = reqToLeg[reqId];
  if (!leg || results[leg.tag]) return;  // first response wins per leg
  const c = details.contract;
  const tc = c.tradingClass;
  // GUARD: reject if trading class isn't the plain root symbol
  if (tc !== SYMBOL) {
    results[leg.tag] = { ok: false, conId: c.conId, tradingClass: tc,
      reason: `tradingClass "${tc}" != root "${SYMBOL}" (the 2SPY-type problem — not combinable)` };
  } else {
    results[leg.tag] = { ok: true, conId: c.conId, tradingClass: tc };
  }
  if (--pending === 0) done();
});

ib.connect();

// safety timeout
setTimeout(() => {
  console.log('\n⏱  Timeout (15s) — some legs never responded. Partial results:');
  done();
}, 15000);
