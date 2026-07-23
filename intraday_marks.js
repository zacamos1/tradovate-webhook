#!/usr/bin/env node
/* intraday_marks.js — the real-marks profit-path tracker.
 *
 * Run by cron every 20 minutes during market hours. For each of today's vol +
 * vol_wide flies (XSP/SPY/IWM) in pmtracker_multi_log.jsonl:
 *   resolve legs -> snapshot REAL quotes (clientId 8, read-only, places nothing)
 *   -> fly value from mids -> P&L% of model credit -> append to fly_marks.jsonl
 *
 * Purpose: confirm (or refute) the 60-day model backtest's verdict that profit
 * builds into the close and hold-to-settle is near-optimal — with real marks.
 * Two weeks of rows re-runs the exit-rule sweep on truth instead of Black-Scholes.
 *
 * Row: { ts, date, variant, symbol, center, wing, model_credit, fly_value,
 *        pl_pct_of_credit, quotes_ok }
 *
 * Exits fast and silently outside market hours or when no rows exist —
 * cron-safe. One run ≈ 30-50s.
 *
 * Cron (every 20 min, 9:50 ET - 15:50 ET weekdays):
 *   50,10,30 13-19 * * 1-5 cd /root/ibkr-webhook && /usr/bin/node intraday_marks.js >> intraday_marks.out 2>&1
 *   (13:50 UTC first run = 9:50 ET; last full run 19:30, plus 19:50 = 15:50 ET)
 */
const fs = require('fs');
const path = require('path');
const { IBApi, EventName, SecType } = require('@stoqey/ib');

const JSONL = path.join(__dirname, 'pmtracker_multi_log.jsonl');
const OUT = path.join(__dirname, 'fly_marks.jsonl');
const HOST = process.env.IB_HOST || '127.0.0.1';
const PORT = +(process.env.IB_PORT || 4002);
const SYMS = ['XSP', 'SPY', 'IWM'];
const VARIANTS = ['vol', 'vol_wide'];
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

function todayUTC() {
  const n = new Date();
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}-${String(n.getUTCDate()).padStart(2, '0')}`;
}
function todayExpiry() { return todayUTC().replace(/-/g, ''); }

// market-hours guard: 13:35-20:05 UTC weekdays (covers EDT session with margin)
const now = new Date();
const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
if ([0, 6].includes(now.getUTCDay()) || mins < 13 * 60 + 35 || mins > 20 * 60 + 5) {
  process.exit(0);   // silent outside hours — cron-safe
}

let flies = [];
try {
  const rows = fs.readFileSync(JSONL, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  flies = rows.filter((r) => r.date === todayUTC() && VARIANTS.includes(r.variant)
    && SYMS.includes(r.symbol) && r.intended_fly && r.TRADE !== false);
} catch (e) { log('jsonl read failed: ' + e.message); process.exit(1); }
if (!flies.length) process.exit(0);   // feeds haven't run / holiday — silent

for (const f of flies) {
  const w = f.intended_fly.wing_pts, c = f.intended_fly.center;
  f._legs = {
    SC: { strike: c, right: 'C' }, LC: { strike: c + w, right: 'C' },
    SP: { strike: c, right: 'P' }, LP: { strike: c - w, right: 'P' },
  };
  f._quotes = {};
}

const ib = new IBApi({ host: HOST, port: PORT, clientId: 8 });
let reqCounter = 800000;
const cdMap = {}, snapMap = {};
const die = (c = 0) => { try { ib.disconnect(); } catch (e) {} process.exit(c); };
setTimeout(() => report('timeout'), 55000);

ib.on(EventName.error, (e, c, r) => {
  if ([2104, 2106, 2107, 2158, 200].includes(c)) return;
  log(`[ib] ${c} ${r}: ${e && e.message ? e.message : e}`);
});

ib.on(EventName.nextValidId, () => {
  for (const f of flies) for (const [k, leg] of Object.entries(f._legs)) {
    const reqId = reqCounter++;
    cdMap[reqId] = { f, k };
    ib.reqContractDetails(reqId, {
      symbol: f.symbol, secType: SecType.OPT, exchange: 'SMART', currency: 'USD',
      lastTradeDateOrContractMonth: todayExpiry(), strike: leg.strike, right: leg.right,
    });
  }
});

ib.on(EventName.contractDetails, (reqId, details) => {
  const m = cdMap[reqId];
  if (!m || m.done) return;
  if (details.contract.tradingClass !== m.f.symbol) return;
  m.done = true;
  const snapId = reqCounter++;
  snapMap[snapId] = m;
  ib.reqMktData(snapId, { conId: details.contract.conId, exchange: 'SMART', currency: 'USD', secType: SecType.OPT }, '', true, false);
});

ib.on(EventName.tickPrice, (reqId, field, price) => {
  const m = snapMap[reqId];
  if (!m) return;
  const q = (m.f._quotes[m.k] = m.f._quotes[m.k] || {});
  if (field === 1) q.bid = price;
  else if (field === 2) q.ask = price;
});

function mid(q) { return q && q.bid != null && q.ask != null && q.ask > 0 && q.bid >= 0 ? (q.bid + q.ask) / 2 : null; }

function report(reason) {
  if (report._ran) return; report._ran = true;
  let wrote = 0;
  for (const f of flies) {
    const q = f._quotes;
    const mids = { SC: mid(q.SC), LC: mid(q.LC), SP: mid(q.SP), LP: mid(q.LP) };
    const ok = Object.values(mids).every((v) => v != null);
    const perShare = ok ? (mids.SC - mids.LC) + (mids.SP - mids.LP) : null;   // current fly value
    // model_credit in the jsonl is PER-CONTRACT dollars (package = credit x contracts,
    // verified against settled real_pl ratios) — use directly:
    const perContractCredit = f.intended_fly.model_credit;
    const flyValue = ok ? +(perShare * 100).toFixed(2) : null;                 // $ per contract
    const plPct = ok ? +(((perContractCredit - flyValue) / perContractCredit) * 100).toFixed(1) : null;
    try {
      fs.appendFileSync(OUT, JSON.stringify({
        ts: new Date().toISOString(), date: todayUTC(), variant: f.variant, symbol: f.symbol,
        center: f.intended_fly.center, wing: f.intended_fly.wing_pts,
        model_credit_per_ct: +perContractCredit.toFixed(2),
        fly_value: flyValue, pl_pct_of_credit: plPct, quotes_ok: ok,
      }) + '\n');
      wrote++;
    } catch (e) { log('write failed: ' + e.message); }
  }
  log(`marks written: ${wrote}/${flies.length}${reason ? ' (' + reason + ')' : ''}`);
  die();
}

setTimeout(() => report(), 40000);
ib.connect();
