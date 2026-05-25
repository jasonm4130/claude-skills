#!/usr/bin/env bash
set -euo pipefail
WORKDIR=$(mktemp -d); trap 'rm -rf "$WORKDIR"' EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
export CLAUDE_SESSION_ID="test-stop-edits"
STOP="$(cd "$(dirname "$0")/.." && pwd)/scripts/stop-write-retro-flag.sh"

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$WORKDIR/events-test-stop-edits.jsonl" <<JSONL
{"ts":"$NOW","tool":"Edit","input":{"file_path":"/a.ts"}}
{"ts":"$NOW","tool":"Edit","input":{"file_path":"/b.ts"}}
{"ts":"$NOW","tool":"Edit","input":{"file_path":"/a.ts"}}
JSONL

echo '{}' | bash "$STOP"
FLAG="$WORKDIR/retro-nudge-test-stop-edits.flag"
[ -f "$FLAG" ] || { echo "FAIL: expected nudge flag to exist, got none"; exit 1; }
CONTENT=$(cat "$FLAG")
echo "$CONTENT" | grep -q "3 edits across 2 files" || { echo "FAIL: flag missing '3 edits across 2 files': $CONTENT"; exit 1; }
echo "PASS"
