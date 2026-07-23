path = "server.js"
with open(path, "r") as f:
    content = f.read()

old_state = """const pendingExitFills = {};  // orderId -> pending exit fill info, awaiting execDetails confirmation"""
new_state = """const pendingExitFills = {};  // orderId -> pending exit fill info, awaiting execDetails confirmation
const deferredSignals = [];  // signals that arrived while disconnected, retried once TWS reconnects
const DEFERRED_SIGNAL_MAX_AGE_MS = 5 * 60 * 1000;  // drop anything older than 5 min once reconnected -- stale price data isn't worth acting on"""

if old_state not in content:
    print("ERROR: could not find pendingExitFills state line — aborting.")
else:
    content = content.replace(old_state, new_state, 1)

    old_connect = """  ib.on(EventName.connected, () => { connected = true; log('Connected to TWS'); ib.reqIds(1); });"""
    new_connect = """  ib.on(EventName.connected, () => {
    connected = true;
    log('Connected to TWS');
    ib.reqIds(1);
    if (deferredSignals.length > 0) {
      const now = Date.now();
      const fresh = deferredSignals.filter(s => now - s.queuedAt <= DEFERRED_SIGNAL_MAX_AGE_MS);
      const stale = deferredSignals.length - fresh.length;
      deferredSignals.length = 0;
      if (stale > 0) log(`Dropped ${stale} deferred signal(s) — too stale (>${DEFERRED_SIGNAL_MAX_AGE_MS/60000}min old) to act on`);
      if (fresh.length > 0) {
        log(`Reconnected — replaying ${fresh.length} deferred signal(s)`);
        for (const s of fresh) {
          signalQueue.push(s.payload);
        }
        if (!processing) processQueue();
      }
    }
  });"""
    if old_connect not in content:
        print("ERROR: could not find connected event handler — aborting.")
    else:
        content = content.replace(old_connect, new_connect, 1)

        old_skip = """  if (!connected) { log('Skipped: not connected to TWS'); return; }
  if (payload.action !== 'buy') { log(`Skipped: action is ${payload.action}`); return; }

  signalQueue.push(payload);
  log(`Queued ${payload.ticker} — queue length: ${signalQueue.length}`);
  if (!processing) processQueue();"""
        new_skip = """  if (payload.action !== 'buy') { log(`Skipped: action is ${payload.action}`); return; }

  if (!connected) {
    deferredSignals.push({ payload, queuedAt: Date.now() });
    log(`DEFERRED (not connected to TWS): ${payload.ticker} — will replay on reconnect if still fresh (${deferredSignals.length} pending)`);
    return;
  }

  signalQueue.push(payload);
  log(`Queued ${payload.ticker} — queue length: ${signalQueue.length}`);
  if (!processing) processQueue();"""
        if old_skip not in content:
            print("ERROR: could not find the webhook skip/queue block — aborting.")
        else:
            content = content.replace(old_skip, new_skip, 1)
            with open(path, "w") as f:
                f.write(content)
            print("Patched successfully: deferred-signal queue with 5-min freshness window added.")
