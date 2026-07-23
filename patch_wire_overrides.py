path = "tradovate_webhook.js"
with open(path, "r") as f:
    content = f.read()

# Fix openPosition() to use getStopMult(symbol)
old_open = """  const stop = direction === 'long'
    ? entryPrice - STOP_MULT * atrAtEntry
    : entryPrice + STOP_MULT * atrAtEntry;"""
new_open = """  const stopMult = getStopMult(symbol);
  const stop = direction === 'long'
    ? entryPrice - stopMult * atrAtEntry
    : entryPrice + stopMult * atrAtEntry;"""

if old_open not in content:
    print("ERROR: could not find openPosition's stop calculation — aborting.")
    exit(1)
content = content.replace(old_open, new_open, 1)

# Fix checkPositions() trail lines to use getTrailPoints(pos.symbol)
old_trail_long = "            pos.trailLine = pos.peak - TRAIL_POINTS;"
new_trail_long = "            pos.trailLine = pos.peak - getTrailPoints(pos.symbol);"
if old_trail_long not in content:
    print("ERROR: could not find LONG trail line — aborting.")
    exit(1)
content = content.replace(old_trail_long, new_trail_long, 1)

old_trail_short = "            pos.trailLine = pos.peak + TRAIL_POINTS;"
new_trail_short = "            pos.trailLine = pos.peak + getTrailPoints(pos.symbol);"
if old_trail_short not in content:
    print("ERROR: could not find SHORT trail line — aborting.")
    exit(1)
content = content.replace(old_trail_short, new_trail_short, 1)

with open(path, "w") as f:
    f.write(content)

print("Patch applied — openPosition() and checkPositions() now use per-instrument overrides.")
