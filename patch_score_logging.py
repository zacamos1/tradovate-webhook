#!/usr/bin/env python3
"""
patch_score_logging.py

Persists the TradingView alert's `score` field into mfe.jsonl.

Currently the alert payload carries score ({{plot_0}}) but the server
drops it at the webhook — it never reaches pendingBrackets, the tracked
position, or the exit log. That's why the signal-quality analysis had to
RECONSTRUCT scores from Yahoo bars (81% faithful). This patch carries the
actual fired score end-to-end so future analysis uses real values.

Four anchored edits:
  1. pendingBrackets entry captures score from the payload (NaN-safe).
  2. Fill-handler destructure picks it up.
  3. Tracked position object carries it.
  4. logExit() writes `score` into every mfe.jsonl record (including the
     timestop_fill correction rows, which reuse logExit).

Behavioral impact: none. Pure logging addition.

Usage (trading VPS, ~/ibkr-webhook, market closed):
    python3 patch_score_logging.py
    node --check server.js
    pm2 restart ibkr-webhook
"""
import shutil
import subprocess
import sys
from datetime import datetime

SERVER = "server.js"

EDITS = [
    # 1) capture score into pendingBrackets (payload is in scope — used 7 lines above)
    (
        "    pendingBrackets[parentId] = {\n"
        "      contract, qty, tpId, slId, ocaGroup, parentId, tpPct, slPct,",
        "    pendingBrackets[parentId] = {\n"
        "      contract, qty, tpId, slId, ocaGroup, parentId, tpPct, slPct,\n"
        "      score: Number.isFinite(parseFloat(payload.score)) ? parseFloat(payload.score) : null,",
    ),
    # 2) pick score up in the fill handler destructure
    (
        "    const { contract: con, qty, tpId, slId, ocaGroup, tpPct, slPct, underlyingConId, entryUnderlying } = pending;",
        "    const { contract: con, qty, tpId, slId, ocaGroup, tpPct, slPct, underlyingConId, entryUnderlying, score } = pending;",
    ),
    # 3) carry it on the tracked position object
    (
        "        peakUnderlying: entryUnderlying,    // best favorable underlying level seen\n"
        "        underlyingReqId: null\n"
        "      };",
        "        peakUnderlying: entryUnderlying,    // best favorable underlying level seen\n"
        "        score: score ?? null,               // fired score from the TV alert payload\n"
        "        underlyingReqId: null\n"
        "      };",
    ),
    # 4) write it into every mfe.jsonl record (anchor unique to logExit —
    #    the similar entryUnderlying line also exists in /health, so anchor
    #    on the straddle line instead)
    (
        "      minsToPeak, minsHeld, qty: p.qty, straddle: !!p.straddle,",
        "      minsToPeak, minsHeld, qty: p.qty, straddle: !!p.straddle,\n"
        "      score: p.score ?? null,",
    ),
]


def main():
    with open(SERVER) as f:
        src = f.read()

    for i, (old, _new) in enumerate(EDITS, 1):
        count = src.count(old)
        if count != 1:
            print(f"ABORT: edit {i} anchor found {count} times (expected exactly 1).")
            print(f"Anchor was:\n{old}")
            print("No changes made.")
            sys.exit(1)

    backup = f"server.js.bak.{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    shutil.copy2(SERVER, backup)
    print(f"Backup written: {backup}")

    for i, (old, new) in enumerate(EDITS, 1):
        src = src.replace(old, new)
        print(f"Edit {i}/4 applied.")

    with open(SERVER, "w") as f:
        f.write(src)

    result = subprocess.run(["node", "--check", SERVER], capture_output=True, text=True)
    if result.returncode != 0:
        print("SYNTAX CHECK FAILED — restoring backup:")
        print(result.stderr)
        shutil.copy2(backup, SERVER)
        print("server.js restored. No changes are live.")
        sys.exit(1)

    print("Syntax check passed.")
    print("\nDone. To activate:  pm2 restart ibkr-webhook")
    print("Verify tomorrow: every new mfe.jsonl row should carry a numeric")
    print("'score' field matching the TV alert that fired it.")


if __name__ == "__main__":
    main()
