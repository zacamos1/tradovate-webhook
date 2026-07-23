# -*- coding: utf-8 -*-
path = "tradovate_webhook.js"
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

old_open = """  positions[key] = {
    symbol, direction, entryPrice, atrAtEntry,
    stopPrice: stop,
    armed:     false,
    peak:      entryPrice,
    trailLine: null,
    barsHeld:  0,
    signalTs,
    openTs:    Date.now(),
  };
  log('position_opened', { key, entryPrice, stopPrice: stop });"""

new_open = """  positions[key] = {
    symbol, direction, entryPrice, atrAtEntry,
    stopPrice: stop,
    armed:     false,
    peak:      entryPrice,
    trailLine: null,
    barsHeld:  0,
    signalTs,
    openTs:    Date.now(),
  };
  log('position_opened', { key, entryPrice, stopPrice: stop });
  ntfyPush(
    `ENTRY: ${symbol} ${direction.toUpperCase()}`,
    `Entry: ${entryPrice}\\nStop: ${stop.toFixed(2)}\\nATR: ${atrAtEntry.toFixed(2)}`,
    'default', 'chart_with_upwards_trend'
  );"""

if old_open not in content:
    print("ERROR: could not find openPosition's positions[key] block — aborting.")
    exit(1)
content = content.replace(old_open, new_open, 1)

with open(path, "w", encoding="utf-8") as f:
    f.write(content)

print("Step 2/3 done: entry alert hooked into openPosition().")
