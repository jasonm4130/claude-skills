#!/usr/bin/env bash
# statusLine command — renders context-fill bar, writes flag on first crossing.
# Reads JSON from stdin (context_window.used_percentage, session_id).
# Outputs a single line of status text to stdout.
set -euo pipefail

# --- Parse stdin ---
INPUT=$(cat)

# Graceful degradation: if jq missing or JSON malformed, output ? and exit.
if ! command -v jq >/dev/null 2>&1; then
    echo "?"
    exit 0
fi

CURRENT_PCT=$(echo "$INPUT" | jq -e '.context_window.used_percentage // empty' 2>/dev/null) || {
    echo "?"
    exit 0
}

# Validate it's a number
if ! echo "$CURRENT_PCT" | grep -qE '^[0-9]+(\.[0-9]+)?$'; then
    echo "?"
    exit 0
fi

SID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
if [ -z "$SID" ]; then
    SID="${CLAUDE_SESSION_ID:-unknown}"
fi

# --- Resolve data dir ---
DATA_DIR="${CLAUDE_PLUGIN_DATA:-/tmp/handoff-data}"
mkdir -p "$DATA_DIR"

LAST_PCT_FILE="${DATA_DIR}/last-context-pct-${SID}.txt"
THRESHOLD="${HANDOFF_THRESHOLD_PCT:-70}"

# Read last percentage (default 0 if missing)
LAST_PCT=0
if [ -f "$LAST_PCT_FILE" ]; then
    LAST_PCT=$(cat "$LAST_PCT_FILE" 2>/dev/null || echo "0")
    # Ensure it's a valid number
    if ! echo "$LAST_PCT" | grep -qE '^[0-9]+(\.[0-9]+)?$'; then
        LAST_PCT=0
    fi
fi

# --- First-crossing detection ---
# Integer comparison: use awk for float-safe comparison
CROSSED=$(awk -v cur="$CURRENT_PCT" -v last="$LAST_PCT" -v thr="$THRESHOLD" \
    'BEGIN { print (cur >= thr && last < thr) ? "yes" : "no" }')

if [ "$CROSSED" = "yes" ]; then
    FLAG_FILE="${DATA_DIR}/handoff-nudge-${SID}.flag"
    printf "context at %s%% (threshold %s%%)" "$CURRENT_PCT" "$THRESHOLD" > "$FLAG_FILE"
fi

# Always update last percentage
printf "%s" "$CURRENT_PCT" > "$LAST_PCT_FILE"

# --- Render status bar ---
# 10-char block bar. Filled blocks = floor(pct/10), rest empty.
PCT_INT=$(awk -v p="$CURRENT_PCT" 'BEGIN { printf "%d", int(p) }')
FILLED=$(awk -v p="$PCT_INT" 'BEGIN { n=int(p/10); print (n>10)?10:n }')
EMPTY=$((10 - FILLED))

BAR=""
for ((i=0; i<FILLED; i++)); do BAR="${BAR}█"; done
for ((i=0; i<EMPTY; i++)); do BAR="${BAR}░"; done

# ANSI color: green <50, yellow 50-69, red >=70
if [ "$PCT_INT" -ge 70 ]; then
    COLOR="\033[0;31m"   # red
elif [ "$PCT_INT" -ge 50 ]; then
    COLOR="\033[0;33m"   # yellow
else
    COLOR="\033[0;32m"   # green
fi
RESET="\033[0m"

printf "${COLOR}[${BAR}] ${PCT_INT}%%${RESET}\n"
