#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAPSHOT_DIR="${HOME}/server-snapshots"

echo "Removing Python cache files..."
find "$PROJECT_DIR" \
  -path "$PROJECT_DIR/node_modules" -prune -o \
  -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true

find "$PROJECT_DIR" \
  -path "$PROJECT_DIR/node_modules" -prune -o \
  -type f \( -name "*.pyc" -o -name "*.pyo" \) -delete 2>/dev/null || true

echo "Removing snapshots older than 30 days..."
if [[ -d "$SNAPSHOT_DIR" ]]; then
    find "$SNAPSHOT_DIR" \
      -type f \
      -name "trading-server-*.tar.gz" \
      -mtime +30 \
      -delete
fi

echo "Running PM2 log rotation flush check..."
pm2 flush >/dev/null 2>&1 || true

echo "Cleanup complete."
