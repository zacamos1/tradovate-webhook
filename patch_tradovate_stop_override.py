path = "tradovate_webhook.js"
with open(path, "r") as f:
    content = f.read()

old = "const ARM_POINTS   = 1.0;\nconst TRAIL_POINTS = 0.75;\nconst STOP_MULT    = 3.0;"
new = """const ARM_POINTS   = 1.0;
const TRAIL_POINTS = 0.75;
const STOP_MULT    = 7.0;

// Per-instrument overrides (validated Jul 19 2026 — see memory)
const STOP_MULT_OVERRIDE = { MES: 6.0 };
const TRAIL_POINTS_OVERRIDE = { MES: 0.25 };

function getStopMult(symbol) {
  const root = symbol.slice(0, 3);
  return STOP_MULT_OVERRIDE[root] ?? STOP_MULT;
}

function getTrailPoints(symbol) {
  const root = symbol.slice(0, 3);
  return TRAIL_POINTS_OVERRIDE[root] ?? TRAIL_POINTS;
}"""

if old not in content:
    print("ERROR: could not find the exact ARM_POINTS/TRAIL_POINTS/STOP_MULT block — aborting.")
    exit(1)
content = content.replace(old, new, 1)

with open(path, "w") as f:
    f.write(content)

print("Patch applied successfully.")
