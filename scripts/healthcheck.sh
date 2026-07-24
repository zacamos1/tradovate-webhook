#!/usr/bin/env bash
set -u

REQUIRED_PROCESSES=(
  "ibkr-webhook"
  "tradovate-webhook"
  "watchdog"
  "shadow-engine"
  "cvd-of"
  "ngrok"
)

FAILED=0

echo "=================================================="
echo " TRADING SERVER HEALTH CHECK"
echo " $(date -Is)"
echo "=================================================="

echo
echo "PM2 processes:"
pm2 list

echo
echo "Required-process status:"

for NAME in "${REQUIRED_PROCESSES[@]}"; do
    STATUS="$(
        pm2 jlist 2>/dev/null |
        node -e '
            let input = "";
            process.stdin.on("data", d => input += d);
            process.stdin.on("end", () => {
                try {
                    const name = process.argv[1];
                    const processes = JSON.parse(input);
                    const match = processes.find(p => p.name === name);
                    process.stdout.write(
                        match ? String(match.pm2_env.status || "unknown") : "missing"
                    );
                } catch {
                    process.stdout.write("unknown");
                }
            });
        ' "$NAME"
    )"

    if [[ "$STATUS" == "online" ]]; then
        printf "  %-22s OK\n" "$NAME"
    else
        printf "  %-22s %s\n" "$NAME" "$STATUS"
        FAILED=1
    fi
done

echo
echo "Disk:"
df -h / | tail -n 1

echo
echo "Memory:"
free -h

echo
echo "Repository:"
printf "  Branch: "
git branch --show-current
printf "  Commit: "
git rev-parse --short HEAD
printf "  Status: "
if [[ -z "$(git status --porcelain)" ]]; then
    echo "clean"
else
    echo "changes present"
fi

echo
if [[ "$FAILED" -eq 0 ]]; then
    echo "HEALTH CHECK PASSED"
    exit 0
else
    echo "HEALTH CHECK FAILED"
    exit 1
fi
