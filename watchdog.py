#!/usr/bin/env python3
"""
watchdog.py - independent health monitor for the trading pipelines.
Does NOT touch any trading logic. Runs on its own pm2 process, checks
every 5 minutes, alerts via ntfy on silent failures (dead-man's-switch
style) rather than only on trade events.
"""
import json
import os
import re
import socket
import subprocess
import time
from datetime import datetime, timezone

from dotenv import load_dotenv
load_dotenv()

import requests

NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "")
CHECK_INTERVAL_SEC = 300  # 5 min
STATE_FILE = "watchdog_state.json"
COOLDOWN_SEC = 30 * 60  # don't re-alert same issue more than once per 30 min

FUTURES_LOG = "/root/.pm2/logs/vwap-sender-out.log"
FUTURES_STALE_AFTER_SEC = 8 * 60  # eval cycle is every 5 min, allow buffer

DIRECTIONAL_LOG = "/root/.pm2/logs/ibkr-webhook-out.log"
FLAP_WINDOW_SEC = 15 * 60
FLAP_THRESHOLD = 4  # more than 4 "connection dropped" in 15 min = flapping

IBGW_CONTAINER = "ibgw-ib-gateway-1"
IBGW_HOST = "127.0.0.1"
IBGW_PORT = 4002

EXPECTED_ONLINE = ["vwap-sender", "tradovate-webhook", "ibkr-webhook", "futures-webhook"]
RESTART_LOOP_THRESHOLD = 3  # more than 3 restarts in the check window = crash loop


def load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE) as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def save_state(state):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f)


def ntfy_push(title, body, priority="high", tags="rotating_light"):
    if not NTFY_TOPIC:
        print(f"[watchdog] NTFY_TOPIC not set, would have alerted: {title} - {body}")
        return
    try:
        requests.post(
            f"https://ntfy.sh/{NTFY_TOPIC}",
            data=body.encode("utf-8"),
            headers={"Title": title, "Priority": priority, "Tags": tags},
            timeout=10,
        )
    except Exception as e:
        print(f"[watchdog] ntfy push failed: {e}")


def should_alert(state, key):
    last = state.get(key, 0)
    return (time.time() - last) > COOLDOWN_SEC


def mark_alerted(state, key):
    state[key] = time.time()


def check_futures_sender(state):
    if not os.path.exists(FUTURES_LOG):
        return
    try:
        with open(FUTURES_LOG, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 5000))
            tail = f.read().decode(errors="ignore")
    except Exception as e:
        print(f"[watchdog] could not read futures log: {e}")
        return

    lines = [l for l in tail.splitlines() if l.strip()]
    if not lines:
        return

    last_ts = None
    for line in reversed(lines):
        m = re.search(r'"ts":\s*"([^"]+)"', line)
        if m:
            try:
                last_ts = datetime.fromisoformat(m.group(1).replace("Z", "+00:00"))
                break
            except Exception:
                continue

    if last_ts is None:
        return

    age = (datetime.now(timezone.utc) - last_ts).total_seconds()
    key = "futures_stale"
    if age > FUTURES_STALE_AFTER_SEC:
        if should_alert(state, key):
            ntfy_push(
                "Futures sender silent",
                f"No vwap-sender log activity in {int(age/60)} min (expected every ~5 min). Check pm2 logs vwap-sender.",
            )
            mark_alerted(state, key)
    else:
        state.pop(key, None)


AUTO_RESTART_MAX_PER_WINDOW = 2
AUTO_RESTART_WINDOW_SEC = 60 * 60  # 1 hour -- IBKR paper sessions appear to throttle after repeated rapid re-logins, so cap how often we self-heal


def try_auto_restart_ibgw(state, reason):
    """Auto-restart IB Gateway, but rate-limited -- more than AUTO_RESTART_MAX_PER_WINDOW
    restarts per AUTO_RESTART_WINDOW_SEC risks tripping IBKR's own session throttling
    (observed directly tonight: a restart that normally fixes things stopped working
    after ~6 restarts in a few hours, likely server-side rate limiting)."""
    now = time.time()
    history = state.get("restart_history", [])
    history = [t for t in history if now - t < AUTO_RESTART_WINDOW_SEC]

    if len(history) >= AUTO_RESTART_MAX_PER_WINDOW:
        key = "auto_restart_capped"
        if should_alert(state, key):
            ntfy_push(
                "Futures pipeline broken - auto-heal capped",
                f"{reason}. Already restarted IB Gateway {len(history)}x in the last hour -- "
                f"stopping auto-restarts to avoid IBKR session throttling. Manual check needed.",
            )
            mark_alerted(state, key)
        state["restart_history"] = history
        return False

    try:
        subprocess.run(["docker", "restart", IBGW_CONTAINER], capture_output=True, timeout=30)
        history.append(now)
        state["restart_history"] = history
        ntfy_push(
            "Auto-healing: restarted IB Gateway",
            f"{reason}. Restarted {IBGW_CONTAINER} automatically ({len(history)}/{AUTO_RESTART_MAX_PER_WINDOW} this hour). Will recheck next cycle.",
            priority="default",
            tags="wrench",
        )
        return True
    except Exception as e:
        ntfy_push("Auto-heal failed", f"Tried to restart {IBGW_CONTAINER} but the command itself failed: {e}")
        return False


def check_futures_pull_failures(state):
    """Detect the sender running (log lines still appearing) but every bar
    pull failing -- the earlier freshness check alone misses this, since
    evaluation_start/next_eval_in keep firing every cycle even when every
    pull inside that cycle errors out."""
    if not os.path.exists(FUTURES_LOG):
        return
    try:
        with open(FUTURES_LOG, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 8000))
            tail = f.read().decode(errors="ignore")
    except Exception as e:
        print(f"[watchdog] could not read futures log: {e}")
        return

    lines = [l for l in tail.splitlines() if l.strip()]
    recent = lines[-15:]
    pull_errors = sum(1 for l in recent if '"event": "ibkr_pull_error"' in l or '"event": "bars_unavailable"' in l)
    evals_done = sum(1 for l in recent if '"event": "evaluation_done"' in l)

    key = "futures_pulls_failing"
    if evals_done >= 2 and pull_errors >= 4:
        print(f"[watchdog] pull failures detected ({pull_errors} errors / {evals_done} cycles) -- attempting self-heal")
        try_auto_restart_ibgw(state, f"{pull_errors} IBKR pull errors across last {evals_done} futures eval cycles")
    else:
        state.pop(key, None)


def check_ibgw(state):
    key = "ibgw_down"
    try:
        result = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Status}}", IBGW_CONTAINER],
            capture_output=True, text=True, timeout=10,
        )
        status = result.stdout.strip()
    except Exception as e:
        status = f"ERROR: {e}"

    port_ok = False
    try:
        with socket.create_connection((IBGW_HOST, IBGW_PORT), timeout=5):
            port_ok = True
    except Exception:
        port_ok = False

    if status != "running" or not port_ok:
        if should_alert(state, key):
            ntfy_push(
                "IB Gateway problem",
                f"Container status: {status}, port {IBGW_PORT} reachable: {port_ok}. May need docker restart {IBGW_CONTAINER}.",
            )
            mark_alerted(state, key)
    else:
        state.pop(key, None)


def check_directional_flapping(state):
    if not os.path.exists(DIRECTIONAL_LOG):
        return
    try:
        with open(DIRECTIONAL_LOG, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 20000))
            tail = f.read().decode(errors="ignore")
    except Exception as e:
        print(f"[watchdog] could not read directional log: {e}")
        return

    now = datetime.now(timezone.utc)
    drop_count = 0
    for line in tail.splitlines():
        m = re.search(r'\[([\d\-T:.]+)Z\] TWS unavailable', line)
        if m:
            try:
                ts = datetime.fromisoformat(m.group(1)).replace(tzinfo=timezone.utc)
                if (now - ts).total_seconds() <= FLAP_WINDOW_SEC:
                    drop_count += 1
            except Exception:
                continue

    key = "directional_flapping"
    if drop_count > FLAP_THRESHOLD:
        if should_alert(state, key):
            ntfy_push(
                "Directional webhook flapping",
                f"{drop_count} TWS disconnects in the last {FLAP_WINDOW_SEC//60} min. Connection is unstable - check IB Gateway / ibkr-webhook.",
            )
            mark_alerted(state, key)
    else:
        state.pop(key, None)


def check_pm2_health(state):
    try:
        result = subprocess.run(["pm2", "jlist"], capture_output=True, text=True, timeout=15)
        procs = json.loads(result.stdout)
    except Exception as e:
        key = "pm2_unreachable"
        if should_alert(state, key):
            ntfy_push("Watchdog error", f"Could not query pm2: {e}")
            mark_alerted(state, key)
        return

    by_name = {p["name"]: p for p in procs}

    for name in EXPECTED_ONLINE:
        p = by_name.get(name)
        key = f"pm2_down_{name}"
        if p is None or p.get("pm2_env", {}).get("status") != "online":
            if should_alert(state, key):
                status = p.get("pm2_env", {}).get("status") if p else "MISSING"
                ntfy_push(
                    f"{name} not online",
                    f"pm2 status: {status}. Check pm2 status / pm2 logs {name}.",
                )
                mark_alerted(state, key)
        else:
            state.pop(key, None)

        # crash-loop detection via restart-count delta since last check
        restarts = p.get("pm2_env", {}).get("restart_time", 0) if p else 0
        prev_key = f"pm2_restarts_{name}"
        prev = state.get(prev_key, restarts)
        delta = restarts - prev
        state[prev_key] = restarts  # persisted regardless of cooldown, tracks continuously
        loop_key = f"pm2_crashloop_{name}"
        if delta >= RESTART_LOOP_THRESHOLD:
            if should_alert(state, loop_key):
                ntfy_push(
                    f"{name} crash-looping",
                    f"{delta} restarts since last check ({CHECK_INTERVAL_SEC//60} min ago). Check pm2 logs {name} --err.",
                )
                mark_alerted(state, loop_key)


def main():
    print(f"[watchdog] started, checking every {CHECK_INTERVAL_SEC//60} min")
    while True:
        state = load_state()
        try:
            check_futures_sender(state)
            check_futures_pull_failures(state)
            check_ibgw(state)
            check_directional_flapping(state)
            check_pm2_health(state)
        except Exception as e:
            print(f"[watchdog] error during checks: {e}")
        save_state(state)
        time.sleep(CHECK_INTERVAL_SEC)


if __name__ == "__main__":
    main()
