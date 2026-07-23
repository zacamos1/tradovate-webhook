#!/usr/bin/env node
/* pmtracker_feed_condor.js — IRON CONDOR variant, A/B companion to pmtracker_feed.js.
   READ-ONLY. Places no orders.

   The structural fork vs. the iron FLY:
     Fly    : short call & short put AT the money (center). Max credit, needs price to PIN.
     Condor : short call & short put OUT of the money (+/- SHORT_MULT * expected move).
              Less credit, but a wide profit ZONE instead of a profit POINT — wins as long
              as price stays in a range, which is exactly the "moved but finished off-center"
              case where the fly loses.

   Strikes (per instrument, expected-move-scaled so it self-sizes):
     em      = round(open * ivd)                 # expected 1-day move in points
     shorts  = center +/- round(SHORT_MULT*em)   # OTM short call / put
     wings   = shorts +/- round(WING_MULT_COND*em)  # long call / put beyond the shorts

   Uses market VIX (matches the live feed's single-vol convention) so this variant isolates
   ONE change vs. the baseline fly: ATM shorts -> OTM shorts. bs() + gate copied verbatim.
   Appends rows tagged variant:"condor" to the same log; settler scores them automatically.

   Cron after the feed, e.g. 8:42 CT:
     42 8 * * 1-5 cd /root/ibkr-webhook && /usr/bin/node pmtracker_feed_condor.js >> feed_condor.out 2>&1
*/

'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOG_FILE   = path.join(__dirname, 'pmtracker_multi_log.jsonl');
const CONTRACTS_N = 2;
const SHORT_MULT  = 1.0;   // short strikes at +/- 1.0 * expected move (wide profit zone vs the fly's point)
const WING_MULT_COND = 1.0; // long strikes 1.0 * expected move beyond the shorts
const VIX_GATE    = 30;
const ACCT        = 5000;

// ---- Black-Scholes (verbatim from pmtracker_feed.js: zero-rate, sst = sigma*sqrt(t)) ----
function ncdf(x){ return 0.5*(1+erf(x/Math.SQRT2)); }
function erf(x){
  const t=1/(1+0.3275911*Math.abs(x));
  const y=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x);
  return x>=0? y : -y;
}
function bs(S,K,sst,call){
  if(sst<=0) return call? Math.max(S-K,0):Math.max(K-S,0);
  const d1=(Math.log(S/K)+0.5*sst*sst)/sst, d2=d1-sst;
  return call? S*ncdf(d1)-K*ncdf(d2) : K*ncdf(-d2)-S*ncdf(-d1);
}

/* Iron condor: sell OTM call+put, buy further-OTM call+put.
   maxloss = widest single spread width - credit  (the call side and put side are equal
   width here, so max loss on either side = spreadWidth - credit). */
function modelCondor(open, vix){
  const ivd = vix/100/Math.sqrt(252);
  const em  = Math.max(1, Math.round(open * ivd));          // expected 1-day move, points
  const K   = Math.round(open);
  const shortOff = Math.max(1, Math.round(SHORT_MULT * em));
  const wingOff  = Math.max(1, Math.round(WING_MULT_COND * em));
  const sc = K + shortOff, sp = K - shortOff;               // OTM short call / put
  const lc = sc + wingOff, lp = sp - wingOff;               // long wings beyond shorts

  // credit = sold shorts - bought longs
  const credit = (bs(open,sc,ivd,true) + bs(open,sp,ivd,false))
               - (bs(open,lc,ivd,true) + bs(open,lp,ivd,false));
  const spreadWidth = wingOff;                              // each side is wingOff wide
  return { center:K, short_call:sc, short_put:sp, long_call:lc, long_put:lp,
    model_credit:+(credit*100).toFixed(2),
    model_maxloss:+((spreadWidth - credit)*100).toFixed(2),
    implied_1d_move_pct:+(ivd*100).toFixed(2),
    short_off:shortOff, wing_off:wingOff };
}

// ---- Yahoo VIX (same curl approach as the feed) ----------------------------
function curlJSON(url){
  return new Promise((resolve)=>{
    execFile('curl', ['-s','-H','User-Agent: Mozilla/5.0', url], {maxBuffer:1024*1024*5}, (err,stdout)=>{
      if(err){ resolve(null); return; }
      try{ resolve(JSON.parse(stdout)); }catch(e){ resolve(null); }
    });
  });
}
function retry(fn,tries=3,waitMs=1500){
  return (async()=>{ for(let i=0;i<tries;i++){ const r=await fn(); if(r!=null) return r; await new Promise(x=>setTimeout(x,waitMs)); } return null; })();
}
function yahooLast(sym){
  const enc=encodeURIComponent(sym);
  return retry(()=>curlJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${enc}?interval=1d&range=2d`).then(j=>{
    try{ const m=j.chart.result[0].meta; if(m && m.regularMarketPrice!=null) return +m.regularMarketPrice.toFixed(2);
         const c=j.chart.result[0].indicators.quote[0].close.filter(x=>x!=null); return c.length?+c[c.length-1].toFixed(2):null; }
    catch(e){ return null; }
  }));
}

function todayNY(){
  return new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
}

(async () => {
  const today = todayNY();
  if(!fs.existsSync(LOG_FILE)){ console.error('log not found'); process.exit(1); }
  const rows = fs.readFileSync(LOG_FILE,'utf8').split('\n').filter(l=>l.trim()).map(l=>JSON.parse(l));

  const base = rows.filter(r => r.date===today && r.variant==null);   // today's baseline fly rows
  if(!base.length){ console.log(`no baseline feed rows for ${today} yet — run after pmtracker_feed.js`); process.exit(0); }
  if(rows.some(r => r.date===today && r.variant==='condor')){ console.log(`condor variant already logged for ${today}`); process.exit(0); }

  const vix = await yahooLast('^VIX');
  if(vix==null){ console.error('could not fetch VIX; aborting'); process.exit(1); }
  const gateOk = vix <= VIX_GATE;

  console.log(`IRON CONDOR variant  ${today}   VIX=${vix}  (shorts +/-${SHORT_MULT}EM, wings ${WING_MULT_COND}EM)`);
  console.log('sym\topen\tshorts\t\twings\t\tcredit\tmaxloss\trisk\tpct');
  console.log('-'.repeat(84));

  let wrote=0; const out=[];
  for(const r of base){
    const fly = modelCondor(r.spot, vix);
    const risk = fly.model_maxloss * CONTRACTS_N;
    const rec = { date:today, symbol:r.symbol, note:r.note, variant:'condor',
      spot:r.spot, spot_src:r.spot_src, vix,
      gate_ok:gateOk, TRADE:gateOk, contracts:CONTRACTS_N, intended_fly:fly,
      capital_at_risk:+risk.toFixed(2), pct_acct:+(risk/ACCT*100).toFixed(1),
      real_fill_credit:null, real_pl:null, vix_close:null, gate_held:null, was_max_loss:null, notes:null };
    out.push(rec); wrote++;
    console.log([r.symbol, r.spot.toFixed(2), `${fly.short_put}/${fly.short_call}`,
      `${fly.long_put}/${fly.long_call}`, fly.model_credit.toFixed(0),
      fly.model_maxloss.toFixed(0), risk.toFixed(0), rec.pct_acct+'%'].join('\t'));
  }

  if(wrote){ fs.appendFileSync(LOG_FILE, out.map(r=>JSON.stringify(r)).join('\n')+'\n'); }
  console.log('='.repeat(84));
  console.log(`Logged ${wrote} condor rows to ${path.basename(LOG_FILE)}  (variant:"condor")`);
  console.log('Settler scores these automatically at 15:20 — flyPnL formula handles all four strikes.');
  process.exit(0);
})();
