#!/usr/bin/env python3
"""
Generate pmtracker_feed_vol_wide.js from the (patched) pmtracker_feed_vol.js.

vol_wide = identical to vol in every way (same VIX/VXN/RVX-proxy inputs, same
baseline rows, same log file, same settler) except WING_MULT 1.25 -> 1.75,
i.e. wings at ~1.75x the expected 1-day move (~1.9-2.0% at VIX 17, ~3.1% at VIX 29).

Creates a NEW file only — pmtracker_feed_vol.js is never touched.
Aborts with no output file unless every anchor matches exactly once.

Run from ~/ibkr-webhook:  python3 make_vol_wide.py
"""
import sys, os

SRC = "pmtracker_feed_vol.js"
DST = "pmtracker_feed_vol_wide.js"

EDITS = [
    # (name, old, new)
    ("wing-mult",     "const WING_MULT   = 1.25;",  "const WING_MULT   = 1.75;"),
    ("dedup-check",   "r.variant==='vol')",          "r.variant==='vol_wide')"),
    ("row-variant",   "variant:'vol',",              "variant:'vol_wide',"),
    ("dedup-message", "vol variant already logged",  "vol_wide variant already logged"),
    ("header",        "VOL-SCALED variant",          "VOL-SCALED-WIDE variant"),
]

def main():
    if not os.path.exists(SRC):
        sys.exit(f"ABORT: {SRC} not found — run from ~/ibkr-webhook")
    if os.path.exists(DST):
        sys.exit(f"ABORT: {DST} already exists — delete it first if regenerating.")

    src = open(SRC, encoding="utf-8").read()

    if "RVX_PROXY_MULT" not in src:
        sys.exit("ABORT: source doesn't contain the RVX proxy patch — expected the patched vol feed.")

    for name, old, _ in EDITS:
        n = src.count(old)
        if n != 1:
            sys.exit(f"ABORT: anchor '{name}' found {n} times (expected 1). Nothing written.")

    out = src
    for _, old, new in EDITS:
        out = out.replace(old, new, 1)

    open(DST, "w", encoding="utf-8").write(out)
    print(f"OK: wrote {DST}  (WING_MULT=1.75, variant='vol_wide', RVX proxy inherited)")
    print("Verify:  node --check pmtracker_feed_vol_wide.js")
    print("Test:    node pmtracker_feed_vol_wide.js   (safe: exits early if baseline rows for today")
    print("         are missing, or logs today's vol_wide rows if baseline exists)")
    print("Cron:    crontab -l | grep -n vol   -> duplicate the vol feed line, +1 minute,")
    print("         pointing at pmtracker_feed_vol_wide.js")

if __name__ == "__main__":
    main()
