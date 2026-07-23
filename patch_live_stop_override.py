path = "vwap_signal_sender.py"
with open(path, "r") as f:
    content = f.read()

# Step 1: fix STOP_MULT back to the group value (3.0 -> 7.0)
old_stop = "STOP_MULT       = 3.0"
if old_stop not in content:
    print("ERROR: could not find STOP_MULT=3.0 — aborting.")
    exit(1)
content = content.replace(old_stop, "STOP_MULT       = 7.0", 1)

# Step 2: add per-instrument override dicts right after TRAIL_POINTS/STOP_MULT
old_consts = "TRAIL_POINTS    = 0.75\nSTOP_MULT       = 7.0"
new_consts = """TRAIL_POINTS    = 0.75
STOP_MULT       = 7.0

# Per-instrument overrides (validated Jul 19 2026 — see memory)
STOP_MULT_OVERRIDE = {'MES': 6.0}
TRAIL_POINTS_OVERRIDE = {'MES': 0.25}

def get_stop_mult(symbol):
    return STOP_MULT_OVERRIDE.get(symbol, STOP_MULT)

def get_trail_points(symbol):
    return TRAIL_POINTS_OVERRIDE.get(symbol, TRAIL_POINTS)"""

if old_consts not in content:
    print("ERROR: could not find TRAIL_POINTS/STOP_MULT block — aborting.")
    exit(1)
content = content.replace(old_consts, new_consts, 1)

with open(path, "w") as f:
    f.write(content)

print("Step 1/2 applied: STOP_MULT fixed to 7.0, per-instrument override functions added.")
