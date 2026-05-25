#!/usr/bin/env bash
# PreCompact writes a retro-nudge flag regardless of state — even if the
# retro-fired flag is present, even with no event log. Context loss is a
# hard event; better to over-nudge than to silently let work disappear.
set -euo pipefail
WORKDIR=$(mktemp -d); trap 'rm -rf "$WORKDIR"' EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
export CLAUDE_SESSION_ID="test-precompact"
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/precompact-write-retro-flag.sh"

# Even with retro-fired flag set, PreCompact should still write the nudge flag
touch "$WORKDIR/retro-fired-test-precompact.flag"

echo '{}' | bash "$SCRIPT"
FLAG="$WORKDIR/retro-nudge-test-precompact.flag"
[ -f "$FLAG" ] || { echo "FAIL: expected nudge flag to exist after PreCompact, got none"; exit 1; }
CONTENT=$(cat "$FLAG")
echo "$CONTENT" | grep -q "compact" || { echo "FAIL: flag content missing 'compact': $CONTENT"; exit 1; }
echo "PASS"
