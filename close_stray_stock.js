#!/usr/bin/env node
/* close_stray_stock.js — one-shot paper-account cleanup, run on the VPS.
 *
 * Connects as a SECOND API client (clientId 77) alongside server.js — placing
 * orders doesn't contend with the market-data session, so server.js is undisturbed.
 *
 * Modes:
 *   node close_stray_stock.js              LIST ONLY: stock positions + ALL working orders. Places nothing.
 *   node close_stray_stock.js --go         queue Market-On-Open closes for every STK position
 *   node close_stray_stock.js --go --tif=DAY   use plain MKT DAY instead (if OPG gets rejected)
 *   node close_stray_stock.js --cancel-all     reqGlobalCancel(): cancels EVERY working order on the account
 *
 * SAFETY: refuses any account not starting with 'D' (paper only).
 */
const { IBApi, EventName, SecType, OrderAction, OrderType } = require('@stoqey/ib');

const HOST = process.env.IB_HOST || '127.0.0.1';
const PORT = +(process.env.IB_PORT || 4002);
const CLIENT_ID = 77;

const GO = process.argv.includes('--go');
const CANCEL_ALL = process.argv.includes('--cancel-all');
const tifArg = process.argv.find(a => a.startsWith('--tif='));
const TIF = tifArg ? tifArg.split('=')[1] : 'OPG';   // OPG = market-on-open auction

const ib = new IBApi({ host: HOST, port: PORT, clientId: CLIENT_ID });

const stocks = [];       // { account, contract, pos, avgCost }
const openOrders = [];   // { orderId, symbol, secType, action, qty, type, lmt, status }
let nextId = null;
let phase = 'connect';

const die = (msg, code = 1) => { console.error(msg); try { ib.disconnect(); } catch (e) {} process.exit(code); };

setTimeout(() => die('TIMEOUT: no connection/next-valid-id in 15s — is IB Gateway up on ' + HOST + ':' + PORT + '?'), 15000).unref();

ib.on(EventName.error, (err, code, reqId) => {
  // 2104/2106/2158 are benign "data farm OK" notices
  if ([2104, 2106, 2158, 2107].includes(code)) return;
  console.log(`[ib err] code=${code} reqId=${reqId}: ${err && err.message ? err.message : err}`);
});

ib.on(EventName.nextValidId, (id) => {
  if (nextId != null) return;
  nextId = id;
  console.log(`connected (clientId ${CLIENT_ID}), nextValidId=${id}\n-- positions --`);
  phase = 'positions';
  ib.reqPositions();
});

ib.on(EventName.position, (account, contract, pos, avgCost) => {
  if (contract.secType === SecType.STK && pos !== 0) {
    stocks.push({ account, contract, pos, avgCost });
  }
});

ib.on(EventName.positionEnd, () => {
  if (phase !== 'positions') return;
  phase = 'orders';
  ib.cancelPositions();
  if (!stocks.length) console.log('(no stock positions)');
  for (const s of stocks) {
    console.log(`STK ${s.contract.symbol}  pos=${s.pos}  avgCost=${(+s.avgCost).toFixed(2)}  acct=${s.account}  conId=${s.contract.conId}`);
  }
  console.log('-- working orders (all clients) --');
  ib.reqAllOpenOrders();
});

ib.on(EventName.openOrder, (orderId, contract, order, orderState) => {
  openOrders.push({
    orderId,
    symbol: contract.symbol, secType: contract.secType,
    action: order.action, qty: order.totalQuantity,
    type: order.orderType, lmt: order.lmtPrice,
    status: orderState && orderState.status,
  });
});

ib.on(EventName.openOrderEnd, () => {
  if (phase !== 'orders') return;
  phase = 'act';
  if (!openOrders.length) console.log('(no working orders)');
  for (const o of openOrders) {
    console.log(`#${o.orderId}  ${o.symbol} ${o.secType}  ${o.action} x${o.qty}  ${o.type}${o.lmt != null ? ' @' + o.lmt : ''}  [${o.status}]`);
  }
  act();
});

ib.on(EventName.orderStatus, (id, status, filled, remaining, avgFillPrice) => {
  console.log(`[status] #${id} ${status} filled=${filled} rem=${remaining}${avgFillPrice ? ' @' + avgFillPrice : ''}`);
});

function act() {
  if (CANCEL_ALL) {
    console.log('\n*** GLOBAL CANCEL: cancelling ALL working orders on the account ***');
    ib.reqGlobalCancel();
    return setTimeout(() => { console.log('done (verify list by re-running without flags)'); die('', 0); }, 4000);
  }

  if (!GO) {
    console.log('\nDRY RUN complete. Re-run with --go to queue closes, --cancel-all to clear working orders.');
    return die('', 0);
  }

  const toClose = stocks.filter(s => /^D/.test(s.account || ''));
  const refused = stocks.length - toClose.length;
  if (refused) console.log(`refusing ${refused} position(s) on non-paper account(s)`);
  if (!toClose.length) { console.log('nothing to close.'); return die('', 0); }

  console.log(`\nqueueing ${TIF === 'OPG' ? 'MARKET-ON-OPEN' : 'MKT ' + TIF} closes:`);
  for (const s of toClose) {
    const id = nextId++;
    const c = {
      conId: s.contract.conId, symbol: s.contract.symbol,
      secType: SecType.STK, exchange: 'SMART',
      currency: s.contract.currency || 'USD',
    };
    const action = s.pos > 0 ? OrderAction.SELL : OrderAction.BUY;
    ib.placeOrder(id, c, {
      action, orderType: OrderType.MKT, totalQuantity: Math.abs(s.pos),
      account: s.account, tif: TIF, transmit: true,
    });
    console.log(`#${id}  ${action} ${Math.abs(s.pos)} ${s.contract.symbol} ${TIF} (closing pos ${s.pos})`);
  }
  setTimeout(() => { console.log('\nqueued — verify tomorrow ~09:31 ET (or re-run with no flags to see them working).'); die('', 0); }, 8000);
}

ib.connect();
