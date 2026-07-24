#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

TARGET="${1:-HEAD~1}"

echo "=================================================="
echo " TRADING SERVER ROLLBACK"
echo "=================================================="
echo
echo "Current commit:"
git --no-pager log -1 --oneline

echo
echo "Rollback target:"
git --no-pager log -1 --oneline "$TARGET"

"$PROJECT_DIR/scripts/backup.sh"

git reset --hard "$TARGET"

if [[ -f package-lock.json ]]; then
    npm ci
fi

for NAME in ibkr-webhook tradovate-webhook watchdog shadow-engine cvd-of; do
    if pm2 describe "$NAME" >/dev/null 2>&1; then
        pm2 restart "$NAME" --update-env
    fi
done

pm2 save >/dev/null
sleep 5

"$PROJECT_DIR/scripts/healthcheck.sh"

echo
echo "ROLLBACK COMPLETE"
