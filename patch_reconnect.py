#!/usr/bin/env python3
"""
patch_reconnect.py — make the webhook's TWS connection insistent.

Found by the cold-boot drill (Jul 11): pm2 resurrects server.js before the
Gateway finishes booting -> initial connect gets ECONNREFUSED (IBKR error 502)
-> logged and then NOTHING retries. The process sits alive but connectionless
indefinitely. (Nightly restarts previously "recovered" only because a dropped
established connection crashed the process and pm2 restarted it — hence the
high restart counters.)

Fix:
  1. scheduleReconnect(): single-flight 15s retry loop calling connect() fresh.
  2. On error 502 while not connected -> schedule retry (the cold-boot case).
  3. New EventName.disconnected handler -> connected=false + schedule retry
     (turns the nightly crash-restart into a clean in-process reconnect).

Backs up server.js. Aborts with NO changes unless both anchors match once.
Run from ~/ibkr-webhook:  python3 patch_reconnect.py
"""
import sys, time, shutil, os

FILE = "server.js"

A1_OLD = """function connect() {
  ib = new IBApi({ host: TWS_HOST, port: TWS_PORT, clientId: Math.floor(Math.random()*9000)+1000 });"""

A1_NEW = """let reconnectTimer = null;
function scheduleReconnect(why) {
  if (reconnectTimer) return;                       // single-flight
  log(`TWS unavailable (${why}) — retrying in 15s`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    try { connect(); } catch (e) { log('reconnect error: ' + e.message); scheduleReconnect('retry threw'); }
  }, 15000);
}

function connect() {
  ib = new IBApi({ host: TWS_HOST, port: TWS_PORT, clientId: Math.floor(Math.random()*9000)+1000 });"""

A2_OLD = """  ib.on(EventName.error, (err, code) => {
    if (![2104,2106,2158,2119].includes(code)) log(`IBKR [${code}]: ${err?.message||err}`);
  });"""

A2_NEW = """  ib.on(EventName.error, (err, code) => {
    if (![2104,2106,2158,2119].includes(code)) log(`IBKR [${code}]: ${err?.message||err}`);
    if (code === 502 && !connected) scheduleReconnect('connect refused (502) — gateway not ready');
  });
  ib.on(EventName.disconnected, () => {
    connected = false;
    scheduleReconnect('connection dropped');
  });"""

def main():
    if not os.path.exists(FILE):
        sys.exit(f"ABORT: {FILE} not found — run from ~/ibkr-webhook")
    src = open(FILE, encoding="utf-8").read()
    if "scheduleReconnect" in src:
        sys.exit("ABORT: reconnect patch already applied.")
    for name, a in (("connect-fn", A1_OLD), ("error-handler", A2_OLD)):
        n = src.count(a)
        if n != 1:
            sys.exit(f"ABORT: anchor '{name}' found {n} times (expected 1). No changes made.")
    bak = f"{FILE}.bak.{int(time.time())}"
    shutil.copy2(FILE, bak)
    src = src.replace(A1_OLD, A1_NEW, 1).replace(A2_OLD, A2_NEW, 1)
    open(FILE, "w", encoding="utf-8").write(src)
    print(f"OK: insistent reconnect added to {FILE}  (backup: {bak})")
    print("Verify:  node --check server.js && pm2 restart ibkr-webhook")
    print("Drill:   docker restart ibgw-ib-gateway-1  -> webhook should log the retry")
    print("         lines and then a fresh 'Connected to TWS' WITHOUT a pm2 restart (watch the ↺ counter).")

if __name__ == "__main__":
    main()
