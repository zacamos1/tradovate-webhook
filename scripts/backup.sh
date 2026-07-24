#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAPSHOT_DIR="${HOME}/server-snapshots"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUTPUT="${SNAPSHOT_DIR}/trading-server-${STAMP}.tar.gz"

mkdir -p "$SNAPSHOT_DIR"

echo "Creating snapshot:"
echo "  $OUTPUT"

tar \
  --exclude="./.git" \
  --exclude="./node_modules" \
  --exclude="./logs" \
  --exclude="./backups" \
  --exclude="./__pycache__" \
  -czf "$OUTPUT" \
  -C "$PROJECT_DIR" .

echo "Snapshot complete:"
ls -lh "$OUTPUT"
