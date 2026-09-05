#!/usr/bin/env bash
# Nightwatch v0 launcher: walk a queue of outcome specs in a clone that never
# pushes, one headless `claude -p` per unit, landing passed outcomes onto an
# integration branch cut from main. The morning pushes that branch and opens
# one PR; branch protection on main is untouched.
#
#   nightwatch/run.sh <clone> <specs-dir> [--dry-run] [--only <slug>]
#
# Layout it expects:
#   <clone>                 a git clone of the repo, origin = GitHub, clean
#   <specs-dir>/NN-slug.md  specs in queue order (Outcome / Acceptance / Non-goals / Context)
#   ~/.local/state/nightwatch/<name>/   journal.md, decisions.jsonl, runs/<stamp>/
#
# Stops for the night on: the kill switch (repo variable STATE_VAR != run),
# the DEADLINE, or the end of the queue. Each stop is one journal line.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
CLONE=${1:?clone dir}; SPECS=${2:?specs dir}; shift 2
dry=0; only=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1 ;;
    --only) only=$2; shift ;;
    *) echo "unknown arg $1" >&2; exit 64 ;;
  esac
  shift
done

: "${STATE_VAR:=LANDING_STATE}"      # repo variable; anything but "run" stops the night
: "${DEADLINE:=7h}"                  # no new unit after this
: "${UNIT_BUDGET:=8}"                # --max-budget-usd per unit (one claude -p)
: "${UNIT_TIMEOUT:=150m}"            # wall clock per unit (three repo checks plus a worker)
: "${MAX_UNITS:=8}"                  # per outcome
: "${MAIN_MODEL:=sonnet}"            # the claude -p driver; phases pick their own models
: "${SETTING_SOURCES:=user,project}" # user, so the worker agent and the advisor resolve
: "${DATE:=$(date +%Y-%m-%d)}"
: "${LANDING:=nightwatch/$DATE}"
: "${BASE:=main}"

CLONE=$(cd "$CLONE" && pwd); SPECS=$(cd "$SPECS" && pwd)
NAME=$(basename "$CLONE")
STATE=$HOME/.local/state/nightwatch/$NAME
stamp=$(date +%Y%m%d-%H%M%S)
RUN=$STATE/runs/$stamp
mkdir -p "$RUN"
JOURNAL=$STATE/journal.md
DECISIONS=$STATE/decisions.jsonl

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$JOURNAL" >&2; } # stderr: stdout carries unit states
record() { # record <spec> <unit> <state> <json-envelope-path>
  jq -c --arg spec "$1" --arg unit "$2" --arg state "$3" --arg run "$stamp" --arg branch "$branch" \
    '{ts: (now|todate), run: $run, spec: $spec, unit: ($unit|tonumber), state: $state, branch: $branch, cost: (.total_cost_usd // 0), turns: (.num_turns // 0)}' \
    "$4" >>"$DECISIONS" 2>/dev/null || true
}
secs() { case "$1" in *h) echo $(( ${1%h} * 3600 )) ;; *m) echo $(( ${1%m} * 60 )) ;; *s) echo "${1%s}" ;; *) echo "$1" ;; esac; }
started=$(date +%s); deadline=$(secs "$DEADLINE")
past_deadline() { [ $(( $(date +%s) - started )) -ge "$deadline" ]; }
switch_says_run() {
  local v; v=$(cd "$CLONE" && gh variable get "$STATE_VAR" 2>/dev/null || echo "unset")
  [ "$v" = "run" ] || { log "kill switch: $STATE_VAR=$v"; return 1; }
}

# The claude -p child must not inherit this session's identity (a nested claude
# forces default permission mode), and commits are unsigned because the signing
# agent is locked at 03:00. Same reasoning as land.sh.
unsigned=(GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false)
# The user settings set CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1, and a claude that sees
# it forces default permission mode, where every unlisted tool is a prompt nobody
# answers. The run is isolated in its own clone, so opt out for the child.
noscrub=(CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0 CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0)  # the Workflow is a background task; never give up on it
scrub=(-u CLAUDECODE -u CLAUDE_CODE_SUBPROCESS_ENV_SCRUB -u CLAUDE_CODE_CHILD_SESSION
  -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_BRIDGE_SESSION_ID -u CLAUDE_CODE_MESSAGING_SOCKET
  -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_PID -u CLAUDE_EFFORT)

UNIT_SCHEMA='{"type":"object","properties":{"state":{"type":"string","enum":["CONTINUE","PASS","PARTIAL","BLOCKED","FAILED","DRYRUN"]},"unit":{"type":"integer"},"unitTitle":{"type":"string"},"summary":{"type":"string"},"blockedReason":{"type":"string"},"commits":{"type":"array","items":{"type":"string"}}},"required":["state","unitTitle","summary","blockedReason","commits"]}'

# ---------- preflight ----------
cd "$CLONE" || exit 1
command -v claude >/dev/null || { log "STOP: claude not on PATH"; exit 1; }
[ -n "${ANTHROPIC_API_KEY:-}" ] && { log "STOP: ANTHROPIC_API_KEY is set; this run bills to the subscription only"; exit 1; }
[ -z "$(git status --porcelain)" ] || { log "STOP: clone is dirty"; exit 1; }
git fetch -q origin || { log "STOP: git fetch failed"; exit 1; }
if git show-ref --verify --quiet "refs/heads/$LANDING"; then
  git switch -q "$LANDING"
  log "landing branch $LANDING exists at $(git rev-parse --short HEAD); continuing on it"
else
  git switch -q -c "$LANDING" "origin/$BASE" || { log "STOP: cannot cut $LANDING from origin/$BASE"; exit 1; }
  log "landing branch $LANDING cut from origin/$BASE at $(git rev-parse --short HEAD)"
fi
switch_says_run || exit 0
log "start: $NAME, queue $(ls "$SPECS"/*.md 2>/dev/null | wc -l | tr -d ' ') spec(s), deadline $DEADLINE, unit budget \$$UNIT_BUDGET, max $MAX_UNITS units$( [ $dry = 1 ] && echo ' (dry run)')"

# ---------- one unit ----------
unit_run() { # unit_run <spec-path> <unit-index> <check-verified 0|1> → writes $RUN/<slug>-u<n>.json, prints state
  local spec=$1 n=$2 cv=$3
  local out=$RUN/$slug-u$n.json
  local argsjson prompt
  argsjson=$(jq -nc --arg repo "$CLONE" --arg spec "$spec" --arg branch "$branch" --arg landing "$LANDING" \
    --argjson unit "$n" --argjson max "$MAX_UNITS" --arg runDir "$RUN/$slug" --argjson cv "$( [ "$cv" = 1 ] && echo true || echo false )" --argjson dry "$( [ $dry = 1 ] && echo true || echo false )" \
    '{repo:$repo, spec:$spec, branch:$branch, landingBranch:$landing, unit:$unit, maxUnits:$max, runDir:$runDir, checkVerified:$cv, dryRun:$dry}')
  mkdir -p "$RUN/$slug"
  prompt="Run the Workflow tool with scriptPath \"$here/nightwatch.mjs\" and args $argsjson (pass args as a JSON object, not a string). The workflow runs in the background and can take over an hour: do not answer while it is still running, and never invent its result. When it has returned, reply with the object it returned, as JSON, unchanged. If it throws or is aborted, reply with {\"state\":\"FAILED\",\"unitTitle\":\"\",\"summary\":\"<the error text>\",\"blockedReason\":\"\",\"commits\":[]}."
  # The child gets its own process group (set -m) so the watchdog can kill the
  # whole tree mid-unit: on the wall-clock cap, or when the repo variable stops
  # saying run. That is the phone kill; nothing in the old loop had it.
  set -m
  (env "${scrub[@]}" "${unsigned[@]}" "${noscrub[@]}" claude -p "$prompt" \
      --permission-mode auto --permission-prompts none --add-dir "$RUN" --add-dir "$SPECS" --add-dir "$here" \
      --allowedTools "Workflow,Agent,Read,Write,Edit,Bash,Glob,Grep,ToolSearch,Skill,WebFetch,WebSearch,StructuredOutput,advisor" \
      --setting-sources "$SETTING_SOURCES" --settings '{"env":{"CLAUDE_CODE_SUBPROCESS_ENV_SCRUB":"0"}}' --no-session-persistence \
      --max-budget-usd "$UNIT_BUDGET" --model "$MAIN_MODEL" --output-format json --json-schema "$UNIT_SCHEMA" \
      </dev/null) >"$out" 2>"$RUN/$slug-u$n.stderr" &
  local pid=$! t0 ticks=0 killed=""
  set +m
  t0=$(date +%s)
  while kill -0 "$pid" 2>/dev/null; do
    sleep 30; ticks=$((ticks+1))
    if [ $(( $(date +%s) - t0 )) -ge "$(secs "$UNIT_TIMEOUT")" ]; then killed="timeout $UNIT_TIMEOUT"; fi
    if [ $((ticks % 2)) -eq 0 ] && ! switch_says_run; then killed="kill switch"; fi
    if [ -n "$killed" ]; then
      kill -TERM -- "-$pid" 2>/dev/null; sleep 20; kill -KILL -- "-$pid" 2>/dev/null
      log "  $slug u$n: killed ($killed)"
      break
    fi
  done
  wait "$pid" 2>/dev/null
  local cost turns
  cost=$(jq -r '.total_cost_usd // 0' "$out" 2>/dev/null || echo 0)
  turns=$(jq -r '.num_turns // 0' "$out" 2>/dev/null || echo 0)
  # The unit's own record, written by the workflow's last agent; the driver's reply
  # is only a fallback for cost and turns. No file means the workflow never finished.
  local res=$RUN/$slug/u$n.result.json
  if [ -s "$res" ]; then
    state=$(jq -r '.state // empty' "$res" 2>/dev/null)
    title=$(jq -r '.unitTitle // ""' "$res" 2>/dev/null)
    summary=$(jq -r '(.blockedReason // "") + " " + (.summary // "")' "$res" 2>/dev/null | tr '\n' ' ' | cut -c1-400)
  else
    state=FAILED; title=""; summary="no result file from the workflow (killed, crashed, or the driver quit early): $(grep -v '^$' "$RUN/$slug-u$n.stderr" 2>/dev/null | tail -1 | cut -c1-200)"
  fi
  [ -n "$state" ] || state=FAILED
  log "  $slug u$n: $state — $title (\$$cost, $turns turns) $summary"
  record "$slug" "$n" "$state" "$out"
  echo "$state"
}

# ---------- the queue ----------
landed=0
for spec in "$SPECS"/*.md; do
  [ -f "$spec" ] || continue
  slug=$(basename "$spec" .md)
  [ -z "$only" ] || [ "$slug" = "$only" ] || continue
  past_deadline && { log "STOP: deadline $DEADLINE reached before $slug"; break; }
  switch_says_run || break
  branch=nw/$DATE/$slug   # not under $LANDING: a ref cannot be both a file and a directory
  git switch -q "$LANDING"
  if git show-ref --verify --quiet "refs/heads/$branch"; then
    git switch -q "$branch"; log "$slug: resuming branch $branch at $(git rev-parse --short HEAD)"
  else
    git switch -q -c "$branch"; log "$slug: branch $branch cut from $LANDING"
  fi
  cv=0; final=""
  for n in $(seq 1 "$MAX_UNITS"); do
    past_deadline && { log "  $slug: deadline reached after unit $((n-1)); PARTIAL"; final=PARTIAL; break; }
    switch_says_run || { final=KILLED; break; }
    st=$(unit_run "$spec" "$n" "$cv")
    case "$st" in
      CONTINUE) cv=1; continue ;;
      PASS|PARTIAL|BLOCKED|FAILED|DRYRUN) final=$st; break ;;
      *) final=FAILED; break ;;
    esac
  done
  [ -n "$final" ] || final=PARTIAL
  [ -z "$(git status --porcelain)" ] || { log "  $slug: tree left dirty; stashing to nightwatch/$slug-dirty"; git stash push -q -m "nightwatch/$slug-dirty" || true; }
  case "$final" in
    PASS)
      git switch -q "$LANDING"
      if git merge -q --ff-only "$branch"; then landed=$((landed+1)); log "$slug: PASS, landed on $LANDING at $(git rev-parse --short HEAD)"; git branch -q -d "$branch"
      else log "$slug: PASS but fast-forward onto $LANDING failed; branch kept for the morning"; fi ;;
    DRYRUN) log "$slug: dry run complete"; git switch -q "$LANDING"; git branch -q -D "$branch" ;;
    KILLED) log "STOP: kill switch during $slug; branch $branch kept"; break ;;
    *) log "$slug: $final; branch $branch kept with $(git rev-list --count "$LANDING".."$branch") commit(s) for the morning" ;;
  esac
done
git switch -q "$LANDING" 2>/dev/null || true
ahead=$(git rev-list --count "origin/$BASE..$LANDING" 2>/dev/null || echo "?")
log "end: $landed outcome(s) landed on $LANDING; $ahead commit(s) ahead of origin/$BASE. Morning: git -C $CLONE push -u origin $LANDING && gh pr create"
