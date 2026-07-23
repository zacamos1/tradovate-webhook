#!/usr/bin/env node
/* pmtracker_feed_vol1d.js — VOL-SCALED variant using VIX1D (1-DAY expected move).
 *
 * A/B companion to pmtracker_feed_vol.js. IDENTICAL mechanism (wings = round(open *
 * ivd * WING_MULT), same contracts, same gate) — the ONLY difference from the "vol"
 * variant is the VOLATILITY INPUT:
 *     vol      -> ^VIX   (30-day S&P implied vol)      <- current variant
 *     vol_1d   -> ^VIX1D (1-DAY S&P implied vol)       <- THIS feed
 *
 * WHY: the flies are 0DTE (held one day), so a 1-day vol measure (VIX1D) is
 * horizon-matched, whereas 30-day VIX is a longer-horizon proxy. This tests
 * whether the better-matched input tightens the edge.
 *
 * SCOPE: SPY + XSP only. VIX1D is built from SPX 0DTE options, so it is the correct
 * 1-day vol for S&P-tracking instruments. There is no clean 1-day Russell index, and
 * QQQ is being retired — so this feed deliberately covers only the S&P names, giving a
 * clean same-ticker A/B against the "vol" variant.
 *
 * Piggybacks on the fixed feed's rows for today (same spots/centers/gate), re-flies at
 * VIX1D-scaled widths. Appends rows tagged variant:"vol_1d" to the same log.
 * Settler needs NO changes (same top-level fly schema as "vol").
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ---- config (mirrors pmtracker_feed_vol.js) ----
const LOG_FILE   = path.join(__dirname, 'pmtracker_multi_log.jsonl');
const CONTRACTS_N = 2;
const WING_MULT   = 1.25;      // wings at 1.25x the expected 1-day move (same as vol)
const VIX_GATE    = 30;
const MULT        = 100;

// VIX1D is S&P-specific -> applies to SPY and XSP only
const VOL_SRC = { SPY:'^VIX1D', XSP:'^VIX1D' };
const SCOPE   = new Set(['SPY','XSP']);

const today = new Date().toISOString().slice(0,10);

// ---- Black-Scholes (verbatim from pmtracker_feed.js) ----
function ncdf(x){ return 0.5*(1+erf(x/Math.SQRT2)); }
function erf(x){
  const t=1/(1+0.3275911*Math.abs(x));
  const y=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x);
  return x>=0?y:-y;
}
function bs(S,K,sst,call){
  if(sst<=0) return call?Math.max(S-K,0):Math.max(K-S,0);
  const d1=(Math.log(S/K)+0.5*sst*sst)/sst, d2=d1-sst;
  return call ? S*ncdf(d1)-K*ncdf(d2) : K*ncdf(-d2)-S*ncdf(-d1);
}

// build a vol-scaled fly (identical to vol feed's modelFly)
function modelFly(spot, volPct){
  const K = Math.round(spot);
  const ivd = volPct/100/Math.sqrt(252);         // annualized -> 1-day sigma
  const W = Math.max(1, Math.round(spot * ivd * WING_MULT));
  const sst = ivd;                                // 0DTE: t = 1 day
  const shortCall = bs(spot, K, sst, true);
  const shortPut  = bs(spot, K, sst, false);
  const longCall  = bs(spot, K+W, sst, true);
  const longPut   = bs(spot, K-W, sst, false);
  const credit  = (shortCall + shortPut - longCall - longPut) * MULT * CONTRACTS_N;
  const maxloss = (W * MULT * CONTRACTS_N) - credit;
  return {
    center:K, short_call:K, short_put:K, long_call:K+W, long_put:K-W,
    model_credit:+credit.toFixed(2), model_maxloss:+maxloss.toFixed(2),
    implied_1d_move_pct:+(ivd*100).toFixed(2), wing_pts:W,
  };
}

// ---- Yahoo latest index value (VIX1D) ----
function curlJSON(url){
  const out = execSync(`curl -s -H 'User-Agent: Mozilla/5.0' '${url}'`, {encoding:'utf8'});
  return JSON.parse(out);
}
function yahooLast(sym){
  const enc = encodeURIComponent(sym);
  const j = curlJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${enc}?interval=1d&range=2d`);
  const meta = j.chart.result[0].meta;
  const p = meta.regularMarketPrice;
  if(p==null) throw new Error(`no value for ${sym}`);
  return p;
}

(function main(){
  const lines = fs.readFileSync(LOG_FILE,'utf8').split('\n').filter(l=>l.trim());
  const rows = lines.map(l=>JSON.parse(l));

  // piggyback on today's fixed rows (variant==null), but ONLY the S&P names in scope
  const base = rows.filter(r => r.date===today && r.variant==null && SCOPE.has(r.symbol));

  if(!base.length){ console.log(`no in-scope fixed rows for ${today} yet (need SPY/XSP) — run after fixed feed.`); process.exit(0); }
  if(rows.some(r => r.date===today && r.variant==='vol_1d')){ console.log(`vol_1d already logged for ${today}`); process.exit(0); }

  // fetch VIX1D once
  let vix1d;
  try { vix1d = yahooLast('^VIX1D'); }
  catch(e){ console.log('VIX1D fetch failed:', e.message); process.exit(1); }

  console.log(`VOL-SCALED (VIX1D)  ${today}   VIX1D=${vix1d}  (WING_MULT=${WING_MULT})`);
  console.log('sym\topen\tvol1d\twings\tcredit\tmaxloss\trisk');

  let wrote=0;
  const out=[];
  for(const r of base){
    const volPct = vix1d;
    const fly = modelFly(r.spot, volPct);
    const gateOk = volPct <= VIX_GATE;
    const risk = fly.model_maxloss;
    const rec = { date:today, symbol:r.symbol, note:r.note, variant:'vol_1d',
      spot:r.spot, spot_src:r.spot_src, vol_pct:volPct, vol_src:'^VIX1D',
      gate_ok:gateOk, TRADE:gateOk, contracts:CONTRACTS_N, intended_fly:fly,
      capital_at_risk:+risk.toFixed(2), pct_acct:+(risk/5000*100).toFixed(2),
      real_fill_credit:null, real_pl:null, vix_close:null, gate_held:null,
      was_max_loss:null, notes:null };
    out.push(JSON.stringify(rec));
    console.log(`${r.symbol}\t${r.spot}\t${volPct}\t${fly.center}pm${fly.wing_pts}\t${fly.model_credit.toFixed(0)}\t${fly.model_maxloss.toFixed(0)}\t${risk.toFixed(0)}`);
    wrote++;
  }

  fs.appendFileSync(LOG_FILE, out.join('\n')+'\n');
  console.log(`Logged ${wrote} vol_1d rows to ${path.basename(LOG_FILE)}  (variant:"vol_1d")`);
})();
