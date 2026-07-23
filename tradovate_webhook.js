#!/usr/bin/env node
/**
 * tradovate_webhook.js — VWAP Reclaim/Rejection strategy on Tradovate Demo
 * ==========================================================================
 *
 * Receives signals from the VWAP reclaim engine (vwap_signal_sender.py)
 * and executes them on the Tradovate demo account.
 *
 * Architecture:
 *   vwap_signal_sender.py → POST /signal → this server → Tradovate REST API
 *   Tradovate WebSocket  → fill/position updates → trail/stop logic
 *
 * Endpoints:
 *   POST /signal   — receive VWAP signal { symbol, direction, entry, atr }
 *   GET  /status   — current positions and P&L
 *   GET  /health   — connection status
 *
 * Config (from .env):
 *   TRADOVATE_CID          — API client ID
 *   TRADOVATE_SECRET       — API secret
 *   TRADOVATE_DEMO_ACCOUNT — account name e.g. DEMO7409799
 *   TRADOVATE_PORT         — HTTP port (default 3002)
 *
 * Deploy:
 *   pm2 start tradovate_webhook.js --name tradovate-webhook
 */

'use strict';
require('dotenv').config();
const { execSync } = require('child_process');
const NTFY_TOPIC_ALERTS = process.env.NTFY_TOPIC || '';
function ntfyPush(title, body, priority = 'default', tags = 'chart_with_upwards_trend') {
  if (!NTFY_TOPIC_ALERTS) return;
  try {
    const safe = body.replace(/"/g, "'");
    execSync(
      `curl -s -H "Title: ${title}" -H "Priority: ${priority}" -H "Tags: ${tags}" -d "${safe}" https://ntfy.sh/${NTFY_TOPIC_ALERTS}`,
      { timeout: 10000 }
    );
  } catch (e) { /* non-fatal, don't let notification failures break trading */ }
}
const http       = require('http');
const https      = require('https');
const WebSocket  = require('ws');
const fs         = require('fs');
const path       = require('path');

// ── Config ──────────────────────────────────────────────────────────────────
const CFG = {
  cid:         process.env.TRADOVATE_CID,
  secret:      process.env.TRADOVATE_SECRET,
  username:    process.env.TRADOVATE_USERNAME,
  password:    process.env.TRADOVATE_PASSWORD,
  deviceId:    process.env.TRADOVATE_DEVICE_ID,
  account:     process.env.TRADOVATE_DEMO_ACCOUNT || 'DEMO7409799',
  port:        parseInt(process.env.TRADOVATE_PORT || '3002', 10),
  maxContracts: Math.max(
    1,
    parseInt(process.env.MAX_CONTRACTS || '5', 10)
  ),
  maxDailyTrades: Math.max(
    1,
    parseInt(process.env.MAX_DAILY_TRADES || '20', 10)
  ),
  duplicateWindowSeconds: Math.max(
    1,
    parseInt(process.env.DUPLICATE_WINDOW_SECONDS || '15', 10)
  ),
  adminToken: process.env.TRADOVATE_ADMIN_TOKEN || '',
  baseUrl:     'https://demo.tradovateapi.com/v1',
  wsUrl:       'wss://demo.tradovateapi.com/v1/websocket',
  logFile:     path.join(__dirname, 'tradovate_log.jsonl'),
  dashboardDir: path.join(__dirname, 'dashboard'),
  stateDir:    path.join(__dirname, 'state'),
  positionsFile: path.join(__dirname, 'state', 'positions.json'),
  runtimeFile: path.join(__dirname, 'state', 'runtime.json'),
  reconciliationFile: path.join(
    __dirname,
    'state',
    'reconciliation.json'
  ),
  reconcileSeconds: Math.max(
    15,
    parseInt(process.env.RECONCILE_SECONDS || '60', 10)
  ),
  appId:       'VWAP Reclaim Futures Bot',
  appVersion:  '1.0.0',
};

// ── Exit parameters (matching the backtest best params) ──────────────────────
const ARM_POINTS   = 1.0;
const TRAIL_POINTS = 0.75;
const STOP_MULT    = 7.0;

// Per-instrument overrides (validated Jul 19 2026 — see memory)
const STOP_MULT_OVERRIDE = { MES: 6.0 };
const TRAIL_POINTS_OVERRIDE = { MES: 0.25 };

function getStopMult(symbol) {
  const root = symbol.slice(0, 3);
  return STOP_MULT_OVERRIDE[root] ?? STOP_MULT;
}

function getTrailPoints(symbol) {
  const root = symbol.slice(0, 3);
  return TRAIL_POINTS_OVERRIDE[root] ?? TRAIL_POINTS;
}
const MAX_BARS     = 24;    // 24 × 5min = 120 min max hold
const BAR_SECONDS  = 300;   // 5-minute bars

// ── State ────────────────────────────────────────────────────────────────────
let accessToken   = null;
let tokenExpiry   = 0;
let accountId     = null;   // numeric account ID
let ws            = null;
let wsConnected   = false;
let positions     = {};     // posKey → position state
let reconnectTimer = null;
let startupReady = false;
let reconciliationRunning = false;

const startedAt = Date.now();

const reconciliationState = {
  safetyLock: false,
  lastRunTs: null,
  lastSuccessTs: null,
  lastError: null,
  mismatches: [],
  brokerPositions: [],
};

const runtimeState = {
  paused: false,
  entriesEnabled: true,
  lastSignal: null,
  lastOrder: null,
  recentSignals: new Map(),
  daily: {
    date: null,
    trades: 0,
    exits: 0,
    estimatedRealizedDollars: 0,
  },
};

// ── Logging ──────────────────────────────────────────────────────────────────
function log(event, data = {}) {
  const entry = { ts: new Date().toISOString(), event, ...data };
  console.log(JSON.stringify(entry));
  fs.appendFileSync(CFG.logFile, JSON.stringify(entry) + '\n');
}

function ensureStateDir() {
  fs.mkdirSync(CFG.stateDir, { recursive: true });
}

function atomicWriteJson(filePath, value) {
  ensureStateDir();

  const tempPath =
    filePath + '.tmp-' + process.pid + '-' + Date.now();

  fs.writeFileSync(
    tempPath,
    JSON.stringify(value, null, 2) + '\n',
    'utf8'
  );

  fs.renameSync(tempPath, filePath);
}

function persistedRuntimeState() {
  return {
    paused: runtimeState.paused,
    entriesEnabled: runtimeState.entriesEnabled,
    lastSignal: runtimeState.lastSignal,
    lastOrder: runtimeState.lastOrder,
    daily: runtimeState.daily,
  };
}

function persistPositions() {
  try {
    atomicWriteJson(CFG.positionsFile, positions);
  } catch (error) {
    log('state_persist_error', {
      target: 'positions',
      error: error.message,
    });
  }
}

function persistRuntime() {
  try {
    atomicWriteJson(
      CFG.runtimeFile,
      persistedRuntimeState()
    );
  } catch (error) {
    log('state_persist_error', {
      target: 'runtime',
      error: error.message,
    });
  }
}

function persistReconciliation() {
  try {
    atomicWriteJson(
      CFG.reconciliationFile,
      reconciliationState
    );
  } catch (error) {
    log('state_persist_error', {
      target: 'reconciliation',
      error: error.message,
    });
  }
}

function persistAllState() {
  persistPositions();
  persistRuntime();
  persistReconciliation();
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;

    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return fallback;

    return JSON.parse(raw);
  } catch (error) {
    log('state_load_error', {
      filePath,
      error: error.message,
    });
    return fallback;
  }
}

function loadPersistedState() {
  ensureStateDir();

  const savedPositions =
    readJsonFile(CFG.positionsFile, {});

  if (
    savedPositions &&
    typeof savedPositions === 'object' &&
    !Array.isArray(savedPositions)
  ) {
    positions = savedPositions;
  }

  const savedRuntime =
    readJsonFile(CFG.runtimeFile, {});

  if (typeof savedRuntime.paused === 'boolean') {
    runtimeState.paused = savedRuntime.paused;
  }

  if (typeof savedRuntime.entriesEnabled === 'boolean') {
    runtimeState.entriesEnabled =
      savedRuntime.entriesEnabled;
  }

  if (savedRuntime.lastSignal) {
    runtimeState.lastSignal = savedRuntime.lastSignal;
  }

  if (savedRuntime.lastOrder) {
    runtimeState.lastOrder = savedRuntime.lastOrder;
  }

  if (
    savedRuntime.daily &&
    typeof savedRuntime.daily === 'object'
  ) {
    runtimeState.daily = {
      ...runtimeState.daily,
      ...savedRuntime.daily,
    };
  }

  const savedReconciliation =
    readJsonFile(CFG.reconciliationFile, {});

  if (
    savedReconciliation &&
    typeof savedReconciliation === 'object'
  ) {
    Object.assign(
      reconciliationState,
      savedReconciliation
    );
  }

  log('state_loaded', {
    positions: Object.keys(positions).length,
    paused: runtimeState.paused,
    entriesEnabled: runtimeState.entriesEnabled,
    daily: runtimeState.daily,
  });
}

function etDateKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function resetDailyStateIfNeeded() {
  const today = etDateKey();

  if (runtimeState.daily.date !== today) {
    runtimeState.daily = {
      date: today,
      trades: 0,
      exits: 0,
      estimatedRealizedDollars: 0,
    };

    log('daily_state_reset', { date: today });
    persistRuntime();
  }
}

function pointValue(symbol) {
  const root = String(symbol).replace('@', '').toUpperCase().slice(0, 3);

  return {
    MES: 5.00,
    MNQ: 2.00,
    MYM: 0.50,
  }[root] || 0;
}

function recordEstimatedRealized(symbol, pnlPoints, qty) {
  resetDailyStateIfNeeded();

  const dollars =
    Number(pnlPoints) *
    pointValue(symbol) *
    Math.max(1, Number(qty) || 1);

  runtimeState.daily.exits += 1;
  runtimeState.daily.estimatedRealizedDollars += dollars;

  log('estimated_realized_recorded', {
    symbol,
    pnlPoints: Number(pnlPoints),
    qty,
    estimatedDollars: Number(dollars.toFixed(2)),
    dailyEstimatedDollars: Number(
      runtimeState.daily.estimatedRealizedDollars.toFixed(2)
    ),
  });

  persistRuntime();
}

function cleanRecentSignals() {
  const cutoff =
    Date.now() - CFG.duplicateWindowSeconds * 1000;

  for (const [key, timestamp] of runtimeState.recentSignals.entries()) {
    if (timestamp < cutoff) {
      runtimeState.recentSignals.delete(key);
    }
  }
}

function duplicateFingerprint(sig, symbol, requestedAction) {
  return JSON.stringify({
    symbol,
    action: requestedAction,
    signalType:
      sig.signal_type ||
      sig.reason ||
      requestedAction,
    price: Number(sig.entry_price ?? sig.price) || null,
  });
}

function isDuplicateSignal(fingerprint) {
  cleanRecentSignals();

  const previous = runtimeState.recentSignals.get(fingerprint);

  if (
    previous &&
    Date.now() - previous < CFG.duplicateWindowSeconds * 1000
  ) {
    return true;
  }

  runtimeState.recentSignals.set(fingerprint, Date.now());
  return false;
}

function adminAuthorized(req, requestUrl) {
  if (!CFG.adminToken) return false;

  const headerToken =
    String(req.headers['x-admin-token'] || '');

  const queryToken =
    requestUrl.searchParams.get('token') || '';

  return (
    headerToken === CFG.adminToken ||
    queryToken === CFG.adminToken
  );
}

function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function dashboardHtml() {
  resetDailyStateIfNeeded();

  const state = {
    account: CFG.account,
    environment: 'Tradovate Demo',
    accountId,
    connected: !!accessToken && Date.now() < tokenExpiry,
    paused: runtimeState.paused,
    entriesEnabled: runtimeState.entriesEnabled,
    maxContracts: CFG.maxContracts,
    maxDailyTrades: CFG.maxDailyTrades,
    duplicateWindowSeconds: CFG.duplicateWindowSeconds,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    daily: {
      ...runtimeState.daily,
      estimatedRealizedDollars: Number(
        runtimeState.daily.estimatedRealizedDollars.toFixed(2)
      ),
    },
    positions,
    lastSignal: runtimeState.lastSignal,
    lastOrder: runtimeState.lastOrder,
  };

  const embeddedState = safeJson(state);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Tradovate Futures Bot</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      background: #111827;
      color: #f3f4f6;
      margin: 0;
      padding: 24px;
    }
    .wrap {
      max-width: 1100px;
      margin: auto;
    }
    h1 {
      margin-top: 0;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
      gap: 14px;
    }
    .card {
      background: #1f2937;
      border: 1px solid #374151;
      border-radius: 10px;
      padding: 16px;
      margin-bottom: 14px;
    }
    .label {
      color: #9ca3af;
      font-size: 13px;
      margin-bottom: 6px;
    }
    .value {
      font-size: 22px;
      font-weight: 700;
    }
    .good { color: #34d399; }
    .bad { color: #f87171; }
    .warn { color: #fbbf24; }
    button {
      border: 0;
      border-radius: 7px;
      padding: 11px 15px;
      margin: 5px;
      cursor: pointer;
      font-weight: 700;
    }
    button.safe { background: #10b981; color: white; }
    button.warn { background: #f59e0b; color: #111827; }
    button.stop { background: #ef4444; color: white; }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      background: #111827;
      padding: 12px;
      border-radius: 7px;
      overflow: auto;
    }
  </style>
</head>
<body>
<div class="wrap">
  <h1>Tradovate Futures Bot</h1>

  <div class="grid">
    <div class="card">
      <div class="label">Connection</div>
      <div class="value \${state.connected ? 'good' : 'bad'}">
        \${state.connected ? 'CONNECTED' : 'DISCONNECTED'}
      </div>
    </div>

    <div class="card">
      <div class="label">Environment</div>
      <div class="value">\${state.environment}</div>
    </div>

    <div class="card">
      <div class="label">Trading State</div>
      <div class="value \${state.paused ? 'bad' : 'good'}">
        \${state.paused ? 'PAUSED' : 'RUNNING'}
      </div>
    </div>

    <div class="card">
      <div class="label">New Entries</div>
      <div class="value \${state.entriesEnabled ? 'good' : 'warn'}">
        \${state.entriesEnabled ? 'ENABLED' : 'DISABLED'}
      </div>
    </div>

    <div class="card">
      <div class="label">Today's Entries</div>
      <div class="value">
        \${state.daily.trades} / \${state.maxDailyTrades}
      </div>
    </div>

    <div class="card">
      <div class="label">Estimated Realized P&L</div>
      <div class="value \${state.daily.estimatedRealizedDollars >= 0 ? 'good' : 'bad'}">
        $\${state.daily.estimatedRealizedDollars.toFixed(2)}
      </div>
    </div>

    <div class="card">
      <div class="label">Open Internal Positions</div>
      <div class="value">\${Object.keys(state.positions).length}</div>
    </div>

    <div class="card">
      <div class="label">Maximum Contracts</div>
      <div class="value">\${state.maxContracts}</div>
    </div>
  </div>

  <div class="card">
    <h2>Controls</h2>
    <button class="stop" onclick="control('PAUSE')">Pause Trading</button>
    <button class="safe" onclick="control('RESUME')">Resume Trading</button>
    <button class="warn" onclick="control('DISABLE_ENTRIES')">
      Disable New Entries
    </button>
    <button class="safe" onclick="control('ENABLE_ENTRIES')">
      Enable New Entries
    </button>
    <p id="controlResult"></p>
  </div>

  <div class="card">
    <h2>Positions</h2>
    <pre>\${JSON.stringify(state.positions, null, 2)}</pre>
  </div>

  <div class="card">
    <h2>Last Signal</h2>
    <pre>\${JSON.stringify(state.lastSignal, null, 2)}</pre>
  </div>

  <div class="card">
    <h2>Last Order</h2>
    <pre>\${JSON.stringify(state.lastOrder, null, 2)}</pre>
  </div>
</div>

<script>
  const state = ${embeddedState};

  async function control(action) {
    const token = new URLSearchParams(location.search).get('token');

    if (!token) {
      document.getElementById('controlResult').textContent =
        'Missing dashboard token in URL.';
      return;
    }

    const response = await fetch('/control', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': token
      },
      body: JSON.stringify({ action })
    });

    const result = await response.json();

    document.getElementById('controlResult').textContent =
      JSON.stringify(result);

    if (response.ok) {
      setTimeout(() => location.reload(), 400);
    }
  }

  setTimeout(() => location.reload(), 15000);
</script>
</body>
</html>`;
}

// ── REST helper ──────────────────────────────────────────────────────────────
function tvPost(endpoint, body, token) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url     = new URL(CFG.baseUrl + endpoint);
    const opts = {
      hostname: url.hostname,
      path:     url.pathname,
      method:   'POST',
      headers: {
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function tvGet(endpoint, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(CFG.baseUrl + endpoint);
    const opts = {
      hostname: url.hostname,
      // BUG FIX: url.pathname alone drops the query string entirely --
      // every GET call through this function (findContract's ?name=...,
      // getquote's ?symbol=...) was silently being sent with NO query
      // parameters at all. Must include url.search to actually send them.
      path:     url.pathname + url.search,
      method:   'GET',
      headers: { Authorization: `Bearer ${token}` },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Authentication ────────────────────────────────────────────────────────────
async function authenticate() {
  if (accessToken && Date.now() < tokenExpiry - 60000) return accessToken;
  log('auth_attempt');
  const res = await tvPost('/auth/accesstokenrequest', {
    name:       CFG.username || CFG.account,
    password:   CFG.password,
    appId:      CFG.appId,
    appVersion: CFG.appVersion,
    cid:        parseInt(CFG.cid, 10),
    sec:        CFG.secret,
    deviceId:   CFG.deviceId,
  });
  if (!res.accessToken) {
    log('auth_failed', { res });
    throw new Error('Auth failed: ' + JSON.stringify(res));
  }
  accessToken = res.accessToken;
  tokenExpiry = Date.now() + (res.expirationTime
    ? new Date(res.expirationTime).getTime() - Date.now()
    : 3600000);
  log('auth_ok', { expiresIn: Math.round((tokenExpiry - Date.now()) / 1000) + 's' });
  return accessToken;
}

// ── Account resolution ────────────────────────────────────────────────────────
async function resolveAccount() {
  if (accountId) return accountId;
  const token = await authenticate();
  const accounts = await tvGet('/account/list', token);
  const acct = accounts.find(a =>
    a.name === CFG.account || String(a.id) === CFG.account
  );
  if (!acct) throw new Error(`Account ${CFG.account} not found`);
  accountId = acct.id;
  log('account_resolved', { accountId, name: acct.name, balance: acct.cashBalance });
  return accountId;
}

// ── Contract lookup ───────────────────────────────────────────────────────────
async function findContract(symbol) {
  const token = await authenticate();

  // Tradable September 2026 contracts.
  // Continuous symbols such as @MES can be queried but cannot be traded.
  const activeContracts = {
    MES: 'MESU6',
    MNQ: 'MNQU6',
    MYM: 'MYMU6',
  };

  const root = String(symbol).replace('@', '').toUpperCase();
  const lookupSymbol = activeContracts[root] || symbol;

  const res = await tvGet(
    `/contract/find?name=${encodeURIComponent(lookupSymbol)}`, token
  );

  if (!res || !res.id) {
    throw new Error(
      `Contract not found: ${symbol} (looked up as ${lookupSymbol})`
    );
  }

  return res;
}

function rootFromContractName(name) {
  const upper =
    String(name || '')
      .replace('@', '')
      .toUpperCase();

  if (upper.startsWith('MES')) return 'MES';
  if (upper.startsWith('MNQ')) return 'MNQ';
  if (upper.startsWith('MYM')) return 'MYM';

  return upper.slice(0, 3);
}

async function getBrokerPositions() {
  const token = await authenticate();
  const acctId = await resolveAccount();
  const response = await tvGet('/position/list', token);

  if (!Array.isArray(response)) {
    throw new Error(
      'Unexpected /position/list response: ' +
      JSON.stringify(response)
    );
  }

  const relevant = response.filter(position => {
    const sameAccount =
      Number(position.accountId) === Number(acctId);

    const netPos = Number(position.netPos || 0);

    return sameAccount && netPos !== 0;
  });

  const result = [];

  for (const brokerPosition of relevant) {
    let contractName =
      brokerPosition.contractName ||
      brokerPosition.symbol ||
      null;

    if (!contractName && brokerPosition.contractId) {
      const contract = await tvGet(
        '/contract/item?id=' +
        encodeURIComponent(brokerPosition.contractId),
        token
      );

      contractName =
        contract && contract.name
          ? contract.name
          : null;
    }

    if (!contractName) {
      log('reconcile_contract_name_missing', {
        brokerPosition,
      });
      continue;
    }

    const netPos = Number(brokerPosition.netPos || 0);
    const root = rootFromContractName(contractName);

    if (!['MES', 'MNQ', 'MYM'].includes(root)) {
      continue;
    }

    const rawPrice =
      brokerPosition.netPrice ??
      brokerPosition.avgPrice ??
      brokerPosition.averagePrice ??
      brokerPosition.price ??
      null;

    const averagePrice = Number(rawPrice);

    result.push({
      symbol: root,
      contractName,
      contractId: brokerPosition.contractId || null,
      direction: netPos > 0 ? 'long' : 'short',
      qty: Math.abs(netPos),
      averagePrice:
        Number.isFinite(averagePrice) && averagePrice > 0
          ? averagePrice
          : null,
      raw: brokerPosition,
    });
  }

  return result;
}


async function getLiveAccountSummary() {
  const token = await authenticate();
  const acctId = await resolveAccount();

  const [accountsResult, cashResult, positionsResult, ordersResult] =
    await Promise.allSettled([
      tvGet('/account/list', token),
      tvGet(
        '/cashBalance/getcashbalancesnapshot?accountId=' +
        encodeURIComponent(acctId),
        token
      ),
      tvGet('/position/list', token),
      tvGet('/order/list', token),
    ]);

  const accounts =
    accountsResult.status === 'fulfilled' &&
    Array.isArray(accountsResult.value)
      ? accountsResult.value
      : [];

  const account =
    accounts.find(item =>
      Number(item.id) === Number(acctId)
    ) || null;

  const cashSnapshot =
    cashResult.status === 'fulfilled' &&
    cashResult.value &&
    typeof cashResult.value === 'object' &&
    !Array.isArray(cashResult.value)
      ? cashResult.value
      : null;

  const brokerPositions =
    positionsResult.status === 'fulfilled' &&
    Array.isArray(positionsResult.value)
      ? positionsResult.value.filter(position =>
          Number(position.accountId) === Number(acctId) &&
          Number(position.netPos || 0) !== 0
        )
      : [];

  const allOrders =
    ordersResult.status === 'fulfilled' &&
    Array.isArray(ordersResult.value)
      ? ordersResult.value.filter(order =>
          Number(order.accountId) === Number(acctId)
        )
      : [];

  const workingStatuses = new Set([
    'Working',
    'PendingNew',
    'PendingReplace',
    'Submitted',
    'Accepted',
    'Suspended',
  ]);

  const workingOrders = allOrders.filter(order =>
    workingStatuses.has(String(order.ordStatus || order.status || ''))
  );

  const endpointErrors = {};

  if (accountsResult.status === 'rejected') {
    endpointErrors.accounts = accountsResult.reason?.message ||
      String(accountsResult.reason);
  }

  if (cashResult.status === 'rejected') {
    endpointErrors.cashBalance = cashResult.reason?.message ||
      String(cashResult.reason);
  }

  if (positionsResult.status === 'rejected') {
    endpointErrors.positions = positionsResult.reason?.message ||
      String(positionsResult.reason);
  }

  if (ordersResult.status === 'rejected') {
    endpointErrors.orders = ordersResult.reason?.message ||
      String(ordersResult.reason);
  }

  const numberOrNull = value => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  return {
    account: {
      id: acctId,
      name: account?.name || CFG.account,
      active: account?.active ?? null,
      accountType:
        account?.accountType ||
        account?.type ||
        null,
    },

    balances: {
      cashBalance: numberOrNull(
        cashSnapshot?.totalCashValue ??
        cashSnapshot?.cashUSD ??
        account?.cashBalance
      ),
      netLiquidatingValue: numberOrNull(
        cashSnapshot?.netLiq ??
        cashSnapshot?.netLiquidatingValue ??
        cashSnapshot?.netLiqValue
      ),
      openPnL: numberOrNull(
        cashSnapshot?.openPnL ??
        cashSnapshot?.unrealizedPnL
      ),
      realizedPnL: numberOrNull(
        cashSnapshot?.realizedPnL
      ),
      totalPnL: numberOrNull(
        cashSnapshot?.totalPnL
      ),
      initialMargin: numberOrNull(
        cashSnapshot?.initialMargin
      ),
      maintenanceMargin: numberOrNull(
        cashSnapshot?.maintenanceMargin
      ),
      availableFunds: numberOrNull(
        cashSnapshot?.currencyCashAvailWithdrawalUSD ??
        cashSnapshot?.availableFunds ??
        cashSnapshot?.buyingPower
      ),
    },

    positions: brokerPositions.map(position => ({
      contractId: position.contractId || null,
      symbol:
        position.contractName ||
        position.symbol ||
        null,
      netPosition: numberOrNull(position.netPos),
      averagePrice: numberOrNull(
        position.netPrice ??
        position.avgPrice ??
        position.averagePrice
      ),
    })),

    workingOrders: workingOrders.map(order => ({
      orderId: order.id || order.orderId || null,
      contractId: order.contractId || null,
      action: order.action || null,
      quantity: numberOrNull(
        order.orderQty ??
        order.quantity
      ),
      filledQuantity: numberOrNull(
        order.cumQty ??
        order.filledQty
      ),
      orderType: order.orderType || null,
      status: order.ordStatus || order.status || null,
      price: numberOrNull(order.price),
      stopPrice: numberOrNull(order.stopPrice),
    })),

    reconciliation: {
      safetyLock: reconciliationState.safetyLock,
      lastRunTs: reconciliationState.lastRunTs,
      lastSuccessTs: reconciliationState.lastSuccessTs,
      lastError: reconciliationState.lastError,
      mismatches: reconciliationState.mismatches,
    },

    endpointErrors,
  };
}

function createReconciledPosition(brokerPosition) {
  const key = posKey(
    brokerPosition.symbol,
    brokerPosition.direction
  );

  const entryPrice = brokerPosition.averagePrice;

  positions[key] = {
    symbol: brokerPosition.symbol,
    direction: brokerPosition.direction,
    entryPrice,
    atrAtEntry: null,
    qty: brokerPosition.qty,
    stopPrice: null,
    armed: false,
    peak: entryPrice,
    trailLine: null,
    barsHeld: 0,
    signalTs: null,
    openTs: Date.now(),
    reconciledFromBroker: true,
    externallyManaged: true,
    contractName: brokerPosition.contractName,
  };

  return key;
}

async function reconcilePositions(source = 'interval') {
  if (reconciliationRunning) {
    return reconciliationState;
  }

  reconciliationRunning = true;
  reconciliationState.lastRunTs =
    new Date().toISOString();
  reconciliationState.lastError = null;
  reconciliationState.mismatches = [];

  try {
    const brokerPositions =
      await getBrokerPositions();

    reconciliationState.brokerPositions =
      brokerPositions.map(position => ({
        symbol: position.symbol,
        contractName: position.contractName,
        direction: position.direction,
        qty: position.qty,
        averagePrice: position.averagePrice,
      }));

    const brokerBySymbol = new Map();

    for (const brokerPosition of brokerPositions) {
      brokerBySymbol.set(
        brokerPosition.symbol,
        brokerPosition
      );
    }

    for (const [key, internalPosition] of
      Object.entries(positions)) {

      const brokerPosition =
        brokerBySymbol.get(internalPosition.symbol);

      if (!brokerPosition) {
        reconciliationState.mismatches.push({
          type: 'internal_position_not_at_broker',
          key,
          symbol: internalPosition.symbol,
          direction: internalPosition.direction,
          qty: internalPosition.qty,
        });

        log('reconcile_removed_phantom_position', {
          key,
          internalPosition,
        });

        delete positions[key];
        continue;
      }

      if (
        brokerPosition.direction !==
        internalPosition.direction
      ) {
        reconciliationState.mismatches.push({
          type: 'direction_mismatch',
          key,
          symbol: internalPosition.symbol,
          internalDirection:
            internalPosition.direction,
          brokerDirection:
            brokerPosition.direction,
        });

        delete positions[key];
        createReconciledPosition(brokerPosition);
        brokerBySymbol.delete(internalPosition.symbol);
        continue;
      }

      const internalQty =
        Math.max(1, Number(internalPosition.qty) || 1);

      if (internalQty !== brokerPosition.qty) {
        reconciliationState.mismatches.push({
          type: 'quantity_mismatch',
          key,
          symbol: internalPosition.symbol,
          internalQty,
          brokerQty: brokerPosition.qty,
        });

        internalPosition.qty = brokerPosition.qty;
      }

      brokerBySymbol.delete(internalPosition.symbol);
    }

    for (const brokerPosition of
      brokerBySymbol.values()) {

      const key =
        createReconciledPosition(brokerPosition);

      reconciliationState.mismatches.push({
        type: 'broker_position_missing_internally',
        key,
        symbol: brokerPosition.symbol,
        direction: brokerPosition.direction,
        qty: brokerPosition.qty,
      });

      log('reconcile_imported_broker_position', {
        key,
        symbol: brokerPosition.symbol,
        direction: brokerPosition.direction,
        qty: brokerPosition.qty,
        averagePrice: brokerPosition.averagePrice,
      });
    }

    reconciliationState.safetyLock =
      Object.values(positions).some(position =>
        position.externallyManaged === true
      );

    reconciliationState.lastSuccessTs =
      new Date().toISOString();

    log('position_reconciliation_complete', {
      source,
      brokerPositions:
        reconciliationState.brokerPositions,
      internalPositions:
        Object.keys(positions),
      mismatches:
        reconciliationState.mismatches,
      safetyLock:
        reconciliationState.safetyLock,
    });

    persistAllState();
    return reconciliationState;
  } catch (error) {
    reconciliationState.safetyLock = true;
    reconciliationState.lastError = error.message;

    log('position_reconciliation_error', {
      source,
      error: error.message,
    });

    persistReconciliation();
    return reconciliationState;
  } finally {
    reconciliationRunning = false;
  }
}

// ── Order placement ────────────────────────────────────────────────────────────
async function placeOrder(symbol, action, qty = 1) {
  const token   = await authenticate();
  const acctId  = await resolveAccount();
  const contract = await findContract(symbol);

  const body = {
    accountSpec:   CFG.account,
    accountId:     acctId,
    action:        action,           // 'Buy' or 'Sell'
    symbol:        contract.name,
    orderQty:      qty,
    orderType:     'Market',
    isAutomated:   true,
    contractId:    contract.id,
  };

  const res = await tvPost('/order/placeorder', body, token);

  runtimeState.lastOrder = {
    ts: new Date().toISOString(),
    symbol,
    action,
    qty,
    orderId: res && res.orderId ? res.orderId : null,
    failureReason:
      res && res.failureReason
        ? res.failureReason
        : null,
  };

  log('order_placed', {
    symbol,
    action,
    qty,
    orderId: res && res.orderId,
    res
  });

  persistRuntime();
  return res;
}

// ── Position management ────────────────────────────────────────────────────────
function posKey(symbol, direction) {
  return `${symbol}_${direction}`;
}

function openPosition(
  symbol,
  direction,
  entryPrice,
  atrAtEntry,
  signalTs,
  qty
) {
  const key  = posKey(symbol, direction);
  const stopMult = getStopMult(symbol);
  const stop = direction === 'long'
    ? entryPrice - stopMult * atrAtEntry
    : entryPrice + stopMult * atrAtEntry;

  positions[key] = {
    symbol,
    direction,
    entryPrice,
    atrAtEntry,
    qty,
    stopPrice: stop,
    armed:     false,
    peak:      entryPrice,
    trailLine: null,
    barsHeld:  0,
    signalTs,
    openTs:    Date.now(),
  };
  log('position_opened', {
    key,
    entryPrice,
    stopPrice: stop,
    qty
  });

  persistPositions();

  ntfyPush(
    `ENTRY: ${symbol} ${direction.toUpperCase()}`,
    `Entry: ${entryPrice}\nStop: ${stop.toFixed(2)}\nATR: ${atrAtEntry.toFixed(2)}`,
    'default', 'chart_with_upwards_trend'
  );
}

async function closePosition(key, exitReason, currentPrice) {
  const pos = positions[key];
  if (!pos) return;
  const action = pos.direction === 'long' ? 'Sell' : 'Buy';
  let closeOrder;

  try {
    closeOrder = await placeOrder(
      pos.symbol,
      action,
      pos.qty || 1
    );
  } catch (e) {
    log('close_order_error', {
      key,
      error: e.message
    });
    return false;
  }

  const closeFailed =
    !closeOrder ||
    !closeOrder.orderId ||
    closeOrder.failureReason;

  if (closeFailed) {
    log('close_order_rejected', {
      key,
      symbol: pos.symbol,
      action,
      qty: pos.qty || 1,
      closeOrder,
    });
    return false;
  }

  const pnlPts = pos.direction === 'long'
    ? currentPrice - pos.entryPrice
    : pos.entryPrice - currentPrice;

  recordEstimatedRealized(
    pos.symbol,
    pnlPts,
    pos.qty || 1
  );

  log('position_closed', {
    key, exitReason, entryPrice: pos.entryPrice,
    exitPrice: currentPrice, pnlPts: pnlPts.toFixed(2),
    armed: pos.armed, barsHeld: pos.barsHeld,
  });
  const pnlIsWin = pnlPts > 0;
  ntfyPush(
    `${pnlIsWin ? 'WIN' : 'LOSS'}: ${pos.symbol} ${pos.direction.toUpperCase()} (${exitReason})`,
    `Entry: ${pos.entryPrice}\nExit: ${currentPrice}\nP&L: ${pnlPts.toFixed(2)} pts\nBars held: ${pos.barsHeld}\nArmed: ${pos.armed}`,
    pnlIsWin ? 'default' : 'high',
    pnlIsWin ? 'white_check_mark' : 'rotating_light'
  );
  delete positions[key];
  persistAllState();
  return true;
}

// ── Price monitoring (polls every 5s between bar closes) ──────────────────────
async function checkPositions() {
  if (Object.keys(positions).length === 0) return;
  const token = await authenticate();
  // Get current quotes for all held symbols
  const syms = [...new Set(Object.values(positions).map(p => p.symbol))];
  for (const sym of syms) {
    try {
      const contract = await findContract(sym);
      const quote = await tvGet(
        `/md/getquote?symbol=${encodeURIComponent(contract.name)}`,
        token
      );
      if (!quote || !quote.price) continue;
      const price = quote.price;

      for (const [key, pos] of Object.entries(positions)) {
        if (pos.symbol !== sym) continue;

        if (pos.externallyManaged === true) {
          continue;
        }

        const hi = price, lo = price; // best available without tick stream

        // Hard stop
        if (pos.direction === 'long' && lo <= pos.stopPrice) {
          await closePosition(key, 'stop', pos.stopPrice);
          continue;
        }
        if (pos.direction === 'short' && hi >= pos.stopPrice) {
          await closePosition(key, 'stop', pos.stopPrice);
          continue;
        }

        // Arm check
        if (!pos.armed) {
          const gain = pos.direction === 'long'
            ? price - pos.entryPrice
            : pos.entryPrice - price;
          if (gain >= ARM_POINTS) {
            pos.armed = true;
            pos.peak  = price;
            log('position_armed', { key, price, gain: gain.toFixed(2) });
          }
        }

        // Trail check
        if (pos.armed) {
          if (pos.direction === 'long') {
            pos.peak     = Math.max(pos.peak, price);
            pos.trailLine = pos.peak - getTrailPoints(pos.symbol);
            if (lo <= pos.trailLine) {
              await closePosition(key, 'trail', pos.trailLine);
            }
          } else {
            pos.peak     = Math.min(pos.peak, price);
            pos.trailLine = pos.peak + getTrailPoints(pos.symbol);
            if (hi >= pos.trailLine) {
              await closePosition(key, 'trail', pos.trailLine);
            }
          }
        }

        // Timestop — count bars
        const barsOpen = Math.floor((Date.now() - pos.openTs) / (BAR_SECONDS * 1000));
        pos.barsHeld = barsOpen;
        if (!pos.armed && barsOpen >= MAX_BARS) {
          await closePosition(key, 'timestop', price);
        }
      }
    } catch (e) {
      log('check_positions_error', { sym, error: e.message });
    }
  }

  persistPositions();
}

function sendDashboardFile(res, filename, contentType) {
  const filePath = path.join(CFG.dashboardDir, filename);

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, {
      'Content-Type': 'application/json'
    });

    res.end(JSON.stringify({
      ok: false,
      error: 'Dashboard file not found'
    }));

    return;
  }

  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  });

  fs.createReadStream(filePath).pipe(res);
}

function readRecentLogEvents(limit = 100) {
  const safeLimit = Math.max(
    1,
    Math.min(500, Number(limit) || 100)
  );

  try {
    if (!fs.existsSync(CFG.logFile)) {
      return [];
    }

    const raw = fs.readFileSync(CFG.logFile, 'utf8');

    const lines = raw
      .split('\n')
      .filter(Boolean)
      .slice(-safeLimit)
      .reverse();

    const events = [];

    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch (error) {
        events.push({
          ts: null,
          event: 'unparsed_log_line',
          line
        });
      }
    }

    return events;
  } catch (error) {
    log('dashboard_event_read_error', {
      error: error.message
    });

    return [];
  }
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const sendHtml = (code, html) => {
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  };

  const requestUrl = new URL(
    req.url,
    `http://${req.headers.host || 'localhost'}`
  );

  resetDailyStateIfNeeded();

  if (
    req.method === 'GET' &&
    requestUrl.pathname === '/health'
  ) {
    return send(200, {
      ok: true,
      environment: 'demo',
      account: CFG.account,
      accountId,
      authenticated:
        !!accessToken && Date.now() < tokenExpiry,
      paused: runtimeState.paused,
      entriesEnabled: runtimeState.entriesEnabled,
      positions: Object.keys(positions).length,
      startupReady,
      safetyLock: reconciliationState.safetyLock,
      reconciliationHealthy:
        !reconciliationState.lastError,
      lastReconciliation:
        reconciliationState.lastSuccessTs,
      uptimeSeconds:
        Math.floor((Date.now() - startedAt) / 1000),
    });
  }

  if (
    req.method === 'GET' &&
    requestUrl.pathname === '/status'
  ) {
    return send(200, {
      positions,
      runtime: {
        paused: runtimeState.paused,
        entriesEnabled: runtimeState.entriesEnabled,
        maxContracts: CFG.maxContracts,
        maxDailyTrades: CFG.maxDailyTrades,
        daily: runtimeState.daily,
        lastSignal: runtimeState.lastSignal,
        lastOrder: runtimeState.lastOrder,
      },
      reconciliation: {
        startupReady,
        safetyLock:
          reconciliationState.safetyLock,
        lastRunTs:
          reconciliationState.lastRunTs,
        lastSuccessTs:
          reconciliationState.lastSuccessTs,
        lastError:
          reconciliationState.lastError,
        mismatches:
          reconciliationState.mismatches,
        brokerPositions:
          reconciliationState.brokerPositions,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // LIVE BROKER ACCOUNT SUMMARY
  // ---------------------------------------------------------------------------
  if (
    req.method === 'GET' &&
    requestUrl.pathname === '/account'
  ) {
    try {
      const summary = await getLiveAccountSummary();

      return send(200, {
        ok: true,
        broker: 'Tradovate',
        environment:
          CFG.baseUrl.includes('demo')
            ? 'demo'
            : 'live',
        ...summary,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log('account_summary_error', {
        error: error.message,
      });

      return send(503, {
        ok: false,
        broker: 'Tradovate',
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  if (
    req.method === 'GET' &&
    (
      requestUrl.pathname === '/dashboard' ||
      requestUrl.pathname === '/dashboard/'
    )
  ) {
    if (!adminAuthorized(req, requestUrl)) {
      return send(401, {
        ok: false,
        error: 'Dashboard authorization required'
      });
    }

    return sendDashboardFile(
      res,
      'index.html',
      'text/html; charset=utf-8'
    );
  }

  if (
    req.method === 'GET' &&
    requestUrl.pathname === '/dashboard/styles.css'
  ) {
    return sendDashboardFile(
      res,
      'styles.css',
      'text/css; charset=utf-8'
    );
  }

  if (
    req.method === 'GET' &&
    requestUrl.pathname === '/dashboard/app.js'
  ) {
    return sendDashboardFile(
      res,
      'app.js',
      'application/javascript; charset=utf-8'
    );
  }

  if (
    req.method === 'GET' &&
    requestUrl.pathname === '/events'
  ) {
    if (!adminAuthorized(req, requestUrl)) {
      return send(401, {
        ok: false,
        error: 'Event feed authorization required'
      });
    }

    return send(200, {
      ok: true,
      events: readRecentLogEvents(
        requestUrl.searchParams.get('limit')
      )
    });
  }

  if (
    req.method === 'POST' &&
    requestUrl.pathname === '/reconcile'
  ) {
    if (!adminAuthorized(req, requestUrl)) {
      return send(401, {
        ok: false,
        error: 'Admin authorization required'
      });
    }

    const reconciliation =
      await reconcilePositions('manual_dashboard');

    return send(200, {
      ok: true,
      reconciliation
    });
  }

  if (
    req.method === 'POST' &&
    requestUrl.pathname === '/control'
  ) {
    if (!adminAuthorized(req, requestUrl)) {
      return send(401, {
        ok: false,
        error: 'Admin authorization required'
      });
    }

    let controlBody = '';

    req.on('data', chunk => controlBody += chunk);

    req.on('end', () => {
      try {
        const command = JSON.parse(controlBody || '{}');
        const action =
          String(command.action || '').toUpperCase();

        if (action === 'PAUSE') {
          runtimeState.paused = true;
        } else if (action === 'RESUME') {
          runtimeState.paused = false;
        } else if (action === 'DISABLE_ENTRIES') {
          runtimeState.entriesEnabled = false;
        } else if (action === 'ENABLE_ENTRIES') {
          runtimeState.entriesEnabled = true;
        } else {
          return send(400, {
            ok: false,
            error: 'Unknown control action'
          });
        }

        log('control_action', {
          action,
          paused: runtimeState.paused,
          entriesEnabled: runtimeState.entriesEnabled,
        });

        persistRuntime();

        return send(200, {
          ok: true,
          action,
          paused: runtimeState.paused,
          entriesEnabled: runtimeState.entriesEnabled,
        });
      } catch (error) {
        return send(400, {
          ok: false,
          error: 'Invalid control payload'
        });
      }
    });

    return;
  }

  if (req.method === 'POST' && req.url === '/signal') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const sig = JSON.parse(body);

        const requestedAction =
          String(sig.action || '').toUpperCase();

        const symbol =
          String(sig.symbol || '')
            .replace('@', '')
            .toUpperCase();

        const requestedQty =
          Number.parseInt(sig.qty ?? 1, 10);

        const qtyIsValid =
          Number.isInteger(requestedQty) &&
          requestedQty >= 1 &&
          requestedQty <= CFG.maxContracts;

        const qty = qtyIsValid
          ? requestedQty
          : null;

        runtimeState.lastSignal = {
          ts: new Date().toISOString(),
          strategy: sig.strategy || null,
          symbol: symbol || null,
          action: requestedAction || null,
          requestedQty,
          entryPrice:
            Number(sig.entry_price ?? sig.price) || null,
          signalType:
            sig.signal_type ||
            sig.reason ||
            requestedAction ||
            null,
        };

        log('signal_received', runtimeState.lastSignal);

        // Harmless connectivity test
        if (requestedAction === 'TEST') {
          log('test_signal_received', {
            strategy: sig.strategy || null,
            symbol: symbol || null,
            source: 'tradingview'
          });

          return send(200, {
            ok: true,
            test: true,
            brokerOrderPlaced: false,
            account: CFG.account,
            message: 'TradingView webhook path is working'
          });
        }

        if (!symbol) {
          return send(400, {
            ok: false,
            error: 'Missing symbol'
          });
        }

        if (
          !['MES', 'MNQ', 'MYM'].includes(symbol)
        ) {
          log('signal_rejected_symbol', {
            symbol,
            requestedAction
          });

          return send(400, {
            ok: false,
            error: 'Unsupported symbol',
            allowedSymbols: ['MES', 'MNQ', 'MYM']
          });
        }

        // TradingView-controlled exits
        if (
          requestedAction === 'EXIT_LONG' ||
          requestedAction === 'EXIT_SHORT'
        ) {
          const exitDirection =
            requestedAction === 'EXIT_LONG' ? 'long' : 'short';

          const exitKey = posKey(symbol, exitDirection);
          const existingPos = positions[exitKey];

          if (!existingPos) {
            log('exit_skipped_no_internal_position', {
              symbol,
              requestedAction,
              reason: sig.reason || null
            });

            return send(200, {
              ok: false,
              reason: 'No matching internal position',
              symbol,
              action: requestedAction
            });
          }

          const exitAction =
            exitDirection === 'long' ? 'Sell' : 'Buy';

          const exitQty =
            existingPos.qty || 1;

          const exitOrder =
            await placeOrder(
              symbol,
              exitAction,
              exitQty
            );

          const exitFailed =
            !exitOrder ||
            !exitOrder.orderId ||
            exitOrder.failureReason;

          if (exitFailed) {
            log('exit_order_rejected', {
              symbol,
              requestedAction,
              order: exitOrder
            });

            return send(200, {
              ok: false,
              reason: 'Exit rejected by broker',
              order: exitOrder
            });
          }

          const referencePrice =
            Number.isFinite(Number(sig.price))
              ? Number(sig.price)
              : null;

          if (referencePrice !== null) {
            const pnlPoints =
              exitDirection === 'long'
                ? referencePrice - existingPos.entryPrice
                : existingPos.entryPrice - referencePrice;

            recordEstimatedRealized(
              symbol,
              pnlPoints,
              existingPos.qty || 1
            );
          }

          log('position_closed_by_tradingview', {
            key: exitKey,
            symbol,
            direction: exitDirection,
            reason: sig.reason || 'TRADINGVIEW_EXIT',
            entryPrice: existingPos.entryPrice,
            referencePrice,
            orderId: exitOrder.orderId
          });

          delete positions[exitKey];
          persistAllState();

          ntfyPush(
            `EXIT: ${symbol} ${exitDirection.toUpperCase()}`,
            `Reason: ${sig.reason || 'TRADINGVIEW_EXIT'}
Order ID: ${exitOrder.orderId}`,
            'default',
            'checkered_flag'
          );

          return send(200, {
            ok: true,
            action: requestedAction,
            orderId: exitOrder.orderId,
            flattened: true
          });
        }

        // Entry commands
        const isEntryAction =
          requestedAction === 'ENTER_LONG' ||
          requestedAction === 'ENTER_SHORT';

        if (isEntryAction && !startupReady) {
          log('signal_rejected_startup_not_ready', {
            symbol,
            requestedAction,
          });

          return send(503, {
            ok: false,
            reason: 'Server startup is not complete'
          });
        }

        if (
          isEntryAction &&
          reconciliationState.safetyLock
        ) {
          log('signal_rejected_reconciliation_lock', {
            symbol,
            requestedAction,
            lastError:
              reconciliationState.lastError,
            mismatches:
              reconciliationState.mismatches,
          });

          return send(200, {
            ok: false,
            reason:
              'New entries blocked by position reconciliation safety lock'
          });
        }

        if (isEntryAction && runtimeState.paused) {
          log('signal_rejected_paused', {
            symbol,
            requestedAction
          });

          return send(200, {
            ok: false,
            reason: 'Trading is paused'
          });
        }

        if (
          isEntryAction &&
          !runtimeState.entriesEnabled
        ) {
          log('signal_rejected_entries_disabled', {
            symbol,
            requestedAction
          });

          return send(200, {
            ok: false,
            reason: 'New entries are disabled'
          });
        }

        resetDailyStateIfNeeded();

        if (
          isEntryAction &&
          runtimeState.daily.trades >= CFG.maxDailyTrades
        ) {
          log('signal_rejected_daily_trade_limit', {
            symbol,
            requestedAction,
            trades: runtimeState.daily.trades,
            maxDailyTrades: CFG.maxDailyTrades,
          });

          return send(200, {
            ok: false,
            reason: 'Maximum daily trades reached'
          });
        }

        if (isEntryAction && !qtyIsValid) {
          log('signal_rejected_quantity', {
            symbol,
            requestedQty,
            maxContracts: CFG.maxContracts,
          });

          return send(400, {
            ok: false,
            error: 'Invalid quantity',
            minContracts: 1,
            maxContracts: CFG.maxContracts,
          });
        }

        if (isEntryAction) {
          const fingerprint =
            duplicateFingerprint(
              sig,
              symbol,
              requestedAction
            );

          if (isDuplicateSignal(fingerprint)) {
            log('signal_rejected_duplicate', {
              symbol,
              requestedAction,
              duplicateWindowSeconds:
                CFG.duplicateWindowSeconds,
            });

            return send(200, {
              ok: false,
              reason: 'Duplicate signal'
            });
          }
        }

        let direction = sig.direction;
        const entry_price = Number(sig.entry_price ?? sig.price);
        const atr_at_entry = Number(sig.atr_at_entry ?? sig.atr ?? 1);
        const signal_type =
          sig.signal_type ||
          sig.reason ||
          requestedAction;

        if (requestedAction === 'ENTER_LONG') {
          direction = 'long';
        }

        if (requestedAction === 'ENTER_SHORT') {
          direction = 'short';
        }

        if (
          !['long', 'short'].includes(direction) ||
          !Number.isFinite(entry_price) ||
          entry_price <= 0
        ) {
          return send(400, {
            ok: false,
            error: 'Invalid entry payload',
            expectedActions: [
              'TEST',
              'ENTER_LONG',
              'ENTER_SHORT',
              'EXIT_LONG',
              'EXIT_SHORT'
            ]
          });
        }

        const key = posKey(symbol, direction);
        if (positions[key]) {
          log('signal_skipped_busy', { key });
          return send(200, { ok: false, reason: 'position already open' });
        }

        // Place the entry order
        const action = direction === 'long' ? 'Buy' : 'Sell';
        const order  = await placeOrder(symbol, action, qty);

        // BUG FIX: only record an open position if the broker actually
        // confirmed the fill. Previously this ran unconditionally, so a
        // rejected order (e.g. the "Access is denied" case) still created
        // internal position-tracking state for a position that was never
        // actually opened -- a phantom position the exit-management logic
        // would then try to manage against a real broker state that didn't
        // exist.
        const orderFailed = !order || !order.orderId || order.failureReason;
        if (orderFailed) {
          log('signal_order_rejected', { symbol, direction, signal_type, entry_price, order });
          return send(200, { ok: false, reason: 'order rejected by broker', order });
        }

        openPosition(
          symbol,
          direction,
          entry_price,
          atr_at_entry,
          new Date().toISOString(),
          qty
        );

        runtimeState.daily.trades += 1;
        persistRuntime();

        log('signal_accepted', {
          symbol,
          direction,
          signal_type,
          entry_price,
          atr_at_entry,
          qty,
          dailyTrades: runtimeState.daily.trades
        });
        return send(200, { ok: true, orderId: order.orderId });
      } catch (e) {
        log('signal_error', { error: e.message });
        return send(500, { error: e.message });
      }
    });
    return;
  }

  send(404, { error: 'Not found' });
});

// ── Position monitor interval ─────────────────────────────────────────────────
setInterval(checkPositions, 5000);

setInterval(
  () => reconcilePositions('interval'),
  CFG.reconcileSeconds * 1000
);

// ── Startup ───────────────────────────────────────────────────────────────────
server.listen(CFG.port, async () => {
  log('server_start', {
    port: CFG.port,
    account: CFG.account
  });

  try {
    loadPersistedState();
    resetDailyStateIfNeeded();

    await authenticate();
    await resolveAccount();
    await reconcilePositions('startup');

    startupReady = true;

    log('ready', {
      accountId,
      restoredPositions:
        Object.keys(positions).length,
      safetyLock:
        reconciliationState.safetyLock,
    });
  } catch (e) {
    reconciliationState.safetyLock = true;
    reconciliationState.lastError = e.message;
    startupReady = true;

    persistAllState();

    log('startup_error', {
      error: e.message,
      safetyLock: true,
    });
  }
});
