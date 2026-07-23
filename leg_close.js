#!/usr/bin/env node
/* leg_close.js — close the orphaned XSP 749/763 short call vertical LEG BY LEG.
 *
 * The paper simulator fills single-leg MKT orders instantly but won't
 * marketable-fill a negative-priced SELL combo — so: cancel our stuck combo
 * close (#17), then BUY 1x 749C and SELL 1x 763C as plain option orders.
 * Also re-attempts cancelling zombie combo #4 (server-owned; may 10147 again —
 * harmless, it dies at the close as a DAY order and we monitor it meanwhile).
 *
 * Run:  node leg_close.js --go     (no dry mode — fix_orphan_close.js is the dry view)
 */
const { IBApi, EventName, SecType, OrderAction, OrderType } = require('@stoqey/ib');

const HOST = process.env.IB_HOST || '127.0.0.1';
const PORT = +(process.env.IB_PORT || 4002);
const ACCOUNT = process.env.ACCOUNT || 'DUN460366';

const STUCK_COMBO_ID = 17;           // our client-0 combo close (cancel will work)
const ZOMBIE_COMBO_ID = 4;           // server-owned flatten (cancel may 10147; retry anyway)
const SHORT_CALL = { conId: 889932956, label: 'XSP 749C (short, BUY to close)' };
const LONG_CALL  = { conId: 889933208, label: 'XSP 763C (long, SELL to close)' };
const ENTRY_CREDIT = 3.02;

if (!process.argv.includes('--go')) { console.log('this script acts immediately — run with --go'); process.exit(0); }
if (!/^D/.test(ACCOUNT)) { console.error('refusing non-paper account'); process.exit(1); }

const ib = new IBApi({ host: HOST, port: PORT, clientId: 0 });
let nextId = null;
const fills = {};
const die = (m, c=0) => { if (m) console.log(m); try { ib.disconnect(); } catch(e){} process.exit(c); };
setTimeout(() => die('TIMEOUT 45s — check IBKR', 1), 45000).unref();

ib.on(EventName.error, (err, code, reqId) => {
  if ([2104,2106,2107,2158].includes(code)) return;
  console.log(`[ib] code=${code} reqId=${reqId}: ${err && err.message ? err.message : err}`);
});

ib.on(EventName.orderStatus, (id, status, filled, remaining, avgFillPrice) => {
  console.log(`[status] #${id} ${status}${avgFillPrice ? ' @'+avgFillPrice : ''}`);
  if (status === 'Filled' && fills[id] === undefined) {
    fills[id] = Math.abs(avgFillPrice);
    if (Object.keys(fills).length === 2) {
      const ids = Object.keys(fills).map(Number).sort((a,b)=>a-b);
      const buyBack = fills[ids[0]];   // 749C bought back
      const sellOut = fills[ids[1]];   // 763C sold out
      const netDebit = buyBack - sellOut;
      const pl = (ENTRY_CREDIT - netDebit) * 100;
      die(`\nFLAT. Bought 749C @ $${buyBack.toFixed(2)}, sold 763C @ $${sellOut.toFixed(2)} -> net close debit $${netDebit.toFixed(2)}.\nRound trip vs $${ENTRY_CREDIT} credit: ${pl >= 0 ? '+' : ''}$${pl.toFixed(2)}  (orphan rehearsal tuition, paper)\nNOTE: zombie combo #4 (-4.53) may still rest if its cancel 10147'd — monitor with: node fix_orphan_close.js`);
    }
  }
});

ib.on(EventName.nextValidId, (id) => {
  if (nextId != null) return;
  nextId = id;
  console.log(`connected clientId 0, nextValidId=${id}`);
  console.log(`cancelling stuck combo #${STUCK_COMBO_ID} and retrying zombie #${ZOMBIE_COMBO_ID}...`);
  try { ib.cancelOrder(STUCK_COMBO_ID); } catch(e) { console.log('cancel 17 err: '+e.message); }
  try { ib.cancelOrder(ZOMBIE_COMBO_ID); } catch(e) { console.log('cancel 4 err: '+e.message); }

  setTimeout(() => {
    const buyId = nextId++;
    const sellId = nextId++;
    console.log(`closing legs: #${buyId} BUY 1 ${SHORT_CALL.label}   #${sellId} SELL 1 ${LONG_CALL.label}`);
    ib.placeOrder(buyId, { conId: SHORT_CALL.conId, symbol:'XSP', secType: SecType.OPT, exchange:'SMART', currency:'USD' },
      { action: OrderAction.BUY, orderType: OrderType.MKT, totalQuantity: 1, account: ACCOUNT, transmit: true });
    ib.placeOrder(sellId, { conId: LONG_CALL.conId, symbol:'XSP', secType: SecType.OPT, exchange:'SMART', currency:'USD' },
      { action: OrderAction.SELL, orderType: OrderType.MKT, totalQuantity: 1, account: ACCOUNT, transmit: true });
  }, 2000);
});

ib.connect();
