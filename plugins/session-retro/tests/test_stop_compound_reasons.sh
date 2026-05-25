#!/usr/bin/env bash
# When multiple thresholds match, the flag should include ALL of them
# joined by " + ", not just the first match.
set -euo pipefail
WORKDIR=$(mktemp -d); trap 'rm -rf "$WORKDIR"' EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
export CLAUDE_SESSION_ID="test-stop-compound"
STOP="$(cd "$(dirname "$0")/.." && pwd)/scripts/stop-write-retro-flag.sh"

# 25-min span + 3 edits across 2 files + a commit = 3 matching conditions
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if date -u -v-25M +%Y-%m-%dT%H:%M:%SZ >/dev/null 2>&1; then
    PAST=$(date -u -v-25M +%Y-%m-%dT%H:%M:%SZ)
else
    PAST=$(date -u -d '25 minutes ago' +%Y-%m-%dT%H:%M:%SZ)
fi
cat > "$WORKDIR/events-test-stop-compound.jsonl" <<JSONL
{"ts":"$PAST","tool":"Edit","input":{"file_path":"/a.ts"}}
{"ts":"$PAST","tool":"Edit","input":{"file_path":"/b.ts"}}
{"ts":"$PAST","tool":"Edit","input":{"file_path":"/a.ts"}}
{"ts":"$NOW","tool":"Bash","input":{"command":"git commit -m foo"}}
JSONL

echo '{}' | bash "$STOP"
FLAG="$WORKDIR/retro-nudge-test-stop-compound.flag"
[ -f "$FLAG" ] || { echo "FAIL: expected nudge flag to exist, got none"; exit 1; }
CONTENT=$(cat "$FLAG")
# All three reasons should appear
echo "$CONTENT" | grep -q "3 edits across 2 files" || { echo "FAIL: missing edits reason: $CONTENT"; exit 1; }
echo "$CONTENT" | grep -q "minutes of work" || { echo "FAIL: missing duration reason: $CONTENT"; exit 1; }
echo "$CONTENT" | grep -q "committed during session" || { echo "FAIL: missing commit reason: $CONTENT"; exit 1; }
# Joined with " + "
echo "$CONTENT" | grep -q " + " || { echo "FAIL: reasons not joined with ' + ': $CONTENT"; exit 1; }
echo "PASS"
