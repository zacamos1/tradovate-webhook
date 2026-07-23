#!/usr/bin/env python3
"""
patch_execdetails_diagnostic.py

Adds a single debug log line at the top of the execDetails handler so
every execution event is visible in pm2 logs — entries AND exits.
This tells us what side/orderId IBKR reports for the timestop market
sell, so we can fix the SLD filter if needed.

Remove this patch once the pattern is confirmed (one more patch to
delete the log line, or just leave it — it's one line and low noise).

Usage (trading VPS, ~/ibkr-webhook, market closed):
    python3 patch_execdetails_diagnostic.py
    pm2 restart ibkr-webhook
"""
import shutil, subprocess, sys
from datetime import datetime

SERVER = "server.js"
ANCHOR = "  ib.on(EventName.execDetails, (reqId, contract, execution) => {\n    if (execution.side === 'SLD') {"
NEW = """  ib.on(EventName.execDetails, (reqId, contract, execution) => {
    log(`[execDetails] side=${execution.side} orderId=${execution.orderId} qty=${execution.shares} px=${execution.price}`);
    if (execution.side === 'SLD') {"""

with open(SERVER) as f:
    src = f.read()

if src.count(ANCHOR) != 1:
    print(f"ABORT: anchor found {src.count(ANCHOR)} times (expected 1). No changes made.")
    sys.exit(1)

backup = f"server.js.bak.{datetime.now().strftime('%Y%m%d_%H%M%S')}"
shutil.copy2(SERVER, backup)
print(f"Backup: {backup}")

src = src.replace(ANCHOR, NEW)
with open(SERVER, "w") as f:
    f.write(src)

result = subprocess.run(["node", "--check", SERVER], capture_output=True, text=True)
if result.returncode != 0:
    print("SYNTAX FAILED — restoring:")
    print(result.stderr)
    shutil.copy2(backup, SERVER)
    sys.exit(1)

print("Syntax OK. Run: pm2 restart ibkr-webhook")
print("Then Monday: pm2 logs ibkr-webhook --lines 5 --nostream after a timestop fires")
print("Look for: [execDetails] side=??? — that tells us the real value to filter on.")
