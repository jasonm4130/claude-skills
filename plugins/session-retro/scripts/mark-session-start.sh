#!/usr/bin/env bash
# SessionStart hook: write timestamp pointer for retro skill.
set -euo pipefail
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | grep -o '"session_id":"[^"]*"' | cut -d'"' -f4)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-/tmp/session-retro-data}"
mkdir -p "$PLUGIN_DATA"
echo "$TIMESTAMP" > "$PLUGIN_DATA/session-start-${SESSION_ID}.txt"
exit 0
