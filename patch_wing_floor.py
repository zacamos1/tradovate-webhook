#!/usr/bin/env python3
"""
patch_wing_floor.py — low-VIX wing floor for pmtracker_feed_vol_wide.js ONLY.

Rationale (from the 18-month breach tables + jump-risk asymmetry): implied vol
compresses in calm regimes but surprise-move size doesn't compress with it.
At VIX 12 the 1.75x formula would size XSP wings ~1.32% of spot — 1-in-8/19
breach territory for minimum credit. The floor guarantees:
    index symbols (XSP/SPX/SPY/QQQ): wings >= 1.5% of spot
    IWM:                             wings >= 2.0% of spot
Completely DORMANT above VIX ~13.6 (index) / ~16 proxied (IWM) — at current
VIX ~15.7 it changes zero rows, so the ongoing vol vs vol_wide A/B is untouched.
vol (the control variant) deliberately gets no floor.

Backs up the file. Aborts with NO changes unless the anchor matches exactly once.
Run from ~/ibkr-webhook:  python3 patch_wing_floor.py
"""
import sys, time, shutil, os

FILE = "pmtracker_feed_vol_wide.js"

OLD = """  const W = Math.max(1, Math.round(open * ivd * WING_MULT));   // <-- the only change vs fixed-%"""

NEW = """  // low-VIX wing floor: crushed IV shrinks wings but jump risk doesn't shrink
  // with it. Floor at 1.5% of spot (2.0% for IWM). Dormant above VIX ~13.6.
  const FLOOR_PCT = (sym === 'IWM') ? 0.020 : 0.015;
  const W = Math.max(1, Math.round(open * ivd * WING_MULT),
                     Math.round(open * FLOOR_PCT));"""

def main():
    if not os.path.exists(FILE):
        sys.exit(f"ABORT: {FILE} not found — run from ~/ibkr-webhook")
    src = open(FILE, encoding="utf-8").read()
    if "FLOOR_PCT" in src:
        sys.exit("ABORT: wing floor already applied.")
    n = src.count(OLD)
    if n != 1:
        sys.exit(f"ABORT: anchor found {n} times (expected 1). No changes made.\n"
                 "Likely cause: the wing line differs — run  grep -n 'WING_MULT' pmtracker_feed_vol_wide.js  and share it.")
    # sanity: the symbol variable name must exist in the file ('sym' per the vol feed's loop)
    if "sym" not in src:
        sys.exit("ABORT: expected symbol variable 'sym' not found — share the per-symbol loop and I'll adjust.")
    bak = f"{FILE}.bak.{int(time.time())}"
    shutil.copy2(FILE, bak)
    open(FILE, "w", encoding="utf-8").write(src.replace(OLD, NEW, 1))
    print(f"OK: wing floor added to {FILE}  (backup: {bak})")
    print("Verify:  node --check pmtracker_feed_vol_wide.js && grep -n 'FLOOR_PCT' pmtracker_feed_vol_wide.js")
    print("Note:    dormant at current VIX — first binds below ~13.6 (index) / ~16 proxied (IWM).")

if __name__ == "__main__":
    main()
