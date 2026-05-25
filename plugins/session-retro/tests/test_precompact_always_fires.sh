#!/usr/bin/env bash
# PreCompact emits a /retro suggestion regardless of state — even if the
# retro-fired flag is present, even with no event log. Context loss is a
# hard event; better to over-suggest than to silently let work disappear.
set -euo pipefail
WORKDIR=$(mktemp -d); trap 'rm -rf "$WORKDIR"' EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
export CLAUDE_SESSION_ID="test-precompact"
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/precompact-suggest-retro.sh"

# Even with retro-fired flag set, PreCompact should still emit
touch "$WORKDIR/retro-fired-test-precompact.flag"

OUT=$(echo '{}' | bash "$SCRIPT")
[ -n "$OUT" ] || { echo "FAIL: expected non-empty stdout, got empty"; exit 1; }
MSG=$(echo "$OUT" | jq -r '.systemMessage')
echo "$MSG" | grep -q "compact" || { echo "FAIL: msg missing 'compact': $OUT"; exit 1; }
echo "$MSG" | grep -q "/retro" || { echo "FAIL: msg missing '/retro': $OUT"; exit 1; }
echo "PASS"
