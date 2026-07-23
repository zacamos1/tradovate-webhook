#!/usr/bin/env python3
"""
patch_ntfy_directional.py

Adds ntfy push notifications to server.js for directional trade events:
  - Entry fill (buy confirmed)
  - Position armed (+10% threshold hit)
  - Trail exit (winner closed)
  - Timestop exit (dead signal closed)
  - EOD flatten

Also edits crontab to:
  - Remove the two fly health_digest lines (morning + eod)
  - Remove the duplicate fly-autotest restart lines
  - Keep fly-autotest pm2 process stopped (already done)

Usage (trading VPS, ~/ibkr-webhook, market closed):
    python3 patch_ntfy_directional.py
    node --check server.js
    pm2 restart ibkr-webhook
"""
import shutil, subprocess, sys, re
from datetime import datetime

SERVER = "server.js"

# Read NTFY_TOPIC from health_digest.js so we use the same topic
with open("health_digest.js") as f:
    hd = f.read()
m = re.search(r"NTFY_TOPIC\s*=\s*process\.env\.NTFY_TOPIC\s*\|\|\s*'([^']+)'", hd)
TOPIC_FALLBACK = m.group(1) if m else 'zac-trading'
print(f"ntfy topic fallback: {TOPIC_FALLBACK}")

# The ntfy helper to inject near the top of server.js
# Uses the same curl approach as health_digest.js
NTFY_HELPER = f"""
// ── ntfy push notifications for directional trades ──────────────────
const {{ execSync: _ntfyExec }} = require('child_process');
const _NTFY_TOPIC = process.env.NTFY_TOPIC || '{TOPIC_FALLBACK}';
function ntfyPush(title, body, priority = 'default', tags = 'chart_with_upwards_trend') {{
  try {{
    const safe = body.replace(/"/g, "'").replace(/\\n/g, ' ');
    _ntfyExec(
      `curl -s -H "Title: ${{title}}" -H "Priority: ${{priority}}" -H "Tags: ${{tags}}" ` +
      `-d "${{safe}}" https://ntfy.sh/${{_NTFY_TOPIC}}`,
      {{ timeout: 8000 }}
    );
  }} catch (e) {{ log('ntfy push failed: ' + e.message); }}
}}
// ─────────────────────────────────────────────────────────────────────
"""

EDITS = [
    # 1. Inject ntfy helper after the existing requires at the top
    (
        "let ib, connected = false, orderId = 1;",
        NTFY_HELPER + "let ib, connected = false, orderId = 1;",
    ),
    # 2. Entry fill notification — after the "Fill @ $X" log line
    (
        "    log(`Fill @ $${fillPrice} → TP:$${tpPrice} SL:$${slPrice}`);",
        "    log(`Fill @ $${fillPrice} → TP:$${tpPrice} SL:$${slPrice}`);\n"
        "    ntfyPush(`⚡ Entry: ${con.symbol} ${con.right}`, "
        "`$${fillPrice} × ${qty} | TP $${tpPrice} SL $${slPrice}`, 'default', 'money_with_wings');",
    ),
    # 3. Arm notification — after p.armed = true (premium arm path)
    (
        "      p.armed = true;\n"
        "    if (!p.armed) return;",
        "      p.armed = true;\n"
        "      ntfyPush(`🎯 ARMED: ${posKey}`, "
        "`bid $${price.toFixed(2)} | entry $${p.fillPrice} | +${gainPct.toFixed(0)}%`, 'high', 'dart');\n"
        "    if (!p.armed) return;",
    ),
    # 4. Trail exit notification
    (
        "      log(`Trail HIT ${posKey}: $${price} <= trail $${trailLine.toFixed(2)} (peak $${p.peak}) — closing`);",
        "      log(`Trail HIT ${posKey}: $${price} <= trail $${trailLine.toFixed(2)} (peak $${p.peak}) — closing`);\n"
        "      const _trailPnlPct = p.fillPrice ? (((price - p.fillPrice) / p.fillPrice) * 100).toFixed(0) : '?';\n"
        "      ntfyPush(`✅ TRAIL EXIT: ${posKey}`, "
        "`exit $${price.toFixed(2)} | peak $${p.peak} | ${_trailPnlPct}% | entry $${p.fillPrice}`, "
        "'high', 'white_check_mark');",
    ),
    # 5. Timestop exit notification
    (
        "      log(`Time-stop HIT ${posKey}: un-armed after ${minsOpen.toFixed(1)}min — closing at market`);",
        "      log(`Time-stop HIT ${posKey}: un-armed after ${minsOpen.toFixed(1)}min — closing at market`);\n"
        "      ntfyPush(`⏱ TIMESTOP: ${posKey}`, "
        "`${minsOpen.toFixed(1)}min un-armed | entry $${p.fillPrice}`, 'low', 'stopwatch');",
    ),
]


def fix_crontab():
    """Remove fly digest lines and deduplicate fly-autotest restart."""
    result = subprocess.run(['crontab', '-l'], capture_output=True, text=True)
    if result.returncode != 0:
        print("No crontab or error reading it — skipping crontab edit.")
        return

    lines = result.stdout.splitlines()
    new_lines = []
    removed = []
    seen = set()

    for line in lines:
        # Remove fly health_digest lines
        if 'health_digest.js' in line:
            removed.append(line)
            continue
        # Deduplicate fly-autotest restart (keep first occurrence only)
        if 'fly-autotest' in line and 'pm2 restart' in line:
            if line in seen:
                removed.append(f"(duplicate) {line}")
                continue
            seen.add(line)
        new_lines.append(line)

    new_crontab = '\n'.join(new_lines) + '\n'
    proc = subprocess.run(['crontab', '-'], input=new_crontab, text=True)
    if proc.returncode == 0:
        print(f"Crontab updated. Removed {len(removed)} lines:")
        for r in removed:
            print(f"  - {r}")
    else:
        print("Crontab update failed.")


def main():
    with open(SERVER) as f:
        src = f.read()

    # Verify anchors
    for i, (old, _new) in enumerate(EDITS, 1):
        count = src.count(old)
        if count != 1:
            print(f"ABORT: edit {i} anchor found {count} times (expected 1).")
            print(f"Anchor: {old[:80]}...")
            sys.exit(1)

    backup = f"server.js.bak.{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    shutil.copy2(SERVER, backup)
    print(f"Backup: {backup}")

    for i, (old, new) in enumerate(EDITS, 1):
        src = src.replace(old, new)
        print(f"Edit {i}/{len(EDITS)} applied.")

    with open(SERVER, 'w') as f:
        f.write(src)

    result = subprocess.run(['node', '--check', SERVER], capture_output=True, text=True)
    if result.returncode != 0:
        print("SYNTAX FAILED — restoring backup:")
        print(result.stderr)
        shutil.copy2(backup, SERVER)
        sys.exit(1)

    print("Syntax OK.")
    fix_crontab()
    print("\nDone. Run: pm2 restart ibkr-webhook")
    print("\nWhat you'll see on ntfy:")
    print("  ⚡ Entry: QQQ C  — $1.40 × 1 | TP $2.80 SL $0.14")
    print("  🎯 ARMED: QQQ_C_695_20260721  — bid $1.56 | entry $1.40 | +11%")
    print("  ✅ TRAIL EXIT: QQQ_C_695_20260721  — exit $2.10 | peak $2.50 | +50% | entry $1.40")
    print("  ⏱ TIMESTOP: AAPL_P_330_20260722  — 15.0min un-armed | entry $3.90")


if __name__ == '__main__':
    main()
