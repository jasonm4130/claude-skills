#!/usr/bin/env bash
# check-retro-flag.sh: when no nudge flag exists, it exits 0 with no stdout.
set -euo pipefail
WORKDIR=$(mktemp -d); trap 'rm -rf "$WORKDIR"' EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
export CLAUDE_SESSION_ID="test-check-no-flag"
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/check-retro-flag.sh"

# No flag present — just run the script
OUT=$(printf '{"session_id":"test-check-no-flag"}' | bash "$SCRIPT")

[ -z "$OUT" ] || { echo "FAIL: expected empty output when no flag, got: $OUT"; exit 1; }

echo "PASS"
