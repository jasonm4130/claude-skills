#!/usr/bin/env bash
set -euo pipefail
WORKDIR=$(mktemp -d); trap 'rm -rf "$WORKDIR"' EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
export CLAUDE_SESSION_ID="test-stop-quiet"
STOP="$(cd "$(dirname "$0")/.." && pwd)/scripts/stop-suggest-retro.sh"

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$WORKDIR/events-test-stop-quiet.jsonl" <<JSONL
{"ts":"$NOW","tool":"Edit","input":{"file_path":"/a.ts"}}
{"ts":"$NOW","tool":"Bash","input":{"command":"ls"}}
JSONL

OUT=$(echo '{}' | bash "$STOP")
[ -z "$OUT" ] || { echo "FAIL: expected empty stdout, got: $OUT"; exit 1; }
echo "PASS"
