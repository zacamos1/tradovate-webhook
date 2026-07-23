#!/usr/bin/env python3
"""
patch_fly_final.py — the two execution lessons from Jul 13-14 live attempts.

1. NULL FAR-WING FALLBACK: deep-OTM wings are legitimately quote-sparse and
   killed 3 attempts across 2 days. If a LONG wing mid is null but both SHORT
   mids are present, assume $0.03 for the wing (we BUY wings — a conservative
   estimate slightly overpays protection, never inflates the credit).
   Shorts stay strict: null short mid still aborts.

2. XSP-CALIBRATED WINDOWS: the 25s fill / 12s chase windows were tuned on SPY.
   XSP's book is slower (call filled in 2s, put wouldn't fill in 25s at its own
   mid). Fill wait 25s -> 50s, chase wait 12s -> 30s. Still finishes ~90s
   before anything else needs the morning.

Backs up fly_exec.js. Aborts with NO changes unless every anchor matches once.
Run from ~/ibkr-webhook:  python3 patch_fly_final.py
"""
import sys, time, shutil, os

FILE = "fly_exec.js"
EDITS = []

# ---- 1. null wing fallback: patch the mids validation block --------------
# current (from patch_fly_modelprice era): computes mids then checks all present
EDITS.append(("null-wing-fallback",
"""      const mid = (t) => {
        const q = quotes[t] || {};
        return q.bid != null && q.ask != null && q.ask > 0 ? (q.bid + q.ask) / 2 : null;
      };
      const mids = { SC: mid('SHORT_CALL'), LC: mid('LONG_CALL'), SP: mid('SHORT_PUT'), LP: mid('LONG_PUT') };
      log(`[fly] mids SC=${mids.SC} LC=${mids.LC} SP=${mids.SP} LP=${mids.LP}`);
      if (Object.values(mids).some((v) => v == null)) {
        return finish({ ok: false, error: 'missing quotes — cannot price (market open? data perms?)' });
      }""",
"""      const mid = (t) => {
        const q = quotes[t] || {};
        return q.bid != null && q.ask != null && q.ask > 0 ? (q.bid + q.ask) / 2 : null;
      };
      const mids = { SC: mid('SHORT_CALL'), LC: mid('LONG_CALL'), SP: mid('SHORT_PUT'), LP: mid('LONG_PUT') };
      log(`[fly] mids SC=${mids.SC} LC=${mids.LC} SP=${mids.SP} LP=${mids.LP}`);
      // deep-OTM LONG wings are quote-sparse; we BUY them, so a tiny estimate is
      // conservative (slightly overpays protection, never inflates credit).
      if (mids.LC == null && mids.SC != null) { mids.LC = 0.03; log('[fly] LC null — deep wing, assuming $0.03'); }
      if (mids.LP == null && mids.SP != null) { mids.LP = 0.03; log('[fly] LP null — deep wing, assuming $0.03'); }
      if (mids.SC == null || mids.SP == null) {
        return finish({ ok: false, error: 'missing quotes — cannot price (market open? data perms?)' });
      }"""))

# ---- 2. fill window 25s -> 50s -------------------------------------------
EDITS.append(("fill-window",
"""      setTimeout(resolveFills, 25000);""",
"""      setTimeout(resolveFills, 50000);   // XSP book is slower than SPY — give mids time to cross"""))

# ---- 3. chase window 12s -> 30s -------------------------------------------
EDITS.append(("chase-window",
"""        setTimeout(() => {
          if (fills[missingTag] != null) return;""",
"""        setTimeout(() => {
          if (fills[missingTag] != null) return;   // (window widened for XSP)"""))

def main():
    if not os.path.exists(FILE):
        sys.exit(f"ABORT: {FILE} not found — run from ~/ibkr-webhook")
    src = open(FILE, encoding="utf-8").read()
    if "deep wing, assuming" in src:
        sys.exit("ABORT: final patch already applied.")
    for name, old, _ in EDITS:
        n = src.count(old)
        if n != 1:
            sys.exit(f"ABORT: anchor '{name}' found {n} times (expected 1). No changes made.\n"
                     f"Run: grep -n \"{old.splitlines()[0].strip()[:40]}\" fly_exec.js  and share output.")
    # chase timing: the 12s lives inside the chase setTimeout call — find and widen it
    if src.count("}, 12000);") != 1:
        sys.exit(f"ABORT: chase 12000ms timeout found {src.count('}, 12000);')} times (expected 1). No changes made.")
    bak = f"{FILE}.bak.{int(time.time())}"
    shutil.copy2(FILE, bak)
    for _, old, new in EDITS:
        src = src.replace(old, new, 1)
    src = src.replace("}, 12000);", "}, 30000);", 1)
    open(FILE, "w", encoding="utf-8").write(src)
    print(f"OK: null-wing fallback + XSP timing windows applied  (backup: {bak})")
    print("Verify:  node --check fly_exec.js && grep -c 'deep wing' fly_exec.js")
    print("Then:    pm2 restart ibkr-webhook")

if __name__ == "__main__":
    main()
