#!/usr/bin/env bash
# PreCompact hook: always write a retro-nudge flag before context is compacted.
# No threshold, no flag check — context loss is a hard event regardless of
# prior state. PreCompact fires 1-2x per long session at most, so always
# writing the flag is fine UX. The flag is consumed by check-retro-flag.sh
# on the next UserPromptSubmit.
set -euo pipefail

# Read hook stdin to extract session_id. Fall back to env var then "unknown".
INPUT=$(cat)
PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-/tmp/session-retro-data}"
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SESSION_ID" ] && SESSION_ID="${CLAUDE_SESSION_ID:-unknown}"
NUDGE_FLAG="$PLUGIN_DATA/retro-nudge-${SESSION_ID}.flag"

# Write the reason to the nudge flag file.
printf '%s' "compact imminent" > "$NUDGE_FLAG"
exit 0
