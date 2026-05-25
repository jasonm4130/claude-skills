#!/usr/bin/env bash
# SessionStart handler — auto-loads pending handoff from previous session.
# Reads JSON from stdin (.cwd). Consumes .pending (one-shot, 24h staleness).
set -euo pipefail

# --- Parse cwd from stdin ---
INPUT=$(cat)

CWD=""
if command -v jq >/dev/null 2>&1; then
    CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null || true)
fi
if [ -z "$CWD" ]; then
    CWD="${PWD:-}"
fi

PENDING_FILE="${CWD}/.claude/handoffs/.pending"

# No pending file — exit silently
[ -f "$PENDING_FILE" ] || exit 0

# Stale check: if file is older than 24h (1440 minutes), delete and exit
if find "$PENDING_FILE" -mmin +1440 2>/dev/null | grep -q .; then
    rm -f "$PENDING_FILE"
    exit 0
fi

# Read the filename stored in .pending (basename only)
HANDOFF_FILENAME=$(cat "$PENDING_FILE" | tr -d '[:space:]')
if [ -z "$HANDOFF_FILENAME" ]; then
    rm -f "$PENDING_FILE"
    exit 0
fi

# Build full path
HANDOFF_PATH="${CWD}/.claude/handoffs/${HANDOFF_FILENAME}"

# Referenced file missing — clean up and exit silently
if [ ! -f "$HANDOFF_PATH" ]; then
    rm -f "$PENDING_FILE"
    exit 0
fi

# Read handoff content
HANDOFF_CONTENT=$(cat "$HANDOFF_PATH")

# Delete .pending (one-shot)
rm -f "$PENDING_FILE"

# Emit additionalContext
CONTEXT="[handoff] Loading pending handoff from previous session:\n\n${HANDOFF_CONTENT}"

printf '{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": %s}}\n' \
    "$(printf '%s' "$CONTEXT" | jq -Rs '.')"
