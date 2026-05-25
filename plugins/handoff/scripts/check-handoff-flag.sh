#!/usr/bin/env bash
# UserPromptSubmit handler — injects additionalContext if handoff flag is set.
# Reads JSON from stdin (.session_id). Consumes the flag (one-shot).
set -euo pipefail

# --- Parse session ID from stdin ---
INPUT=$(cat)

SID=""
if command -v jq >/dev/null 2>&1; then
    SID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
fi
if [ -z "$SID" ]; then
    SID="${CLAUDE_SESSION_ID:-unknown}"
fi

# --- Resolve data dir ---
DATA_DIR="${CLAUDE_PLUGIN_DATA:-/tmp/handoff-data}"
FLAG_FILE="${DATA_DIR}/handoff-nudge-${SID}.flag"

# No flag — exit silently
[ -f "$FLAG_FILE" ] || exit 0

# Read flag content
FLAG_CONTENT=$(cat "$FLAG_FILE")

# Delete flag (consume it)
rm -f "$FLAG_FILE"

# Emit additionalContext
CONTEXT="[handoff] ${FLAG_CONTENT}. Consider running /handoff to write a resume doc before /compact or /clear, or /compact if you want to keep the session going."

# Output JSON envelope (issue #53682 safe form)
printf '{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": %s}}\n' \
    "$(printf '%s' "$CONTEXT" | jq -Rs '.')"
