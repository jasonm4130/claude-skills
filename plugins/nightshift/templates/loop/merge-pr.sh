#!/usr/bin/env bash
# Merge a pull request into the base branch the one way this repo allows.
#
#   loop/merge-pr.sh [--stay] [<pr-number>]   defaults to the PR for the current branch
#
# Waits for the named CI checks to register and pass, re-reads the kill
# switch, merges with a merge commit, then puts the working tree back on an
# up-to-date base. Refuses if any check fails or never appears.
#
# Where the check names come from is MERGE_MODE in loop/config:
#   protected  the base branch has branch protection with required checks;
#              their exact contexts are read from the API at merge time, so a
#              matrix job's `name (os)` contexts are matched as GitHub names them.
#   wait       no branch protection (a private repo on a free plan, say); the
#              names come from EXPECTED_CHECKS in loop/config. Prefer one final
#              `gate` job in CI that needs every other job, so this is one name
#              and a paths-filtered job that never registers cannot stall it.
#
# Never `gh pr merge --auto`: a merge queued on GitHub's side cannot be
# cancelled by the kill switch, so a freeze while CI is pending would still
# merge on green; and it needs auto-merge enabled on the repository, which
# branch protection does not imply. Waiting here and merging once keeps the
# irreversible step behind both CI and the switch.
#
# Why wait at all: `gh pr checks --watch` only waits for checks that have
# already registered, and a check appears some seconds after the push — so a
# watch started straight after `gh pr create` returns before CI is queued.
# That is how cargo fmt drift once sat on main for six pushes.
#
# Why a merge commit and not squash or rebase: the PR's history survives as it
# was reviewed, and `git revert -m 1 <merge-sha>` undoes one task cleanly.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=config
[ -f "$here/config" ] && . "$here/config"
: "${BASE:=main}"
: "${MERGE_MODE:=wait}"
: "${EXPECTED_CHECKS:=}"
: "${STATE_VAR:=LANDING_STATE}"
: "${REGISTER_WAIT:=300}"   # seconds to wait for every expected check to register

stay=0
if [ "${1:-}" = "--stay" ]; then stay=1; shift; fi
pr="${1:-}"
if [ -z "$pr" ]; then
  pr=$(gh pr view --json number --jq .number 2>/dev/null || true)
  if [ -z "$pr" ]; then
    echo "no PR for the current branch — pass a number, or: gh pr create" >&2
    exit 1
  fi
fi

read -r state base_ref head_ref <<<"$(gh pr view "$pr" --json baseRefName,headRefName,state --jq '"\(.state) \(.baseRefName) \(.headRefName)"')"
if [ "$state" != "OPEN" ]; then
  echo "PR #$pr is $state, not open" >&2
  exit 1
fi
if [ "$base_ref" != "$BASE" ]; then
  echo "PR #$pr targets $base_ref, not $BASE" >&2
  exit 1
fi

# The check names this PR must pass.
case "$MERGE_MODE" in
  protected)
    slug=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
    expected_text=$(gh api "repos/$slug/branches/$BASE/protection" --jq '.required_status_checks.contexts[]' 2>/dev/null || true)
    if [ -z "$expected_text" ]; then
      echo "MERGE_MODE=protected but $BASE has no required status checks — set MERGE_MODE=wait and EXPECTED_CHECKS in loop/config" >&2
      exit 2
    fi
    ;;
  wait)
    expected_text=$(tr ' ' '\n' <<<"$EXPECTED_CHECKS" | sed '/^$/d')
    if [ -z "$expected_text" ]; then
      echo "MERGE_MODE=wait needs EXPECTED_CHECKS in loop/config (the CI check names to wait for)" >&2
      exit 2
    fi
    ;;
  *)
    echo "MERGE_MODE must be protected or wait, not '$MERGE_MODE'" >&2
    exit 2
    ;;
esac
expected=()
while IFS= read -r line; do [ -n "$line" ] && expected+=("$line"); done <<<"$expected_text"

echo "PR #$pr: $head_ref → $BASE. Waiting for: ${expected[*]}"
missing=()
waited=0
while :; do
  names=$(gh pr checks "$pr" --json name --jq '.[].name' 2>/dev/null || true)
  missing=()
  for want in "${expected[@]}"; do
    grep -qxF -- "$want" <<<"$names" || missing+=("$want")
  done
  [ "${#missing[@]}" -eq 0 ] && break
  [ "$waited" -ge "$REGISTER_WAIT" ] && break
  sleep 5; waited=$((waited + 5))
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "checks never appeared on PR #$pr: ${missing[*]} — not merging." >&2
  exit 1
fi
# --fail-fast stops on the first failure.
if ! gh pr checks "$pr" --watch --fail-fast; then
  echo "" >&2
  echo "checks did not pass on PR #$pr — not merging. See: gh pr checks $pr" >&2
  exit 1
fi
failed=$(gh pr checks "$pr" --json name,bucket --jq '.[] | select(.bucket != "pass" and .bucket != "skipping") | .name')
if [ -n "$failed" ]; then
  echo "checks not passing on PR #$pr: $(tr '\n' ' ' <<<"$failed")— not merging." >&2
  exit 1
fi

# The switch is read again here, after the wait: a night frozen while CI ran
# must not land. Only enforced when the variable exists, so a daytime merge in
# a repo that never set it is unaffected.
sw=$(gh variable get "$STATE_VAR" 2>/dev/null || echo "unset")
if [ "$sw" != "run" ] && [ "$sw" != "unset" ] && [ "${NIGHTSHIFT:-0}" = 1 ]; then
  echo "$STATE_VAR=$sw — frozen, not merging PR #$pr" >&2
  exit 3
fi

gh pr merge "$pr" --merge --delete-branch=false
echo "merged PR #$pr with a merge commit"

# --stay: merge and stop. The landing loop runs this from its own worktree,
# where the base branch is not checkable-out and the caller does its own tidying.
if [ "$stay" = 1 ]; then exit 0; fi

# Back to an up-to-date base. `--ff-only` so a local base that has somehow
# diverged is reported, not silently merged.
git switch "$BASE"
git pull --ff-only origin "$BASE"
if [ "$head_ref" != "$BASE" ] && git show-ref --verify --quiet "refs/heads/$head_ref"; then
  git branch -d "$head_ref" || true
fi
git fetch --prune origin
