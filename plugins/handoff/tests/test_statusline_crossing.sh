#!/usr/bin/env bash
# Test: used_percentage=76, last-pct=60 → flag written, last-pct updated to 76
set -euo pipefail
WORKDIR=$(mktemp -d); trap 'rm -rf "$WORKDIR"' EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/status-and-flag.sh"

SID="test-crossing"
# Write previous percentage below threshold
printf "60" > "$WORKDIR/last-context-pct-${SID}.txt"

INPUT='{"session_id":"test-crossing","context_window":{"used_percentage":76}}'
OUT=$(echo "$INPUT" | bash "$SCRIPT")

# Flag should be written
FLAG_FILE="$WORKDIR/handoff-nudge-${SID}.flag"
[ -f "$FLAG_FILE" ] || { echo "FAIL: flag not written"; exit 1; }
FLAG_CONTENT=$(cat "$FLAG_FILE")
echo "$FLAG_CONTENT" | grep -q "76" || { echo "FAIL: flag missing percentage: $FLAG_CONTENT"; exit 1; }
echo "$FLAG_CONTENT" | grep -q "70" || { echo "FAIL: flag missing threshold: $FLAG_CONTENT"; exit 1; }

# last-pct should be updated to 76
LAST_PCT=$(cat "$WORKDIR/last-context-pct-${SID}.txt")
[ "$LAST_PCT" = "76" ] || { echo "FAIL: last-pct not updated, got: $LAST_PCT"; exit 1; }

# Output should be non-empty (status bar)
[ -n "$OUT" ] || { echo "FAIL: no output from status script"; exit 1; }

echo "PASS"
