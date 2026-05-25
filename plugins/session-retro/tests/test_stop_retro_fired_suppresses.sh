#!/usr/bin/env bash
set -euo pipefail
WORKDIR=$(mktemp -d); trap 'rm -rf "$WORKDIR"' EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
export CLAUDE_SESSION_ID="test-stop-suppressed"
STOP="$(cd "$(dirname "$0")/.." && pwd)/scripts/stop-suggest-retro.sh"

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# Generous events that would trigger if not suppressed
cat > "$WORKDIR/events-test-stop-suppressed.jsonl" <<JSONL
{"ts":"$NOW","tool":"Edit","input":{"file_path":"/a.ts"}}
{"ts":"$NOW","tool":"Edit","input":{"file_path":"/b.ts"}}
{"ts":"$NOW","tool":"Edit","input":{"file_path":"/c.ts"}}
{"ts":"$NOW","tool":"Bash","input":{"command":"git commit -m foo"}}
JSONL
# Retro already fired this session
touch "$WORKDIR/retro-fired-test-stop-suppressed.flag"

OUT=$(echo '{}' | bash "$STOP")
[ -z "$OUT" ] || { echo "FAIL: expected empty stdout when retro-fired, got: $OUT"; exit 1; }
echo "PASS"
