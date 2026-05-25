#!/usr/bin/env bash
# Test: .pending references nonexistent file → .pending deleted, no output
set -euo pipefail
WORKDIR=$(mktemp -d); trap 'rm -rf "$WORKDIR"' EXIT
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/load-pending-handoff.sh"

PROJECT_DIR="$WORKDIR/project"
mkdir -p "$PROJECT_DIR/.claude/handoffs"

PENDING_FILE="$PROJECT_DIR/.claude/handoffs/.pending"
# Point to a file that doesn't exist
printf "nonexistent-handoff.md" > "$PENDING_FILE"

INPUT="{\"cwd\":\"${PROJECT_DIR}\"}"
OUT=$(echo "$INPUT" | bash "$SCRIPT")

# .pending should be deleted
[ ! -f "$PENDING_FILE" ] || { echo "FAIL: .pending not deleted when file missing"; exit 1; }

# Output should be empty
[ -z "$OUT" ] || { echo "FAIL: expected empty output for missing file, got: $OUT"; exit 1; }

echo "PASS"
