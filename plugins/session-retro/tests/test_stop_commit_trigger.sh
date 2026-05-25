#!/usr/bin/env bash
set -euo pipefail
WORKDIR=$(mktemp -d); trap 'rm -rf "$WORKDIR"' EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
export CLAUDE_SESSION_ID="test-stop-commit"
STOP="$(cd "$(dirname "$0")/.." && pwd)/scripts/stop-suggest-retro.sh"

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$WORKDIR/events-test-stop-commit.jsonl" <<JSONL
{"ts":"$NOW","tool":"Bash","input":{"command":"git status"}}
{"ts":"$NOW","tool":"Bash","input":{"command":"git commit -m 'fix: thing'"}}
JSONL

OUT=$(echo '{}' | bash "$STOP")
[ -n "$OUT" ] || { echo "FAIL: expected stdout for commit, got empty"; exit 1; }
echo "$OUT" | jq -r '.systemMessage' | grep -q "committed" || { echo "FAIL: msg missing 'committed': $OUT"; exit 1; }
echo "PASS"
