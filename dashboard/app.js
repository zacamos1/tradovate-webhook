'use strict';

const state = {
  health: null,
  status: null,
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

function renderSummary() {
  const health = state.health || {};
  const runtime = state.status?.runtime || {};
  const daily = runtime.daily || {};
  const reconciliation = state.status?.reconciliation || {};

  setText('accountName', health.account || '--');
  setText(
    'accountId',
    health.accountId ? `ID ${health.accountId}` : 'Not resolved'
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
  const brokerPositions = reconciliation.brokerPositions || [];

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
  renderPositions();
  renderSignalPipeline();
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
}

async function refreshDashboard() {
  try {
    const [health, status, eventResponse] =
      await Promise.all([
        fetchJson('/health'),
        fetchJson('/status'),
        fetchJson('/events?limit=120'),
      ]);

    state.health = health;
    state.status = status;
    state.events = eventResponse.events || [];

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
