#!/usr/bin/env bash
# scripts/update-plugins.sh
#
# Refresh this marketplace's metadata and fetch new versions of the plugins you have
# installed from it — the two things `/reload-plugins` does NOT do — so a following
# `/reload-plugins` applies them in the running session without a restart.
#
#   bash scripts/update-plugins.sh
#   # then, in your Claude Code session:  /reload-plugins
#
# Self-contained: operates on ~/.claude only, so it runs from anywhere. Needs the
# `claude` CLI and `jq` on PATH.
set -euo pipefail

MARKETPLACE="jasonm4130-claude-skills"
CACHE="$HOME/.claude/plugins/cache/$MARKETPLACE"
META="$HOME/.claude/plugins/marketplaces/$MARKETPLACE/.claude-plugin/marketplace.json"

command -v claude >/dev/null || { echo "claude CLI not on PATH" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq not on PATH" >&2; exit 1; }

echo "Refreshing marketplace metadata…"
claude plugin marketplace update "$MARKETPLACE" >/dev/null

[ -f "$META" ] || { echo "marketplace metadata not found: $META" >&2; exit 1; }

updated=0
# For each plugin the (refreshed) marketplace offers: if it's installed and the
# available version's cache dir doesn't exist yet, fetch it. Keying off the version
# dir avoids parsing/among-versions guessing — it's the fetched-payload marker.
while IFS=$'\t' read -r name avail; do
  [ -d "$CACHE/$name" ] || continue          # not installed → skip
  [ -d "$CACHE/$name/$avail" ] && continue    # available version already fetched → current
  echo "Updating $name → $avail"
  if claude plugin update "${name}@${MARKETPLACE}" >/dev/null; then
    updated=$((updated + 1))
  else
    echo "  (update failed for $name)" >&2
  fi
done < <(jq -r '.plugins[] | "\(.name)\t\(.version)"' "$META")

if [ "$updated" -eq 0 ]; then
  echo "All installed plugins already current — nothing to fetch."
else
  echo
  echo "Fetched $updated update(s). Now run /reload-plugins in your Claude Code session to apply."
fi
