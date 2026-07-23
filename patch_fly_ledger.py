#!/usr/bin/env python3
"""
patch_fly_ledger.py — give every iron fly a unique identity.

Adds to fly_exec.js:
  1. FLY_ID per placeFly() call: fly_<expiry>_<symbol>_<4hex>
  2. orderRef = FLY_ID on EVERY order (entry verticals, chase, flatten) —
     visible at IBKR in order status, executions, and TWS.
  3. Append-only lifecycle events to fly_ledger.jsonl:
       legs_resolved -> submitted -> filled | no_fill | orphaned
                        -> orphan_flattened | orphan_unresolved
     Each event row: { ts, flyId, symbol, expiry, event, ...details }.
     A fly's current status = its latest event (read with fly_status.js).

fly_legs_today.json keeps being written unchanged (the EOD-flatten consumes it);
the ledger is the richer superset and future tools key on it.

Backs up fly_exec.js. Aborts with NO changes unless every anchor matches once.
Run from ~/ibkr-webhook:  python3 patch_fly_ledger.py
"""
import sys, time, shutil, os

FILE = "fly_exec.js"

EDITS = []

# 1 ---- flyId + ledger helper, right after opts destructure --------------------
EDITS.append(("flyid-helper",
"""    putCredit:  modelPut,
  } = opts;""",
"""    putCredit:  modelPut,
  } = opts;

  // ---- fly identity: one ID stamped on every leg, order, and ledger event ----
  const FLY_ID = `fly_${expiry || todayUTC()}_${symbol}_${Math.random().toString(16).slice(2, 6)}`;
  const ledger = (event, extra) => {
    try {
      require('fs').appendFileSync(require('path').join(__dirname, 'fly_ledger.jsonl'),
        JSON.stringify(Object.assign({ ts: new Date().toISOString(), flyId: FLY_ID, symbol, expiry, event }, extra || {})) + '\\n');
    } catch (e) { log('[fly] ledger write failed: ' + e.message); }
  };"""))

# 2 ---- orderRef on entry/chase orders ----------------------------------------
EDITS.append(("orderref-entry",
"""      const mkOrder = (credit) => ({
        action: OrderAction.BUY, orderType: OrderType.LMT, totalQuantity: contracts,
        lmtPrice: -Math.abs(credit), account, transmit: true, tif: 'DAY',
      });""",
"""      const mkOrder = (credit) => ({
        action: OrderAction.BUY, orderType: OrderType.LMT, totalQuantity: contracts,
        lmtPrice: -Math.abs(credit), account, orderRef: FLY_ID, transmit: true, tif: 'DAY',
      });"""))

# 3 ---- orderRef on the flatten order ------------------------------------------
EDITS.append(("orderref-flatten",
"""              action: OrderAction.SELL, orderType: OrderType.LMT, totalQuantity: contracts,
              lmtPrice: -Math.abs(flatDebit), account, transmit: true, tif: 'DAY',""",
"""              action: OrderAction.SELL, orderType: OrderType.LMT, totalQuantity: contracts,
              lmtPrice: -Math.abs(flatDebit), account, orderRef: FLY_ID, transmit: true, tif: 'DAY',"""))

# 4 ---- ledger: legs resolved ---------------------------------------------------
EDITS.append(("ledger-legs",
"""        } catch (e) { log('[fly] leg-file write failed: ' + e.message); }""",
"""        } catch (e) { log('[fly] leg-file write failed: ' + e.message); }
        ledger('legs_resolved', { center, wing, contracts, account,
          legs: Object.fromEntries(legDefs.map(l => [l.tag, resolved[l.tag].conId])),
          shorts: legDefs.filter(l => l.tag.startsWith('SHORT')).map(l => resolved[l.tag].conId) });"""))

# 5 ---- ledger: submitted -------------------------------------------------------
EDITS.append(("ledger-submitted",
"""      log(`[fly] SUBMIT ${symbol} PUT  vertical id=${putId} SELL @ $${putCredit} x${contracts}`);
      ib.placeOrder(putId, vertical('SHORT_PUT','LONG_PUT'), mkOrder(putCredit));""",
"""      log(`[fly] SUBMIT ${symbol} PUT  vertical id=${putId} SELL @ $${putCredit} x${contracts}`);
      ib.placeOrder(putId, vertical('SHORT_PUT','LONG_PUT'), mkOrder(putCredit));
      ledger('submitted', { callCredit, putCredit, callOrderId: callId, putOrderId: putId });"""))

# 6 ---- ledger: filled (both) ---------------------------------------------------
EDITS.append(("ledger-filled",
"""          return finish(resultBase({ ok:true, note:'both verticals filled — iron fly complete' }));""",
"""          ledger('filled', { fills: { CALL: fills.CALL, PUT: fills.PUT } });
          return finish(resultBase({ ok:true, note:'both verticals filled — iron fly complete' }));"""))

# 7 ---- ledger: no_fill ---------------------------------------------------------
EDITS.append(("ledger-nofill",
"""          return finish(resultBase({ ok:false,
            note:'no fills — both orders cancelled; model credits did not cross, shade and retry' }));""",
"""          ledger('no_fill', { callCredit, putCredit });
          return finish(resultBase({ ok:false,
            note:'no fills — both orders cancelled; model credits did not cross, shade and retry' }));"""))

# 8 ---- ledger: orphaned --------------------------------------------------------
EDITS.append(("ledger-orphaned",
"""        log(`[fly] ORPHAN: ${filledTag} filled, ${missingTag} sitting — cancelling sitter, chasing @ $${chaseCredit} (85% of model)`);""",
"""        log(`[fly] ORPHAN: ${filledTag} filled, ${missingTag} sitting — cancelling sitter, chasing @ $${chaseCredit} (85% of model)`);
        ledger('orphaned', { filled: filledTag, filledAt: fills[filledTag], chasing: missingTag, chaseCredit });"""))

# 9 ---- ledger: filled via chase ------------------------------------------------
EDITS.append(("ledger-chased",
"""            return finish(resultBase({ ok:true, chased:missingTag,
              note:`fly complete — ${missingTag} filled on chase @ ~$${chaseCredit}` }));""",
"""            ledger('filled', { via: 'chase', fills: { CALL: fills.CALL, PUT: fills.PUT } });
            return finish(resultBase({ ok:true, chased:missingTag,
              note:`fly complete — ${missingTag} filled on chase @ ~$${chaseCredit}` }));"""))

# 10 ---- ledger: orphan flattened ------------------------------------------------
EDITS.append(("ledger-flattened",
"""              return finish(resultBase({ ok:false, orphan_flattened:true, orphan_pl_dollars:plDollars,
                note:`orphan ${filledTag} flattened @ $${fills.FLATTEN} — round-trip P/L $${plDollars}` }));""",
"""              ledger('orphan_flattened', { pl_dollars: plDollars, flattenAt: fills.FLATTEN });
              return finish(resultBase({ ok:false, orphan_flattened:true, orphan_pl_dollars:plDollars,
                note:`orphan ${filledTag} flattened @ $${fills.FLATTEN} — round-trip P/L $${plDollars}` }));"""))

# 11 ---- ledger: orphan unresolved -----------------------------------------------
EDITS.append(("ledger-unresolved",
"""            try { ib.cancelOrder(flatId); } catch(e) {}   // no zombies: leave nothing working""",
"""            ledger('orphan_unresolved', { openSide: filledTag, filledAt: fills[filledTag] });
            try { ib.cancelOrder(flatId); } catch(e) {}   // no zombies: leave nothing working"""))

def main():
    if not os.path.exists(FILE):
        sys.exit(f"ABORT: {FILE} not found — run from ~/ibkr-webhook")
    src = open(FILE, encoding="utf-8").read()
    if "FLY_ID" in src:
        sys.exit("ABORT: ledger patch appears already applied (FLY_ID present).")
    for name, old, _ in EDITS:
        n = src.count(old)
        if n != 1:
            sys.exit(f"ABORT: anchor '{name}' found {n} times (expected 1). No changes made.")
    bak = f"{FILE}.bak.{int(time.time())}"
    shutil.copy2(FILE, bak)
    for _, old, new in EDITS:
        src = src.replace(old, new, 1)
    open(FILE, "w", encoding="utf-8").write(src)
    print(f"OK: patched {FILE} with fly ledger  (backup: {bak})")
    print("Verify:  node --check fly_exec.js && grep -c 'ledger(' fly_exec.js   (expect ~9)")
    print("Then:    pm2 restart ibkr-webhook")

if __name__ == "__main__":
    main()
