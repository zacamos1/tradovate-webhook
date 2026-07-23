#!/usr/bin/env node
/* fly_place_paper_v2.js — STAGE 2 (TWO-VERTICALS) of the premium execution module.
 *
 * WHY THIS VERSION: IBKR's paper simulator rejected the single 4-leg BAG iron fly
 * with error 201 "riskless/guaranteed-loss combination". The fix is to submit the
 * fly as TWO separate vertical CREDIT spreads:
 *     CALL SPREAD: SELL center call, BUY (center+wing) call   -> net credit
 *     PUT  SPREAD: SELL center put,  BUY (center-wing) put    -> net credit
 * Together these two verticals ARE the iron fly (same 4 strikes, same risk).
 * Each vertical has obvious defined risk, so the sim accepts it. Bonus: if one
 * vertical fills and the other doesn't, you hold a defined-risk spread, never a
 * naked leg — sturdier for live too.
 *
 * SAFETY:
 *   - Hardcoded to PAPER (account must start with 'D'), else refuses.
 *   - Places at most TWO orders (one call spread, one put spread), once. Then exits.
 *   - 1 contract each. No loops.
 *
 * USAGE (market hours, IB Gateway up, paper):
 *   node fly_place_paper_v2.js SPY 743 6
 *   node fly_place_paper_v2.js XSP 748 6
 */

const { IBApi, EventName, SecType, OrderAction, OrderType } = require('@stoqey/ib');

const SYMBOL = process.argv[2];
const CENTER = parseInt(process.argv[3], 10);
const WING   = parseInt(process.argv[4], 10);
const QTY    = 1;
const ACCOUNT = process.env.PAPER_ACCOUNT || 'DUR110649';

if (!SYMBOL || !CENTER || !WING) {
  console.error('usage: node fly_place_paper_v2.js <SYMBOL> <CENTER> <WING>');
  process.exit(1);
}
if (!/^D/.test(ACCOUNT)) {
  console.error(`REFUSING: account "${ACCOUNT}" is not paper (must start with D). Aborting.`);
  process.exit(1);
}

const now = new Date();
const EXPIRY = now.getUTCFullYear().toString()
  + String(now.getUTCMonth() + 1).padStart(2, '0')
  + String(now.getUTCDate()).padStart(2, '0');

// four legs we need conIds + quotes for
const legDefs = [
  { tag: 'SHORT_CALL', right: 'C', strike: CENTER        },
  { tag: 'LONG_CALL',  right: 'C', strike: CENTER + WING },
  { tag: 'SHORT_PUT',  right: 'P', strike: CENTER        },
  { tag: 'LONG_PUT',   right: 'P', strike: CENTER - WING },
];

console.log(`\n=== Stage 2 (two-verticals): ${SYMBOL} c${CENTER} w${WING} exp ${EXPIRY}  (acct ${ACCOUNT}) ===`);
console.log(`  CALL spread: SELL ${CENTER}C / BUY ${CENTER+WING}C`);
console.log(`  PUT  spread: SELL ${CENTER}P / BUY ${CENTER-WING}P\n`);

const PORT = parseInt(process.env.IB_PORT || '4002', 10);
const HOST = process.env.IB_HOST || '127.0.0.1';
const ib = new IBApi({ host: HOST, port: PORT, clientId: 79 });

let orderId = null;
const resolved = {};    // tag -> {conId, tradingClass}
const quotes = {};      // tag -> {bid, ask, last}
let nextReq = 9200;
const reqToTag = {};
const mktToTag = {};
let phase = 'resolve';
let placed = false;
const fills = {};       // 'CALL'/'PUT' -> avgFillPrice
const orderTag = {};    // orderId -> 'CALL'/'PUT'

function fail(msg) { console.error('✗ ' + msg); try { ib.disconnect(); } catch(e){} process.exit(1); }

ib.on(EventName.nextValidId, (id) => { orderId = id; });

ib.on(EventName.error, (err, code, reqId) => {
  if ([2104,2106,2107,2108,2158].includes(code)) return; // benign data-farm notices
  const msg = (err && err.message) ? err.message : String(err);
  console.error(`  [error code=${code} reqId=${reqId}] ${msg}`);
});

ib.on(EventName.connected, () => {
  console.log(`Connected ${HOST}:${PORT} (clientId 79). Resolving 4 legs...`);
  ib.reqIds(1);
  for (const leg of legDefs) {
    const reqId = nextReq++;
    reqToTag[reqId] = leg.tag;
    ib.reqContractDetails(reqId, {
      symbol: SYMBOL, secType: SecType.OPT, exchange: 'SMART', currency: 'USD',
      lastTradeDateOrContractMonth: EXPIRY, strike: leg.strike, right: leg.right,
    });
  }
});

ib.on(EventName.contractDetails, (reqId, details) => {
  const tag = reqToTag[reqId];
  if (!tag || resolved[tag]) return;
  const c = details.contract;
  if (c.tradingClass !== SYMBOL) {
    return fail(`${tag}: tradingClass "${c.tradingClass}" != "${SYMBOL}" (2SPY-type). Aborting.`);
  }
  resolved[tag] = { conId: c.conId, tradingClass: c.tradingClass };
  if (Object.keys(resolved).length === legDefs.length && phase === 'resolve') {
    phase = 'quote';
    console.log('  legs resolved:', legDefs.map(l => `${l.tag}=${resolved[l.tag].conId}`).join('  '));
    console.log('  fetching live quotes...');
    for (const leg of legDefs) {
      const reqId = nextReq++;
      mktToTag[reqId] = leg.tag;
      ib.reqMktData(reqId, { conId: resolved[leg.tag].conId, exchange: 'SMART', currency: 'USD', secType: SecType.OPT }, '', false, false);
    }
    setTimeout(priceAndSubmit, 6000);
  }
});

ib.on(EventName.tickPrice, (reqId, field, price) => {
  const tag = mktToTag[reqId];
  if (!tag) return;
  quotes[tag] = quotes[tag] || {};
  if (field === 1) quotes[tag].bid = price;
  else if (field === 2) quotes[tag].ask = price;
  else if (field === 4) quotes[tag].last = price;
});

function mid(tag) {
  const q = quotes[tag] || {};
  if (q.bid != null && q.ask != null && q.bid >= 0 && q.ask > 0) return (q.bid + q.ask) / 2;
  if (q.last != null && q.last > 0) return q.last;
  return null;
}

function buildVertical(shortTag, longTag) {
  // a 2-leg BAG: SELL the short strike, BUY the long strike -> net credit when sold
  return {
    symbol: SYMBOL, secType: SecType.BAG, currency: 'USD', exchange: 'SMART',
    comboLegs: [
      { conId: resolved[shortTag].conId, ratio: 1, action: 'SELL', exchange: 'SMART' },
      { conId: resolved[longTag].conId,  ratio: 1, action: 'BUY',  exchange: 'SMART' },
    ],
  };
}

function priceAndSubmit() {
  if (placed) return;
  if (phase !== 'quote') return;
  phase = 'submit';
  for (const reqId of Object.keys(mktToTag)) { try { ib.cancelMktData(parseInt(reqId,10)); } catch(e){} }

  const mSC = mid('SHORT_CALL'), mLC = mid('LONG_CALL'), mSP = mid('SHORT_PUT'), mLP = mid('LONG_PUT');
  console.log('  mids:', {SHORT_CALL:mSC, LONG_CALL:mLC, SHORT_PUT:mSP, LONG_PUT:mLP});
  if ([mSC,mLC,mSP,mLP].some(v => v == null)) return fail('missing quotes — cannot price. (Market open?)');

  const callCredit = +(mSC - mLC).toFixed(2);   // sell center call, buy wing call
  const putCredit  = +(mSP - mLP).toFixed(2);   // sell center put,  buy wing put
  if (callCredit <= 0) return fail(`call-spread credit ${callCredit} <= 0. Aborting.`);
  if (putCredit  <= 0) return fail(`put-spread credit ${putCredit} <= 0. Aborting.`);
  console.log(`  call-spread credit = $${callCredit}   put-spread credit = $${putCredit}   total = $${(callCredit+putCredit).toFixed(2)}`);

  if (orderId == null) return fail('no orderId from nextValidId. Aborting.');
  placed = true;

  const callId = orderId++;
  const putId  = orderId++;
  orderTag[callId] = 'CALL';
  orderTag[putId]  = 'PUT';

  const mkOrder = (credit) => ({
    action: OrderAction.SELL, orderType: OrderType.LMT, totalQuantity: QTY,
    lmtPrice: credit, account: ACCOUNT, transmit: true, tif: 'DAY',
  });

  console.log(`  >>> SUBMIT CALL spread orderId=${callId} SELL @ $${callCredit}`);
  ib.placeOrder(callId, buildVertical('SHORT_CALL','LONG_CALL'), mkOrder(callCredit));

  console.log(`  >>> SUBMIT PUT  spread orderId=${putId} SELL @ $${putCredit}`);
  ib.placeOrder(putId, buildVertical('SHORT_PUT','LONG_PUT'), mkOrder(putCredit));

  setTimeout(() => {
    console.log('\n  --- summary ---');
    console.log(`  CALL spread: ${fills.CALL != null ? 'FILLED @ $'+fills.CALL : 'not filled (working/unfilled)'}`);
    console.log(`  PUT  spread: ${fills.PUT  != null ? 'FILLED @ $'+fills.PUT  : 'not filled (working/unfilled)'}`);
    if (fills.CALL != null && fills.PUT != null) {
      const total = (fills.CALL + fills.PUT) * 100 * QTY;
      console.log(`\n✓ BOTH VERTICALS FILLED — iron fly complete. Net credit ~$${total.toFixed(2)}. Stage 2 PASS.`);
    } else {
      console.log('\n⚠ Not both filled — check IBKR paper Orders & Trades. (One-sided = defined-risk spread, not naked.)');
    }
    try { ib.disconnect(); } catch(e){}
    process.exit(0);
  }, 30000);
}

ib.on(EventName.orderStatus, (id, status, filled, remaining, avgFillPrice) => {
  const which = orderTag[id];
  if (!which) return;
  console.log(`  orderStatus[${which}]: ${status} filled=${filled} remaining=${remaining} avgFill=$${avgFillPrice}`);
  if (status === 'Filled' && fills[which] == null) {
    fills[which] = avgFillPrice;
    console.log(`  ✓ ${which} spread FILLED @ $${avgFillPrice} (credit ~$${(avgFillPrice*100).toFixed(2)})`);
  }
});

ib.connect();
setTimeout(() => { console.log('\n⏱ overall timeout (45s) — exiting.'); try { ib.disconnect(); } catch(e){} process.exit(0); }, 45000);
