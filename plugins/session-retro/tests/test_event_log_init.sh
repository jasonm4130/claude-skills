#!/usr/bin/env bash
# First PostToolUse call creates events-{session_id}.jsonl with one JSON line.
# (Counter-file design was replaced — see commit 615d8b0 spec pivot.)
set -euo pipefail
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
export CLAUDE_SESSION_ID="test-event-log-init"
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/posttooluse-append-event.sh"

echo '{"tool_name":"Edit","tool_input":{"file_path":"/repo/src/foo.ts"}}' | bash "$SCRIPT"

EVENTS="$WORKDIR/events-test-event-log-init.jsonl"
[ -f "$EVENTS" ] || { echo "FAIL: events file not created"; exit 1; }
LINES=$(wc -l < "$EVENTS" | tr -d ' ')
[ "$LINES" = "1" ] || { echo "FAIL: expected 1 line, got $LINES"; exit 1; }
TOOL=$(jq -r '.tool' < "$EVENTS")
[ "$TOOL" = "Edit" ] || { echo "FAIL: tool should be Edit, got $TOOL"; exit 1; }
FP=$(jq -r '.input.file_path' < "$EVENTS")
[ "$FP" = "/repo/src/foo.ts" ] || { echo "FAIL: file_path should be /repo/src/foo.ts, got $FP"; exit 1; }
TS=$(jq -r '.ts' < "$EVENTS")
[[ "$TS" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || { echo "FAIL: ts not ISO-8601, got $TS"; exit 1; }

echo "PASS"
