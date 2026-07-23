path = "watchdog.py"
with open(path, "r") as f:
    content = f.read()

old_func = '''def check_futures_pull_failures(state):
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
    # look at the last 2 full evaluation cycles worth of lines (roughly last ~12 lines)
    recent = lines[-15:]
    pull_errors = sum(1 for l in recent if '"event": "ibkr_pull_error"' in l or '"event": "bars_unavailable"' in l)
    evals_done = sum(1 for l in recent if '"event": "evaluation_done"' in l)

    key = "futures_pulls_failing"
    # 2 full evaluation_done cycles with pull errors present = consistently broken, not a blip
    if evals_done >= 2 and pull_errors >= 4:
        if should_alert(state, key):
            ntfy_push(
                "Futures sender: bars failing every cycle",
                f"{pull_errors} pull errors across last {evals_done} eval cycles. Sender is running but IB Gateway pulls are failing -- likely needs docker restart {IBGW_CONTAINER}.",
            )
            mark_alerted(state, key)
    else:
        state.pop(key, None)'''

new_func = '''AUTO_RESTART_MAX_PER_WINDOW = 2
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
                "Futures pipeline broken — auto-heal capped",
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
        state.pop(key, None)'''

if old_func not in content:
    print("ERROR: could not find check_futures_pull_failures block — aborting.")
else:
    content = content.replace(old_func, new_func, 1)
    with open(path, "w") as f:
        f.write(content)
    print("Patched successfully: self-healing auto-restart added with rate limiting.")
