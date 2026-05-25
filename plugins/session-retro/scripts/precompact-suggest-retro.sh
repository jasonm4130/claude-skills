#!/usr/bin/env bash
# PreCompact hook: always nudge user to run /retro before context is compacted.
# No threshold, no flag check — context loss is a hard event regardless of
# prior state. PreCompact fires 1-2x per long session at most, so always
# suggesting is fine UX.
set -euo pipefail

# Drain hook stdin (we don't read its contents)
cat >/dev/null

MSG="[session-retro] Context is about to compact. If this session had substantial work, run /retro now to capture decisions before details are lost."
# PreCompact hook output schema (validated by Claude Code) — does NOT support
# `hookSpecificOutput`; that's PreToolUse/UserPromptSubmit/PostToolUse only.
# Use `systemMessage` to surface a passive notice to the user without blocking.
jq -n --arg msg "$MSG" '{systemMessage: $msg}'
exit 0
