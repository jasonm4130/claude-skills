#!/usr/bin/env bash
# Test: pre-create flag, run check script, assert additionalContext output, flag deleted
set -euo pipefail
WORKDIR=$(mktemp -d); trap 'rm -rf "$WORKDIR"' EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/check-handoff-flag.sh"

SID="test-flag-consumes"
FLAG_FILE="$WORKDIR/handoff-nudge-${SID}.flag"
printf "context at 76%% (threshold 70%%)" > "$FLAG_FILE"

INPUT="{\"session_id\":\"${SID}\"}"
OUT=$(echo "$INPUT" | bash "$SCRIPT")

# Output should contain hookSpecificOutput
echo "$OUT" | jq -e '.hookSpecificOutput' >/dev/null || { echo "FAIL: no hookSpecificOutput in output: $OUT"; exit 1; }

# additionalContext should contain [handoff]
CONTEXT=$(echo "$OUT" | jq -r '.hookSpecificOutput.additionalContext')
echo "$CONTEXT" | grep -q "\[handoff\]" || { echo "FAIL: missing [handoff] in context: $CONTEXT"; exit 1; }
echo "$CONTEXT" | grep -q "76" || { echo "FAIL: missing percentage in context: $CONTEXT"; exit 1; }

# Flag should be deleted
[ ! -f "$FLAG_FILE" ] || { echo "FAIL: flag not deleted after consumption"; exit 1; }

echo "PASS"
