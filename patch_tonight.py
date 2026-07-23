#!/usr/bin/env python3
"""
patch_tonight.py — the two mandatory patches before any fly rides to settlement,
in one script. Edits BOTH server.js and fly_exec.js with anchor checks + backups.

server.js:
  S1. EOD-flatten skips fly legs: reads fly_legs_today.json (written by fly_exec)
      and never touches those conIds. Without this, the flatten sells a fly's
      long wings at 15:50 and leaves naked shorts into settlement.
  S2. Pass-1 flatten no longer refires after the close (adds < 16:01 guard) —
      kills the harmless-but-noisy 'already expired' rejects on evening restarts.

fly_exec.js:
  F1. After leg resolution, writes fly_legs_today.json:
      { date, conIds:[all 4], shorts:[short conIds] } — consumed by S1 and by
      any external cleanup (shorts list = what must never be left unmanaged).
  F2. ORPHAN UNRESOLVED no longer leaves a zombie flatten limit working —
      it cancels it before finishing (today's zombie #4 lesson). External
      cleanup becomes the single owner of any remnant.

Run from ~/ibkr-webhook:  python3 patch_tonight.py
Aborts file-by-file with NO changes to a file unless all its anchors match once.
"""
import sys, time, shutil, os

def patch(fname, edits, already_marker):
    if not os.path.exists(fname):
        print(f"SKIP {fname}: not found"); return False
    src = open(fname, encoding="utf-8").read()
    if already_marker in src:
        print(f"SKIP {fname}: already patched ({already_marker})"); return False
    for name, old, _ in edits:
        n = src.count(old)
        if n != 1:
            print(f"ABORT {fname}: anchor '{name}' found {n} times (expected 1) — file unchanged")
            return False
    bak = f"{fname}.bak.{int(time.time())}"
    shutil.copy2(fname, bak)
    for _, old, new in edits:
        src = src.replace(old, new, 1)
    open(fname, "w", encoding="utf-8").write(src)
    print(f"OK {fname} patched (backup {bak})")
    return True

# ============================== server.js ====================================
S1_OLD = """    if (contract.secType !== 'OPT') return;
    if (contract.lastTradeDateOrContractMonth !== today) return;
    if (pos <= 0) return;  // we only buy-to-open; skip flat/short"""

S1_NEW = """    if (contract.secType !== 'OPT') return;
    if (contract.lastTradeDateOrContractMonth !== today) return;
    if (pos <= 0) return;  // we only buy-to-open; skip flat/short
    try {   // never touch premium-book (fly) legs — they ride to cash settlement
      const flyLegs = JSON.parse(require('fs').readFileSync(require('path').join(__dirname,'fly_legs_today.json'),'utf8'));
      if (flyLegs && Array.isArray(flyLegs.conIds) && flyLegs.conIds.includes(contract.conId)) {
        log(`EOD-flatten: skipping FLY LEG conId ${contract.conId} (${contract.symbol} ${contract.right} ${contract.strike})`);
        return;
      }
    } catch(e) {}"""

S2_OLD = """    if (nowHHMM_ET() >= EOD_FLATTEN_HHMM) {
      eodFlattenedOn = today;"""

S2_NEW = """    if (nowHHMM_ET() >= EOD_FLATTEN_HHMM && Number(nowHHMM_ET()) < 1601) {
      eodFlattenedOn = today;"""

# ============================== fly_exec.js ==================================
F1_OLD = """        log(`[fly] ${symbol} legs resolved: ` + legDefs.map(l => `${l.tag}=${resolved[l.tag].conId}`).join(' '));"""

F1_NEW = """        log(`[fly] ${symbol} legs resolved: ` + legDefs.map(l => `${l.tag}=${resolved[l.tag].conId}`).join(' '));
        try {   // publish leg conIds so the EOD-flatten (and cleanup tools) can exclude/act on them
          const fs2 = require('fs'), path2 = require('path');
          const p = path2.join(__dirname, 'fly_legs_today.json');
          let d = { date: expiry, conIds: [], shorts: [] };
          try { const j = JSON.parse(fs2.readFileSync(p, 'utf8')); if (j.date === expiry) d = j; } catch (e) {}
          for (const l of legDefs) {
            const cid = resolved[l.tag].conId;
            if (!d.conIds.includes(cid)) d.conIds.push(cid);
            if (l.tag.startsWith('SHORT') && !d.shorts.includes(cid)) d.shorts.push(cid);
          }
          fs2.writeFileSync(p, JSON.stringify(d));
        } catch (e) { log('[fly] leg-file write failed: ' + e.message); }"""

F2_OLD = """            log(`[fly] *** ORPHAN UNRESOLVED: ${filledTag} vertical OPEN, flatten limit left working DAY @ $${flatDebit} — CHECK IBKR NOW ***`);
            finish(resultBase({ ok:false, orphan_unresolved:true,
              note:`ORPHAN UNRESOLVED — ${filledTag} vertical open; flatten limit working DAY @ $${flatDebit}. Check IBKR.` }));"""

F2_NEW = """            try { ib.cancelOrder(flatId); } catch(e) {}   // no zombies: leave nothing working
            log(`[fly] *** ORPHAN UNRESOLVED: ${filledTag} vertical OPEN, flatten CANCELLED (no zombie) — external cleanup required ***`);
            finish(resultBase({ ok:false, orphan_unresolved:true,
              note:`ORPHAN UNRESOLVED — ${filledTag} vertical open; flatten cancelled, nothing left working. External cleanup required.` }));"""

ok1 = patch("server.js",
            [("fly-exclusion", S1_OLD, S1_NEW), ("post-close-guard", S2_OLD, S2_NEW)],
            "skipping FLY LEG")
ok2 = patch("fly_exec.js",
            [("leg-file", F1_OLD, F1_NEW), ("no-zombie", F2_OLD, F2_NEW)],
            "fly_legs_today.json")

print("\nNext:  node --check server.js && node --check fly_exec.js && pm2 restart ibkr-webhook")
sys.exit(0 if (ok1 or ok2) else 1)
