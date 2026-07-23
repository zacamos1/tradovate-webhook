path = "watchdog.py"
with open(path, "r") as f:
    content = f.read()

old = '''def check_ibgw(state):'''

new = '''def check_futures_pull_failures(state):
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
        state.pop(key, None)


def check_ibgw(state):'''

if old not in content:
    print("ERROR: could not find check_ibgw function marker — aborting.")
else:
    content = content.replace(old, new, 1)
    # also call it from main()
    old_main = """            check_futures_sender(state)
            check_ibgw(state)"""
    new_main = """            check_futures_sender(state)
            check_futures_pull_failures(state)
            check_ibgw(state)"""
    if old_main not in content:
        print("ERROR: could not find main() check-call block — aborting.")
    else:
        content = content.replace(old_main, new_main, 1)
        with open(path, "w") as f:
            f.write(content)
        print("Patched successfully: added check_futures_pull_failures, wired into main().")
