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

# Every fetched payload currently in the cache, as "name<TAB>version".
#
# The summary is computed by diffing this before and after, rather than by
# counting update calls, because one call is not one plugin. `claude plugin
# update <name>` refreshes the whole marketplace payload, so a single invocation
# can land several plugins at once — measured 2026-08-03: design-gate-guard 0.2.2
# and workflow-model-guard 0.4.2 both appeared at 11:16:02 from one call, and the
# loop below then skipped workflow-model-guard as already-current. Counting calls
# reported "Fetched 1 update(s)" for two updated plugins, which is exactly the
# wrong direction for a tool you consult to answer "did my plugin update?".
snapshot() {
  find "$CACHE" -mindepth 2 -maxdepth 2 -type d 2>/dev/null \
    | sed "s|^$CACHE/||" \
    | tr '/' '\t' \
    | sort
}

before=$(snapshot)

# For each plugin the (refreshed) marketplace offers: if it's installed and the
# available version's cache dir doesn't exist yet, fetch it. Keying off the version
# dir avoids parsing/among-versions guessing — it's the fetched-payload marker, and
# it also means a plugin already pulled in by an earlier call costs nothing here.
while IFS=$'\t' read -r name avail; do
  [ -d "$CACHE/$name" ] || continue          # not installed → skip
  [ -d "$CACHE/$name/$avail" ] && continue    # available version already fetched → current
  echo "Updating $name → $avail"
  claude plugin update "${name}@${MARKETPLACE}" >/dev/null \
    || echo "  (update failed for $name)" >&2
done < <(jq -r '.plugins[] | "\(.name)\t\(.version)"' "$META")

fetched=$(comm -13 <(printf '%s\n' "$before") <(snapshot))

if [ -z "$fetched" ]; then
  echo "All installed plugins already current — nothing to fetch."
else
  echo
  # Name every plugin that actually landed, not just how many. A failed update
  # cannot show up here: nothing was written, so nothing appears in the diff.
  while IFS=$'\t' read -r name version; do
    [ -n "$name" ] && echo "  $name → $version"
  done <<< "$fetched"
  echo
  echo "Fetched $(grep -c . <<< "$fetched") update(s). Now run /reload-plugins in your Claude Code session to apply."
fi
