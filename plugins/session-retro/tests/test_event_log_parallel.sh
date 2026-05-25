#!/usr/bin/env bash
# Append-only design must be race-free: 50 parallel Edits should produce 50 lines.
# (The previous read-modify-write counter design lost ~96% of updates here.)
set -euo pipefail
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
export CLAUDE_SESSION_ID="test-event-log-parallel"
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/posttooluse-append-event.sh"

for i in $(seq 1 50); do
    echo '{"tool_name":"Edit","tool_input":{"file_path":"/file_'"$i"'.ts"}}' | bash "$SCRIPT" &
done
wait

EVENTS="$WORKDIR/events-test-event-log-parallel.jsonl"
LINES=$(wc -l < "$EVENTS" | tr -d ' ')
[ "$LINES" = "50" ] || { echo "FAIL: expected 50 lines after parallel writes, got $LINES"; exit 1; }
# Each line must be valid JSON
while IFS= read -r line; do
    echo "$line" | jq -e . > /dev/null || { echo "FAIL: corrupt JSON line: $line"; exit 1; }
done < "$EVENTS"
echo "PASS"
