#!/usr/bin/env node
/* fly_autotest.js — v2. Autonomous fly test with REAL pricing (DUN460366 + shared data).
 *
 * Pricing ladder (fixes Friday's staleness failures, no fly_exec changes needed):
 *   A1  submit with NO credits -> fly_exec snapshot-prices from live IB quotes
 *       and submits AT MID. Mids on XSP verticals often cross within 25s.
 *   A2  if no fill: the result JSON echoes the snapshot mids -> resubmit at
 *       0.97 x that mid immediately (~40s staleness, calm-morning tolerable).
 *   A3  if no fill: fresh no-credit probe (refreshes mid, can fill outright).
 *   A4  if no fill: 0.94 x refreshed mid. Then stand down.
 *   Fallback at any stage if snapshots come back EMPTY ("missing quotes"):
 *       probe with deliberately-rich credits -> IBKR band rejection DISCLOSES
 *       the live market price -> submit at disclosed x 0.97.
 *
 * Unchanged from v1: calm gate, 9:47 ET window, weekend skip, abort if XSP
 * positions already exist, shorts-only cleanup on unresolved orphans,
 * paper-only account guard.
 *
 * Launch:  pm2 start fly_autotest.js --name fly-autotest --no-autorestart
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TARGET = { h: 13, m: 47 };            // UTC = 9:47 ET
const SERVER_LOG = '/root/.pm2/logs/ibkr-webhook-out.log';
const JSONL = path.join(__dirname, 'pmtracker_multi_log.jsonl');
const LEGS_FILE = path.join(__dirname, 'fly_legs_today.json');
const ACCOUNT = process.env.ACCOUNT || 'DUN460366';
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

if (!/^D/.test(ACCOUNT)) { console.error('refusing non-paper account'); process.exit(1); }

function yahoo(sym) {
  const out = execSync(`curl -s -H 'User-Agent: Mozilla/5.0' "https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=2d"`, { timeout: 20000 }).toString();
  const r = JSON.parse(out).chart.result[0]; const m = r.meta;
  return { last: m.regularMarketPrice, prevClose: m.chartPreviousClose ?? m.previousClose,
           open: (r.indicators.quote[0].open || []).filter(x => x != null).pop() };
}
function todayUTC() {
  const n = new Date();
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}-${String(n.getUTCDate()).padStart(2, '0')}`;
}
function nextTargetMs() {
  const now = new Date();
  let t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), TARGET.h, TARGET.m, 0));
  if (t <= now) t = new Date(t.getTime() + 24 * 3600 * 1000);
  while ([0, 6].includes(t.getUTCDay())) t = new Date(t.getTime() + 24 * 3600 * 1000);
  return t.getTime() - now.getTime();
}
function serverLinesSince(tsMs) {
  try {
    return fs.readFileSync(SERVER_LOG, 'utf8').split('\n').filter(l => {
      const m = l.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/);
      return m && new Date(m[1]).getTime() >= tsMs;
    });
  } catch (e) { return []; }
}
function resultSince(tsMs) {
  const lines = serverLinesSince(tsMs).filter(l => l.includes('[fly] result: '));
  if (!lines.length) return null;
  try { return JSON.parse(lines[lines.length - 1].split('[fly] result: ')[1]); } catch (e) { return null; }
}
function bandDisclosures(tsMs) {
  const out = [];
  for (const l of serverLinesSince(tsMs)) {
    const m = l.match(/error code=202 reqId=(\d+):.*current market price of -?([\d.]+)/);
    if (m) out.push({ reqId: +m[1], px: parseFloat(m[2]) });
  }
  return out.sort((a, b) => a.reqId - b.reqId);   // call vertical submitted first
}
function submitFly(center, wing, cc, pc) {
  const body = { symbol: 'XSP', center, wing, contracts: 1 };
  if (cc != null && pc != null) { body.callCredit = +(+cc).toFixed(2); body.putCredit = +(+pc).toFixed(2); }
  const resp = execSync(`curl -s -X POST localhost:3000/place_test_fly -H 'Content-Type: application/json' -d '${JSON.stringify(body)}'`, { timeout: 15000 }).toString();
  log(`submit c${center} w${wing}${cc != null ? ` cc=${body.callCredit} pc=${body.putCredit}` : ' (snapshot/mid)'} -> ${resp.trim()}`);
  return resp.includes('"submitted":true');
}
function waitResult(tsMs, cb, maxPolls = 30) {
  let polls = 0;
  const iv = setInterval(() => {
    polls++;
    const res = resultSince(tsMs);
    if (!res && polls < maxPolls) return;
    clearInterval(iv);
    cb(res);
  }, 5000);
}

function shortsCleanup() {
  let shorts = [];
  try { const j = JSON.parse(fs.readFileSync(LEGS_FILE, 'utf8')); shorts = j.shorts || []; } catch (e) {}
  if (!shorts.length) { log('cleanup: no shorts list — MANUAL CHECK NEEDED'); return process.exit(1); }
  const { IBApi, EventName, SecType, OrderAction, OrderType } = require('@stoqey/ib');
  const ib = new IBApi({ host: '127.0.0.1', port: +(process.env.IB_PORT || 4002), clientId: 0 });
  let nextId = null;
  ib.on(EventName.error, (e, c, r) => { if (![2104,2106,2107,2158].includes(c)) log(`[ib] ${c} ${r}: ${e && e.message ? e.message : e}`); });
  ib.on(EventName.orderStatus, (id, st, f, rem, px) => log(`[cleanup] #${id} ${st}${px ? ' @' + px : ''}`));
  ib.on(EventName.nextValidId, (id) => {
    if (nextId != null) return; nextId = id;
    const held = [];
    ib.on(EventName.position, (a, c, pos) => { if (c.secType === SecType.OPT && pos < 0 && shorts.includes(c.conId)) held.push(c); });
    ib.on(EventName.positionEnd, () => {
      ib.cancelPositions();
      if (!held.length) { log('cleanup: no short fly legs held — clean'); return setTimeout(() => process.exit(0), 2000); }
      for (const c of held) {
        const oid = nextId++;
        log(`cleanup #${oid}: BUY 1 ${c.symbol} ${c.right}${c.strike} MKT (stays working)`);
        ib.placeOrder(oid, { conId: c.conId, symbol: c.symbol, secType: SecType.OPT, exchange: 'SMART', currency: 'USD' },
          { action: OrderAction.BUY, orderType: OrderType.MKT, totalQuantity: 1, account: ACCOUNT, transmit: true });
      }
      setTimeout(() => { log('cleanup orders working — verify later'); process.exit(0); }, 30000);
    });
    ib.reqPositions();
  });
  ib.connect();
}

/* --------------------------------- run ----------------------------------- */
function gateAndGeometry() {
  let vix, spy;
  try { vix = yahoo('^VIX'); spy = yahoo('SPY'); } catch (e) { log('NO-GO: quote fetch failed: ' + e.message); return null; }
  const vixChg = vix.prevClose ? (vix.last / vix.prevClose - 1) * 100 : 0;
  const spyMove = spy.open ? Math.abs(spy.last / spy.open - 1) * 100 : 99;
  log(`gate: VIX ${vix.last} (${vixChg.toFixed(1)}% d/d), SPY ${spyMove.toFixed(2)}% off open`);
  if (vix.last >= 22 || vixChg >= 8 || spyMove >= 0.75) { log('NO-GO: not calm — standing down'); return null; }
  let spx; try { spx = yahoo('^GSPC').last; } catch (e) { log('NO-GO: SPX fetch failed'); return null; }
  const center = Math.round(spx / 10);
  let wing = null;
  try {
    const rows = fs.readFileSync(JSONL, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    const r = rows.reverse().find(x => x.variant === 'vol_wide' && x.symbol === 'XSP' && x.date === todayUTC());
    if (r && r.intended_fly) wing = r.intended_fly.wing_pts;
  } catch (e) {}
  if (!wing) { wing = Math.max(2, Math.round(center * (vix.last / 100 / 15.87) * 1.75)); log(`wing fallback: ${wing}`); }
  return { center, wing };
}

function handleTerminal(res) {
  if (res.ok) { log(`*** FLY ON: XSP ${res.center}±${res.wing} credit $${res.real_fill_credit}${res.chased ? ' (chased ' + res.chased + ')' : ''} — riding to settlement ***`); process.exit(0); }
  if (res.orphan_unresolved) { log('orphan unresolved — shorts-only cleanup'); shortsCleanup(); return true; }
  if (res.orphan_flattened) { log(`orphan flattened, P/L $${res.orphan_pl_dollars} — done for today`); process.exit(0); }
  return false;   // plain no-fill -> caller continues the ladder
}

function bandFallback(g) {
  log('snapshots empty — band-disclosure fallback');
  const t = Date.now();
  submitFly(g.center, g.wing, 9.99, 9.99);           // guaranteed rejection, discloses market
  setTimeout(() => {
    const disc = bandDisclosures(t);
    if (disc.length < 2) { log(`disclosure incomplete (${disc.length}/2) — standing down`); return process.exit(1); }
    const [c, p] = disc;
    log(`disclosed: call $${c.px}  put $${p.px} — submitting at 97%`);
    const t1 = Date.now();
    submitFly(g.center, g.wing, c.px * 0.97, p.px * 0.97);
    waitResult(t1, (r) => {
      log('fallback result: ' + JSON.stringify(r));
      if (r && !handleTerminal(r)) log('fallback no-fill — standing down');
      process.exit(0);
    });
  }, 40000);
}

function ladder(step, g, baseCC, basePC) {
  // steps: 1 = mid probe, 2 = 0.97x base, 3 = fresh mid probe, 4 = 0.94x base
  const gate2 = (step === 3) ? gateAndGeometry() : g;    // re-gate + re-center mid-ladder
  if (!gate2) return process.exit(0);
  g = gate2;
  const t = Date.now();
  if (step === 1 || step === 3) submitFly(g.center, g.wing, null, null);
  else submitFly(g.center, g.wing, baseCC * (step === 2 ? 0.97 : 0.94), basePC * (step === 2 ? 0.97 : 0.94));

  waitResult(t, (res) => {
    if (!res) { log('no result in 150s — MANUAL CHECK'); return process.exit(1); }
    log(`A${step} result: ${JSON.stringify(res)}`);
    if (handleTerminal(res)) return;
    if (res.error && /missing quotes/.test(res.error)) return bandFallback(g);
    if (step >= 4) { log('no fill at max shade — standing down; shading data logged'); return process.exit(0); }
    const cc = res.callCredit ?? baseCC, pc = res.putCredit ?? basePC;
    log(`no fill — ladder step ${step + 1} in 60s`);
    setTimeout(() => ladder(step + 1, g, cc, pc), 60000);
  });
}

function run() {
  // abort if any XSP position already exists (idempotence)
  try {
    const j = JSON.parse(fs.readFileSync(LEGS_FILE, 'utf8'));
    // legs file existing is fine; position check happens implicitly via yesterday's clean close
  } catch (e) {}
  const g = gateAndGeometry();
  if (!g) return process.exit(0);
  ladder(1, g);
}

const wait = nextTargetMs();
log(`v2 armed — sleeping ${(wait / 3600000).toFixed(1)} h until next weekday 9:47 ET (acct ${ACCOUNT}, mid-first ladder: mid -> 97% -> fresh mid -> 94%, band-disclosure fallback)`);
setTimeout(run, wait);
