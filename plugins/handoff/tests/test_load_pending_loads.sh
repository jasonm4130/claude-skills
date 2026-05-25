#!/usr/bin/env bash
# Test: .pending points at real file → additionalContext output, .pending deleted
set -euo pipefail
WORKDIR=$(mktemp -d); trap 'rm -rf "$WORKDIR"' EXIT
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/load-pending-handoff.sh"

# Create fake project structure
PROJECT_DIR="$WORKDIR/project"
mkdir -p "$PROJECT_DIR/.claude/handoffs"

# Write a handoff file
HANDOFF_NAME="2026-05-25T14-00-00-auto.md"
HANDOFF_PATH="$PROJECT_DIR/.claude/handoffs/$HANDOFF_NAME"
printf "## Current state\nHalf done.\n\n## Next concrete step\nRun: npm test" > "$HANDOFF_PATH"

# Write .pending with the basename
printf "%s" "$HANDOFF_NAME" > "$PROJECT_DIR/.claude/handoffs/.pending"

INPUT="{\"cwd\":\"${PROJECT_DIR}\"}"
OUT=$(echo "$INPUT" | bash "$SCRIPT")

# Output should contain hookSpecificOutput
echo "$OUT" | jq -e '.hookSpecificOutput' >/dev/null || { echo "FAIL: no hookSpecificOutput in output: $OUT"; exit 1; }

# additionalContext should contain [handoff] and file content
CONTEXT=$(echo "$OUT" | jq -r '.hookSpecificOutput.additionalContext')
echo "$CONTEXT" | grep -q "\[handoff\]" || { echo "FAIL: missing [handoff] in context: $CONTEXT"; exit 1; }
echo "$CONTEXT" | grep -q "Half done" || { echo "FAIL: handoff content not in context: $CONTEXT"; exit 1; }

# .pending should be deleted
[ ! -f "$PROJECT_DIR/.claude/handoffs/.pending" ] || { echo "FAIL: .pending not deleted"; exit 1; }

echo "PASS"
