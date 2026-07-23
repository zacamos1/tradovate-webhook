#!/usr/bin/env python3
"""
Patch server.js — make /place_test_fly async (fire-and-log).

Why: orphan handling can take ~60-90s to resolve; holding the HTTP response open
that long through ngrok risks a cut connection mid-test. Endpoint now returns
202 immediately; the result lands in pm2 logs as '[fly] result: ...' and fills
get appended to fly_exec_log.jsonl (now including real_fill_dollars, chase and
orphan flags).

Backs up to server.js.bak.<timestamp>. Aborts with NO changes unless the anchor
matches exactly once. Run from ~/ibkr-webhook:  python3 patch_fly_endpoint.py
"""
import sys, time, shutil, os

FILE = "server.js"

OLD = """  try {
    const result = await placeFly(ib, {
      symbol, center: parseInt(center,10), wing: parseInt(wing,10),
      contracts: parseInt(contracts,10) || 1, account: ACCOUNT, log, getOrderId: nextFlyOrderId,
      callCredit: callCredit != null ? parseFloat(callCredit) : undefined,
      putCredit:  putCredit  != null ? parseFloat(putCredit)  : undefined,
    });
    if (result.ok && result.real_fill_credit != null) {
      try {
        const row = { ts:new Date().toISOString(), source:'place_test_fly', symbol:result.symbol,
          center:result.center, wing:result.wing, contracts:result.contracts, expiry:result.expiry,
          real_fill_credit:result.real_fill_credit, call_credit:result.callCredit, put_credit:result.putCredit,
          account:result.account };
        fs.appendFileSync(require('path').join(__dirname,'fly_exec_log.jsonl'), JSON.stringify(row)+'\\n');
      } catch(e) { log('[fly] log write failed: '+e.message); }
    }
    log(`[fly] result: ${JSON.stringify(result)}`);
    return res.json(result);
  } catch (e) { log('[fly] endpoint error: '+e.message); return res.status(500).json({ ok:false, error:e.message }); }"""

NEW = """  try {
    placeFly(ib, {
      symbol, center: parseInt(center,10), wing: parseInt(wing,10),
      contracts: parseInt(contracts,10) || 1, account: ACCOUNT, log, getOrderId: nextFlyOrderId,
      callCredit: callCredit != null ? parseFloat(callCredit) : undefined,
      putCredit:  putCredit  != null ? parseFloat(putCredit)  : undefined,
    }).then((result) => {
      if (result.ok && result.real_fill_credit != null) {
        try {
          const row = { ts:new Date().toISOString(), source:'place_test_fly', symbol:result.symbol,
            center:result.center, wing:result.wing, contracts:result.contracts, expiry:result.expiry,
            real_fill_credit:result.real_fill_credit, real_fill_dollars:result.real_fill_dollars ?? null,
            call_credit:result.callCredit, put_credit:result.putCredit,
            chased:result.chased ?? null, account:result.account };
          fs.appendFileSync(require('path').join(__dirname,'fly_exec_log.jsonl'), JSON.stringify(row)+'\\n');
        } catch(e) { log('[fly] log write failed: '+e.message); }
      }
      if (result.orphan_flattened || result.orphan_unresolved) {
        try {
          const row = { ts:new Date().toISOString(), source:'place_test_fly', symbol:result.symbol,
            center:result.center, wing:result.wing, contracts:result.contracts, expiry:result.expiry,
            orphan_flattened:result.orphan_flattened ?? false, orphan_unresolved:result.orphan_unresolved ?? false,
            orphan_pl_dollars:result.orphan_pl_dollars ?? null, fills:result.fills, account:result.account };
          fs.appendFileSync(require('path').join(__dirname,'fly_exec_log.jsonl'), JSON.stringify(row)+'\\n');
        } catch(e) { log('[fly] orphan log write failed: '+e.message); }
      }
      log(`[fly] result: ${JSON.stringify(result)}`);
    }).catch((e) => log('[fly] async error: '+(e && e.message ? e.message : e)));

    return res.status(202).json({ ok:true, submitted:true,
      note:'fly working async — watch pm2 logs for [fly] result (up to ~90s if orphan handling engages)' });
  } catch (e) { log('[fly] endpoint error: '+e.message); return res.status(500).json({ ok:false, error:e.message }); }"""

def main():
    if not os.path.exists(FILE):
        sys.exit(f"ABORT: {FILE} not found — run from ~/ibkr-webhook")
    src = open(FILE, encoding="utf-8").read()

    if "fly working async" in src:
        sys.exit("ABORT: endpoint already patched.")

    n = src.count(OLD)
    if n != 1:
        sys.exit(f"ABORT: anchor found {n} times (expected 1). No changes made.")

    bak = f"{FILE}.bak.{int(time.time())}"
    shutil.copy2(FILE, bak)
    open(FILE, "w", encoding="utf-8").write(src.replace(OLD, NEW, 1))

    print(f"OK: patched {FILE}  (backup: {bak})")
    print("Verify:  node --check server.js")

if __name__ == "__main__":
    main()
