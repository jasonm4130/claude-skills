#!/usr/bin/env bash
# Test: .pending with mtime >24h old → .pending deleted, no output
set -euo pipefail
WORKDIR=$(mktemp -d); trap 'rm -rf "$WORKDIR"' EXIT
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/load-pending-handoff.sh"

PROJECT_DIR="$WORKDIR/project"
mkdir -p "$PROJECT_DIR/.claude/handoffs"

PENDING_FILE="$PROJECT_DIR/.claude/handoffs/.pending"
printf "2026-05-24T10-00-00-auto.md" > "$PENDING_FILE"

# Set mtime to >24h ago (use touch -t: 2 days ago)
# macOS touch -t format: [[CC]YY]MMDDhhmm[.SS]
TWO_DAYS_AGO=$(date -v-2d +%Y%m%d%H%M 2>/dev/null || date -d '2 days ago' +%Y%m%d%H%M 2>/dev/null)
touch -t "${TWO_DAYS_AGO}" "$PENDING_FILE"

INPUT="{\"cwd\":\"${PROJECT_DIR}\"}"
OUT=$(echo "$INPUT" | bash "$SCRIPT")

# .pending should be deleted
[ ! -f "$PENDING_FILE" ] || { echo "FAIL: stale .pending not deleted"; exit 1; }

# Output should be empty
[ -z "$OUT" ] || { echo "FAIL: expected empty output for stale .pending, got: $OUT"; exit 1; }

echo "PASS"
