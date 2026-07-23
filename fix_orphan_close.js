#!/usr/bin/env node
/* fix_orphan_close.js — one-shot: close the orphaned XSP 749/763 short call vertical.
 *
 * Connects as clientId 0 (IB master client — the only client allowed to cancel
 * orders placed by other API clients). Steps:
 *   1. list positions (sanity: confirm the XSP option legs exist)
 *   2. list all working orders; CANCEL any XSP BAG (combo) orders
 *      (the resting flatten @ $4.53 from the orphan handler)
 *   3. place a closing order: SELL the combo @ -9.00
 *      (legs defined SELL short / BUY long; SELL order reverses them =
 *       BUY 749C / SELL 763C = close; negative price = pay the debit;
 *       IB fills at best available price, the -9 is just a generous cap)
 *   4. report fill and round-trip P/L vs the $3.02 entry credit
 *
 * SAFETY: paper account guard (/^D/); touches ONLY XSP BAG orders; single combo close.
 * Run:  node fix_orphan_close.js            (dry: positions+orders, no action)
 *       node fix_orphan_close.js --go       (cancel + close)
 */
const { IBApi, EventName, SecType, OrderAction, OrderType } = require('@stoqey/ib');

const HOST = process.env.IB_HOST || '127.0.0.1';
const PORT = +(process.env.IB_PORT || 4002);
const ACCOUNT = process.env.ACCOUNT || 'DUN460366';
const GO = process.argv.includes('--go');

// today's resolved conIds (from the fly log)
const SHORT_CALL_CONID = 889932956;  // XSP 20260709 749 C  (currently short)
const LONG_CALL_CONID  = 889933208;  // XSP 20260709 763 C  (currently long)
const ENTRY_CREDIT = 3.02;
const CLOSE_CAP = 9.00;              // pay at most $9.00 debit (fills near market)

if (!/^D/.test(ACCOUNT)) { console.error('refusing non-paper account'); process.exit(1); }

const ib = new IBApi({ host: HOST, port: PORT, clientId: 0 });
let nextId = null, phase = 'connect';
const xspBagOrders = [];

const die = (m, c=0) => { if (m) console.log(m); try { ib.disconnect(); } catch(e){} process.exit(c); };
setTimeout(() => die('TIMEOUT 60s — check gateway', 1), 60000).unref();

ib.on(EventName.error, (err, code, reqId) => {
  if ([2104,2106,2107,2158].includes(code)) return;
  console.log(`[ib] code=${code} reqId=${reqId}: ${err && err.message ? err.message : err}`);
});

ib.on(EventName.nextValidId, (id) => {
  if (nextId != null) return;
  nextId = id;
  console.log(`connected as MASTER clientId 0, nextValidId=${id}\n-- positions --`);
  phase = 'pos';
  ib.reqPositions();
});

ib.on(EventName.position, (account, contract, pos) => {
  if (contract.secType === SecType.OPT && pos !== 0)
    console.log(`OPT ${contract.symbol} ${contract.right} ${contract.strike} ${contract.lastTradeDateOrContractMonth}  pos=${pos}  conId=${contract.conId}`);
});

ib.on(EventName.positionEnd, () => {
  if (phase !== 'pos') return;
  phase = 'orders';
  ib.cancelPositions();
  console.log('-- working orders --');
  ib.reqAllOpenOrders();
});

ib.on(EventName.openOrder, (orderId, contract, order, orderState) => {
  const st = orderState && orderState.status;
  console.log(`#${orderId}  ${contract.symbol} ${contract.secType}  ${order.action} x${order.totalQuantity} ${order.orderType}@${order.lmtPrice}  [${st}]`);
  if (contract.secType === SecType.BAG && contract.symbol === 'XSP' && !['Filled','Cancelled','Inactive'].includes(st))
    xspBagOrders.push(orderId);
});

ib.on(EventName.openOrderEnd, () => {
  if (phase !== 'orders') return;
  phase = 'act';
  if (!GO) return die('\nDRY RUN done. Re-run with --go to cancel the XSP combo order(s) and close the vertical.');

  console.log(`\ncancelling ${xspBagOrders.length} working XSP combo order(s): ${xspBagOrders.join(', ') || '(none)'}`);
  for (const id of xspBagOrders) { try { ib.cancelOrder(id); } catch(e) { console.log('cancel err: '+e.message); } }

  setTimeout(() => {
    const closeId = nextId++;
    console.log(`placing CLOSE: combo SELL @ -${CLOSE_CAP.toFixed(2)} (= BUY back the short vertical, pay up to $${CLOSE_CAP.toFixed(2)})  id=${closeId}`);
    ib.placeOrder(closeId, {
      symbol: 'XSP', secType: SecType.BAG, currency: 'USD', exchange: 'SMART',
      comboLegs: [
        { conId: SHORT_CALL_CONID, ratio: 1, action: 'SELL', exchange: 'SMART' },
        { conId: LONG_CALL_CONID,  ratio: 1, action: 'BUY',  exchange: 'SMART' },
      ],
    }, {
      action: OrderAction.SELL, orderType: OrderType.LMT, totalQuantity: 1,
      lmtPrice: -CLOSE_CAP, account: ACCOUNT, transmit: true, tif: 'DAY',
    });

    ib.on(EventName.orderStatus, (id, status, filled, remaining, avgFillPrice) => {
      console.log(`[status] #${id} ${status} filled=${filled}${avgFillPrice ? ' @'+avgFillPrice : ''}`);
      if (id === closeId && status === 'Filled') {
        const debit = Math.abs(avgFillPrice);
        const pl = (ENTRY_CREDIT - debit) * 100;
        die(`\nCLOSED @ $${debit.toFixed(2)} debit. Round trip: sold $${ENTRY_CREDIT} -> bought $${debit.toFixed(2)} = ${pl >= 0 ? '+' : ''}$${pl.toFixed(2)}  (orphan rehearsal tuition)`);
      }
    });
    setTimeout(() => die('\nclose order still working after 20s — re-run dry to inspect, or check IBKR', 1), 20000);
  }, 2500);
});

ib.connect();
