#!/usr/bin/env bash
# PostToolUse hook: append one JSONL event to events-{session_id}.jsonl per
# tool use. Single jq fork, single atomic POSIX append (PIPE_BUF guarantee).
# Stop hook aggregates the events at evaluation time — see SKILL.md.
set -euo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
[ -z "$TOOL_NAME" ] && exit 0

# Claude Code passes session_id in the hook payload (stdin), NOT as an env var.
# Fall back to env var (for tests) then to "unknown" (last-resort, will collide
# across sessions but at least won't crash).
PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-/tmp/session-retro-data}"
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
[ -z "$SESSION_ID" ] && SESSION_ID="${CLAUDE_SESSION_ID:-unknown}"
mkdir -p "$PLUGIN_DATA"
EVENTS="$PLUGIN_DATA/events-${SESSION_ID}.jsonl"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Build a compact one-line JSON event (ts + tool + input verbatim) then append.
# `printf %s\n` is preferred over `echo` for arbitrary content. The shell's
# single `>>` redirect uses O_APPEND, which POSIX guarantees is atomic for
# writes smaller than PIPE_BUF (typically 4KB). One event line is ~50–600 bytes.
EVENT=$(printf '%s' "$INPUT" | jq -c --arg ts "$NOW" '{ts: $ts, tool: .tool_name, input: .tool_input}')
printf '%s\n' "$EVENT" >> "$EVENTS"
exit 0
