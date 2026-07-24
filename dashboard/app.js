'use strict';

const state = {
  health: null,
  status: null,
  account: null,
  accountError: null,
  analytics: {},
  events: [],
  refreshTimer: null,
  token: new URLSearchParams(window.location.search).get('token') || '',
};

const $ = id => document.getElementById(id);

function apiUrl(path) {
  const separator = path.includes('?') ? '&' : '?';
  return state.token
    ? `${path}${separator}token=${encodeURIComponent(state.token)}`
    : path;
}

async function fetchJson(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    cache: 'no-store',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  let body;

  try {
    body = await response.json();
  } catch {
    body = {
      ok: false,
      error: `Invalid response from ${path}`,
    };
  }

  if (!response.ok) {
    throw new Error(body.error || body.reason || `HTTP ${response.status}`);
  }

  return body;
}

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value;
}

function setStatusText(id, text, className) {
  const element = $(id);
  if (!element) return;

  element.textContent = text;
  element.className = className || '';
}

function formatMoney(value) {
  const number = Number(value || 0);

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    signDisplay: 'auto',
  }).format(number);
}

function formatNumber(value, digits = 2) {
  const number = Number(value);

  if (!Number.isFinite(number)) return '--';

  return number.toLocaleString('en-US', {
    maximumFractionDigits: digits,
  });
}

function formatTime(value) {
  if (!value) return '--';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';

  return date.toLocaleString();
}

function formatUptime(seconds) {
  const total = Math.max(0, Number(seconds || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function lastSignalAgeMinutes() {
  const lastSignal = state.status?.runtime?.lastSignal;
  if (!lastSignal?.ts) return null;

  const age = Date.now() - new Date(lastSignal.ts).getTime();
  return Math.max(0, age / 60000);
}

function computeConfidence() {
  const health = state.health || {};
  const status = state.status || {};
  const reconciliation = status.reconciliation || {};
  const checks = [];

  checks.push({
    name: 'Server startup complete',
    pass: health.startupReady === true,
    warning: false,
  });

  checks.push({
    name: 'Tradovate authenticated',
    pass: health.authenticated === true,
    warning: false,
  });

  checks.push({
    name: 'Position reconciliation healthy',
    pass:
      reconciliation.lastError == null &&
      Boolean(reconciliation.lastSuccessTs),
    warning: false,
  });

  checks.push({
    name: 'Safety lock is off',
    pass: reconciliation.safetyLock === false,
    warning: false,
  });

  checks.push({
    name: 'Internal and broker positions agree',
    pass: (reconciliation.mismatches || []).length === 0,
    warning: false,
  });

  const signalAge = lastSignalAgeMinutes();

  checks.push({
    name: 'TradingView signal channel',
    pass: signalAge !== null && signalAge <= 720,
    warning: signalAge === null,
    detail:
      signalAge === null
        ? 'No signal received since state reset'
        : `Last signal ${Math.round(signalAge)} minutes ago`,
  });

  checks.push({
    name: 'Risk controls active',
    pass:
      Number(status.runtime?.maxContracts) >= 1 &&
      Number(status.runtime?.maxDailyTrades) >= 1,
    warning: false,
  });

  let score = 0;

  for (const check of checks) {
    if (check.pass) {
      score += 100 / checks.length;
    } else if (check.warning) {
      score += 50 / checks.length;
    }
  }

  return {
    score: Math.round(score),
    checks,
  };
}

function renderConfidence() {
  const result = computeConfidence();

  setText('confidenceScore', `${result.score}%`);
  setText('confidenceRingValue', result.score);

  const container = $('confidenceChecks');
  container.innerHTML = '';

  for (const check of result.checks) {
    const row = document.createElement('div');
    row.className = 'check-item';

    const name = document.createElement('span');
    name.textContent = check.detail
      ? `${check.name} — ${check.detail}`
      : check.name;

    const value = document.createElement('strong');

    if (check.pass) {
      value.textContent = 'PASS';
      value.className = 'good';
    } else if (check.warning) {
      value.textContent = 'WAIT';
      value.className = 'warning';
    } else {
      value.textContent = 'FAIL';
      value.className = 'bad';
    }

    row.append(name, value);
    container.appendChild(row);
  }

  const dot = $('overallDot');

  if (result.score >= 85) {
    dot.className = 'status-dot good';
    setText('overallStatus', 'Engine Healthy');
  } else if (result.score >= 65) {
    dot.className = 'status-dot warning';
    setText('overallStatus', 'Engine Degraded');
  } else {
    dot.className = 'status-dot bad';
    setText('overallStatus', 'Attention Required');
  }
}

function renderEngineStatus() {
  const health = state.health || {};
  const runtime = state.status?.runtime || {};
  const reconciliation = state.status?.reconciliation || {};

  setStatusText(
    'brokerStatus',
    health.accountId ? 'CONNECTED' : 'NOT READY',
    health.accountId ? 'good-text' : 'bad-text'
  );

  setStatusText(
    'authStatus',
    health.authenticated ? 'AUTHENTICATED' : 'EXPIRED',
    health.authenticated ? 'good-text' : 'bad-text'
  );

  setStatusText(
    'reconcileStatus',
    reconciliation.lastError ? 'ERROR' : 'HEALTHY',
    reconciliation.lastError ? 'bad-text' : 'good-text'
  );

  setStatusText(
    'safetyLock',
    reconciliation.safetyLock ? 'ON' : 'OFF',
    reconciliation.safetyLock ? 'bad-text' : 'good-text'
  );

  let tradingText = 'ACTIVE';
  let tradingClass = 'good-text';

  if (runtime.paused) {
    tradingText = 'PAUSED';
    tradingClass = 'warning-text';
  } else if (!runtime.entriesEnabled) {
    tradingText = 'EXITS ONLY';
    tradingClass = 'warning-text';
  }

  setStatusText('tradingStatus', tradingText, tradingClass);
  setText('uptime', formatUptime(health.uptimeSeconds));
}


function applyMoneyClass(element, value) {
  if (!element) return;

  const number = Number(value);

  element.className =
    number > 0
      ? 'good-text'
      : number < 0
        ? 'bad-text'
        : '';
}

function renderBrokerAccount() {
  const account = state.account;
  const freshnessBadge = $('accountFreshnessBadge');

  if (!account || account.ok !== true) {
    const message = state.accountError || 'Account data unavailable';

    setText('cashBalance', '--');
    setText('netLiquidatingValue', '--');
    setText('availableFunds', '--');
    setText('brokerRealizedPnl', '--');
    setText('brokerOpenPnl', '--');
    setText('brokerTotalPnl', '--');
    setText('initialMargin', '--');
    setText('maintenanceMargin', '--');
    setText('accountSnapshotTime', `Snapshot: ${message}`);
    setText('accountEndpointState', 'Broker endpoints: unavailable');

    freshnessBadge.textContent = 'Unavailable';
    freshnessBadge.className = 'badge danger';

    renderBrokerPositions([]);
    renderWorkingOrders([]);
    return;
  }

  const balances = account.balances || {};
  const endpointErrors = account.endpointErrors || {};
  const errorCount = Object.keys(endpointErrors).length;

  setText('cashBalance', formatMoney(balances.cashBalance));
  setText(
    'netLiquidatingValue',
    formatMoney(balances.netLiquidatingValue)
  );
  setText('availableFunds', formatMoney(balances.availableFunds));
  setText('brokerRealizedPnl', formatMoney(balances.realizedPnL));
  setText('brokerOpenPnl', formatMoney(balances.openPnL));
  setText('brokerTotalPnl', formatMoney(balances.totalPnL));
  setText('initialMargin', formatMoney(balances.initialMargin));
  setText(
    'maintenanceMargin',
    formatMoney(balances.maintenanceMargin)
  );

  applyMoneyClass($('brokerRealizedPnl'), balances.realizedPnL);
  applyMoneyClass($('brokerOpenPnl'), balances.openPnL);
  applyMoneyClass($('brokerTotalPnl'), balances.totalPnL);

  setText(
    'accountEnvironment',
    `Environment: ${account.environment || '--'}`
  );

  setText(
    'accountSnapshotTime',
    `Snapshot: ${formatTime(account.timestamp)}`
  );

  setText(
    'accountEndpointState',
    errorCount
      ? `Broker endpoints: ${errorCount} error${errorCount === 1 ? '' : 's'}`
      : 'Broker endpoints: healthy'
  );

  freshnessBadge.textContent = errorCount ? 'Partial data' : 'Live';
  freshnessBadge.className =
    errorCount ? 'badge warning' : 'badge live';

  renderBrokerPositions(account.positions || []);
  renderWorkingOrders(account.workingOrders || []);
}

function brokerItemStat(label, value) {
  const item = document.createElement('div');
  item.className = 'broker-item-stat';

  const labelElement = document.createElement('span');
  labelElement.textContent = label;

  const valueElement = document.createElement('strong');
  valueElement.textContent =
    value === undefined || value === null || value === ''
      ? '--'
      : String(value);

  item.append(labelElement, valueElement);
  return item;
}

function renderBrokerPositions(positions) {
  const container = $('brokerPositionsContainer');
  const badge = $('brokerPositionsBadge');

  container.innerHTML = '';

  if (!positions.length) {
    container.innerHTML =
      '<div class="empty-state">No broker positions.</div>';
    badge.textContent = '0 positions';
    badge.className = 'badge neutral';
    return;
  }

  badge.textContent =
    `${positions.length} position${positions.length === 1 ? '' : 's'}`;
  badge.className = 'badge live';

  for (const position of positions) {
    const card = document.createElement('div');
    card.className = 'broker-item';

    const header = document.createElement('div');
    header.className = 'broker-item-header';

    const title = document.createElement('strong');
    title.textContent =
      position.symbol ||
      position.contractName ||
      position.name ||
      `Contract ${position.contractId ?? '--'}`;

    const quantity =
      Number(
        position.netPos ??
        position.netPosition ??
        position.quantity ??
        position.qty ??
        0
      );

    const direction = document.createElement('span');
    direction.textContent =
      quantity > 0
        ? 'LONG'
        : quantity < 0
          ? 'SHORT'
          : 'FLAT';

    direction.className =
      quantity > 0
        ? 'good-text'
        : quantity < 0
          ? 'bad-text'
          : '';

    header.append(title, direction);

    const stats = document.createElement('div');
    stats.className = 'broker-item-stats';

    stats.append(
      brokerItemStat('Quantity', quantity),
      brokerItemStat(
        'Average Price',
        formatNumber(
          position.netPrice ??
          position.averagePrice ??
          position.avgPrice
        )
      ),
      brokerItemStat(
        'Contract ID',
        position.contractId
      ),
      brokerItemStat(
        'Account ID',
        position.accountId
      )
    );

    card.append(header, stats);
    container.appendChild(card);
  }
}

function renderWorkingOrders(orders) {
  const container = $('workingOrdersContainer');
  const badge = $('workingOrdersBadge');

  container.innerHTML = '';

  if (!orders.length) {
    container.innerHTML =
      '<div class="empty-state">No working orders.</div>';
    badge.textContent = '0 orders';
    badge.className = 'badge neutral';
    return;
  }

  badge.textContent =
    `${orders.length} order${orders.length === 1 ? '' : 's'}`;
  badge.className = 'badge warning';

  for (const order of orders) {
    const card = document.createElement('div');
    card.className = 'broker-item';

    const header = document.createElement('div');
    header.className = 'broker-item-header';

    const title = document.createElement('strong');
    title.textContent =
      order.symbol ||
      order.contractName ||
      order.name ||
      `Order ${order.id ?? '--'}`;

    const status = document.createElement('span');
    status.textContent =
      String(order.ordStatus || order.status || 'WORKING').toUpperCase();
    status.className = 'warning-text';

    header.append(title, status);

    const stats = document.createElement('div');
    stats.className = 'broker-item-stats';

    stats.append(
      brokerItemStat(
        'Action',
        order.action || order.side
      ),
      brokerItemStat(
        'Quantity',
        order.orderQty ?? order.qty ?? order.quantity
      ),
      brokerItemStat(
        'Type',
        order.orderType || order.type
      ),
      brokerItemStat(
        'Price',
        formatNumber(
          order.price ??
          order.limitPrice ??
          order.stopPrice
        )
      ),
      brokerItemStat(
        'Filled',
        order.filledQty ?? order.filledQuantity ?? 0
      ),
      brokerItemStat(
        'Order ID',
        order.id ?? order.orderId
      )
    );

    card.append(header, stats);
    container.appendChild(card);
  }
}

function renderSummary() {
  const health = state.health || {};
  const runtime = state.status?.runtime || {};
  const daily = runtime.daily || {};
  const reconciliation = state.status?.reconciliation || {};

  const brokerAccount = state.account?.account || {};

  setText(
    'accountName',
    brokerAccount.name || health.account || '--'
  );

  const resolvedAccountId =
    brokerAccount.id || health.accountId;

  setText(
    'accountId',
    resolvedAccountId
      ? `ID ${resolvedAccountId}`
      : 'Not resolved'
  );

  setText('dailyTrades', daily.trades || 0);
  setText(
    'dailyTradeLimit',
    `Limit ${runtime.maxDailyTrades ?? '--'}`
  );

  setText('dailyExits', daily.exits || 0);

  const pnlElement = $('dailyPnl');
  const pnl = Number(daily.estimatedRealizedDollars || 0);

  pnlElement.textContent = formatMoney(pnl);
  pnlElement.className =
    pnl > 0
      ? 'good-text'
      : pnl < 0
        ? 'bad-text'
        : '';

  const positions = state.status?.positions || {};
  const brokerPositions =
    state.account?.positions ||
    reconciliation.brokerPositions ||
    [];

  setText('positionCount', Object.keys(positions).length);
  setText(
    'brokerPositionCount',
    `Broker: ${brokerPositions.length}`
  );

  setText('maxContracts', runtime.maxContracts ?? '--');
  setText('maxDailyTrades', runtime.maxDailyTrades ?? '--');
  setText(
    'lastReconciliation',
    formatTime(reconciliation.lastSuccessTs)
  );
}

function positionStat(label, value) {
  const item = document.createElement('div');
  item.className = 'position-stat';

  const labelElement = document.createElement('span');
  labelElement.textContent = label;

  const valueElement = document.createElement('strong');
  valueElement.textContent = value;

  item.append(labelElement, valueElement);
  return item;
}

function renderPositions() {
  const positions = state.status?.positions || {};
  const entries = Object.entries(positions);
  const container = $('positionsContainer');
  const badge = $('positionBadge');

  container.innerHTML = '';

  if (entries.length === 0) {
    container.innerHTML =
      '<div class="empty-state">No open positions.</div>';
    badge.textContent = 'No positions';
    badge.className = 'badge neutral';
    return;
  }

  badge.textContent =
    entries.length === 1
      ? '1 position'
      : `${entries.length} positions`;

  badge.className = 'badge live';

  for (const [key, position] of entries) {
    const card = document.createElement('div');
    card.className = 'position';

    const header = document.createElement('div');
    header.className = 'position-header';

    const title = document.createElement('div');
    title.className = 'position-title';
    title.textContent = position.symbol || key;

    const direction = document.createElement('div');
    direction.className =
      `position-direction ${position.direction || ''}`;
    direction.textContent =
      String(position.direction || '--').toUpperCase();

    header.append(title, direction);

    const stats = document.createElement('div');
    stats.className = 'position-stats';

    stats.append(
      positionStat('Quantity', position.qty ?? '--'),
      positionStat(
        'Entry',
        formatNumber(position.entryPrice)
      ),
      positionStat(
        'Stop',
        formatNumber(position.stopPrice)
      ),
      positionStat(
        'Trail',
        formatNumber(position.trailLine)
      ),
      positionStat(
        'ATR',
        formatNumber(position.atrAtEntry)
      ),
      positionStat(
        'Peak',
        formatNumber(position.peak)
      ),
      positionStat(
        'Bars Held',
        position.barsHeld ?? 0
      ),
      positionStat(
        'Management',
        position.externallyManaged
          ? 'Broker imported'
          : position.armed
            ? 'Trail armed'
            : 'Initial stop'
      )
    );

    card.append(header, stats);
    container.appendChild(card);
  }
}

function safeJson(value, fallback) {
  if (!value) return fallback;

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function renderSignalPipeline() {
  const runtime = state.status?.runtime || {};

  setText(
    'lastSignal',
    safeJson(runtime.lastSignal, 'No signal received.')
  );

  setText(
    'lastOrder',
    safeJson(runtime.lastOrder, 'No order submitted.')
  );
}

function renderEvents() {
  const container = $('eventFeed');
  container.innerHTML = '';

  if (!state.events.length) {
    container.innerHTML =
      '<div class="empty-state">No recent events.</div>';
    return;
  }

  for (const event of state.events) {
    const row = document.createElement('div');
    row.className = 'event-row';

    const time = document.createElement('div');
    time.className = 'event-time';
    time.textContent = event.ts
      ? new Date(event.ts).toLocaleTimeString()
      : '--';

    const name = document.createElement('div');
    name.className = 'event-name';
    name.textContent =
      String(event.event || 'unknown')
        .replaceAll('_', ' ')
        .toUpperCase();

    const data = document.createElement('div');
    data.className = 'event-data';

    const copy = { ...event };
    delete copy.ts;
    delete copy.event;

    data.textContent =
      Object.keys(copy).length > 0
        ? JSON.stringify(copy)
        : '—';

    row.append(time, name, data);
    container.appendChild(row);
  }
}



// PHASE2A_STRATEGY_ANALYTICS

const STRATEGY_CONFIG = {
  pointValue: {
    MES: 5,
    MNQ: 2,
    MYM: 0.5,
  },

  // Conservative placeholder for estimated total round-trip cost per
  // micro contract. Change these values when your exact commission,
  // exchange, NFA and clearing totals are confirmed.
  roundTripCost: {
    MES: 1.50,
    MNQ: 1.50,
    MYM: 1.50,
  },
};

function firstFinite(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function deepObjects(value, output = [], depth = 0) {
  if (
    value == null ||
    depth > 4 ||
    typeof value !== 'object'
  ) {
    return output;
  }

  output.push(value);

  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      deepObjects(child, output, depth + 1);
    }
  }

  return output;
}

function deepValue(event, names) {
  const normalizedNames = names.map(name =>
    String(name).toLowerCase()
  );

  for (const object of deepObjects(event)) {
    for (const [key, value] of Object.entries(object)) {
      if (
        normalizedNames.includes(String(key).toLowerCase()) &&
        value !== undefined &&
        value !== null &&
        value !== ''
      ) {
        return value;
      }
    }
  }

  return null;
}

function eventText(event) {
  try {
    return JSON.stringify(event).toUpperCase();
  } catch {
    return String(event).toUpperCase();
  }
}

function normalizeSymbol(event) {
  const raw = String(
    deepValue(event, [
      'symbol',
      'ticker',
      'contract',
      'instrument',
      'rootSymbol',
    ]) || ''
  ).toUpperCase();

  for (const symbol of ['MES', 'MNQ', 'MYM']) {
    if (raw.includes(symbol)) return symbol;
  }

  const text = eventText(event);

  for (const symbol of ['MES', 'MNQ', 'MYM']) {
    if (text.includes(`"${symbol}"`) || text.includes(symbol)) {
      return symbol;
    }
  }

  return null;
}

function normalizeQty(event) {
  return Math.max(
    1,
    Math.abs(
      firstFinite(
        deepValue(event, ['qty']),
        deepValue(event, ['quantity']),
        deepValue(event, ['orderQty']),
        deepValue(event, ['contracts']),
        1
      )
    )
  );
}

function normalizePrice(event) {
  return firstFinite(
    deepValue(event, ['exit_price']),
    deepValue(event, ['entry_price']),
    deepValue(event, ['fillPrice']),
    deepValue(event, ['filledPrice']),
    deepValue(event, ['avgPrice']),
    deepValue(event, ['averagePrice']),
    deepValue(event, ['orderPrice']),
    deepValue(event, ['price']),
    deepValue(event, ['close'])
  );
}

function classifySignal(event, openTrade) {
  const text = eventText(event);

  if (
    text.includes('MANUAL_WEBHOOK_TEST') ||
    text.includes('"ACTION":"TEST"') ||
    text.includes('"ACTION": "TEST"')
  ) {
    return null;
  }

  if (
    text.includes('EXIT_LONG') ||
    text.includes('CLOSE_LONG') ||
    text.includes('LONG_EXIT')
  ) {
    return 'EXIT_LONG';
  }

  if (
    text.includes('EXIT_SHORT') ||
    text.includes('CLOSE_SHORT') ||
    text.includes('SHORT_EXIT')
  ) {
    return 'EXIT_SHORT';
  }

  if (
    text.includes('ENTER_LONG') ||
    text.includes('ENTRY_LONG') ||
    text.includes('LONG_ENTRY')
  ) {
    return 'ENTER_LONG';
  }

  if (
    text.includes('ENTER_SHORT') ||
    text.includes('ENTRY_SHORT') ||
    text.includes('SHORT_ENTRY')
  ) {
    return 'ENTER_SHORT';
  }

  const action = String(
    deepValue(event, [
      'action',
      'side',
      'orderAction',
      'signal',
      'direction',
    ]) || ''
  ).toUpperCase();

  if (['BUY', 'BUY_TO_COVER', 'BTC'].includes(action)) {
    return openTrade?.side === 'SHORT'
      ? 'EXIT_SHORT'
      : 'ENTER_LONG';
  }

  if (['SELL', 'SELL_SHORT', 'SHORT', 'STC'].includes(action)) {
    return openTrade?.side === 'LONG'
      ? 'EXIT_LONG'
      : 'ENTER_SHORT';
  }

  return null;
}

function normalizeExitReason(event) {
  const raw = String(
    deepValue(event, [
      'signal_type',
      'comment',
      'exitReason',
      'reason',
      'orderComment',
    ]) || ''
  );

  if (raw) {
    return raw
      .replace(/^EXIT[_ -]?(LONG|SHORT)?[_ -]?/i, '')
      .replaceAll('_', ' ')
      .trim() || 'Signal exit';
  }

  const text = eventText(event);

  if (text.includes('TRAIL')) return 'Trail stop';
  if (text.includes('STOP')) return 'Stop';
  if (text.includes('TARGET')) return 'Target';
  if (text.includes('TIME')) return 'Time exit';

  return 'Signal exit';
}

function sameLocalTradingDay(value, now = new Date()) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return false;

  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

function reconstructStrategyTrades(events) {
  const chronological = [...events]
    .filter(event => event && event.ts)
    .sort((a, b) =>
      new Date(a.ts).getTime() - new Date(b.ts).getTime()
    );

  const openBySymbol = {};
  const trades = [];
  let signalCount = 0;

  for (const event of chronological) {
    if (!sameLocalTradingDay(event.ts)) continue;

    const symbol = normalizeSymbol(event);
    if (!symbol) continue;

    const openTrade = openBySymbol[symbol] || null;
    const signal = classifySignal(event, openTrade);
    const price = normalizePrice(event);

    if (!signal || !Number.isFinite(price)) continue;

    signalCount += 1;

    if (signal === 'ENTER_LONG' || signal === 'ENTER_SHORT') {
      if (openTrade) {
        continue;
      }

      openBySymbol[symbol] = {
        symbol,
        side: signal === 'ENTER_LONG' ? 'LONG' : 'SHORT',
        qty: normalizeQty(event),
        entryPrice: price,
        entryTs: event.ts,
        entryEvent: event,
      };

      continue;
    }

    if (!openTrade) continue;

    const expectedExit =
      openTrade.side === 'LONG'
        ? 'EXIT_LONG'
        : 'EXIT_SHORT';

    if (signal !== expectedExit) continue;

    const directionMultiplier =
      openTrade.side === 'LONG' ? 1 : -1;

    const points =
      (price - openTrade.entryPrice) * directionMultiplier;

    const pointValue =
      STRATEGY_CONFIG.pointValue[symbol] || 0;

    const grossPnl =
      points * pointValue * openTrade.qty;

    const estimatedCost =
      (STRATEGY_CONFIG.roundTripCost[symbol] || 0) *
      openTrade.qty;

    const entryTime = new Date(openTrade.entryTs).getTime();
    const exitTime = new Date(event.ts).getTime();

    trades.push({
      ...openTrade,
      exitPrice: price,
      exitTs: event.ts,
      exitEvent: event,
      exitReason: normalizeExitReason(event),
      points,
      grossPnl,
      estimatedCost,
      netPnl: grossPnl - estimatedCost,
      holdMinutes:
        Number.isFinite(entryTime) && Number.isFinite(exitTime)
          ? Math.max(0, (exitTime - entryTime) / 60000)
          : null,
    });

    delete openBySymbol[symbol];
  }

  return {
    signalCount,
    trades,
    openTrades: Object.values(openBySymbol),
  };
}

function strategyMetrics(reconstruction) {
  const trades = reconstruction.trades;
  const winners = trades.filter(trade => trade.grossPnl > 0);
  const losers = trades.filter(trade => trade.grossPnl < 0);

  const grossPnl = trades.reduce(
    (sum, trade) => sum + trade.grossPnl,
    0
  );

  const estimatedCosts = trades.reduce(
    (sum, trade) => sum + trade.estimatedCost,
    0
  );

  const grossProfit = winners.reduce(
    (sum, trade) => sum + trade.grossPnl,
    0
  );

  const grossLoss = Math.abs(
    losers.reduce(
      (sum, trade) => sum + trade.grossPnl,
      0
    )
  );

  const winRate = trades.length
    ? winners.length / trades.length
    : null;

  const profitFactor =
    grossLoss > 0
      ? grossProfit / grossLoss
      : grossProfit > 0
        ? Infinity
        : null;

  const netPnl = grossPnl - estimatedCosts;

  return {
    completed: trades.length,
    winners: winners.length,
    losers: losers.length,
    grossPnl,
    estimatedCosts,
    netPnl,
    winRate,
    profitFactor,
    expectancy:
      trades.length ? netPnl / trades.length : null,
  };
}

function formatPercentRatio(value) {
  return value == null
    ? '--'
    : `${(value * 100).toFixed(1)}%`;
}

function formatProfitFactor(value) {
  if (value === Infinity) return '∞';
  return value == null || !Number.isFinite(value)
    ? '--'
    : value.toFixed(2);
}

function formatTradeClock(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return '--';

  return date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDuration(minutes) {
  if (!Number.isFinite(minutes)) return '--';

  if (minutes < 60) {
    return `${Math.round(minutes)}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainder = Math.round(minutes % 60);

  return `${hours}h ${remainder}m`;
}

function makeCell(text, className = '') {
  const cell = document.createElement('td');
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}

function renderSymbolPerformance(trades) {
  const container = $('symbolPerformance');
  if (!container) return;

  container.innerHTML = '';

  const symbols = ['MES', 'MNQ', 'MYM'];
  let rendered = 0;

  for (const symbol of symbols) {
    const symbolTrades = trades.filter(
      trade => trade.symbol === symbol
    );

    if (!symbolTrades.length) continue;
    rendered += 1;

    const pnl = symbolTrades.reduce(
      (sum, trade) => sum + trade.netPnl,
      0
    );

    const wins = symbolTrades.filter(
      trade => trade.grossPnl > 0
    ).length;

    const card = document.createElement('div');
    card.className = 'symbol-card';

    const header = document.createElement('div');
    header.className = 'symbol-card-header';

    const name = document.createElement('strong');
    name.textContent = symbol;

    const count = document.createElement('span');
    count.textContent =
      `${symbolTrades.length} trade` +
      `${symbolTrades.length === 1 ? '' : 's'}`;

    header.append(name, count);

    const pnlElement = document.createElement('strong');
    pnlElement.className = 'symbol-card-pnl';
    pnlElement.textContent = formatMoney(pnl);
    applyMoneyClass(pnlElement, pnl);

    const meta = document.createElement('div');
    meta.className = 'symbol-card-meta';

    const winBox = document.createElement('div');
    winBox.innerHTML =
      `<span>Win rate</span><strong>` +
      `${formatPercentRatio(wins / symbolTrades.length)}` +
      `</strong>`;

    const avgBox = document.createElement('div');
    avgBox.innerHTML =
      `<span>Avg trade</span><strong>` +
      `${formatMoney(pnl / symbolTrades.length)}` +
      `</strong>`;

    meta.append(winBox, avgBox);
    card.append(header, pnlElement, meta);
    container.appendChild(card);
  }

  if (!rendered) {
    container.innerHTML =
      '<div class="empty-state">' +
      'No completed theoretical trades today.' +
      '</div>';
  }
}

function renderTheoreticalTrades(trades) {
  const body = $('theoreticalTradeBody');
  const badge = $('theoreticalTradeBadge');

  if (!body || !badge) return;

  body.innerHTML = '';

  badge.textContent =
    `${trades.length} trade${trades.length === 1 ? '' : 's'}`;

  badge.className =
    trades.length ? 'badge live' : 'badge neutral';

  if (!trades.length) {
    const row = document.createElement('tr');
    const cell = makeCell('No reconstructed trades yet.');
    cell.colSpan = 12;
    cell.className = 'table-empty';
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }

  for (const trade of [...trades].reverse()) {
    const row = document.createElement('tr');

    row.append(
      makeCell(formatTradeClock(trade.entryTs)),
      makeCell(formatTradeClock(trade.exitTs)),
      makeCell(trade.symbol),
      makeCell(
        trade.side,
        trade.side === 'LONG' ? 'good-text' : 'bad-text'
      ),
      makeCell(formatNumber(trade.qty, 0)),
      makeCell(formatNumber(trade.entryPrice)),
      makeCell(formatNumber(trade.exitPrice)),
      makeCell(
        formatNumber(trade.points),
        trade.points > 0
          ? 'good-text'
          : trade.points < 0
            ? 'bad-text'
            : ''
      ),
      makeCell(
        formatMoney(trade.grossPnl),
        trade.grossPnl > 0
          ? 'good-text'
          : trade.grossPnl < 0
            ? 'bad-text'
            : ''
      ),
      makeCell(
        formatMoney(trade.netPnl),
        trade.netPnl > 0
          ? 'good-text'
          : trade.netPnl < 0
            ? 'bad-text'
            : ''
      ),
      makeCell(formatDuration(trade.holdMinutes)),
      makeCell(trade.exitReason)
    );

    body.appendChild(row);
  }
}

function renderStrategyAnalytics() {
  const reconstruction =
    reconstructStrategyTrades(state.events || []);

  const metrics = strategyMetrics(reconstruction);

  setText('strategySignals', reconstruction.signalCount);
  setText('strategyCompleted', metrics.completed);
  setText('strategyOpen', reconstruction.openTrades.length);
  setText('strategyWinRate', formatPercentRatio(metrics.winRate));
  setText(
    'strategyWinLoss',
    `${metrics.winners} wins / ${metrics.losers} losses`
  );

  setText('strategyGrossPnl', formatMoney(metrics.grossPnl));
  setText(
    'strategyCosts',
    `-${formatMoney(metrics.estimatedCosts).replace('-', '')}`
  );
  setText('strategyNetPnl', formatMoney(metrics.netPnl));
  setText(
    'strategyProfitFactor',
    formatProfitFactor(metrics.profitFactor)
  );
  setText(
    'strategyExpectancy',
    metrics.expectancy == null
      ? 'Expectancy --'
      : `Expectancy ${formatMoney(metrics.expectancy)}/trade`
  );

  applyMoneyClass($('strategyGrossPnl'), metrics.grossPnl);
  applyMoneyClass($('strategyNetPnl'), metrics.netPnl);

  const badge = $('strategyDataBadge');

  if (metrics.completed > 0) {
    badge.textContent = 'Live reconstruction';
    badge.className = 'badge live';
  } else if (reconstruction.openTrades.length > 0) {
    badge.textContent = 'Open signal detected';
    badge.className = 'badge warning';
  } else {
    badge.textContent = 'Waiting for paired signals';
    badge.className = 'badge neutral';
  }

  const brokerDaily = state.status?.runtime?.daily || {};
  const brokerBalances = state.account?.balances || {};

  const brokerTrades = Number(
    brokerDaily.exits ??
    brokerDaily.trades ??
    0
  );

  const brokerPnl = firstFinite(
    brokerDaily.estimatedRealizedDollars,
    brokerBalances.realizedPnL,
    0
  );

  const difference = brokerPnl - metrics.netPnl;

  let executionScore = null;

  if (metrics.completed > 0) {
    const tradeMatch =
      Math.min(1, brokerTrades / metrics.completed);

    const pnlDenominator = Math.max(
      1,
      Math.abs(metrics.netPnl)
    );

    const pnlMatch = Math.max(
      0,
      1 - Math.abs(difference) / pnlDenominator
    );

    executionScore =
      Math.round((tradeMatch * 0.6 + pnlMatch * 0.4) * 100);
  }

  setText('comparisonStrategyTrades', metrics.completed);
  setText('comparisonBrokerTrades', brokerTrades);
  setText('comparisonStrategyPnl', formatMoney(metrics.netPnl));
  setText('comparisonBrokerPnl', formatMoney(brokerPnl));
  setText('comparisonDifference', formatMoney(difference));
  setText(
    'comparisonExecutionScore',
    executionScore == null
      ? 'Score --'
      : `Score ${executionScore}%`
  );

  applyMoneyClass(
    $('comparisonStrategyPnl'),
    metrics.netPnl
  );
  applyMoneyClass($('comparisonBrokerPnl'), brokerPnl);
  applyMoneyClass($('comparisonDifference'), difference);

  renderSymbolPerformance(reconstruction.trades);
  renderTheoreticalTrades(reconstruction.trades);
}

function renderControlAvailability() {
  const runtime = state.status?.runtime || {};

  $('pauseButton').disabled = Boolean(runtime.paused);
  $('resumeButton').disabled = !runtime.paused;

  $('disableEntriesButton').disabled =
    runtime.entriesEnabled === false;

  $('enableEntriesButton').disabled =
    runtime.entriesEnabled === true;
}

function renderAll() {
  renderConfidence();
  renderEngineStatus();
  renderSummary();
  renderBrokerAccount();
  renderPositions();
  renderSignalPipeline();
  renderStrategyAnalytics();
  renderEvents();
  renderControlAvailability();

  const now = new Date();
  setText('lastUpdated', `Updated ${now.toLocaleTimeString()}`);
  setText(
    'footerState',
    state.status?.reconciliation?.safetyLock
      ? 'Safety lock active'
      : 'Position synchronization healthy'
  );

  renderAnalyticsSummary();

}

async function refreshDashboard() {
  try {
    const [health, status, eventResponse, analytics, accountResult] =
      await Promise.all([
        fetchJson('/health'),
        fetchJson('/status'),
        fetchJson('/events?limit=500'),
        fetchJson('/analytics'),
        fetchJson('/account')
          .then(account => ({
            account,
            error: null,
          }))
          .catch(error => ({
            account: null,
            error: error.message,
          })),
      ]);

    state.health = health;
    state.status = status;
    state.events = eventResponse.events || [];
    state.analytics = analytics || {};
    state.account = accountResult.account;
    state.accountError = accountResult.error;

    renderAll();
  } catch (error) {
    $('overallDot').className = 'status-dot bad';
    setText('overallStatus', 'Dashboard Offline');
    setText('lastUpdated', error.message);
    setText('footerState', 'Unable to reach engine');
  }
}

function showToast(message, error = false) {
  const toast = $('toast');

  toast.textContent = message;
  toast.className = `toast show${error ? ' error' : ''}`;

  setTimeout(() => {
    toast.className = 'toast';
  }, 3500);
}

async function sendControl(action) {
  const message = $('controlMessage');
  message.textContent = `Sending ${action}…`;

  try {
    const response = await fetchJson('/control', {
      method: 'POST',
      body: JSON.stringify({ action }),
    });

    message.textContent =
      `${response.action}: paused=${response.paused}, ` +
      `entriesEnabled=${response.entriesEnabled}`;

    showToast(`${response.action} completed`);
    await refreshDashboard();
  } catch (error) {
    message.textContent = error.message;
    showToast(error.message, true);
  }
}

async function reconcileNow() {
  const button = $('reconcileButton');
  button.disabled = true;
  setText('controlMessage', 'Running broker reconciliation…');

  try {
    const response = await fetchJson('/reconcile', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const mismatchCount =
      response.reconciliation?.mismatches?.length || 0;

    setText(
      'controlMessage',
      `Reconciliation complete. Mismatches: ${mismatchCount}. ` +
      `Safety lock: ${response.reconciliation?.safetyLock ? 'ON' : 'OFF'}.`
    );

    showToast('Reconciliation completed');
    await refreshDashboard();
  } catch (error) {
    setText('controlMessage', error.message);
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function installHandlers() {
  document
    .querySelectorAll('[data-action]')
    .forEach(button => {
      button.addEventListener('click', () => {
        sendControl(button.dataset.action);
      });
    });

  $('reconcileButton').addEventListener(
    'click',
    reconcileNow
  );

  $('refreshButton').addEventListener(
    'click',
    refreshDashboard
  );

  $('clearVisualFeed').addEventListener('click', () => {
    state.events = [];
    renderEvents();
  });

  $('autoRefreshToggle').addEventListener(
    'change',
    event => {
      if (event.target.checked) {
        startAutoRefresh();
      } else {
        stopAutoRefresh();
      }
    }
  );
}

function startAutoRefresh() {
  stopAutoRefresh();

  state.refreshTimer = setInterval(
    refreshDashboard,
    5000
  );
}

function stopAutoRefresh() {
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
}

installHandlers();
refreshDashboard();
startAutoRefresh();


function renderAnalyticsSummary() {

  const a = state.analytics || {};

  const lifetime = a;
  const today = a.today || {};

  setText('aSignals', lifetime.signals ?? '--');
  setText('aAccepted', lifetime.accepted ?? '--');

  if (typeof lifetime.acceptanceRate === 'number')
    setText('aRate', lifetime.acceptanceRate.toFixed(1) + '%');
  else
    setText('aRate', '--');

  setText('aOrders', lifetime.orders ?? '--');
  setText('aClosed', today.closed ?? '--');
}
