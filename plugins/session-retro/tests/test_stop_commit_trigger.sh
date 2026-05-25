#!/usr/bin/env bash
set -euo pipefail
WORKDIR=$(mktemp -d); trap 'rm -rf "$WORKDIR"' EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
export CLAUDE_SESSION_ID="test-stop-commit"
STOP="$(cd "$(dirname "$0")/.." && pwd)/scripts/stop-write-retro-flag.sh"

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$WORKDIR/events-test-stop-commit.jsonl" <<JSONL
{"ts":"$NOW","tool":"Bash","input":{"command":"git status"}}
{"ts":"$NOW","tool":"Bash","input":{"command":"git commit -m 'fix: thing'"}}
JSONL

echo '{}' | bash "$STOP"
FLAG="$WORKDIR/retro-nudge-test-stop-commit.flag"
[ -f "$FLAG" ] || { echo "FAIL: expected nudge flag to exist for commit, got none"; exit 1; }
CONTENT=$(cat "$FLAG")
echo "$CONTENT" | grep -q "committed" || { echo "FAIL: flag missing 'committed': $CONTENT"; exit 1; }
echo "PASS"
