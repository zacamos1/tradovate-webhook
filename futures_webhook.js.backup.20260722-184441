/**
 * futures_webhook.js — Dedicated futures autotrader webhook (paper-first)
 * ---------------------------------------------------------------------------
 * SEPARATE process, SEPARATE port from the options server (server.js:3000).
 * Never route futures signals through the options webhook (DoS lesson).
 *
 * Model: SIGNAL = TARGET POSITION
 *   buy/long  -> target +SIZE
 *   sell/short-> target -SIZE
 *   exit/flat -> target  0
 *   order qty = target - effectivePosition   (0 => no-op; this IS the dedupe)
 * Flips handled automatically (short -1, buy -> delta +2 -> net +1).
 * MKT orders, NO bracket — the ParadoxAlgo strategy self-manages exits.
 *
 * Idempotency: effectivePosition = confirmed fills + in-flight order deltas,
 * plus a per-root async lock, so the order-fills alert mode firing multiple
 * times per bar collapses to a single fill (duplicates compute delta 0).
 *
 * No reqMktData anywhere: MKT orders don't need a price feed, so this sidesteps
 * the 10089/10168 market-data-subscription problems entirely.
 *
 * Deploy:
 *   cd ~/ibkr-webhook
 *   pm2 start futures_webhook.js --name futures-webhook
 *   pm2 save
 * ---------------------------------------------------------------------------
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { IBApi, EventName } = require('@stoqey/ib');

// ------------------------------- config ------------------------------------
const CFG = {
  IB_HOST:  process.env.IB_HOST  || '127.0.0.1',
  IB_PORT:  parseInt(process.env.IB_PORT  || '4002', 10),   // Docker host port
  // Distinct client-id band from the options server (which randomizes 1000-9999),
  // so the two processes can never collide, while still dodging stale sessions.
  CLIENT_ID: parseInt(process.env.CLIENT_ID || String(12000 + Math.floor(Math.random() * 1000)), 10),
  PORT:     parseInt(process.env.PORT || '3001', 10),
  SIZE:     parseInt(process.env.SIZE || '1', 10),          // contracts per signal
  SECRET:   process.env.WEBHOOK_SECRET || '',               // '' => no auth check
  ACCOUNT:  process.env.ACCOUNT || undefined,               // undefined => gateway default
  ROLL_BUFFER_DAYS: parseInt(process.env.ROLL_BUFFER_DAYS || '4', 10),
  DRY_RUN:  /^(1|true|yes)$/i.test(process.env.DRY_RUN || ''), // log, don't place
  LOG_FILE: process.env.LOG_FILE || path.join(process.cwd(), 'futures_webhook_log.jsonl'),
};

// root -> venue spec. currency is USD for all four.
const SPECS = {
  MES: { exchange: 'CME',   multiplier: '5'   },
  MNQ: { exchange: 'CME',   multiplier: '2'   },
  MYM: { exchange: 'CBOT',  multiplier: '0.5' },
  MGC: { exchange: 'COMEX', multiplier: '10'  },
};
const ROOTS = Object.keys(SPECS);

// Target is derived per-payload (see resolveTarget): direction only, in our SIZE.

// ------------------------------- logging -----------------------------------
function log(event, data) {
  const rec = { ts: new Date().toISOString(), event, ...data };
  const line = JSON.stringify(rec);
  console.log(line);
  try { fs.appendFileSync(CFG.LOG_FILE, line + '\n'); } catch (_) {}
}

// ------------------------------- normalizers -------------------------------
function normAction(a) {
  a = String(a == null ? '' : a).trim().toLowerCase();
  if (a === 'buy'  || a === 'long')  return 'buy';
  if (a === 'sell' || a === 'short') return 'sell';
  if (a === 'exit' || a === 'flat' || a === 'flatten' || a === 'close') return 'exit';
  return null;
}

// Guard against an un-substituted TradingView placeholder arriving as a literal.
function present(v) {
  return v != null && String(v).trim() !== '' && !String(v).includes('{{');
}

// DESIRED net position (in our own SIZE units), direction only.
// Priority: strategy.market_position (long/short/flat) > numeric position/position_size
// > legacy action (buy/sell/exit). Order-fill alerts report FILL DIRECTION, so
// market_position is preferred: it is the strategy's net position AFTER the fill,
// which makes entries, exits (->flat), and flips all unambiguous.
// Returns { target, source, label } or null.
function resolveTarget(payload) {
  const mp = payload.market_position ?? payload.marketPosition;
  if (present(mp)) {
    const s = String(mp).trim().toLowerCase();
    if (s === 'long')  return { target: +CFG.SIZE, source: 'market_position', label: 'long' };
    if (s === 'short') return { target: -CFG.SIZE, source: 'market_position', label: 'short' };
    if (s === 'flat')  return { target: 0,         source: 'market_position', label: 'flat' };
  }
  const pos = payload.position ?? payload.position_size ?? payload.positionSize;
  if (present(pos)) {
    const n = Number(pos);
    if (Number.isFinite(n)) {
      return { target: n > 0 ? +CFG.SIZE : n < 0 ? -CFG.SIZE : 0, source: 'position', label: String(n) };
    }
  }
  const a = normAction(payload.action ?? payload.side);
  if (a) return { target: a === 'buy' ? +CFG.SIZE : a === 'sell' ? -CFG.SIZE : 0, source: 'action', label: a };
  return null;
}

// Any incoming symbol ("MNQ1!", "MNQU2026", "MES ") -> canonical root, or null.
// Defensive against the cross-wiring history (MYM alert once carried MNQ):
// we trust only the payload symbol field, and reject anything not in SPECS.
function normRoot(s) {
  s = String(s == null ? '' : s).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  for (const r of ROOTS) if (s.startsWith(r)) return r;
  return null;
}

// ------------------------------- IB state ----------------------------------
const ib = new IBApi({ host: CFG.IB_HOST, port: CFG.IB_PORT, clientId: CFG.CLIENT_ID });

let connected = false;
let nextOrderId = null;
const position = {};                    // root -> confirmed net position (int)
const inFlight = new Map();             // orderId -> { root, delta, qty, action }
const resolved = {};                    // root -> resolved Contract (with conId)
const resolving = {};                   // root -> Promise (in-progress resolution)
const contractReqs = new Map();         // reqId -> { root, resolve, reject, rows }
let reqIdSeq = 9000;                    // contract-details reqId sequence

function effectivePosition(root) {
  let p = position[root] || 0;
  for (const o of inFlight.values()) if (o.root === root) p += o.delta;
  return p;
}

// per-root serialization so multi-fire-per-bar signals don't race the read
const locks = {};
function withLock(key, fn) {
  const prev = locks[key] || Promise.resolve();
  const next = prev.then(fn);
  locks[key] = next.catch(() => {});   // keep the chain alive on rejection
  return next;
}

// ---------------------- front-month contract resolution --------------------
function parseYmd(s) {
  s = String(s || '');
  if (s.length >= 8) return new Date(Date.UTC(+s.slice(0,4), +s.slice(4,6)-1, +s.slice(6,8)));
  if (s.length === 6) return new Date(Date.UTC(+s.slice(0,4), +s.slice(4,6), 0)); // month-end
  return null;
}

function resolveContract(root) {
  if (resolved[root]) return Promise.resolve(resolved[root]);
  if (resolving[root]) return resolving[root];

  const spec = SPECS[root];
  const override = process.env[`EXPIRY_${root}`];   // e.g. EXPIRY_MGC=202608 to pin
  const base = {
    symbol: root,
    secType: 'FUT',
    exchange: spec.exchange,
    currency: 'USD',
    tradingClass: root,           // avoids ambiguity (error 200)
    multiplier: spec.multiplier,
  };
  if (override) base.lastTradeDateOrContractMonth = override;

  const reqId = reqIdSeq++;
  const p = new Promise((resolve, reject) => {
    const rows = [];
    contractReqs.set(reqId, { root, resolve, reject, rows });
    const to = setTimeout(() => {
      if (contractReqs.has(reqId)) {
        contractReqs.delete(reqId);
        reject(new Error(`contractDetails timeout for ${root}`));
      }
    }, 10000);
    // wrap resolve/reject to clear the timer
    const rec = contractReqs.get(reqId);
    rec.resolve = (c) => { clearTimeout(to); resolve(c); };
    rec.reject  = (e) => { clearTimeout(to); reject(e); };
    ib.reqContractDetails(reqId, base);
  }).finally(() => { delete resolving[root]; });

  resolving[root] = p;
  return p;
}

ib.on(EventName.contractDetails, (reqId, details) => {
  const rec = contractReqs.get(reqId);
  if (rec) rec.rows.push(details);
});

ib.on(EventName.contractDetailsEnd, (reqId) => {
  const rec = contractReqs.get(reqId);
  if (!rec) return;
  contractReqs.delete(reqId);
  const now = Date.now();
  const bufferMs = CFG.ROLL_BUFFER_DAYS * 86400000;

  const candidates = rec.rows.map((d) => {
    const c = d.contract || {};
    const exp = parseYmd(d.realExpirationDate || c.lastTradeDateOrContractMonth);
    return { c, exp: exp ? exp.getTime() : Infinity };
  }).filter((x) => isFinite(x.exp)).sort((a, b) => a.exp - b.exp);

  if (!candidates.length) { rec.reject(new Error(`no futures returned for ${rec.root}`)); return; }

  // nearest expiry beyond the roll buffer; fall back to plain nearest future.
  let pick = candidates.find((x) => x.exp > now + bufferMs)
          || candidates.find((x) => x.exp > now)
          || candidates[0];

  resolved[rec.root] = pick.c;
  log('contract_resolved', {
    root: rec.root, conId: pick.c.conId,
    expiry: pick.c.lastTradeDateOrContractMonth, exchange: pick.c.exchange,
  });
  rec.resolve(pick.c);
});

// ------------------------------- orders ------------------------------------
function buildMktOrder(action, qty) {
  const o = {
    action,                 // 'BUY' | 'SELL'
    orderType: 'MKT',
    totalQuantity: qty,
    tif: 'DAY',
    outsideRth: true,       // globex trades ~23h; allow overnight / session-overlap fills
    transmit: true,
  };
  if (CFG.ACCOUNT) o.account = CFG.ACCOUNT;
  return o;
}

ib.on(EventName.orderStatus, (orderId, status, filled, remaining) => {
  const o = inFlight.get(orderId);
  if (!o) return;
  if (status === 'Filled' && remaining === 0) {
    position[o.root] = (position[o.root] || 0) + o.delta;
    inFlight.delete(orderId);
    log('fill', { orderId, root: o.root, delta: o.delta, netPosition: position[o.root] });
  } else if (status === 'Cancelled' || status === 'ApiCancelled' || status === 'Inactive') {
    inFlight.delete(orderId);
    log('order_terminal', { orderId, root: o.root, status });
  }
});

// ---------------------- position seeding / reconcile -----------------------
let seeding = false;
function seedPositions() {
  if (seeding) return;
  seeding = true;
  for (const r of ROOTS) position[r] = 0;   // reset before snapshot
  ib.reqPositions();
}
ib.on(EventName.position, (account, contract, pos) => {
  const root = contract && ROOTS.includes(contract.symbol) ? contract.symbol : null;
  if (root && contract.secType === 'FUT') position[root] = (position[root] || 0) + Number(pos || 0);
});
ib.on(EventName.positionEnd, () => {
  seeding = false;
  ib.cancelPositions();
  log('positions_seeded', { position });
});

// ------------------------------- signal core -------------------------------
async function handleSignal(root, target, source, label) {
  return withLock(root, async () => {
    const contract = await resolveContract(root);
    const current = effectivePosition(root);
    const delta = target - current;

    if (delta === 0) {
      log('noop', { root, source, label, target, current });
      return { status: 'noop', root, target, current };
    }

    const orderAction = delta > 0 ? 'BUY' : 'SELL';
    const qty = Math.abs(delta);

    if (CFG.DRY_RUN) {
      log('dry_run', { root, source, label, orderAction, qty, target, current });
      return { status: 'dry_run', root, orderAction, qty, target, current };
    }

    const orderId = nextOrderId++;
    inFlight.set(orderId, { root, delta, qty, action: orderAction });
    ib.placeOrder(orderId, contract, buildMktOrder(orderAction, qty));
    log('order_placed', { orderId, root, source, label, orderAction, qty, target, current, conId: contract.conId });
    return { status: 'placed', orderId, root, orderAction, qty, target, current };
  });
}

// ------------------------------- HTTP server -------------------------------
function authOk(payload, url) {
  if (!CFG.SECRET) return true;
  const q = (url.split('?')[1] || '').split('&').reduce((a, kv) => {
    const [k, v] = kv.split('='); if (k) a[k] = decodeURIComponent(v || ''); return a;
  }, {});
  const supplied = payload.token || payload.passphrase || payload.secret || q.token;
  return supplied === CFG.SECRET;
}

const server = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (req.method === 'GET' && req.url.startsWith('/health')) {
    return send(200, { ok: true, connected, clientId: CFG.CLIENT_ID, port: CFG.PORT });
  }
  if (req.method === 'GET' && req.url.startsWith('/positions')) {
    const eff = {}; for (const r of ROOTS) eff[r] = effectivePosition(r);
    return send(200, { confirmed: position, effective: eff, inFlight: inFlight.size });
  }
  if (req.method !== 'POST' || !req.url.startsWith('/webhook')) {
    return send(404, { error: 'not found' });
  }

  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
  req.on('end', async () => {
    let payload;
    try { payload = JSON.parse(body); }
    catch { log('bad_payload', { body: body.slice(0, 300) }); return send(400, { error: 'invalid json' }); }

    if (!authOk(payload, req.url)) { log('auth_fail', {}); return send(401, { error: 'unauthorized' }); }
    if (!connected)               { log('not_connected', { payload }); return send(503, { error: 'ib not connected' }); }

    // Tolerate scrambled TradersPost-style payloads: take only symbol + target,
    // ignore quantity/take_profit/stop_loss/trailing_stop bleed-through.
    const root = normRoot(payload.symbol ?? payload.ticker);
    const t    = resolveTarget(payload);

    if (!root || !t) {
      log('reject', { reason: 'unparseable target/symbol', payload: JSON.stringify(payload).slice(0, 300) });
      return send(422, { error: 'unrecognized target or symbol' });
    }

    try {
      const result = await handleSignal(root, t.target, t.source, t.label);
      return send(200, result);
    } catch (e) {
      log('signal_error', { root, source: t.source, label: t.label, error: String(e && e.message || e) });
      return send(500, { error: String(e && e.message || e) });
    }
  });
});

// ------------------------------- IB wiring ---------------------------------
ib.on(EventName.nextValidId, (orderId) => {
  nextOrderId = nextOrderId == null ? orderId : Math.max(nextOrderId, orderId);
  log('next_valid_id', { nextOrderId });
});

ib.on(EventName.connected, () => {
  connected = true;
  log('ib_connected', { host: CFG.IB_HOST, port: CFG.IB_PORT, clientId: CFG.CLIENT_ID });
  ib.reqIds();
  seedPositions();
  // warm the contract cache so the first live signal isn't blocked on resolution
  for (const r of ROOTS) resolveContract(r).catch((e) => log('resolve_warn', { root: r, error: String(e.message || e) }));
});

ib.on(EventName.disconnected, () => {
  connected = false;
  log('ib_disconnected', {});
  setTimeout(connect, 5000);
});

ib.on(EventName.error, (err, code, reqId) => {
  // 2104/2106/2158 = data-farm-OK noise; suppress
  if ([2104, 2106, 2158, 2107, 2119].includes(code)) return;
  log('ib_error', { code, reqId, message: String(err && err.message || err) });
  // if a contract-details request errored, reject its waiter
  const rec = contractReqs.get(reqId);
  if (rec) { contractReqs.delete(reqId); rec.reject(new Error(`contractDetails error ${code}`)); }
});

function connect() {
  try { ib.connect(); } catch (e) { log('connect_throw', { error: String(e.message || e) }); setTimeout(connect, 5000); }
}

// ------------------------------- boot --------------------------------------
process.on('uncaughtException',  (e) => log('uncaught', { error: String(e && e.stack || e) }));
process.on('unhandledRejection', (e) => log('unhandled', { error: String(e && e.message || e) }));

server.listen(CFG.PORT, () => log('http_listening', {
  port: CFG.PORT, dryRun: CFG.DRY_RUN, size: CFG.SIZE, secret: !!CFG.SECRET,
}));
connect();
