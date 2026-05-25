#!/usr/bin/env bash
# UserPromptSubmit hook: check for a retro-nudge flag and, if present,
# inject additionalContext so the agent surfaces the suggestion in its own voice.
# Deletes the flag after consuming it (fire-once-per-set).
set -euo pipefail

# Read hook stdin to extract session_id. Fall back to env var then "unknown".
INPUT=$(cat)
PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-/tmp/session-retro-data}"
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SESSION_ID" ] && SESSION_ID="${CLAUDE_SESSION_ID:-unknown}"
NUDGE_FLAG="$PLUGIN_DATA/retro-nudge-${SESSION_ID}.flag"

# No flag → nothing to do
[ -f "$NUDGE_FLAG" ] || exit 0

# Read the trigger reasons from the flag
REASONS=$(cat "$NUDGE_FLAG")

# Delete the flag before emitting (fire-once)
rm -f "$NUDGE_FLAG"

# Emit additionalContext using the full hookSpecificOutput envelope (avoids
# issue #53682 silent-drop bug).
jq -n --arg reasons "$REASONS" '{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": ("[session-retro] This session: " + $reasons + ". Consider running /retro to capture decisions/learnings before /clear.")
  }
}'
exit 0
