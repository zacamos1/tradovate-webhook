#!/usr/bin/env node
/* fly_place_paper.js — STAGE 2 of the premium execution module.
 *
 * PURPOSE: place exactly ONE iron fly as a 4-leg BAG combo order on the PAPER
 * account (DUR110649), priced slightly worse than mid to guarantee a fill, then
 * confirm the fill and print the real net credit. This proves the full path:
 *   resolve 4 legs -> guard trading class -> fetch live quotes -> build BAG
 *   -> submit ONE net-credit LMT -> confirm atomic fill -> report real credit.
 *
 * SAFETY:
 *   - Hardcoded to the PAPER account. Refuses to run if ACCOUNT doesn't start with 'D'.
 *   - Places exactly ONE combo order, once. Exits after fill or timeout.
 *   - 1 contract only (QTY=1). No loops, no repeats.
 *
 * USAGE (market hours, IB Gateway up, paper):
 *   node /tmp/fly_place_paper.js SPY 743 6
 *   node /tmp/fly_place_paper.js XSP 748 6
 *
 * The iron fly (net CREDIT, defined risk):
 *   SELL 1 call @ center      SELL 1 put @ center
 *   BUY  1 call @ center+wing  BUY  1 put @ center-wing
 */

const { IBApi, EventName, SecType, OrderAction, OrderType } = require('@stoqey/ib');

const SYMBOL = process.argv[2];
const CENTER = parseInt(process.argv[3], 10);
const WING   = parseInt(process.argv[4], 10);
const QTY    = 1;                                   // one contract, always, for this test
const ACCOUNT = process.env.PAPER_ACCOUNT || 'DUR110649';

if (!SYMBOL || !CENTER || !WING) {
  console.error('usage: node fly_place_paper.js <SYMBOL> <CENTER> <WING>');
  process.exit(1);
}
// HARD SAFETY: paper accounts start with 'D'. Refuse anything else.
if (!/^D/.test(ACCOUNT)) {
  console.error(`REFUSING: account "${ACCOUNT}" is not a paper account (must start with D). Aborting.`);
  process.exit(1);
}

const now = new Date();
const EXPIRY = now.getUTCFullYear().toString()
  + String(now.getUTCMonth() + 1).padStart(2, '0')
  + String(now.getUTCDate()).padStart(2, '0');

const legs = [
  { tag: 'SHORT_CALL', right: 'C', strike: CENTER,        action: 'SELL' },
  { tag: 'SHORT_PUT',  right: 'P', strike: CENTER,        action: 'SELL' },
  { tag: 'LONG_CALL',  right: 'C', strike: CENTER + WING, action: 'BUY'  },
  { tag: 'LONG_PUT',   right: 'P', strike: CENTER - WING, action: 'BUY'  },
];

console.log(`\n=== Stage 2: place ONE paper fly  ${SYMBOL} c${CENTER} w${WING} exp ${EXPIRY}  (acct ${ACCOUNT}) ===`);

const PORT = parseInt(process.env.IB_PORT || '4002', 10);
const HOST = process.env.IB_HOST || '127.0.0.1';
const ib = new IBApi({ host: HOST, port: PORT, clientId: 78 });

let orderId = null;
const resolved = {};      // tag -> {conId, tradingClass}
const quotes = {};        // tag -> {bid, ask}
let nextReq = 9100;
const reqToTag = {};      // reqId -> leg tag  (contractDetails)
const mktToTag = {};      // reqId -> leg tag  (mktData)
let phase = 'resolve';
let submitted = false;

function fail(msg) { console.error('✗ ' + msg); try { ib.disconnect(); } catch(e){} process.exit(1); }

ib.on(EventName.nextValidId, (id) => { orderId = id; });

ib.on(EventName.error, (err, code, reqId) => {
  const msg = (err && err.message) ? err.message : String(err);
  // ignore benign market-data farm/status notices
  if (code === 2104 || code === 2106 || code === 2158 || code === 2107 || code === 2108) return;
  console.error(`  [error code=${code} reqId=${reqId}] ${msg}`);
});

ib.on(EventName.connected, () => {
  console.log(`Connected ${HOST}:${PORT} (clientId 78). Resolving 4 legs...`);
  ib.reqIds(1);
  for (const leg of legs) {
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
    return fail(`${tag}: tradingClass "${c.tradingClass}" != "${SYMBOL}" (2SPY-type). Aborting before any order.`);
  }
  resolved[tag] = { conId: c.conId, tradingClass: c.tradingClass };
  if (Object.keys(resolved).length === legs.length && phase === 'resolve') {
    phase = 'quote';
    console.log('  legs resolved:', legs.map(l => `${l.tag}=${resolved[l.tag].conId}`).join('  '));
    console.log('  fetching live quotes for each leg...');
    for (const leg of legs) {
      const reqId = nextReq++;
      mktToTag[reqId] = leg.tag;
      ib.reqMktData(reqId, {
        conId: resolved[leg.tag].conId, exchange: 'SMART', currency: 'USD', secType: SecType.OPT,
      }, '', false, false);
    }
    // give quotes a few seconds to arrive, then price + submit
    setTimeout(priceAndSubmit, 6000);
  }
});

ib.on(EventName.tickPrice, (reqId, field, price) => {
  const tag = mktToTag[reqId];
  if (!tag) return;
  quotes[tag] = quotes[tag] || {};
  // field 1 = bid, 2 = ask, 4 = last
  if (field === 1) quotes[tag].bid = price;
  else if (field === 2) quotes[tag].ask = price;
  else if (field === 4) quotes[tag].last = price;
});

function mid(tag) {
  const q = quotes[tag] || {};
  if (q.bid != null && q.ask != null && q.bid >= 0 && q.ask > 0) return (q.bid + q.ask) / 2;
  if (q.last != null && q.last > 0) return q.last;   // fallback
  return null;
}

function priceAndSubmit() {
  if (submitted) return;
  if (phase !== 'quote') return;
  phase = 'submit';

  // cancel mkt data streams
  for (const reqId of Object.keys(mktToTag)) { try { ib.cancelMktData(parseInt(reqId,10)); } catch(e){} }

  const mSC = mid('SHORT_CALL'), mSP = mid('SHORT_PUT'), mLC = mid('LONG_CALL'), mLP = mid('LONG_PUT');
  console.log('  mids:', {SHORT_CALL:mSC, SHORT_PUT:mSP, LONG_CALL:mLC, LONG_PUT:mLP});
  if ([mSC,mSP,mLC,mLP].some(v => v == null)) {
    return fail('missing quotes for one or more legs — cannot price. (Market open? Data permissions?)');
  }

  // net credit at mid = (short call + short put) - (long call + long put)
  const netMid = (mSC + mSP) - (mLC + mLP);
  if (netMid <= 0) return fail(`net mid credit is ${netMid.toFixed(2)} (<=0) — not a credit. Aborting.`);

  // Price at TRUE MID. (Pricing worse than mid paradoxically tripped IBKR paper's
  // "riskless/guaranteed-loss combination" check (error 201). A realistic mid-priced
  // credit spread carries genuine risk in the sim's eyes and clears that flag.)
  const limitCredit = +netMid.toFixed(2);
  console.log(`  net mid credit = $${netMid.toFixed(2)}  ->  submitting LMT at mid $${limitCredit.toFixed(2)}`);

  // Build BAG combo. For a CREDIT spread we SELL the combo (receive premium).
  // comboLegs actions are relative to BUYING the bag; since we SELL the bag,
  // we express the structure so that selling the bag = our intended fly.
  // Convention that works cleanly: define the bag as the LONG fly and BUY it at a
  // negative price === receiving credit. To avoid sign confusion on the first test,
  // we define legs explicitly and SELL the bag at a positive limit credit.
  const comboContract = {
    symbol: SYMBOL, secType: SecType.BAG, currency: 'USD', exchange: 'SMART',
    comboLegs: [
      { conId: resolved.SHORT_CALL.conId, ratio: 1, action: 'SELL', exchange: 'SMART' },
      { conId: resolved.SHORT_PUT.conId,  ratio: 1, action: 'SELL', exchange: 'SMART' },
      { conId: resolved.LONG_CALL.conId,  ratio: 1, action: 'BUY',  exchange: 'SMART' },
      { conId: resolved.LONG_PUT.conId,   ratio: 1, action: 'BUY',  exchange: 'SMART' },
    ],
  };

  if (orderId == null) return fail('no valid orderId yet from nextValidId. Aborting.');
  const thisOrderId = orderId;
  submitted = true;

  // We SELL the bag to collect the net credit. limitPrice is the net credit per combo.
  const order = {
    action: OrderAction.SELL,
    orderType: OrderType.LMT,
    totalQuantity: QTY,
    lmtPrice: limitCredit,
    account: ACCOUNT,
    transmit: true,
    tif: 'DAY',
  };

  console.log(`  >>> SUBMITTING BAG SELL orderId=${thisOrderId} qty=${QTY} lmt=$${limitCredit} acct=${ACCOUNT}`);
  ib.placeOrder(thisOrderId, comboContract, order);

  // watch for fill
  setTimeout(() => {
    console.log('  (30s elapsed — if no fill printed above, order may be working or unfilled. Check IBKR.)');
    try { ib.disconnect(); } catch(e){}
    process.exit(0);
  }, 30000);
}

ib.on(EventName.orderStatus, (id, status, filled, remaining, avgFillPrice) => {
  if (id !== orderId) return;
  console.log(`  orderStatus: ${status}  filled=${filled} remaining=${remaining} avgFill=$${avgFillPrice}`);
  if (status === 'Filled') {
    console.log(`\n✓ FILLED: ${SYMBOL} fly, ${QTY} contract, net credit ~$${(avgFillPrice*100).toFixed(2)} per fly`);
    console.log('  Stage 2 PASS — the 4-leg BAG combo submitted and filled atomically on paper.');
    setTimeout(() => { try { ib.disconnect(); } catch(e){} process.exit(0); }, 1500);
  }
});

ib.connect();

setTimeout(() => { console.log('\n⏱ overall timeout (45s) — exiting.'); try { ib.disconnect(); } catch(e){} process.exit(0); }, 45000);
