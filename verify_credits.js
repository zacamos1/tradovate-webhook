#!/usr/bin/env node
/* verify_credits.js — THE number that grades the paper track record.
 *
 * Self-arms for the next weekday 9:44 ET (2 min after the vol_wide feed, 3 min
 * before the autotest). For each of today's vol + vol_wide rows (XSP, SPY, IWM):
 *   1. read intended_fly (center, wings, model_credit) from pmtracker_multi_log.jsonl
 *   2. resolve the 4 legs and snapshot REAL quotes over the IB connection
 *      (clientId 7 — data sharing to DUN460366 makes this possible now)
 *   3. print model credit vs real market mid, per fly:  ratio = real / model
 *
 * That ratio, averaged over a week of mornings, is the honest haircut on every
 * model-credit P&L number in the tracker. Read-only: resolves contracts and
 * requests snapshots, places NOTHING.
 *
 * Results append to credit_verification.jsonl and print to the pm2 log.
 * Launch:  pm2 start verify_credits.js --name verify-credits --no-autorestart
 * (Re-arm each day you want a reading: pm2 restart verify-credits)
 */
const fs = require('fs');
const path = require('path');
const { IBApi, EventName, SecType } = require('@stoqey/ib');

const TARGET = { h: 13, m: 44 };   // UTC = 9:44 ET
const JSONL = path.join(__dirname, 'pmtracker_multi_log.jsonl');
const OUT = path.join(__dirname, 'credit_verification.jsonl');
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
function nextTargetMs() {
  const now = new Date();
  let t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), TARGET.h, TARGET.m, 0));
  if (t <= now) t = new Date(t.getTime() + 24 * 3600 * 1000);
  while ([0, 6].includes(t.getUTCDay())) t = new Date(t.getTime() + 24 * 3600 * 1000);
  return t.getTime() - now.getTime();
}

function run() {
  // gather today's fly definitions
  let flies = [];
  try {
    const rows = fs.readFileSync(JSONL, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    flies = rows.filter((r) => r.date === todayUTC() && VARIANTS.includes(r.variant)
      && SYMS.includes(r.symbol) && r.intended_fly && r.TRADE !== false);
  } catch (e) { log('jsonl read failed: ' + e.message); return process.exit(1); }
  if (!flies.length) { log('no fly rows for today yet — did the feeds run?'); return process.exit(1); }
  log(`verifying ${flies.length} flies against live market...`);

  const ib = new IBApi({ host: HOST, port: PORT, clientId: 7 });
  let reqCounter = 700000;
  const cdMap = {};     // reqId -> {fly, legKey}
  const snapMap = {};   // reqId -> {fly, legKey}
  const done = [];
  const die = (m, c = 0) => { if (m) log(m); try { ib.disconnect(); } catch (e) {} process.exit(c); };
  setTimeout(() => finishReport('overall timeout (75s) — reporting what resolved'), 75000);

  ib.on(EventName.error, (e, c, r) => {
    if ([2104, 2106, 2107, 2158].includes(c)) return;
    if (c === 200) return;                     // no security definition — logged via missing quote
    log(`[ib] ${c} ${r}: ${e && e.message ? e.message : e}`);
  });

  // per-fly working state
  for (const f of flies) {
    const ifly = f.intended_fly;
    const center = ifly.center;
    const wC = ifly.strikes ? null : ifly.wing_pts;   // vol rows carry wing_pts; condor-style rows carry strikes
    f._legs = ifly.strikes && ifly.strikes.long_call ? {
      SC: { strike: ifly.strikes.short || center, right: 'C' },
      LC: { strike: ifly.strikes.long_call, right: 'C' },
      SP: { strike: ifly.strikes.short || center, right: 'P' },
      LP: { strike: ifly.strikes.long_put, right: 'P' },
    } : {
      SC: { strike: center, right: 'C' },
      LC: { strike: center + ifly.wing_pts, right: 'C' },
      SP: { strike: center, right: 'P' },
      LP: { strike: center - ifly.wing_pts, right: 'P' },
    };
    f._quotes = {};
  }

  ib.on(EventName.nextValidId, () => {
    for (const f of flies) {
      for (const [k, leg] of Object.entries(f._legs)) {
        const reqId = reqCounter++;
        cdMap[reqId] = { f, k };
        ib.reqContractDetails(reqId, {
          symbol: f.symbol, secType: SecType.OPT, exchange: 'SMART', currency: 'USD',
          lastTradeDateOrContractMonth: todayExpiry(), strike: leg.strike, right: leg.right,
        });
      }
    }
  });

  ib.on(EventName.contractDetails, (reqId, details) => {
    const m = cdMap[reqId];
    if (!m) return;
    const c = details.contract;
    if (c.tradingClass !== m.f.symbol) return;          // trading-class guard, same as fly_exec
    if (m.done) return;
    m.done = true;
    const snapId = reqCounter++;
    snapMap[snapId] = m;
    ib.reqMktData(snapId, { conId: c.conId, exchange: 'SMART', currency: 'USD', secType: SecType.OPT }, '', true, false);
  });

  ib.on(EventName.tickPrice, (reqId, field, price) => {
    const m = snapMap[reqId];
    if (!m) return;
    const q = (m.f._quotes[m.k] = m.f._quotes[m.k] || {});
    if (field === 1) q.bid = price;
    else if (field === 2) q.ask = price;
  });

  function mid(q) { return q && q.bid != null && q.ask != null && q.ask > 0 && q.bid >= 0 ? (q.bid + q.ask) / 2 : null; }

  function finishReport(reason) {
    if (finishReport._ran) return; finishReport._ran = true;
    if (reason) log(reason);
    console.log('\nvariant     sym   fly          model$   market$   ratio');
    console.log('-'.repeat(60));
    for (const f of flies) {
      const q = f._quotes;
      const mids = { SC: mid(q.SC), LC: mid(q.LC), SP: mid(q.SP), LP: mid(q.LP) };
      let market = null;
      if (Object.values(mids).every((v) => v != null)) {
        market = +(((mids.SC - mids.LC) + (mids.SP - mids.LP)) * 100 * (f.contracts || 1)).toFixed(2);
      }
      const model = +(f.intended_fly.model_credit * (f.contracts || 1)).toFixed(2);
      const ratio = market != null && model ? (market / model).toFixed(3) : 'n/a';
      console.log(`${f.variant.padEnd(11)} ${f.symbol.padEnd(5)} ${(f.intended_fly.center + '±' + (f.intended_fly.wing_pts || '?')).padEnd(12)} ${String(model).padEnd(8)} ${String(market ?? 'no quotes').padEnd(9)} ${ratio}`);
      try {
        fs.appendFileSync(OUT, JSON.stringify({ ts: new Date().toISOString(), date: todayUTC(),
          variant: f.variant, symbol: f.symbol, center: f.intended_fly.center, wing: f.intended_fly.wing_pts,
          contracts: f.contracts || 1, model_credit: model, market_credit: market,
          ratio: market != null && model ? +(market / model).toFixed(4) : null }) + '\n');
      } catch (e) { log('write failed: ' + e.message); }
    }
    console.log('\nratio = real market / tracker model. ~1.00 = paper P&L is honest; <1 = haircut factor.');
    die();
  }

  // give snapshots ~45s after connect, then report whatever arrived
  setTimeout(() => finishReport(), 50000);
  ib.connect();
}

const wait = nextTargetMs();
log(`verify-credits armed — sleeping ${(wait / 3600000).toFixed(1)} h until next weekday 9:44 ET (read-only: model vs market credit ratios)`);
setTimeout(run, wait);
