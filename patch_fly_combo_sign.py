#!/usr/bin/env python3
"""
Patch fly_exec.js — fix the 201 'riskless combination' rejection (root cause).

IB combo semantics: leg actions execute AS DEFINED on a BUY order; a SELL order
REVERSES every leg. Our legs are defined SELL-short/BUY-long (correct credit
vertical), but we were placing SELL orders at +credit — which reversed the legs
into a long spread (value >= 0) while collecting a credit: guaranteed profit,
hence IBKR's 'riskless combination' 201 on every attempt ever made (fly_exec
AND fly_place_paper_v2 share the construction).

Fix (documented IB convention for credit combos):
  - ENTRY:   BUY the combo at lmtPrice = -credit  (pay -X = receive X)
  - FLATTEN: SELL the combo at lmtPrice = -debit  (receive -X = pay X)
  - record fills as Math.abs(avgFillPrice) since combo fills report negative

Backs up to fly_exec.js.bak.<timestamp>. Aborts with NO changes unless every
anchor matches exactly once. Run from ~/ibkr-webhook:  python3 patch_fly_combo_sign.py
"""
import sys, time, shutil, os

FILE = "fly_exec.js"

# ---- edit 1: entry/chase order — BUY at negative price ----------------------
OLD_MK = """      const mkOrder = (credit) => ({
        action: OrderAction.SELL, orderType: OrderType.LMT, totalQuantity: contracts,
        lmtPrice: credit, account, transmit: true, tif: 'DAY',
      });"""

NEW_MK = """      // IB combo semantics: legs execute AS DEFINED on a BUY order (SELL reverses
      // them). Enter the credit vertical as BUY @ negative price = receive credit.
      // (SELL @ +credit reversed the legs -> 'riskless combination' 201.)
      const mkOrder = (credit) => ({
        action: OrderAction.BUY, orderType: OrderType.LMT, totalQuantity: contracts,
        lmtPrice: -Math.abs(credit), account, transmit: true, tif: 'DAY',
      });"""

# ---- edit 2: flatten order — SELL at negative price (pay the debit) ---------
OLD_FLAT = """          setTimeout(() => {
            ib.placeOrder(flatId, flatCombo, {
              action: OrderAction.BUY, orderType: OrderType.LMT, totalQuantity: contracts,
              lmtPrice: flatDebit, account, transmit: true, tif: 'DAY',
            });
          }, 1500);"""

NEW_FLAT = """          setTimeout(() => {
            // closing = SELL the combo (reverses legs back); paying a debit =
            // negative price on the SELL side, mirroring the entry convention.
            ib.placeOrder(flatId, flatCombo, {
              action: OrderAction.SELL, orderType: OrderType.LMT, totalQuantity: contracts,
              lmtPrice: -Math.abs(flatDebit), account, transmit: true, tif: 'DAY',
            });
          }, 1500);"""

# ---- edit 3: fills come back with negative prices — record magnitude --------
OLD_FILL = """      if (status === 'Filled' && fills[which] == null) {
        fills[which] = avgFillPrice;"""

NEW_FILL = """      if (status === 'Filled' && fills[which] == null) {
        fills[which] = Math.abs(avgFillPrice);   // combo fills report negative for credit structures"""

def main():
    if not os.path.exists(FILE):
        sys.exit(f"ABORT: {FILE} not found — run from ~/ibkr-webhook")
    src = open(FILE, encoding="utf-8").read()

    if "riskless combination' 201" in src or "lmtPrice: -Math.abs(credit)" in src:
        sys.exit("ABORT: combo-sign patch appears already applied.")

    for name, a in (("mkOrder", OLD_MK), ("flatten", OLD_FLAT), ("fill-record", OLD_FILL)):
        n = src.count(a)
        if n != 1:
            sys.exit(f"ABORT: anchor '{name}' found {n} times (expected 1). No changes made.")

    bak = f"{FILE}.bak.{int(time.time())}"
    shutil.copy2(FILE, bak)
    src = src.replace(OLD_MK, NEW_MK, 1)
    src = src.replace(OLD_FLAT, NEW_FLAT, 1)
    src = src.replace(OLD_FILL, NEW_FILL, 1)
    open(FILE, "w", encoding="utf-8").write(src)

    print(f"OK: patched {FILE}  (backup: {bak})")
    print("Verify:  node --check fly_exec.js && grep -n 'Math.abs' fly_exec.js")
    print("Then:    pm2 restart ibkr-webhook   and re-run the same curl")

if __name__ == "__main__":
    main()
