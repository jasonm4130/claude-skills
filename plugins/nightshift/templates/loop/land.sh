#!/usr/bin/env bash
# Nightshift: land a plan while nobody is watching, one task per pull request.
#
#   loop/land.sh                 # next undone task(s) of the plan in loop/config
#   loop/land.sh --max 1         # at most one task tonight
#   loop/land.sh --task 3        # this task, even if the plan says it is done
#   loop/land.sh --dry-run       # say what would happen, touch nothing
#
# One task, start to finish:
#   1. fresh branch <prefix>/<plan>-t<N> from origin/<base>, in its own worktree
#   2. generator: `claude -p` in auto mode, budget-capped, commits, never pushes
#   3. verifier: CHECK_CMD must end with "CHECK OK"
#   4. skeptic: a second read-only `claude -p` that tries to refute the diff
#   5. one repair round on a red verifier or a refutation, then give up
#   6. push, open a PR labelled `land`, hand it to MERGE_CMD (CI decides)
#
# Nothing here remembers anything between runs. Done means a merge commit on
# <base> names the branch; in flight means an open PR on the branch; blocked
# means that PR is a draft with the blocked label. A run killed halfway leaves
# a branch and maybe a PR, and the next run picks up from what GitHub says.
#
# Stops for the night on: the kill switch (repo variable STATE_VAR != run), a
# blocked or human-closed PR on any task of the plan, a task whose generator
# produced nothing, MAX tasks landed, or the DEADLINE. Each stop is one line in
# the journal saying which.
#
# Repo-agnostic on purpose: everything project-specific is in loop/config.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
# shellcheck source=config
[ -f "$here/config" ] && . "$here/config"
: "${PLAN:?loop/config must set PLAN}"
: "${BASE:=main}"
: "${MAX:=3}"
: "${CHECK_CMD:=scripts/check}"
: "${MODEL:=opus}"
: "${GEN_BUDGET:=4}"
: "${SKEPTIC_BUDGET:=1}"
: "${REPAIR_ROUNDS:=1}"
: "${GEN_TIMEOUT:=45m}"
: "${CHECK_TIMEOUT:=30m}"
: "${SKEPTIC_TIMEOUT:=15m}"
: "${MERGE_CMD:=./loop/merge-pr.sh --stay}"
: "${MERGE_TIMEOUT:=45m}"
: "${DEADLINE:=6h}"
: "${BRANCH_PREFIX:=land}"
: "${LABEL:=land}"
: "${BLOCKED_LABEL:=land:blocked}"
: "${STATE_VAR:=LANDING_STATE}"
: "${SETTING_SOURCES:=project}"
: "${WORKTREE:=$repo/../$(basename "$repo")-nightshift}"
: "${STATE_DIR:=$HOME/.local/state/nightshift/$(basename "$repo")}"

dry=0; only=""
while [ $# -gt 0 ]; do
  case "$1" in
    --max) MAX=$2; shift 2 ;;
    --task) only=$2; shift 2 ;;
    --dry-run) dry=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$STATE_DIR"
journal=$STATE_DIR/journal.md
log() { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$journal" >&2; }
die() { log "STOP: $*"; exit 1; }
stop() { log "STOP: $*"; exit 0; }

# ---- helpers ---------------------------------------------------------------

# Minutes-to-seconds for the timeout wrapper; falls back to no bound if no
# coreutils `timeout` is on PATH, and says so once.
have_timeout=1; command -v timeout >/dev/null || { have_timeout=0; log "warn: no timeout(1) on PATH; steps run unbounded"; }
bounded() { # bounded <duration> <cmd...>
  local t=$1; shift
  if [ $have_timeout = 1 ]; then timeout --kill-after=1m "$t" "$@"; else "$@"; fi
}

secs() { # 45m → 2700, 6h → 21600, 90 → 90
  case "$1" in *h) echo $(( ${1%h} * 3600 )) ;; *m) echo $(( ${1%m} * 60 )) ;; *s) echo "${1%s}" ;; *) echo "$1" ;; esac
}
deadline=$(secs "$DEADLINE")
past_deadline() { [ "$SECONDS" -ge "$deadline" ]; }

slug=$(basename "$PLAN" .md)
branch_for() { echo "$BRANCH_PREFIX/$slug-t$1"; }
gw() { git -C "$WORKTREE" "$@"; }

switch_is_run() {
  local v
  v=$(gh variable get "$STATE_VAR" 2>/dev/null || echo "unset")
  [ "$v" = "run" ] || { log "kill switch: $STATE_VAR=$v"; return 1; }
}

# Task numbers and titles, in plan order: "N<TAB>title".
plan_tasks() {
  grep -E '^#+[[:space:]]+Task[[:space:]]+[0-9]+' "$repo/$PLAN" \
    | sed -E 's/^#+[[:space:]]+Task[[:space:]]+([0-9]+)[[:space:]:.–-]*/\1\t/'
}

# Task N is done when a merge commit on origin/<base> names its branch. GitHub
# writes "Merge pull request #12 from <owner>/<branch>", so a slash may precede
# the branch name; only a longer branch name (land/x-t1 vs land/x-t10) may not
# follow it. The log is captured first: under pipefail, `grep -q` closing the
# pipe on an early match makes git exit 141 and the task read as not done.
task_done() {
  local merges
  merges=$(git -C "$repo" log "origin/$BASE" --merges --format=%s%n%b)
  grep -qE "(^|[^A-Za-z0-9])$(branch_for "$1")([^A-Za-z0-9-]|$)" <<<"$merges"
}

# The open PR on task N's branch: "number<TAB>draft<TAB>labels" or nothing.
open_pr() {
  gh pr list --state open --head "$(branch_for "$1")" --base "$BASE" \
    --json number,isDraft,labels --jq '.[] | "\(.number)\t\(.isDraft)\t\([.labels[].name] | join(","))"' 2>/dev/null | head -1
}
closed_unmerged_pr() {
  gh pr list --state closed --head "$(branch_for "$1")" --base "$BASE" \
    --json number,mergedAt --jq '.[] | select(.mergedAt == null) | .number' 2>/dev/null | head -1
}

fill() { # fill <template-file> KEY=VALUE...  ({{KEY}} → VALUE, values may be multi-line)
  local text; text=$(cat "$1"); shift
  local kv k v
  for kv in "$@"; do k=${kv%%=*}; v=${kv#*=}; text=${text//\{\{$k\}\}/$v}; done
  printf '%s\n' "$text"
}

# One claude -p call. Writes the JSON envelope and the text result to run_dir,
# logs the cost, and prints the result text. Never fails the script: the caller
# judges by what is in git, not by the exit code.
ask() { # ask <name> <permission-mode> <budget> <timeout> <prompt>
  local name=$1 mode=$2 budget=$3 t=$4 prompt=$5
  local out=$run_dir/$name.json
  (cd "$WORKTREE" && bounded "$t" claude -p "$prompt" \
      --permission-mode "$mode" --permission-prompts none \
      --setting-sources "$SETTING_SOURCES" --no-session-persistence \
      --max-budget-usd "$budget" --model "$MODEL" --output-format json) >"$out" 2>"$run_dir/$name.stderr" || true
  jq -r '.result // empty' "$out" 2>/dev/null >"$run_dir/$name.md" || true
  local cost turns
  cost=$(jq -r '.total_cost_usd // 0' "$out" 2>/dev/null || echo 0)
  turns=$(jq -r '.num_turns // 0' "$out" 2>/dev/null || echo 0)
  log "  $name: \$$cost, $turns turns, $(wc -l <"$run_dir/$name.md" | tr -d ' ') lines"
  cat "$run_dir/$name.md"
}

ensure_worktree() {
  git -C "$repo" fetch -q origin
  local worktrees
  worktrees=$(git -C "$repo" worktree list --porcelain)
  if ! grep -qx "worktree $(cd "$WORKTREE" 2>/dev/null && pwd || echo "$WORKTREE")" <<<"$worktrees"; then
    git -C "$repo" worktree add --detach "$WORKTREE" "origin/$BASE" >/dev/null || die "cannot add worktree at $WORKTREE"
  fi
  gw reset -q --hard && gw clean -fdq
}

fresh_branch() { # fresh_branch <branch>: the branch at origin/<base>, no leftovers
  gw switch -q --detach "origin/$BASE"
  gw branch -q -D "$1" 2>/dev/null || true
  gw switch -q -c "$1" "origin/$BASE"
}

run_check() { # run_check <round>: 0 if CHECK_CMD ends with CHECK OK
  local logf=$run_dir/check-$1.log
  (cd "$WORKTREE" && bounded "$CHECK_TIMEOUT" bash -c "$CHECK_CMD") >"$logf" 2>&1
  [ "$(tail -1 "$logf")" = "CHECK OK" ]
}

pr_body() { # pr_body <n> <title> <status-line>
  cat <<EOF
Task $1 of \`$PLAN\`, landed by Nightshift ($3).

## Generator's report
$(cat "$run_dir/gen-$round.md")

## Skeptic
$(cat "$run_dir/skeptic-$round.md" 2>/dev/null || echo "not run")

## Verifier
\`\`\`
$(tail -20 "$run_dir/check-$round.log" 2>/dev/null || echo "not run")
\`\`\`

Journal: \`$run_dir\`
Landed-Task: $slug#$1
EOF
}

# Wait for the PR to land. With MERGE_CMD set, that command is the gate (it
# waits for CI and merges). With it empty, something else merges (a workflow
# on the default branch) and this just watches.
land_pr() { # land_pr <n> <pr>
  local n=$1 pr=$2 rc=0
  if [ -n "$MERGE_CMD" ]; then
    # NIGHTSHIFT=1 tells merge-pr.sh to re-read the kill switch after the wait.
    # shellcheck disable=SC2086
    (cd "$WORKTREE" && NIGHTSHIFT=1 bounded "$MERGE_TIMEOUT" $MERGE_CMD "$pr") >"$run_dir/merge.log" 2>&1 || rc=$?
  else
    local waited=0 st
    while :; do
      st=$(gh pr view "$pr" --json state,isDraft,labels --jq '"\(.state) \(.isDraft) \([.labels[].name]|join(","))"')
      case "$st" in
        MERGED*) break ;;
        *"$BLOCKED_LABEL"*|"OPEN true"*|CLOSED*) rc=1; break ;;
      esac
      sleep 60; waited=$((waited + 60))
      [ "$waited" -ge "$(secs "$MERGE_TIMEOUT")" ] && { rc=124; break; }
    done
  fi
  if [ $rc = 0 ]; then
    log "task $n: landed as PR #$pr"
    return 0
  fi
  log "task $n: PR #$pr did not land (rc=$rc); marking $BLOCKED_LABEL"
  gh pr ready "$pr" --undo >/dev/null 2>&1 || true
  gh pr edit "$pr" --add-label "$BLOCKED_LABEL" >/dev/null 2>&1 || true
  gh pr comment "$pr" --body "Nightshift: CI did not pass or the merge timed out (rc=$rc). Log tail:
\`\`\`
$(tail -30 "$run_dir/merge.log" 2>/dev/null)
\`\`\`" >/dev/null 2>&1 || true
  return 1
}

# ---- one task --------------------------------------------------------------

run_task() { # run_task <n> <title>
  local n=$1 title=$2 branch feedback="" round=0 verdict="" rc
  branch=$(branch_for "$n")
  run_dir=$STATE_DIR/$(date +%F)-t$n
  mkdir -p "$run_dir"
  log "task $n: $title → $branch"

  ensure_worktree
  fresh_branch "$branch"
  "$here/task-brief" "$WORKTREE/$PLAN" "$n" "$run_dir/brief.md" >/dev/null || die "task $n has no section in $PLAN"

  while :; do
    log "  round $round: generator"
    ask "gen-$round" auto "$GEN_BUDGET" "$GEN_TIMEOUT" \
      "$(fill "$here/PROMPT.md" "TASK=$n" "TITLE=$title" "PLAN=$PLAN" "BRIEF=$run_dir/brief.md" "CHECK_CMD=$CHECK_CMD" "BASE=$BASE" "FEEDBACK=$feedback")" >/dev/null

    # Only committed work is judged. Anything left in the tree is discarded.
    if [ -n "$(gw status --porcelain)" ]; then
      log "  round $round: generator left uncommitted changes; discarding them"
      gw reset -q --hard && gw clean -fdq
    fi
    if [ "$(gw rev-list --count "origin/$BASE..HEAD")" = 0 ]; then
      log "task $n: no commits after round $round; last line: $(tail -1 "$run_dir/gen-$round.md")"
      return 2
    fi

    log "  round $round: verifier ($CHECK_CMD)"
    if run_check "$round"; then
      log "  round $round: skeptic"
      verdict=$(ask "skeptic-$round" plan "$SKEPTIC_BUDGET" "$SKEPTIC_TIMEOUT" \
        "$(fill "$here/SKEPTIC.md" "TASK=$n" "TITLE=$title" "BRIEF=$(cat "$run_dir/brief.md")" "DIFF=$(gw diff "origin/$BASE...HEAD" | head -c 200000)")" \
        | grep -E '^VERDICT:' | tail -1)
      log "  round $round: $verdict"
      case "$verdict" in
        "VERDICT: OK"*) break ;;
        *) feedback="A reviewer read your diff and refuted it. Fix this, or if the reviewer is wrong say why in your report:
$(cat "$run_dir/skeptic-$round.md")" ;;
      esac
    else
      log "  round $round: verifier red: $(grep -m1 '^ERROR' "$run_dir/check-$round.log" || tail -1 "$run_dir/check-$round.log")"
      feedback="The verifier ($CHECK_CMD) failed on your commits. Fix the cause, never the check:
$(tail -60 "$run_dir/check-$round.log")"
    fi
    if [ "$round" -ge "$REPAIR_ROUNDS" ]; then
      gw push -q -u origin "$branch" || die "push failed"
      pr=$(gh pr create --draft --base "$BASE" --head "$branch" --label "$BLOCKED_LABEL" \
        --title "[task $n] $title" --body "$(pr_body "$n" "$title" "blocked: $( [ -z "$verdict" ] && echo "verifier red" || echo "$verdict")")" \
        --json number --jq .number 2>/dev/null || gh pr view "$branch" --json number --jq .number)
      log "task $n: blocked after $((round + 1)) round(s); draft PR #$pr carries the evidence"
      return 1
    fi
    round=$((round + 1))
  done

  gw push -q -u origin "$branch" || die "push failed"
  pr=$(gh pr create --base "$BASE" --head "$branch" --label "$LABEL" \
    --title "[task $n] $title" --body "$(pr_body "$n" "$title" "$verdict")" \
    --json number --jq .number 2>/dev/null || gh pr view "$branch" --json number --jq .number)
  log "task $n: PR #$pr open, handing to the gate"
  land_pr "$n" "$pr"
}

# ---- the night -------------------------------------------------------------

# One run at a time. A stale lock from a killed run is taken over.
lock=$STATE_DIR/lock
if ! mkdir "$lock" 2>/dev/null; then
  if [ -f "$lock/pid" ] && kill -0 "$(cat "$lock/pid")" 2>/dev/null; then die "another run holds $lock (pid $(cat "$lock/pid"))"; fi
  rm -rf "$lock"; mkdir "$lock" || die "cannot take $lock"
fi
echo $$ >"$lock/pid"
trap 'rm -rf "$lock"' EXIT

log "start: $PLAN, max $MAX, deadline $DEADLINE, model $MODEL$( [ $dry = 1 ] && echo ' (dry run)')"
[ -f "$repo/$PLAN" ] || die "no plan at $PLAN"
git -C "$repo" fetch -q origin || die "fetch failed"
switch_is_run || stop "frozen"

landed=0
while IFS=$'\t' read -r n title; do
  [ -n "$n" ] || continue
  if [ -n "$only" ] && [ "$n" != "$only" ]; then continue; fi
  if [ -z "$only" ] && task_done "$n"; then continue; fi

  # Anything GitHub already knows about this task settles it before new work.
  closed=$(closed_unmerged_pr "$n")
  [ -z "$closed" ] || stop "task $n: PR #$closed was closed without merging; a human decided"
  IFS=$'\t' read -r pr draft labels <<<"$(open_pr "$n")"
  if [ -n "${pr:-}" ]; then
    case "$draft,$labels" in
      true,*|*"$BLOCKED_LABEL"*) stop "task $n: PR #$pr is blocked, waiting for a human" ;;
    esac
    [ $dry = 1 ] && stop "would wait on open PR #$pr for task $n"
    log "task $n: resuming on open PR #$pr"
    run_dir=$STATE_DIR/$(date +%F)-t$n; mkdir -p "$run_dir"; round=0
    land_pr "$n" "$pr" || stop "task $n did not land"
    landed=$((landed + 1))
  else
    [ $dry = 1 ] && stop "would run task $n: $title"
    [ "$landed" -lt "$MAX" ] || stop "$MAX task(s) landed, that is the night"
    past_deadline && stop "deadline $DEADLINE reached"
    switch_is_run || stop "frozen"
    run_task "$n" "$title"; rc=$?
    case $rc in
      0) landed=$((landed + 1)) ;;
      2) stop "task $n produced nothing; a human should read $run_dir" ;;
      *) stop "task $n is blocked" ;;
    esac
  fi
  [ -n "$only" ] && break
done < <(plan_tasks)

[ $dry = 1 ] && stop "nothing to do: every task of $slug is landed"
stop "done: $landed task(s) landed tonight"
