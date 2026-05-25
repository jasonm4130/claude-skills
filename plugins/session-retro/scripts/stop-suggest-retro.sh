#!/usr/bin/env bash
# Stop hook: aggregate events-{session_id}.jsonl, evaluate thresholds, emit
# additionalContext suggestion if retro-worthy AND no retro fired this session.
# Silent otherwise. Cost target <50ms per invocation.
set -euo pipefail

# Read hook stdin to extract session_id (Claude Code passes it in the payload,
# NOT as an env var). Fall back to env var (tests use that) then to "unknown".
INPUT=$(cat)
PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-/tmp/session-retro-data}"
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SESSION_ID" ] && SESSION_ID="${CLAUDE_SESSION_ID:-unknown}"
EVENTS="$PLUGIN_DATA/events-${SESSION_ID}.jsonl"
FIRED_FLAG="$PLUGIN_DATA/retro-fired-${SESSION_ID}.flag"

# No events recorded yet → no work to suggest a retro on
[ -f "$EVENTS" ] || exit 0
# Already retro'd this session → suppress
[ -f "$FIRED_FLAG" ] && exit 0

# `-R` reads raw lines (so bad JSON doesn't abort jq); `-s` slurps them.
# `fromjson?` returns empty (skip) on parse error. `select(. != null)` discards
# blank/whitespace-only lines after split. Robust to partial writes, mid-line
# truncation, future appender bugs.
AGG=$(jq -R -s '
    split("\n")
    | map(select(. != "") | fromjson?)
    | {
        edits: ([.[] | select(.tool == "Edit")] | length),
        writes: ([.[] | select(.tool == "Write")] | length),
        bash_calls: ([.[] | select(.tool == "Bash")] | length),
        files_touched: ([.[] | select(.tool == "Edit" or .tool == "Write") | .input.file_path // empty] | map(select(. != "")) | unique | length),
        first_ts: ([.[].ts] | min),
        last_ts: ([.[].ts] | max),
        ran_tests: ([.[] | select(.tool == "Bash") | .input.command // ""] | any(test("pytest|jest |go test|cargo test|npm test|npm run test|bun test|yarn test"))),
        ran_commit: ([.[] | select(.tool == "Bash") | .input.command // ""] | any(test("git commit")))
    }
' < "$EVENTS")

EDITS=$(echo "$AGG" | jq -r '.edits')
WRITES=$(echo "$AGG" | jq -r '.writes')
BASH_CALLS=$(echo "$AGG" | jq -r '.bash_calls')
FILES_COUNT=$(echo "$AGG" | jq -r '.files_touched')
RAN_TESTS=$(echo "$AGG" | jq -r '.ran_tests')
RAN_COMMIT=$(echo "$AGG" | jq -r '.ran_commit')
FIRST_TS=$(echo "$AGG" | jq -r '.first_ts // empty')
LAST_TS=$(echo "$AGG" | jq -r '.last_ts // empty')

# Compute duration in seconds — handle BSD (macOS) and GNU date
DURATION_SEC=0
if [ -n "$FIRST_TS" ] && [ -n "$LAST_TS" ]; then
    if date -u -d "$LAST_TS" +%s >/dev/null 2>&1; then
        FIRST_S=$(date -u -d "$FIRST_TS" +%s)
        LAST_S=$(date -u -d "$LAST_TS" +%s)
    else
        FIRST_S=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$FIRST_TS" +%s 2>/dev/null || echo 0)
        LAST_S=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$LAST_TS" +%s 2>/dev/null || echo 0)
    fi
    DURATION_SEC=$((LAST_S - FIRST_S))
fi
DURATION_MIN=$((DURATION_SEC / 60))
TOTAL_TOOLS=$((EDITS + WRITES + BASH_CALLS))
EDIT_WRITE=$((EDITS + WRITES))

# Threshold evaluation — collect ALL matching reasons, not just the first.
# More signal = stronger nudge. Conditions are independent; a 25-min session
# with 3 edits across 2 files reads better as "3 edits across 2 files + 25
# minutes of work" than as just one or the other.
REASONS=()
if [ "$EDIT_WRITE" -ge 3 ] && [ "$FILES_COUNT" -ge 2 ]; then
    REASONS+=("${EDIT_WRITE} edits across ${FILES_COUNT} files")
fi
if [ "$DURATION_SEC" -ge 1200 ]; then
    REASONS+=("${DURATION_MIN} minutes of work")
fi
if [ "$RAN_COMMIT" = "true" ]; then
    REASONS+=("committed during session")
fi
if [ "$RAN_TESTS" = "true" ] && [ "$EDIT_WRITE" -ge 2 ]; then
    # Only mention this if not already covered by the edits+files trigger
    if [ "$EDIT_WRITE" -lt 3 ] || [ "$FILES_COUNT" -lt 2 ]; then
        REASONS+=("ran tests + ${EDIT_WRITE} edits")
    fi
fi
if [ "$TOTAL_TOOLS" -ge 30 ]; then
    REASONS+=("${TOTAL_TOOLS} tool calls")
fi

[ "${#REASONS[@]}" -eq 0 ] && exit 0

# Join reasons with " + " (bash ${arr[*]} only uses IFS first char, so build manually)
TRIGGER_REASON="${REASONS[0]}"
for ((i = 1; i < ${#REASONS[@]}; i++)); do
    TRIGGER_REASON="${TRIGGER_REASON} + ${REASONS[i]}"
done

MSG="[session-retro] This session: ${TRIGGER_REASON}. Suggest running /retro to capture decisions/learnings before /clear."
# Stop hook output schema (validated by Claude Code) — does NOT support
# `hookSpecificOutput`; that's PreToolUse/UserPromptSubmit/PostToolUse only.
# Use `systemMessage` to surface a passive notice to the user without blocking.
jq -n --arg msg "$MSG" '{systemMessage: $msg}'
exit 0
