#!/usr/bin/env bash
# When multiple thresholds match, the message should include ALL of them
# joined by " + ", not just the first match.
set -euo pipefail
WORKDIR=$(mktemp -d); trap 'rm -rf "$WORKDIR"' EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
export CLAUDE_SESSION_ID="test-stop-compound"
STOP="$(cd "$(dirname "$0")/.." && pwd)/scripts/stop-suggest-retro.sh"

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

OUT=$(echo '{}' | bash "$STOP")
[ -n "$OUT" ] || { echo "FAIL: expected trigger, got empty"; exit 1; }
MSG=$(echo "$OUT" | jq -r '.systemMessage')
# All three reasons should appear
echo "$MSG" | grep -q "3 edits across 2 files" || { echo "FAIL: missing edits reason: $MSG"; exit 1; }
echo "$MSG" | grep -q "minutes of work" || { echo "FAIL: missing duration reason: $MSG"; exit 1; }
echo "$MSG" | grep -q "committed during session" || { echo "FAIL: missing commit reason: $MSG"; exit 1; }
# Joined with " + "
echo "$MSG" | grep -q " + " || { echo "FAIL: reasons not joined with ' + ': $MSG"; exit 1; }
echo "PASS"
