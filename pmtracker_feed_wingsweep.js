#!/usr/bin/env node
/* pmtracker_feed_wingsweep.js — WING-WIDTH SWEEP feed (Layer-1 research)
 *
 * Logs a premium fly on each index ticker at SEVERAL wing widths per day, so real
 * settlement decides the optimal wing rather than a model. One row per (ticker,wing).
 *
 * Tag: variant:"wingsweep"  +  wing_pct field  (so the settler & tallies can group by wing)
 * Sizing: 1 CONTRACT (clean per-wing structure comparison; contract count is a separate decision)
 *
 * Tailored width sets (from the recalibrated 18mo EV sweep against real credits):
 *   SPY / XSP : 1.5 / 2.0 / 2.5   (S&P optimum ~1.5-2.0)
 *   IWM       : 2.0 / 2.5 / 3.0   (wilder, optimum ~3.0)
 *   QQQ       : 2.0 / 2.5 / 3.0   (wildest; peak ~2.5, 3.0 to confirm roll-off)
 *
 * Reuses the SAME row schema as pmtracker_feed.js so the existing settler
 * (generic flyPnL over 4 strikes) scores these rows automatically at 15:20.
 *
 * Spot sources mirror the other feeds:
 *   ETFs (SPY/QQQ/IWM) via IB reqMktData ; index (XSP) via Yahoo ^GSPC/10.
 *
 * Gated in cron by trading_day.js so it never fires on a closed market.
 */
'use strict';

const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

// ---- config ----
const LOG = path.join(__dirname, 'pmtracker_multi_log.jsonl');
const ACCT = 5000;
const CONTRACTS_N = 1;            // 1 contract: comparing wings, not sizes
const VIX_GATE = 30;             // skip logging TRADE:true above this (still logs row)
const IB_HOST = '127.0.0.1';
const IB_PORT = 4002;
const CLIENT_ID = 78;            // distinct from other feeds (feed=77)

// per-ticker wing-width sets (percent of spot)
const WING_SETS = {
  SPY: [1.5, 2.0, 2.5],
  XSP: [1.5, 2.0, 2.5],
  IWM: [2.0, 2.5, 3.0],
  QQQ: [2.0, 2.5, 3.0],
};

// which tickers use IB (ETF) vs Yahoo (index)
const ETF = ['SPY', 'QQQ', 'IWM'];
const YahooSrc = { XSP: '^GSPC' };   // XSP = S&P/10

const today = new Date().toISOString().slice(0, 10);

// ---- Black-Scholes (zero-rate, sst = sigma*sqrt(t)) — same as pmtracker_feed.js ----
function ncdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function bs(S, K, sst, call) {
  if (sst <= 0) return call ? Math.max(S - K, 0) : Math.max(K - S, 0);
  const d1 = (Math.log(S / K) + 0.5 * sst * sst) / sst;
  const d2 = d1 - sst;
  return call ? S * ncdf(d1) - K * ncdf(d2) : K * ncdf(-d2) - S * ncdf(-d1);
}

// build a fly at a given wing width (in % of spot). Mirrors modelFly() schema.
function modelFly(spot, ivPct, wingPct) {
  const K = Math.round(spot);
  const W = Math.max(1, Math.round(spot * wingPct / 100));
  const ivd = ivPct / 100 / Math.sqrt(252);   // 0DTE: 1 day
  const sst = ivd; // sqrt(1 day) = 1
  // short straddle at K, long wings at K±W
  const shortCall = bs(spot, K, sst, true);
  const shortPut = bs(spot, K, sst, false);
  const longCall = bs(spot, K + W, sst, true);
  const longPut = bs(spot, K - W, sst, false);
  const credit = (shortCall + shortPut - longCall - longPut) * 100 * CONTRACTS_N;
  const maxloss = (W * 100 * CONTRACTS_N) - credit;
  return {
    center: K, wing_pts: W, wing_pct: wingPct,
    strikes: { short: K, long_call: K + W, long_put: K - W },
    model_credit: +credit.toFixed(2),
    model_maxloss: +maxloss.toFixed(2),
  };
}

// ---- spot fetchers ----
function yahooSpot(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`;
  const out = execSync(`curl -s -H 'User-Agent: Mozilla/5.0' '${url}'`, { encoding: 'utf8' });
  const j = JSON.parse(out);
  const p = j.chart.result[0].meta.regularMarketPrice;
  if (!p) throw new Error('no price');
  return p;
}

async function ibSpots(symbols) {
  // returns {sym: openPrice}. Uses reqMktData like pmtracker_feed.js.
  const { IBApi, EventName } = require('@stoqey/ib');
  const ib = new IBApi({ host: IB_HOST, port: IB_PORT, clientId: CLIENT_ID });
  const got = {};
  return await new Promise((resolve) => {
    const done = () => { try { ib.disconnect(); } catch (e) {} resolve(got); };
    const timer = setTimeout(done, 12000);
    ib.on(EventName.connected, () => {
      symbols.forEach((sym, i) => {
        const c = { symbol: sym, secType: 'STK', exchange: 'SMART', currency: 'USD' };
        ib.reqMktData(1000 + i, c, '', false, false);
      });
    });
    ib.on(EventName.tickPrice, (id, field, price) => {
      // field 4=last, 9=close, 14=open ; accept last/close as spot proxy
      if (price > 0) {
        const sym = symbols[id - 1000];
        if (sym && !got[sym]) got[sym] = price;
        if (Object.keys(got).length === symbols.length) { clearTimeout(timer); done(); }
      }
    });
    ib.on(EventName.error, () => {});
    ib.connect();
  });
}

// crude IV proxy per ticker for the credit model (annualized %). VIX-family levels.
// (This only affects MODELED credit; real fills are what the settler scores.)
const IV_PROXY = { SPY: 17, XSP: 17, QQQ: 22, IWM: 20 };

(async () => {
  const rows = [];
  const spots = {};

  // fetch ETF spots via IB
  try {
    const ibgot = await ibSpots(ETF);
    Object.assign(spots, ibgot);
  } catch (e) {
    console.log('IB spot fetch failed:', e.message);
  }
  // fetch index spots via Yahoo
  for (const [sym, ysrc] of Object.entries(YahooSrc)) {
    try {
      let p = yahooSpot(ysrc);
      if (sym === 'XSP') p = p / 10;
      spots[sym] = +p.toFixed(2);
    } catch (e) {
      console.log(`${sym} Yahoo spot failed:`, e.message);
    }
  }

  console.log(`\nWING SWEEP  ${today}  (1 contract)`);
  console.log('sym   spot     wing%  center  credit  maxloss');
  console.log('-'.repeat(60));

  for (const sym of Object.keys(WING_SETS)) {
    const spot = spots[sym];
    if (!spot) { console.log(`${sym}\t(no spot — skipped)`); continue; }
    const iv = IV_PROXY[sym];
    for (const wp of WING_SETS[sym]) {
      const fly = modelFly(spot, iv, wp);
      const risk = fly.model_maxloss;
      const rec = {
        date: today, symbol: sym, variant: 'wingsweep', wing_pct: wp,
        spot, spot_src: ETF.includes(sym) ? 'IB' : 'YH',
        iv_proxy: iv, contracts: CONTRACTS_N,
        intended_fly: fly,
        capital_at_risk: +risk.toFixed(2),
        pct_acct: +(risk / ACCT * 100).toFixed(2),
        TRADE: iv <= VIX_GATE,
        real_fill_credit: null, real_pl: null, vix_close: null,
        gate_held: null, was_max_loss: null, notes: null,
      };
      rows.push(rec);
      console.log(`${sym.padEnd(4)} ${spot.toFixed(2).padStart(8)}  ${wp.toFixed(1)}%   ${fly.center}   ${fly.model_credit.toFixed(0).padStart(5)}   ${fly.model_maxloss.toFixed(0).padStart(6)}`);
    }
  }

  if (!rows.length) { console.log('no rows to log (no spots).'); return; }

  // append atomically-ish
  const lines = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(LOG, lines);
  console.log('-'.repeat(60));
  console.log(`Logged ${rows.length} wingsweep rows to ${LOG}`);
  console.log('Settler scores these at 15:20 (variant:"wingsweep", grouped by wing_pct).');
})();
