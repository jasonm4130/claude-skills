#!/usr/bin/env bash
set -euo pipefail
WORKDIR=$(mktemp -d); trap 'rm -rf "$WORKDIR"' EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
export CLAUDE_SESSION_ID="test-stop-dur"
STOP="$(cd "$(dirname "$0")/.." && pwd)/scripts/stop-write-retro-flag.sh"

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

echo '{}' | bash "$STOP"
FLAG="$WORKDIR/retro-nudge-test-stop-dur.flag"
[ -f "$FLAG" ] || { echo "FAIL: expected nudge flag for 25-min session, got none"; exit 1; }
CONTENT=$(cat "$FLAG")
echo "$CONTENT" | grep -q "minutes of work" || { echo "FAIL: flag missing duration phrase: $CONTENT"; exit 1; }
echo "PASS"
