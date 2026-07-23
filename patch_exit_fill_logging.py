#!/usr/bin/env python3
"""
patch_exit_fill_logging.py

Adds TRUE fill-price logging for timestop exits in server.js.

Current behavior: the timestop path logs `logExit(p, 'timestop', p.lastPrice
|| p.peak)` at close-SUBMIT time — the last observed quote, not the actual
market-order fill. The execDetails handler ignores all sells
(`if (execution.side !== 'BOT') return;`), so the real fill never gets logged.

This patch (3 anchored edits):
  1. Adds a `pendingExitFills` map near the logger.
  2. Registers the timestop sell order ID + a snapshot of the position
     when the close is submitted (keeps existing immediate approx line —
     fail-safe property unchanged).
  3. Extends execDetails: on a SLD execution matching a registered exit,
     writes a SECOND mfe line via the existing logExit() with reason
     'timestop_fill' and the true execution price.

Result in mfe.jsonl: timestop exits get two lines — the immediate approx
line (reason 'timestop', as today) and a corrected line (reason
'timestop_fill', true fill). Analysis should prefer *_fill rows when
present. Trail/EOD exits are unchanged (their logged trigger prices are
already close to real; can be extended the same way later if wanted).

Usage (on the trading VPS, market closed, from ~/ibkr-webhook):
    python3 patch_exit_fill_logging.py
    node --check server.js
    pm2 restart ibkr-webhook
"""
import shutil
import subprocess
import sys
from datetime import datetime

SERVER = "server.js"

EDITS = [
    # 1) global map, anchored to the _lastBarSignals line right above logExit
    (
        "const _lastBarSignals = {};  // posKey-ish -> {time, dir} for same-bar straddle detection",
        "const _lastBarSignals = {};  // posKey-ish -> {time, dir} for same-bar straddle detection\n"
        "const pendingExitFills = {}; // sellOrderId -> {p: snapshot, reason, ts} for true-fill exit logging",
    ),
    # 2) register the timestop sell for fill correction (immediately after the existing approx logExit)
    (
        "      logExit(p, 'timestop', p.lastPrice || p.peak);",
        "      logExit(p, 'timestop', p.lastPrice || p.peak);\n"
        "      pendingExitFills[sellId] = { p: Object.assign({}, p), reason: 'timestop', ts: Date.now() };",
    ),
    # 3) handle SLD executions in execDetails before the BOT-only filter
    (
        "    if (execution.side !== 'BOT') return;",
        "    if (execution.side === 'SLD') {\n"
        "      const pe = pendingExitFills[execution.orderId];\n"
        "      if (pe) {\n"
        "        delete pendingExitFills[execution.orderId];\n"
        "        logExit(pe.p, pe.reason + '_fill', execution.price);\n"
        "      }\n"
        "      // prune stale entries (fills that never came back) after 30 min\n"
        "      const _cutoff = Date.now() - 30 * 60 * 1000;\n"
        "      for (const k in pendingExitFills) { if (pendingExitFills[k].ts < _cutoff) delete pendingExitFills[k]; }\n"
        "      return;\n"
        "    }\n"
        "    if (execution.side !== 'BOT') return;",
    ),
]


def main():
    with open(SERVER) as f:
        src = f.read()

    # Verify every anchor exists exactly once BEFORE touching anything
    for i, (old, _new) in enumerate(EDITS, 1):
        count = src.count(old)
        if count != 1:
            print(f"ABORT: edit {i} anchor found {count} times (expected exactly 1).")
            print(f"Anchor was:\n{old}")
            print("No changes made. server.js may differ from the version this patch was written against.")
            sys.exit(1)

    backup = f"server.js.bak.{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    shutil.copy2(SERVER, backup)
    print(f"Backup written: {backup}")

    for i, (old, new) in enumerate(EDITS, 1):
        src = src.replace(old, new)
        print(f"Edit {i}/3 applied.")

    with open(SERVER, "w") as f:
        f.write(src)

    # Syntax check
    result = subprocess.run(["node", "--check", SERVER], capture_output=True, text=True)
    if result.returncode != 0:
        print("SYNTAX CHECK FAILED — restoring backup:")
        print(result.stderr)
        shutil.copy2(backup, SERVER)
        print("server.js restored. No changes are live.")
        sys.exit(1)

    print("Syntax check passed.")
    print("\nDone. To activate:  pm2 restart ibkr-webhook")
    print("Verify tomorrow: timestop exits in mfe.jsonl should be followed by a")
    print("matching 'timestop_fill' line carrying the true execution price.")


if __name__ == "__main__":
    main()
