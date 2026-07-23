#!/usr/bin/env node
/* sell_763.js — final leg: SELL the remaining long XSP 763C (no short exists now,
 * so this is a plain long-close; the earlier rejection was a validation race).
 * Reports the complete round trip: +3.02 combo credit, -2.26 buy-back, +X this sale.
 * Run:  node sell_763.js --go
 */
const { IBApi, EventName, SecType, OrderAction, OrderType } = require('@stoqey/ib');
const HOST = process.env.IB_HOST || '127.0.0.1';
const PORT = +(process.env.IB_PORT || 4002);
const ACCOUNT = process.env.ACCOUNT || 'DUN460366';
const LONG_CALL_CONID = 889933208;   // XSP 20260709 763 C

if (!process.argv.includes('--go')) { console.log('run with --go'); process.exit(0); }
if (!/^D/.test(ACCOUNT)) { console.error('refusing non-paper account'); process.exit(1); }

const ib = new IBApi({ host: HOST, port: PORT, clientId: 0 });
let nextId = null;
const die = (m, c=0) => { if (m) console.log(m); try { ib.disconnect(); } catch(e){} process.exit(c); };
setTimeout(() => die('TIMEOUT 30s — check IBKR', 1), 30000).unref();

ib.on(EventName.error, (err, code, reqId) => {
  if ([2104,2106,2107,2158].includes(code)) return;
  console.log(`[ib] code=${code} reqId=${reqId}: ${err && err.message ? err.message : err}`);
});

ib.on(EventName.orderStatus, (id, status, filled, remaining, avgFillPrice) => {
  console.log(`[status] #${id} ${status}${avgFillPrice ? ' @'+avgFillPrice : ''}`);
  if (status === 'Filled') {
    const x = Math.abs(avgFillPrice);
    const pl = (3.02 - 2.26 + x) * 100;
    die(`\nFLAT. 763C sold @ $${x.toFixed(2)}.\nComplete round trip: +3.02 (combo credit) - 2.26 (749C buy-back) + ${x.toFixed(2)} = ${pl >= 0 ? '+' : ''}$${pl.toFixed(2)}\nZombie #4 note: still monitor with fix_orphan_close.js dry runs until the close.`);
  }
});

ib.on(EventName.nextValidId, (id) => {
  if (nextId != null) return;
  nextId = id;
  const oid = nextId++;
  console.log(`connected clientId 0 — #${oid} SELL 1 XSP 763C MKT`);
  ib.placeOrder(oid, { conId: LONG_CALL_CONID, symbol:'XSP', secType: SecType.OPT, exchange:'SMART', currency:'USD' },
    { action: OrderAction.SELL, orderType: OrderType.MKT, totalQuantity: 1, account: ACCOUNT, transmit: true });
});

ib.connect();
