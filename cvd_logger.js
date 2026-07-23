#!/usr/bin/env node
/* cvd_logger.js — Layer-1 ORDER-FLOW logger for MES. READ-ONLY. Places no orders.
   Listens to tick-by-tick trades, infers aggressor side from bid/ask, computes:
     - running CVD (cumulative volume delta)
     - per-bar delta (5-min buckets)
     - price at bar open/close alongside delta, so you can see LEAD vs LAG
   Logs one JSON line per completed 5-min bar to cvd_log.jsonl, and prints live.
   clientId 88 (clear of webhook 1000-9999, tracker 77, diagnostics 78-82).

   PURPOSE: answer ONE question before any trading —
   does CVD/delta LEAD price (divergences precede reversals) or just LAG it?
   If it leads, order-flow automation has promise. If it lags, it's noise. */

const { IBApi, EventName, SecType } = require('@stoqey/ib');
const fs = require('fs');
const path = require('path');

const GW_HOST   = process.env.TWS_HOST || '127.0.0.1';
const GW_PORT   = parseInt(process.env.TWS_PORT || '4002', 10);
const CLIENT_ID = 88;
const SYMBOL    = process.env.OF_SYMBOL || 'MES';
const EXCHANGE  = 'CME';
const LOG_FILE  = path.join(__dirname, 'cvd_log.jsonl');
const BAR_MS    = 5*60*1000;   // 5-minute buckets

let ib;
let bid=null, ask=null;                 // current top-of-book (for aggressor inference)
let cvd=0;                              // running cumulative volume delta
let bar=null;                           // current bar accumulator
let gotAnyTick=false;
let denied=false;

function log(msg){ console.log(`[${new Date().toISOString()}] ${msg}`); }

function newBar(ts, px){
  return { start:ts, openPx:px, closePx:px, hi:px, lo:px,
           buyVol:0, sellVol:0, neutVol:0, delta:0, trades:0, cvdAtClose:0 };
}
function flushBar(){
  if(!bar) return;
  bar.cvdAtClose = cvd;
  const rec = {
    ts: new Date(bar.start).toISOString(),
    sym: SYMBOL,
    openPx: bar.openPx, closePx: bar.closePx, hi: bar.hi, lo: bar.lo,
    priceChg: +(bar.closePx-bar.openPx).toFixed(2),
    barDelta: bar.delta, buyVol: bar.buyVol, sellVol: bar.sellVol, neutVol: bar.neutVol,
    trades: bar.trades, cvd: +cvd.toFixed(0),
    // the KEY diagnostic: did delta and price move the SAME direction this bar?
    // agree = delta and price both + or both - (flow confirmed the move / lagged)
    // diverge = opposite signs (flow LED against the price move — the interesting case)
    agree: (Math.sign(bar.delta)===Math.sign(bar.closePx-bar.openPx))
  };
  fs.appendFileSync(LOG_FILE, JSON.stringify(rec)+'\n');
  const arrow = bar.closePx>bar.openPx?'UP  ':bar.closePx<bar.openPx?'DOWN':'FLAT';
  const tag = rec.agree ? 'agree ' : 'DIVERGE';
  log(`BAR ${SYMBOL} ${arrow} px ${bar.openPx}->${bar.closePx} (${rec.priceChg>=0?'+':''}${rec.priceChg}) | delta ${bar.delta>=0?'+':''}${bar.delta} (buy ${bar.buyVol}/sell ${bar.sellVol}) | CVD ${rec.cvd} | ${tag}`);
}

function onTrade(price, size){
  gotAnyTick=true;
  const now=Date.now();
  const bucket=Math.floor(now/BAR_MS)*BAR_MS;
  if(!bar){ bar=newBar(bucket, price); }
  else if(bucket!==bar.start){ flushBar(); bar=newBar(bucket, price); }

  // aggressor inference: trade at/above ask = buyer aggressor; at/below bid = seller
  let side='neut';
  if(ask!=null && price>=ask) side='buy';
  else if(bid!=null && price<=bid) side='sell';
  // fallback tick-rule if no quote: compare to last close
  else if(price>bar.closePx) side='buy';
  else if(price<bar.closePx) side='sell';

  if(side==='buy'){ bar.buyVol+=size; bar.delta+=size; cvd+=size; }
  else if(side==='sell'){ bar.sellVol+=size; bar.delta-=size; cvd-=size; }
  else { bar.neutVol+=size; }

  bar.closePx=price; bar.hi=Math.max(bar.hi,price); bar.lo=Math.min(bar.lo,price); bar.trades++;
}

ib = new IBApi({ host:GW_HOST, port:GW_PORT, clientId:CLIENT_ID });
ib.on(EventName.connected, ()=>log('connected to Gateway'));
ib.on(EventName.error, (e,code,reqId)=>{
  const m = e&&e.message?e.message:e;
  if([2104,2106,2158].includes(code)) return; // benign data-farm OK msgs
  if([10089,10168,10167,354,10091].includes(code)){ denied=true; log(`DATA DENIED [${code}]: ${m}`); }
  else log(`ERR [${code}] reqId=${reqId}: ${m}`);
});

// keep a live quote so we can classify aggressor side
ib.on(EventName.tickPrice, (reqId, field, price)=>{
  if(price==null||price<=0) return;
  if(field===1) bid=price;    // BID
  else if(field===2) ask=price; // ASK
});

// tick-by-tick trades (AllLast)
ib.on(EventName.tickByTickAllLast, (reqId, tickType, time, price, size /*, attribs, exch, specialConds*/)=>{
  if(price==null||size==null) return;
  onTrade(price, size);
});

ib.connect();

const EXPIRY   = process.env.OF_EXPIRY || '202609';   // MES front month (Sep 2026 as of Jul 2026). Roll quarterly: Mar=03 Jun=06 Sep=09 Dec=12.
const contract = { symbol:SYMBOL, secType:SecType.FUT, exchange:EXCHANGE, currency:'USD',
                   lastTradeDateOrContractMonth:EXPIRY, tradingClass:SYMBOL, multiplier:'5' };
// MES multiplier is 5 ($5 x index). MNQ=2, MYM=0.5, MGC=10 if you repoint OF_SYMBOL/OF_EXPIRY.

setTimeout(()=>{
  try{ ib.reqMarketDataType(3); }catch(e){}          // allow delayed if live denied
  try{ ib.reqMktData(9001, contract, '', false, false); }catch(e){ log('reqMktData threw: '+e.message); }
  try{ ib.reqTickByTickData(9002, contract, 'AllLast', 0, false); }catch(e){ log('reqTickByTick threw: '+e.message); }
  log(`requested MES quote + tick-by-tick trades. Watching... (Ctrl-C to stop)`);
}, 2500);

// status check at 20s: did we get ANY ticks?
setTimeout(()=>{
  if(!gotAnyTick){
    log('=== NO TICKS after 20s ==='+(denied?' -- DATA DENIED (need CME real-time subscription)':' -- market may be quiet, or contract not resolving (needs front-month expiry?)'));
  } else {
    log('=== ticks flowing -- order-flow data path is OPEN ===');
  }
}, 20000);

process.on('SIGINT', ()=>{ flushBar(); log('flushed final bar, exiting.'); try{ib.disconnect();}catch(e){} process.exit(0); });
