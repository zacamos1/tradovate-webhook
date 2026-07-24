#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

PROCESSES=(
  "ibkr-webhook"
  "tradovate-webhook"
  "watchdog"
  "shadow-engine"
  "cvd-of"
)

echo "=================================================="
echo " TRADING SERVER DEPLOYMENT"
echo " $(date -Is)"
echo "=================================================="

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    echo
    echo "DEPLOYMENT STOPPED"
    echo "Tracked local changes are present:"
    git status --short
    echo
    echo "Commit, stash, or discard those changes before deploying."
    exit 1
fi

OLD_COMMIT="$(git rev-parse HEAD)"
echo "Current commit: $(git rev-parse --short HEAD)"

"$PROJECT_DIR/scripts/backup.sh"

echo
echo "Fetching GitHub updates..."
git fetch origin main

echo "Updating with fast-forward only..."
git pull --ff-only origin main

NEW_COMMIT="$(git rev-parse HEAD)"
echo "Deployed commit: $(git rev-parse --short HEAD)"

if [[ -f package-lock.json ]]; then
    if git diff --name-only "$OLD_COMMIT" "$NEW_COMMIT" | grep -Eq '^package(-lock)?\.json$'; then
        echo
        echo "Node dependencies changed; running npm ci..."
        npm ci
    fi
fi

echo
echo "Restarting managed services..."

for NAME in "${PROCESSES[@]}"; do
    if pm2 describe "$NAME" >/dev/null 2>&1; then
        echo "Restarting $NAME"
        pm2 restart "$NAME" --update-env
    else
        echo "Skipping $NAME — not registered in PM2"
    fi
done

pm2 save >/dev/null

echo
echo "Waiting for services..."
sleep 5

"$PROJECT_DIR/scripts/healthcheck.sh"

echo
echo "DEPLOYMENT COMPLETE"
