#!/usr/bin/env bash
# check-retro-flag.sh: when a nudge flag exists, it emits additionalContext JSON
# with the flag content embedded, then deletes the flag (fire-once).
set -euo pipefail
WORKDIR=$(mktemp -d); trap 'rm -rf "$WORKDIR"' EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
export CLAUDE_SESSION_ID="test-check-consume"
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/check-retro-flag.sh"

# Pre-create a nudge flag with known content
REASONS="3 edits across 2 files + 25 minutes of work"
FLAG="$WORKDIR/retro-nudge-test-check-consume.flag"
printf '%s' "$REASONS" > "$FLAG"

# Run the script; session_id passed via stdin (same as hook payload)
OUT=$(printf '{"session_id":"test-check-consume"}' | bash "$SCRIPT")

# Assert the output is valid JSON with the right envelope
[ -n "$OUT" ] || { echo "FAIL: expected non-empty output, got empty"; exit 1; }
HOOK_EVENT=$(echo "$OUT" | jq -r '.hookSpecificOutput.hookEventName')
[ "$HOOK_EVENT" = "UserPromptSubmit" ] || { echo "FAIL: hookEventName mismatch: $HOOK_EVENT"; exit 1; }
ADDITIONAL=$(echo "$OUT" | jq -r '.hookSpecificOutput.additionalContext')
echo "$ADDITIONAL" | grep -q "3 edits across 2 files" || { echo "FAIL: additionalContext missing reasons: $ADDITIONAL"; exit 1; }
echo "$ADDITIONAL" | grep -q "/retro" || { echo "FAIL: additionalContext missing '/retro': $ADDITIONAL"; exit 1; }

# Assert the flag has been consumed (deleted)
[ ! -f "$FLAG" ] || { echo "FAIL: nudge flag should have been deleted after consumption, but still exists"; exit 1; }

echo "PASS"
