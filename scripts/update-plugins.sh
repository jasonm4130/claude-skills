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

# A plugin whose update adds a dependency (gates 0.7.0 became a bundle of units)
# does not get it from `claude plugin update`: it stays "failed to load" until the
# dependency is installed. Each `claude plugin install` of the dependent plugin,
# and each /reload-plugins, adds only one missing dependency (measured on Claude
# Code 2.1.301, 2026-10-16), so repeat until none is reported. The cap stops a
# dependency that cannot install from looping forever. A listing that fails or does
# not parse skips this step with a warning rather than ending the script under
# `set -e`, so the summary below still prints.
for _ in 1 2 3 4 5 6 7 8; do
  if ! listing=$(claude plugin list --json 2>/dev/null) \
    || ! needs=$(jq -r --arg m "@$MARKETPLACE" \
      '.[] | select(.id | endswith($m)) | select(any(.errorDetails[]?; .type == "dependency-unsatisfied")) | .id' \
      <<< "$listing" 2>/dev/null); then
    echo "  (could not list plugins; skipping the missing-dependency check)" >&2
    break
  fi
  needs=$(sort -u <<< "$needs")
  [ -n "$needs" ] || break
  while IFS= read -r id; do
    echo "Installing a missing dependency of $id"
    claude plugin install "$id" >/dev/null || echo "  (install failed for $id)" >&2
  done <<< "$needs"
done

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
