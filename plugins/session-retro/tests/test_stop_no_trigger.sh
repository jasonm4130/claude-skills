#!/usr/bin/env bash
set -euo pipefail
WORKDIR=$(mktemp -d); trap 'rm -rf "$WORKDIR"' EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
export CLAUDE_SESSION_ID="test-stop-quiet"
STOP="$(cd "$(dirname "$0")/.." && pwd)/scripts/stop-write-retro-flag.sh"

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$WORKDIR/events-test-stop-quiet.jsonl" <<JSONL
{"ts":"$NOW","tool":"Edit","input":{"file_path":"/a.ts"}}
{"ts":"$NOW","tool":"Bash","input":{"command":"ls"}}
JSONL

echo '{}' | bash "$STOP"
FLAG="$WORKDIR/retro-nudge-test-stop-quiet.flag"
[ ! -f "$FLAG" ] || { echo "FAIL: expected no nudge flag, but flag exists"; exit 1; }
echo "PASS"
