#!/usr/bin/env python3
"""
Patch fly_exec.js — wire up model pricing (currently dead code).

server.js passes callCredit/putCredit into placeFly(), but placeFly never reads
them: it always snapshot-quotes and prices from mids. This patch makes model
prices real: if BOTH are provided, snapshots are skipped entirely and the
verticals are submitted at the model credits ("model-priced, skips live quotes"
as originally intended). If either is missing, behavior is unchanged
(snapshot mids).

Backs up to fly_exec.js.bak.<timestamp>. Aborts with NO changes unless every
anchor matches exactly once. Run from ~/ibkr-webhook:
  python3 patch_fly_modelprice.py
"""
import sys, time, shutil, os

FILE = "fly_exec.js"

# ---- anchor 1: opts destructure — accept model credits ----------------------
OLD_OPTS = """    getOrderId,                 // function returning a fresh unique orderId from server.js
  } = opts;"""

NEW_OPTS = """    getOrderId,                 // function returning a fresh unique orderId from server.js
    callCredit: modelCall,      // optional model prices — if BOTH provided, snapshots are skipped
    putCredit:  modelPut,
  } = opts;"""

# ---- anchor 2: after legs resolve, skip snapshots when model-priced ---------
OLD_RESOLVE = """      if (Object.keys(resolved).length === legDefs.length && phase === 'resolve') {
        phase = 'quote';
        log(`[fly] ${symbol} legs resolved: ` + legDefs.map(l => `${l.tag}=${resolved[l.tag].conId}`).join(' '));
        requestSnapshots();
      }"""

NEW_RESOLVE = """      if (Object.keys(resolved).length === legDefs.length && phase === 'resolve') {
        phase = 'quote';
        log(`[fly] ${symbol} legs resolved: ` + legDefs.map(l => `${l.tag}=${resolved[l.tag].conId}`).join(' '));
        if (modelCall != null && modelPut != null) {
          priceAndSubmit();          // model-priced: no market data needed
        } else {
          requestSnapshots();
        }
      }"""

# ---- anchor 3: pricing — use model credits when provided --------------------
OLD_PRICE = """      const mSC = mid('SHORT_CALL'), mLC = mid('LONG_CALL'), mSP = mid('SHORT_PUT'), mLP = mid('LONG_PUT');
      log(`[fly] mids SC=${mSC} LC=${mLC} SP=${mSP} LP=${mLP}`);
      if ([mSC,mLC,mSP,mLP].some(v => v == null)) {
        return finish({ ok:false, error:'missing quotes — cannot price (market open? data perms?)' });
      }
      const callCredit = +(mSC - mLC).toFixed(2);
      const putCredit  = +(mSP - mLP).toFixed(2);"""

NEW_PRICE = """      let callCredit, putCredit;
      if (modelCall != null && modelPut != null) {
        callCredit = +(+modelCall).toFixed(2);
        putCredit  = +(+modelPut).toFixed(2);
        log(`[fly] MODEL-PRICED call=$${callCredit} put=$${putCredit} (snapshots skipped)`);
      } else {
        const mSC = mid('SHORT_CALL'), mLC = mid('LONG_CALL'), mSP = mid('SHORT_PUT'), mLP = mid('LONG_PUT');
        log(`[fly] mids SC=${mSC} LC=${mLC} SP=${mSP} LP=${mLP}`);
        if ([mSC,mLC,mSP,mLP].some(v => v == null)) {
          return finish({ ok:false, error:'missing quotes — cannot price (market open? data perms?)' });
        }
        callCredit = +(mSC - mLC).toFixed(2);
        putCredit  = +(mSP - mLP).toFixed(2);
      }"""

def main():
    if not os.path.exists(FILE):
        sys.exit(f"ABORT: {FILE} not found — run from ~/ibkr-webhook")
    src = open(FILE, encoding="utf-8").read()

    if "modelCall" in src:
        sys.exit("ABORT: file already contains modelCall — patch appears applied.")

    for name, a in (("opts-destructure", OLD_OPTS), ("resolve-branch", OLD_RESOLVE), ("pricing-block", OLD_PRICE)):
        n = src.count(a)
        if n != 1:
            sys.exit(f"ABORT: anchor '{name}' found {n} times (expected 1). No changes made.")

    bak = f"{FILE}.bak.{int(time.time())}"
    shutil.copy2(FILE, bak)
    src = src.replace(OLD_OPTS, NEW_OPTS, 1)
    src = src.replace(OLD_RESOLVE, NEW_RESOLVE, 1)
    src = src.replace(OLD_PRICE, NEW_PRICE, 1)
    open(FILE, "w", encoding="utf-8").write(src)

    print(f"OK: patched {FILE}  (backup: {bak})")
    print("Verify:  node --check fly_exec.js && grep -n 'MODEL-PRICED' fly_exec.js")

if __name__ == "__main__":
    main()
