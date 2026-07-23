#!/usr/bin/env python3
"""
Patch server.js — fix EOD-flatten error 321 ("Missing order exchange").

Root cause: contracts returned by reqPositions() have an empty `exchange` field.
Passing them straight to placeOrder() gets the close rejected, so 0DTE positions
ride into expiry unmanaged (happened 2026-07-08: SPY C745 + QQQ P710).

Fix: build a minimal close contract from conId with exchange:'SMART' before placing.

Backs up to server.js.bak.<timestamp>. Aborts with NO changes unless the anchor
matches exactly once. Run from ~/ibkr-webhook:  python3 patch_eod_exchange.py
"""
import sys, time, shutil, os

FILE = "server.js"

OLD = """      const sellId = orderId++;
      ib.placeOrder(sellId, contract, {
        action: OrderAction.SELL, orderType: OrderType.MKT,
        totalQuantity: pos, account: ACCOUNT, transmit: true
      });"""

NEW = """      const sellId = orderId++;
      // positions() contracts come back with exchange:'' — placeOrder rejects them (err 321).
      // Rebuild minimal contract from conId with SMART routing.
      const closeContract = {
        conId: contract.conId,
        symbol: contract.symbol,
        secType: contract.secType,
        exchange: 'SMART',
        currency: contract.currency || 'USD',
      };
      ib.placeOrder(sellId, closeContract, {
        action: OrderAction.SELL, orderType: OrderType.MKT,
        totalQuantity: pos, account: ACCOUNT, transmit: true
      });"""

def main():
    if not os.path.exists(FILE):
        sys.exit(f"ABORT: {FILE} not found — run from ~/ibkr-webhook")
    src = open(FILE, encoding="utf-8").read()

    if "closeContract" in src:
        sys.exit("ABORT: file already contains closeContract — patch appears applied.")

    n = src.count(OLD)
    if n != 1:
        sys.exit(f"ABORT: anchor found {n} times (expected 1). No changes made.")

    bak = f"{FILE}.bak.{int(time.time())}"
    shutil.copy2(FILE, bak)
    open(FILE, "w", encoding="utf-8").write(src.replace(OLD, NEW, 1))

    print(f"OK: patched {FILE}  (backup: {bak})")
    print("Verify:  node --check server.js && grep -n 'closeContract' server.js")
    print("Then:    pm2 restart ibkr-webhook   (plain restart, env untouched)")

if __name__ == "__main__":
    main()
