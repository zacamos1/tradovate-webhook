#!/usr/bin/env python3
"""
Patch pmtracker_feed_vol.js: derive ^RVX from ^VIX x 1.25 (Yahoo won't serve ^RVX).
- Backs up original to pmtracker_feed_vol.js.bak.<timestamp>
- Aborts (no changes) unless every anchor is found exactly once.
Run from ~/ibkr-webhook:  python3 patch_rvx_proxy.py
"""
import sys, time, shutil, os

FILE = "pmtracker_feed_vol.js"

# ---- edit 1: proxy block inserted right after the vol-fetch loop ----
ANCHOR_FETCH = "  for(const v of need){ vols[v] = await yahooLast(v); }"
PROXY_BLOCK = ANCHOR_FETCH + """

  // ---- RVX proxy: Yahoo won't serve ^RVX; derive from VIX -------------------
  const RVX_PROXY_MULT = 1.25;
  const volSrcLabel = {};                       // per-index source override for logging
  if(need.includes('^RVX') && vols['^RVX']==null){
    let vix = vols['^VIX'];
    if(vix==null) vix = await yahooLast('^VIX');   // VIX not in book's needs? fetch it
    if(vix!=null && vix>=5 && vix<=100){           // sanity bounds: never proxy off garbage
      vols['^RVX'] = +(vix * RVX_PROXY_MULT).toFixed(2);
      volSrcLabel['^RVX'] = `rvx_proxy_vix_x${RVX_PROXY_MULT}`;
      console.log(`(^RVX unavailable — using VIX ${vix} x ${RVX_PROXY_MULT} = ${vols['^RVX']})`);
    } else {
      console.log(`(^RVX unavailable and VIX fetch failed/out-of-bounds — IWM will be skipped)`);
    }
  }"""

# ---- edit 2: tag proxied source in the logged row ----
ANCHOR_SRC = "spot:r.spot, spot_src:r.spot_src, vol_pct:volPct, vol_src:vsrc,"
NEW_SRC    = "spot:r.spot, spot_src:r.spot_src, vol_pct:volPct, vol_src:(volSrcLabel[vsrc]||vsrc),"

def main():
    if not os.path.exists(FILE):
        sys.exit(f"ABORT: {FILE} not found — run from ~/ibkr-webhook")
    src = open(FILE, encoding="utf-8").read()

    if "RVX_PROXY_MULT" in src:
        sys.exit("ABORT: file already contains RVX_PROXY_MULT — patch appears applied.")

    for name, a in (("fetch-loop", ANCHOR_FETCH), ("vol_src", ANCHOR_SRC)):
        n = src.count(a)
        if n != 1:
            sys.exit(f"ABORT: anchor '{name}' found {n} times (expected 1). No changes made.")

    bak = f"{FILE}.bak.{int(time.time())}"
    shutil.copy2(FILE, bak)

    src = src.replace(ANCHOR_FETCH, PROXY_BLOCK, 1)
    src = src.replace(ANCHOR_SRC, NEW_SRC, 1)
    open(FILE, "w", encoding="utf-8").write(src)

    print(f"OK: patched {FILE}  (backup: {bak})")
    print("Verify with:  node --check pmtracker_feed_vol.js && grep -n 'RVX_PROXY' pmtracker_feed_vol.js")

if __name__ == "__main__":
    main()
