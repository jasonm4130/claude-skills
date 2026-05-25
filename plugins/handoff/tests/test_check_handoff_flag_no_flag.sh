#!/usr/bin/env bash
# Test: no flag present → script exits silently (no output, exit 0)
set -euo pipefail
WORKDIR=$(mktemp -d); trap 'rm -rf "$WORKDIR"' EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/check-handoff-flag.sh"

SID="test-flag-no-flag"
INPUT="{\"session_id\":\"${SID}\"}"
OUT=$(echo "$INPUT" | bash "$SCRIPT")

# Output should be empty
[ -z "$OUT" ] || { echo "FAIL: expected empty output, got: $OUT"; exit 1; }

echo "PASS"
