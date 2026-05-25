#!/usr/bin/env bash
# Test: used_percentage=65, last-pct=60 → no flag written (below threshold), last-pct updated
set -euo pipefail
WORKDIR=$(mktemp -d); trap 'rm -rf "$WORKDIR"' EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/status-and-flag.sh"

SID="test-no-crossing"
printf "60" > "$WORKDIR/last-context-pct-${SID}.txt"

INPUT='{"session_id":"test-no-crossing","context_window":{"used_percentage":65}}'
echo "$INPUT" | bash "$SCRIPT" >/dev/null

# Flag should NOT exist
FLAG_FILE="$WORKDIR/handoff-nudge-${SID}.flag"
[ ! -f "$FLAG_FILE" ] || { echo "FAIL: flag should not be written below threshold"; exit 1; }

# last-pct updated to 65
LAST_PCT=$(cat "$WORKDIR/last-context-pct-${SID}.txt")
[ "$LAST_PCT" = "65" ] || { echo "FAIL: last-pct not updated, got: $LAST_PCT"; exit 1; }

echo "PASS"
