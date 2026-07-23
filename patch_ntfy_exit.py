# -*- coding: utf-8 -*-
path = "tradovate_webhook.js"
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

old_close = """  const pnlPts = pos.direction === 'long'
    ? currentPrice - pos.entryPrice
    : pos.entryPrice - currentPrice;
  log('position_closed', {
    key, exitReason, entryPrice: pos.entryPrice,
    exitPrice: currentPrice, pnlPts: pnlPts.toFixed(2),
    armed: pos.armed, barsHeld: pos.barsHeld,
  });
  delete positions[key];"""

new_close = """  const pnlPts = pos.direction === 'long'
    ? currentPrice - pos.entryPrice
    : pos.entryPrice - currentPrice;
  log('position_closed', {
    key, exitReason, entryPrice: pos.entryPrice,
    exitPrice: currentPrice, pnlPts: pnlPts.toFixed(2),
    armed: pos.armed, barsHeld: pos.barsHeld,
  });
  const pnlIsWin = pnlPts > 0;
  ntfyPush(
    `${pnlIsWin ? 'WIN' : 'LOSS'}: ${pos.symbol} ${pos.direction.toUpperCase()} (${exitReason})`,
    `Entry: ${pos.entryPrice}\\nExit: ${currentPrice}\\nP&L: ${pnlPts.toFixed(2)} pts\\nBars held: ${pos.barsHeld}\\nArmed: ${pos.armed}`,
    pnlIsWin ? 'default' : 'high',
    pnlIsWin ? 'white_check_mark' : 'rotating_light'
  );
  delete positions[key];"""

if old_close not in content:
    print("ERROR: could not find closePosition's log/delete block — aborting.")
    exit(1)
content = content.replace(old_close, new_close, 1)

with open(path, "w", encoding="utf-8") as f:
    f.write(content)

print("Step 3/3 done: exit/fill alert hooked into closePosition().")
