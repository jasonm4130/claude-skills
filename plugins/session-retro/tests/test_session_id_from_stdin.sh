#!/usr/bin/env bash
# Regression: Claude Code passes session_id in the hook payload (stdin),
# NOT as $CLAUDE_SESSION_ID env var. Manual e2e on 2026-05-02 caught this:
# all events were landing in events-unknown.jsonl because the hook scripts
# only read the env var. This test pins the stdin extraction so the bug
# cannot return.
set -euo pipefail
WORKDIR=$(mktemp -d); trap 'rm -rf "$WORKDIR"' EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
# Deliberately UNSET the env var to force the script to use stdin
unset CLAUDE_SESSION_ID
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/posttooluse-append-event.sh"

# Real Claude Code payload includes session_id at the top level
echo '{"session_id":"abc-123-real-session","tool_name":"Edit","tool_input":{"file_path":"/foo.ts"}}' | bash "$SCRIPT"

# Event must land in events-abc-123-real-session.jsonl, NOT events-unknown.jsonl
[ -f "$WORKDIR/events-abc-123-real-session.jsonl" ] || { echo "FAIL: event file not created with session_id from stdin"; ls "$WORKDIR/"; exit 1; }
[ ! -f "$WORKDIR/events-unknown.jsonl" ] || { echo "FAIL: event landed in events-unknown.jsonl, session_id extraction is broken"; exit 1; }

# And the Stop hook must pick up the same session_id from its own stdin
STOP="$(cd "$(dirname "$0")/.." && pwd)/scripts/stop-suggest-retro.sh"
# Build a synthetic event log under that session id with enough events to trigger
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$WORKDIR/events-stop-test-from-stdin.jsonl" <<JSONL
{"ts":"$NOW","tool":"Edit","input":{"file_path":"/a.ts"}}
{"ts":"$NOW","tool":"Edit","input":{"file_path":"/b.ts"}}
{"ts":"$NOW","tool":"Edit","input":{"file_path":"/a.ts"}}
JSONL

OUT=$(echo '{"session_id":"stop-test-from-stdin"}' | bash "$STOP")
[ -n "$OUT" ] || { echo "FAIL: Stop hook didn't trigger when session_id came from stdin"; exit 1; }
echo "$OUT" | jq -e '.systemMessage | type == "string"' >/dev/null || { echo "FAIL: bad Stop output, expected systemMessage string: $OUT"; exit 1; }

echo "PASS"
