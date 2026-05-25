#!/usr/bin/env bash
set -euo pipefail
WORKDIR=$(mktemp -d); trap 'rm -rf "$WORKDIR"' EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
export CLAUDE_SESSION_ID="test-stop-edits"
STOP="$(cd "$(dirname "$0")/.." && pwd)/scripts/stop-suggest-retro.sh"

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$WORKDIR/events-test-stop-edits.jsonl" <<JSONL
{"ts":"$NOW","tool":"Edit","input":{"file_path":"/a.ts"}}
{"ts":"$NOW","tool":"Edit","input":{"file_path":"/b.ts"}}
{"ts":"$NOW","tool":"Edit","input":{"file_path":"/a.ts"}}
JSONL

OUT=$(echo '{}' | bash "$STOP")
[ -n "$OUT" ] || { echo "FAIL: expected stdout, got empty"; exit 1; }
MSG=$(echo "$OUT" | jq -r '.systemMessage')
echo "$MSG" | grep -q "3 edits across 2 files" || { echo "FAIL: msg missing '3 edits across 2 files': $MSG"; exit 1; }
echo "$MSG" | grep -q "/retro" || { echo "FAIL: msg missing '/retro': $MSG"; exit 1; }
echo "PASS"
