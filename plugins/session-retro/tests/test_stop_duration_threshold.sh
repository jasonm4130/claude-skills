#!/usr/bin/env bash
set -euo pipefail
WORKDIR=$(mktemp -d); trap 'rm -rf "$WORKDIR"' EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
export CLAUDE_SESSION_ID="test-stop-dur"
STOP="$(cd "$(dirname "$0")/.." && pwd)/scripts/stop-suggest-retro.sh"

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if date -u -v-25M +%Y-%m-%dT%H:%M:%SZ >/dev/null 2>&1; then
    PAST=$(date -u -v-25M +%Y-%m-%dT%H:%M:%SZ)  # BSD/macOS
else
    PAST=$(date -u -d '25 minutes ago' +%Y-%m-%dT%H:%M:%SZ)  # GNU
fi
cat > "$WORKDIR/events-test-stop-dur.jsonl" <<JSONL
{"ts":"$PAST","tool":"Edit","input":{"file_path":"/a.ts"}}
{"ts":"$NOW","tool":"Bash","input":{"command":"echo done"}}
JSONL

OUT=$(echo '{}' | bash "$STOP")
[ -n "$OUT" ] || { echo "FAIL: expected stdout for 25-min session, got empty"; exit 1; }
MSG=$(echo "$OUT" | jq -r '.systemMessage')
echo "$MSG" | grep -q "minutes of work" || { echo "FAIL: msg missing duration phrase: $MSG"; exit 1; }
echo "PASS"
