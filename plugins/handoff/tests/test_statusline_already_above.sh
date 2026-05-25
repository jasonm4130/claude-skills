#!/usr/bin/env bash
# Test: used_percentage=78, last-pct=76 → no flag (already above threshold last turn), last-pct updated
set -euo pipefail
WORKDIR=$(mktemp -d); trap 'rm -rf "$WORKDIR"' EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/status-and-flag.sh"

SID="test-already-above"
# Previous pct already above threshold
printf "76" > "$WORKDIR/last-context-pct-${SID}.txt"

INPUT='{"session_id":"test-already-above","context_window":{"used_percentage":78}}'
echo "$INPUT" | bash "$SCRIPT" >/dev/null

# Flag should NOT be written (not a new crossing)
FLAG_FILE="$WORKDIR/handoff-nudge-${SID}.flag"
[ ! -f "$FLAG_FILE" ] || { echo "FAIL: flag should not be written when already above threshold"; exit 1; }

# last-pct updated to 78
LAST_PCT=$(cat "$WORKDIR/last-context-pct-${SID}.txt")
[ "$LAST_PCT" = "78" ] || { echo "FAIL: last-pct not updated, got: $LAST_PCT"; exit 1; }

echo "PASS"
