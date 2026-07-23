#!/usr/bin/env node
/* xsp_cleanup_1530.js — self-scheduling one-shot. Started any time today; sleeps
 * until 15:30 ET (19:30 UTC), then cleans up all XSP remnants from this morning:
 *
 *   1. cancel our stuck MKT sell #20 and re-attempt zombie combo #4
 *      (single-owner rule: after this, only THIS script or the 15:50 flatten
 *       may hold a working close on the 763C — never both)
 *   2. positions sweep, XSP options only:
 *        pos < 0 (short): BUY MKT to close, LEAVE working no matter what
 *                         (the flatten skips shorts — this is the only closer)
 *        pos > 0 (long):  SELL MKT, wait 45s; if unfilled -> CANCEL and
 *                         delegate to the 15:50 flatten (prevents double-sell)
 *   3. report end state
 *
 * If started after 15:30 ET it acts immediately; it will NOT act after 15:48 ET
 * (too close to the flatten — it stands down and delegates everything long).
 *
 * Launch (survives SSH logout):
 *   pm2 start xsp_cleanup_1530.js --name xsp-cleanup --no-autorestart
 * Watch later:  pm2 logs xsp-cleanup --lines 40 --nostream
 */
const { IBApi, EventName, SecType, OrderAction, OrderType } = require('@stoqey/ib');

const HOST = process.env.IB_HOST || '127.0.0.1';
const PORT = +(process.env.IB_PORT || 4002);
const ACCOUNT = process.env.ACCOUNT || 'DUN460366';
const STALE_ORDER_IDS = [20, 4];         // our MKT sell + zombie combo
const TARGET_UTC = { h: 19, m: 30 };     // 15:30 ET
const STANDDOWN_UTC_MIN = 19 * 60 + 48;  // never act at/after 15:48 ET
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

if (!/^D/.test(ACCOUNT)) { console.error('refusing non-paper account'); process.exit(1); }

function msUntilTarget() {
  const now = new Date();
  const tgt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), TARGET_UTC.h, TARGET_UTC.m, 0));
  return tgt.getTime() - now.getTime();
}

function run() {
  const nowMin = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  if (nowMin >= STANDDOWN_UTC_MIN) {
    log('past 15:48 ET — standing down; EOD-flatten owns any long remnants. (Shorts, if any, would need manual attention.)');
    process.exit(0);
  }
  const ib = new IBApi({ host: HOST, port: PORT, clientId: 0 });
  let nextId = null;
  const xsp = [];
  const die = (m, c = 0) => { if (m) log(m); try { ib.disconnect(); } catch (e) {} process.exit(c); };
  setTimeout(() => die('TIMEOUT 120s overall — check IBKR', 1), 120000).unref();

  ib.on(EventName.error, (err, code, reqId) => {
    if ([2104, 2106, 2107, 2158].includes(code)) return;
    log(`[ib] code=${code} reqId=${reqId}: ${err && err.message ? err.message : err}`);
  });

  ib.on(EventName.orderStatus, (id, status, filled, remaining, avgFillPrice) => {
    log(`[status] #${id} ${status}${avgFillPrice ? ' @' + avgFillPrice : ''}`);
  });

  ib.on(EventName.nextValidId, (id) => {
    if (nextId != null) return;
    nextId = id;
    log(`connected clientId 0, nextValidId=${id}; cancelling stale orders ${STALE_ORDER_IDS.join(', ')}`);
    for (const oid of STALE_ORDER_IDS) { try { ib.cancelOrder(oid); } catch (e) { log(`cancel ${oid} err: ${e.message}`); } }
    setTimeout(() => { log('positions sweep...'); ib.reqPositions(); }, 2500);
  });

  ib.on(EventName.position, (account, contract, pos) => {
    if (contract.secType === SecType.OPT && contract.symbol === 'XSP' && pos !== 0)
      xsp.push({ contract, pos });
  });

  ib.on(EventName.positionEnd, () => {
    ib.cancelPositions();
    if (!xsp.length) return die('no XSP option positions — already clean. Done.');
    for (const p of xsp) log(`XSP ${p.contract.right} ${p.contract.strike}  pos=${p.pos}  conId=${p.contract.conId}`);

    const shorts = xsp.filter(p => p.pos < 0);
    const longs = xsp.filter(p => p.pos > 0);
    const longOrderIds = [];
    const filledIds = new Set();
    ib.on(EventName.orderStatus, (id, status) => { if (status === 'Filled') filledIds.add(id); });

    for (const p of shorts) {
      const oid = nextId++;
      log(`#${oid} BUY ${Math.abs(p.pos)} XSP ${p.contract.right}${p.contract.strike} MKT (closing SHORT — order stays working regardless)`);
      ib.placeOrder(oid, { conId: p.contract.conId, symbol: 'XSP', secType: SecType.OPT, exchange: 'SMART', currency: 'USD' },
        { action: OrderAction.BUY, orderType: OrderType.MKT, totalQuantity: Math.abs(p.pos), account: ACCOUNT, transmit: true });
    }
    setTimeout(() => {
      for (const p of longs) {
        const oid = nextId++;
        longOrderIds.push(oid);
        log(`#${oid} SELL ${p.pos} XSP ${p.contract.right}${p.contract.strike} MKT (closing LONG — 45s then cancel-and-delegate)`);
        ib.placeOrder(oid, { conId: p.contract.conId, symbol: 'XSP', secType: SecType.OPT, exchange: 'SMART', currency: 'USD' },
          { action: OrderAction.SELL, orderType: OrderType.MKT, totalQuantity: p.pos, account: ACCOUNT, transmit: true });
      }
      setTimeout(() => {
        let delegated = 0;
        for (const oid of longOrderIds) {
          if (!filledIds.has(oid)) { delegated++; log(`#${oid} unfilled after 45s — CANCELLING, 15:50 flatten owns this close`); try { ib.cancelOrder(oid); } catch (e) {} }
        }
        setTimeout(() => die(`done. longs delegated to flatten: ${delegated}. Shorts (if any) left with working BUY MKT — check pm2 logs after 15:50.`), 3000);
      }, 45000);
    }, shorts.length ? 5000 : 500);
  });

  ib.connect();
}

const wait = msUntilTarget();
if (wait > 0) {
  log(`armed — sleeping ${(wait / 60000).toFixed(1)} min until 15:30 ET, then cleaning up XSP remnants`);
  setTimeout(run, wait);
} else {
  log('past 15:30 ET — acting now');
  run();
}
