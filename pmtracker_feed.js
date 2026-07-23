#!/usr/bin/env node
/* pmtracker_feed.js — Layer-1 spot feed + tracker logger. READ-ONLY. Places no orders.
   ETFs (SPY/QQQ/IWM): open via reqMktData live snapshot (historical bars don't serve on
   this paper Gateway; live data does — matches server.js). Indexes (SPX/XSP) + VIX: curl
   to Yahoo. Gate = skip VIX>30. clientId 77. */

const { IBApi, EventName } = require('@stoqey/ib');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const GW_HOST   = process.env.TWS_HOST || '127.0.0.1';
const GW_PORT   = parseInt(process.env.TWS_PORT || '4002', 10);
const CLIENT_ID = parseInt(process.env.IB_FEED_CLIENT_ID || '77', 10);
const LOG_FILE  = path.join(__dirname, 'pmtracker_multi_log.jsonl');

const CONTRACTS_N = 2;
const WING_PCT    = 0.020;
const VIX_GATE    = 30;
const ACCT        = 5000;

const ETF_UNIVERSE = [
  { sym:'SPY', note:'liquid sibling; American, assignable',  secType:'STK', exchange:'SMART', currency:'USD' },
  { sym:'QQQ', note:'weaker premium (Nasdaq realizes more)', secType:'STK', exchange:'SMART', currency:'USD' },
  { sym:'IWM', note:'smallest credit; low priority',         secType:'STK', exchange:'SMART', currency:'USD' },
];

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
function modelFly(open, vix){
  const ivd = vix/100/Math.sqrt(252);
  const K = Math.round(open), W = Math.round(open*WING_PCT);
  const credit = (bs(open,K,ivd,true)+bs(open,K,ivd,false))
               - (bs(open,K+W,ivd,true)+bs(open,K-W,ivd,false));
  return { center:K, short_call:K, short_put:K, long_call:K+W, long_put:K-W,
    model_credit:+(credit*100).toFixed(2), model_maxloss:+((W-credit)*100).toFixed(2),
    implied_1d_move_pct:+(ivd*100).toFixed(2) };
}

function curlJSON(url){
  return new Promise((resolve)=>{
    execFile('curl', ['-s','-H','User-Agent: Mozilla/5.0', url], {maxBuffer:1024*1024*5}, (err,stdout)=>{
      if(err){ resolve(null); return; }
      try{ resolve(JSON.parse(stdout)); }catch(e){ resolve(null); }
    });
  });
}
async function retry(fn,tries=3,waitMs=1500){
  for(let i=0;i<tries;i++){ const r=await fn(); if(r!=null) return r; await new Promise(x=>setTimeout(x,waitMs)); }
  return null;
}
function yahooOpen(sym){
  return retry(()=>curlJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=2d`).then(j=>{
    try{ const q=j.chart.result[0].indicators.quote[0].open.filter(x=>x!=null); return q.length?+q[q.length-1].toFixed(2):null; }catch(e){ return null; }
  }));
}
function yahooLastClose(sym){
  return retry(()=>curlJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`).then(j=>{
    try{ const c=j.chart.result[0].indicators.quote[0].close.filter(x=>x!=null); return c.length?+c[c.length-1].toFixed(2):null; }catch(e){ return null; }
  }));
}

function pullETFOpens(ib){
  return new Promise((resolve)=>{
    const opens={}; let pending=ETF_UNIVERSE.length; const byReq={}; let settled=false;
    const onTick=(reqId, field, value)=>{
      if(byReq[reqId]===undefined) return;
      if((field===14||field===75) && value!=null && value>0 && opens[byReq[reqId]]===undefined){
        opens[byReq[reqId]]=value; mark(reqId);
      }
    };
    const seen={};
    const mark=(reqId)=>{ if(!seen[reqId]){ seen[reqId]=true; if(--pending<=0) finish(); } };
    const finish=()=>{ if(settled) return; settled=true; cleanup(); resolve(opens); };
    function cleanup(){ ib.off(EventName.tickPrice,onTick); ETF_UNIVERSE.forEach((u,i)=>{ try{ ib.cancelMktData(2000+i); }catch(e){} }); }
    try{ ib.reqMarketDataType(3); }catch(e){}
    ib.on(EventName.tickPrice,onTick);
    ETF_UNIVERSE.forEach((u,i)=>{
      const reqId=2000+i; byReq[reqId]=u.sym;
      const c={ symbol:u.sym, secType:u.secType, exchange:u.exchange, currency:u.currency };
      ib.reqMktData(reqId, c, '', false, false);
    });
    setTimeout(finish, 12000);
  });
}

(async function main(){
  const today=new Date().toISOString().slice(0,10);
  const vix=await yahooLastClose('%5EVIX');
  if(vix==null){ console.error(`[${today}] VIX pull failed after retries — aborting (no gate without VIX).`); process.exit(1); }

  let spx = await yahooOpen('%5EGSPC');
  let spxSrc = 'YH:open';
  if(spx==null){ spx = await yahooLastClose('%5EGSPC'); spxSrc='YH:close'; }

  const ib=new IBApi({ host:GW_HOST, port:GW_PORT, clientId:CLIENT_ID });
  let connected=false;
  ib.on(EventName.connected,()=>{ connected=true; });
  ib.on(EventName.error,(err,code,reqId)=>{ if(reqId===-1) console.error(`[${today}] IB error ${code}: ${err && err.message? err.message:err}`); });
  ib.connect();
  await new Promise(r=>setTimeout(r,2500));
  if(!connected) console.error(`[${today}] Not connected to Gateway ${GW_HOST}:${GW_PORT} (clientId ${CLIENT_ID}).`);
  const etfOpens=await pullETFOpens(ib);
  try{ ib.disconnect(); }catch(e){}

  const rows=[];
  if(spx!=null){
    rows.push({ sym:'XSP', note:'PRIMARY trade vehicle (SPX/10)', open:+(spx/10).toFixed(2), src:spxSrc+'/10' });
    rows.push({ sym:'SPX', note:'10x XSP size; reference only on $5k', open:+spx.toFixed(2), src:spxSrc });
  } else {
    console.error(`[${today}] SPX pull failed — XSP/SPX rows skipped this run.`);
  }
  for(const u of ETF_UNIVERSE){
    const o=etfOpens[u.sym];
    rows.push({ sym:u.sym, note:u.note, open:(o!=null?+o.toFixed(2):null), src:(o!=null?'IB':'MISSING') });
  }

  const gateOk=vix<=VIX_GATE;
  console.log('='.repeat(76));
  console.log(`PM FEED  ${today}  | VIX ${vix}  | gate ${gateOk?'OPEN':'CLOSED (VIX>'+VIX_GATE+')'}`);
  console.log('='.repeat(76));
  console.log(['inst','open','fly','credit','maxloss',`risk${CONTRACTS_N}x`,'%acct','src'].join('\t'));

  let wrote=0;
  for(const r of rows){
    if(r.open==null){ console.log(`${r.sym}\t(no open — ${r.src}; Gateway up + live data?)`); continue; }
    const fly=modelFly(r.open,vix); const risk=fly.model_maxloss*CONTRACTS_N;
    const rec={ date:today, symbol:r.sym, note:r.note, spot:r.open, spot_src:r.src, vix,
      gate_ok:gateOk, TRADE:gateOk, contracts:CONTRACTS_N, intended_fly:fly,
      capital_at_risk:+risk.toFixed(2), pct_acct:+(risk/ACCT*100).toFixed(1),
      real_fill_credit:null, real_pl:null, vix_close:null, gate_held:null, was_max_loss:null, notes:null };
    fs.appendFileSync(LOG_FILE, JSON.stringify(rec)+'\n'); wrote++;
    console.log([r.sym, r.open.toFixed(2), `${fly.short_call}pm${fly.long_call-fly.center}`,
      fly.model_credit.toFixed(0), fly.model_maxloss.toFixed(0), risk.toFixed(0), rec.pct_acct+'%', r.src].join('\t'));
  }
  console.log('='.repeat(76));
  console.log(`Logged ${wrote}/5 instruments to ${LOG_FILE}`);
  console.log('EOD: fill real_fill_credit / real_pl / vix_close / gate_held / was_max_loss per row.');
  process.exit(0);
})();
