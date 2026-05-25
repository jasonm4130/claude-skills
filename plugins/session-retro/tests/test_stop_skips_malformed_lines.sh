#!/usr/bin/env bash
# A corrupt line in events-{session_id}.jsonl must not crash the Stop hook.
# Append-only design's whole point is resilience against partial writes.
set -euo pipefail
WORKDIR=$(mktemp -d); trap 'rm -rf "$WORKDIR"' EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
export CLAUDE_SESSION_ID="test-stop-malformed"
STOP="$(cd "$(dirname "$0")/.." && pwd)/scripts/stop-suggest-retro.sh"

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# Mix valid + corrupt lines (truncated, garbage, blank)
cat > "$WORKDIR/events-test-stop-malformed.jsonl" <<JSONL
{"ts":"$NOW","tool":"Edit","input":{"file_path":"/a.ts"}}
this is not json at all
{"ts":"$NOW","tool":"Edit","input":{"file_pat
{"ts":"$NOW","tool":"Edit","input":{"file_path":"/b.ts"}}

{"ts":"$NOW","tool":"Edit","input":{"file_path":"/c.ts"}}
JSONL

# Should NOT crash; should aggregate the 3 valid Edits and trigger
OUT=$(echo '{}' | bash "$STOP")
RC=$?
[ "$RC" = "0" ] || { echo "FAIL: hook exited non-zero ($RC) on malformed line"; exit 1; }
[ -n "$OUT" ] || { echo "FAIL: expected trigger from 3 valid edits, got empty stdout"; exit 1; }
MSG=$(echo "$OUT" | jq -r '.systemMessage')
echo "$MSG" | grep -q "3 edits across 3 files" || { echo "FAIL: expected '3 edits across 3 files' (corrupt lines skipped), got: $MSG"; exit 1; }
echo "PASS"
