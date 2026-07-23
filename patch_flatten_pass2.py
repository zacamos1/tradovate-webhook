#!/usr/bin/env python3
"""
Patch server.js — add EOD-flatten PASS 2 (catch-all).

Pass 1 fires at EOD_FLATTEN_HHMM (15:50 ET) as before. Pass 2 re-runs
flattenZeroDTE() 7 minutes later (15:57 ET) — it re-queries live positions, so
it only acts on whatever pass 1 failed to close (rejects, partials, races).
Guarded to never fire at/after 16:00, and state is kept on the function object
(flattenZeroDTE._p2) so no new top-level declaration is needed.

NOTE: assumes EOD_FLATTEN_HHMM + 7 stays within the same clock hour (1550 -> 1557
is fine; don't move the flatten time past :52 without revisiting this).

Backs up to server.js.bak.<timestamp>. Aborts with NO changes unless the anchor
matches exactly once. Run from ~/ibkr-webhook:  python3 patch_flatten_pass2.py
"""
import sys, time, shutil, os

FILE = "server.js"

OLD = """    if (eodFlattenedOn === today) return;
    if (nowHHMM_ET() >= EOD_FLATTEN_HHMM) {
      eodFlattenedOn = today;
      log(`EOD-flatten trigger at ${nowHHMM_ET()} ET`);
      flattenZeroDTE();"""

NEW = """    // PASS 2 catch-all: re-run 7 min after pass 1. Re-queries positions, so it
    // only touches what pass 1 failed to close. Never fires at/after 16:00.
    if (eodFlattenedOn === today && flattenZeroDTE._p2 !== today
        && Number(nowHHMM_ET()) >= Number(EOD_FLATTEN_HHMM) + 7
        && Number(nowHHMM_ET()) < 1600) {
      flattenZeroDTE._p2 = today;
      log(`EOD-flatten PASS 2 (catch-all) at ${nowHHMM_ET()} ET`);
      flattenZeroDTE();
    }
    if (eodFlattenedOn === today) return;
    if (nowHHMM_ET() >= EOD_FLATTEN_HHMM) {
      eodFlattenedOn = today;
      log(`EOD-flatten trigger at ${nowHHMM_ET()} ET`);
      flattenZeroDTE();"""

def main():
    if not os.path.exists(FILE):
        sys.exit(f"ABORT: {FILE} not found — run from ~/ibkr-webhook")
    src = open(FILE, encoding="utf-8").read()

    if "_p2" in src:
        sys.exit("ABORT: file already contains _p2 — patch appears applied.")

    n = src.count(OLD)
    if n != 1:
        sys.exit(f"ABORT: anchor found {n} times (expected 1). No changes made.")

    bak = f"{FILE}.bak.{int(time.time())}"
    shutil.copy2(FILE, bak)
    open(FILE, "w", encoding="utf-8").write(src.replace(OLD, NEW, 1))

    print(f"OK: patched {FILE}  (backup: {bak})")
    print("Verify:  node --check server.js && grep -n 'PASS 2' server.js")
    print("Then:    pm2 restart ibkr-webhook")

if __name__ == "__main__":
    main()
