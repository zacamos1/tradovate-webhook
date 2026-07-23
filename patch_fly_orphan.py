#!/usr/bin/env python3
"""
Patch fly_exec.js — orphan-leg handling + result-object fix.

Changes:
 1. 25s resolution becomes three-outcome:
      both filled   -> done (unchanged)
      neither       -> cancel BOTH working orders (no more stale DAY limits), report model-vs-market gap
      one filled    -> ORPHAN: cancel sitter, chase once @ 85% of model credit (~12.5s),
                       if chase fails -> flatten the filled vertical (BUY back @ credit x1.5, ~12s),
                       if flatten fails -> orphan_unresolved:true + loud log (flatten limit left working)
 2. real_fill_credit becomes per-fly credit ($/share); new real_fill_dollars carries the
    total-dollar figure that used to (wrongly) sit in real_fill_credit.
 3. Overall watchdog 40s -> 90s so it can't fire mid-chase and rip out listeners.

Backs up to fly_exec.js.bak.<timestamp>. Aborts with NO changes unless every anchor
matches exactly once. Run from ~/ibkr-webhook:  python3 patch_fly_orphan.py
"""
import sys, time, shutil, os

FILE = "fly_exec.js"

# ---------------------------------------------------------------- anchor 1
OLD_TIMER = """      // resolve after 25s with whatever fill state we have
      setTimeout(() => {
        const bothFilled = fills.CALL != null && fills.PUT != null;
        finish({
          ok: bothFilled,
          symbol, center, wing, contracts, account, expiry,
          callCredit, putCredit,
          fills: { CALL: fills.CALL ?? null, PUT: fills.PUT ?? null },
          real_fill_credit: bothFilled ? +(((fills.CALL + fills.PUT) * 100 * contracts)).toFixed(2) : null,
          note: bothFilled ? 'both verticals filled — iron fly complete'
                           : 'not both filled — check IBKR (one-sided = defined-risk spread, not naked)',
        });
      }, 25000);"""

NEW_TIMER = """      // resolve after 25s: both / neither / orphan (cancel -> chase -> flatten)
      setTimeout(() => resolveFills(), 25000);

      function resultBase(extra) {
        const c = fills.CALL, p = fills.PUT;
        const both = c != null && p != null;
        return Object.assign({
          symbol, center, wing, contracts, account, expiry,
          callCredit, putCredit,
          fills: { CALL: c ?? null, PUT: p ?? null, FLATTEN: fills.FLATTEN ?? null },
          real_fill_credit:  both ? +((c + p).toFixed(2)) : null,                       // per-fly credit ($/share)
          real_fill_dollars: both ? +(((c + p) * 100 * contracts)).toFixed(2) : null,   // total $ received
        }, extra);
      }

      function resolveFills() {
        const cF = fills.CALL != null, pF = fills.PUT != null;

        if (cF && pF) {
          return finish(resultBase({ ok:true, note:'both verticals filled — iron fly complete' }));
        }

        if (!cF && !pF) {
          log(`[fly] no fills in 25s — cancelling both (model call $${callCredit} / put $${putCredit} did not cross)`);
          try { ib.cancelOrder(callId); } catch(e) { log(`[fly] cancel call err: ${e.message||e}`); }
          try { ib.cancelOrder(putId);  } catch(e) { log(`[fly] cancel put err: ${e.message||e}`);  }
          return finish(resultBase({ ok:false,
            note:'no fills — both orders cancelled; model credits did not cross, shade and retry' }));
        }

        // ---- ORPHAN: exactly one vertical filled ----------------------------
        const filledTag  = cF ? 'CALL' : 'PUT';
        const missingTag = cF ? 'PUT'  : 'CALL';
        const sitterId   = cF ? putId  : callId;
        const missingModel = missingTag === 'CALL' ? callCredit : putCredit;
        const chaseCredit  = Math.max(+((missingModel * 0.85).toFixed(2)), 0.01);

        log(`[fly] ORPHAN: ${filledTag} filled, ${missingTag} sitting — cancelling sitter, chasing @ $${chaseCredit} (85% of model)`);
        try { ib.cancelOrder(sitterId); } catch(e) { log(`[fly] cancel sitter err: ${e.message||e}`); }

        const chaseId = getOrderId();
        orderTag[chaseId] = missingTag;   // onOrderStatus records its fill under CALL/PUT automatically
        const chaseCombo = missingTag === 'CALL' ? vertical('SHORT_CALL','LONG_CALL')
                                                 : vertical('SHORT_PUT','LONG_PUT');
        setTimeout(() => {                // let the cancel land first
          log(`[fly] CHASE ${symbol} ${missingTag} vertical id=${chaseId} SELL @ $${chaseCredit} x${contracts}`);
          ib.placeOrder(chaseId, chaseCombo, mkOrder(chaseCredit));
        }, 1500);

        // chase window: ~12.5s working after the 1.5s cancel gap
        setTimeout(() => {
          if (fills.CALL != null && fills.PUT != null) {
            return finish(resultBase({ ok:true, chased:missingTag,
              note:`fly complete — ${missingTag} filled on chase @ ~$${chaseCredit}` }));
          }

          // ---- chase failed: flatten the filled vertical ---------------------
          try { ib.cancelOrder(chaseId); } catch(e) { log(`[fly] cancel chase err: ${e.message||e}`); }
          const filledCredit = fills[filledTag];
          const flatDebit = Math.max(+((filledCredit * 1.5).toFixed(2)), +((filledCredit + 0.05).toFixed(2)));
          const flatId = getOrderId();
          orderTag[flatId] = 'FLATTEN';
          const flatCombo = filledTag === 'CALL' ? vertical('SHORT_CALL','LONG_CALL')
                                                 : vertical('SHORT_PUT','LONG_PUT');
          log(`[fly] chase failed — FLATTEN ${filledTag} vertical id=${flatId} BUY back @ $${flatDebit} (sold @ $${filledCredit})`);
          setTimeout(() => {
            ib.placeOrder(flatId, flatCombo, {
              action: OrderAction.BUY, orderType: OrderType.LMT, totalQuantity: contracts,
              lmtPrice: flatDebit, account, transmit: true, tif: 'DAY',
            });
          }, 1500);

          // flatten window: ~10.5s
          setTimeout(() => {
            if (fills.FLATTEN != null) {
              const plDollars = +(((filledCredit - fills.FLATTEN) * 100 * contracts).toFixed(2));
              return finish(resultBase({ ok:false, orphan_flattened:true, orphan_pl_dollars:plDollars,
                note:`orphan ${filledTag} flattened @ $${fills.FLATTEN} — round-trip P/L $${plDollars}` }));
            }
            log(`[fly] *** ORPHAN UNRESOLVED: ${filledTag} vertical OPEN, flatten limit left working DAY @ $${flatDebit} — CHECK IBKR NOW ***`);
            finish(resultBase({ ok:false, orphan_unresolved:true,
              note:`ORPHAN UNRESOLVED — ${filledTag} vertical open; flatten limit working DAY @ $${flatDebit}. Check IBKR.` }));
          }, 12000);
        }, 14000);
      }"""

# ---------------------------------------------------------------- anchor 2
OLD_WATCHDOG = """    // overall safety timeout
    setTimeout(() => finish({ ok:false, error:'overall timeout (40s) before fills confirmed' }), 40000);"""

NEW_WATCHDOG = """    // overall safety timeout — long enough to cover orphan chase + flatten (~62s worst case)
    setTimeout(() => finish({ ok:false, error:'overall timeout (90s) before resolution',
      fills: { CALL: fills.CALL ?? null, PUT: fills.PUT ?? null, FLATTEN: fills.FLATTEN ?? null } }), 90000);"""

def main():
    if not os.path.exists(FILE):
        sys.exit(f"ABORT: {FILE} not found — run from ~/ibkr-webhook")
    src = open(FILE, encoding="utf-8").read()

    if "resolveFills" in src:
        sys.exit("ABORT: file already contains resolveFills — patch appears applied.")

    for name, a in (("25s-timer-block", OLD_TIMER), ("40s-watchdog", OLD_WATCHDOG)):
        n = src.count(a)
        if n != 1:
            sys.exit(f"ABORT: anchor '{name}' found {n} times (expected 1). No changes made.")

    bak = f"{FILE}.bak.{int(time.time())}"
    shutil.copy2(FILE, bak)

    src = src.replace(OLD_TIMER, NEW_TIMER, 1)
    src = src.replace(OLD_WATCHDOG, NEW_WATCHDOG, 1)
    open(FILE, "w", encoding="utf-8").write(src)

    print(f"OK: patched {FILE}  (backup: {bak})")
    print("Verify:  node --check fly_exec.js && grep -n 'resolveFills\\|ORPHAN\\|90000' fly_exec.js")

if __name__ == "__main__":
    main()
