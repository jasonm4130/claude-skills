#!/usr/bin/env bash
# Nightwatch launcher: walk a queue of outcome specs in a clone that never
# pushes, one headless `claude -p` per unit, landing passed outcomes onto an
# integration branch cut from main. The morning pushes that branch and opens
# one PR; branch protection on main is untouched.
#
#   nightwatch/run.sh <clone> <specs-dir> [--dry-run] [--only <slug>[,<slug>...]]
#
# Layout it expects:
#   <clone>                 a git clone of the repo, origin = GitHub, clean
#   <specs-dir>/NN-slug.md  specs in queue order (Outcome / Acceptance / Non-goals / Context)
#   ~/.local/state/nightwatch/<name>/   journal.md, decisions.jsonl, landed, control, runs/<stamp>/
#
# Spec header lines, between the `# title` line and the first `## ` heading:
#   Repo: <path>              where the outcome lives (documentation; the clone is argv[1])
#   Depends: <slug>[, ...]    do not start until each slug has a landed SHA the
#                             landing branch (or origin/<BASE>) can reach
#   Units: <n>                cap this spec at n units, overriding MAX_UNITS
#   Writes: <path>[, ...]     files an acceptance command creates (documentation)
#
# Steering a live run, all at unit boundaries (before each unit, before each spec):
#   $STATE/control    append-only, one command per line, never truncated or renamed:
#                       stop            finish this unit, then end the night
#                       skip <slug>     do not start that spec; the current one
#                                       ends after this unit as PARTIAL
#                       requeue <slug>  append that spec to the queue again
#                     The launcher keeps $STATE/control.offset (bytes consumed) and
#                     reads only complete lines, so nothing an operator appends is lost.
#   $STATE/pause      while this file exists the launcher waits at the boundary.
#   $STATE/landed     one line per landed outcome, tab separated:
#                       <slug> <run-stamp> <base-sha> <landed-sha> <spec-path>
#                     (base = the landing branch head before the fast-forward.)
#
# Stops for the night on: the kill switch (repo variable STATE_VAR != run),
# the DEADLINE, `stop` in the control file, or the end of the queue. Each stop
# is one journal line.
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
: "${MAX_UNITS:=8}"                  # per outcome, unless the spec says Units:
: "${MAIN_MODEL:=sonnet}"            # the claude -p driver; phases pick their own models
: "${SETTING_SOURCES:=user,project}" # user, so the worker agent and the advisor resolve
: "${POLL_S:=30}"                    # watchdog and pause poll interval; the tests set it low
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
# One launcher per repo: two would both build $LANDING in separate clones and only one could ever push it.
LOCK=$STATE/launcher.lock
take_lock() { ( set -C; echo $$ > "$LOCK" ) 2>/dev/null; }   # noclobber: create-or-fail is one syscall
if ! take_lock; then
  owner=$(cat "$LOCK" 2>/dev/null)
  if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then echo "STOP: launcher pid $owner already owns $NAME (lock $LOCK)" >&2; exit 2; fi
  # A dead owner's lock is taken over by renaming it away: mv is atomic, so of two
  # launchers that both saw the stale lock only one removes it, and neither can
  # remove the other's fresh lock.
  if mv "$LOCK" "$LOCK.stale.$$" 2>/dev/null; then
    if [ "$(cat "$LOCK.stale.$$" 2>/dev/null)" = "$owner" ]; then rm -f "$LOCK.stale.$$"
    else mv "$LOCK.stale.$$" "$LOCK" 2>/dev/null; echo "STOP: $LOCK changed hands while being taken over" >&2; exit 2; fi   # we grabbed a fresh lock, not the stale one
  fi
  take_lock || { echo "STOP: lost the race for $LOCK" >&2; exit 2; }
fi
trap '[ "$(cat "$LOCK" 2>/dev/null)" = "$$" ] && rm -f "$LOCK"' EXIT   # only ever remove our own lock
# The lock names its holder; a launcher that finds another pid there has been
# displaced (a takeover race, or an operator) and ends the night at the next boundary.
holds_lock() { [ "$(cat "$LOCK" 2>/dev/null)" = "$$" ] || { log "STOP: $LOCK is held by $(cat "$LOCK" 2>/dev/null || echo nobody), not this launcher"; return 1; }; }
DECISIONS=$STATE/decisions.jsonl
LANDEDF=$STATE/landed
CONTROL=$STATE/control

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$JOURNAL" >&2; } # stderr: stdout carries unit states
record() { # record <spec> <unit> <state> <json-envelope-path> <startedAt> <endedAt> <durationS>
  jq -c --arg spec "$1" --arg unit "$2" --arg state "$3" --arg run "$stamp" --arg branch "$branch" \
    --arg startedAt "$5" --arg endedAt "$6" --argjson durationS "$7" \
    '{ts: (now|todate), run: $run, spec: $spec, unit: ($unit|tonumber), state: $state, branch: $branch, cost: (.total_cost_usd // 0), turns: (.num_turns // 0), startedAt: $startedAt, endedAt: $endedAt, durationS: $durationS}' \
    "$4" >>"$DECISIONS" 2>/dev/null || true
}
secs() { case "$1" in *h) echo $(( ${1%h} * 3600 )) ;; *m) echo $(( ${1%m} * 60 )) ;; *s) echo "${1%s}" ;; *) echo "$1" ;; esac; }
started=$(date +%s); deadline=$(secs "$DEADLINE")
past_deadline() { [ $(( $(date +%s) - started )) -ge "$deadline" ]; }
switch_says_run() {
  local v; v=$(cd "$CLONE" && gh variable get "$STATE_VAR" 2>/dev/null || echo "unset")
  [ "$v" = "run" ] || { log "kill switch: $STATE_VAR=$v"; return 1; }
}

# ---------- spec headers ----------
# The header is everything between the `# title` line and the first `## ` heading.
spec_field() { # spec_field <spec> <Field> → the field's value, or empty
  sed -n '1,/^## /p' "$1" | sed -n "/^$2:/s/^$2:[[:space:]]*//p" | head -1 | sed 's/[[:space:]]*$//'
}

# ---------- the control file ----------
# Append-only, read forward from the offset we have consumed. A trailing partial
# line (a writer mid-append) is left for the next boundary, so no order is lost.
ctl_stop=0; ctl_skip=""
drain_control() {
  [ -f "$CONTROL" ] || return 0
  local off size chunk complete last partial line cmd arg
  off=$(cat "$CONTROL.offset" 2>/dev/null || echo 0)
  case "$off" in ''|*[!0-9]*) off=0 ;; esac
  size=$(wc -c <"$CONTROL" | tr -d ' ')
  [ "$size" -gt "$off" ] || return 0
  chunk=$RUN/control.chunk
  tail -c "+$((off + 1))" "$CONTROL" >"$chunk"
  complete=$(wc -c <"$chunk" | tr -d ' ')
  last=$(tail -c 1 "$chunk")            # empty when the last byte is a newline
  if [ -n "$last" ]; then
    partial=$(tail -n 1 "$chunk" | wc -c | tr -d ' ')
    complete=$((complete - partial))
  fi
  [ "$complete" -gt 0 ] || return 0
  head -c "$complete" "$chunk" >"$chunk.lines"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    cmd=${line%% *}; arg=${line#* }; [ "$arg" != "$line" ] || arg=""
    case "$cmd" in
      stop) ctl_stop=1; log "control: stop" ;;
      skip) ctl_skip="$ctl_skip $arg"; log "control: skip $arg" ;;
      requeue)
        if [ -f "$SPECS/$arg.md" ]; then
          queue[$qn]=$SPECS/$arg.md; qn=$((qn + 1)); log "control: requeue $arg"
        else log "control: requeue $arg ignored (no $SPECS/$arg.md)"; fi ;;
      *) log "control: ignoring unknown line \"$line\"" ;;
    esac
  done <"$chunk.lines"
  echo $((off + complete)) >"$CONTROL.offset"
}

wait_while_paused() { # 1 when the night should end rather than resume
  local logged=0
  while [ -e "$STATE/pause" ]; do
    [ "$logged" = 1 ] || { log "paused: waiting while $STATE/pause exists"; logged=1; }
    past_deadline && { log "STOP: deadline $DEADLINE reached while paused"; return 1; }
    switch_says_run || return 1
    sleep "$POLL_S"
  done
  return 0
}

# ---------- dependencies ----------
# A dependency is met only when some landed row for it names a SHA the landing
# branch (or origin/<BASE>) can reach: a row from a night whose integration
# branch was never merged is not a landing.
dep_unmet=""
deps_met() { # deps_met <spec>
  local spec=$1 deps dep ok d sha
  dep_unmet=""
  deps=$(spec_field "$spec" Depends | tr ',' ' ')
  [ -n "$deps" ] || return 0
  for dep in $deps; do
    ok=0
    if [ -f "$LANDEDF" ]; then
      while IFS="$(printf '\t')" read -r d _ _ sha _; do
        [ "$d" = "$dep" ] && [ -n "$sha" ] || continue
        if git merge-base --is-ancestor "$sha" "$LANDING" 2>/dev/null ||
           git merge-base --is-ancestor "$sha" "origin/$BASE" 2>/dev/null; then ok=1; break; fi
      done <"$LANDEDF"
    fi
    [ "$ok" = 1 ] || { dep_unmet=$dep; return 1; }
  done
  return 0
}

# ---------- verify evidence ----------
# A PASS is only as good as the logs its acceptance commands wrote. Each entry
# names the file the command wrote; the file must exist and its last line must
# be the exit code the entry claims.
evidence_bad=0; evidence_total=0; evidence_cmd=""
verify_evidence() { # verify_evidence <result-json>
  local lp ex cmd last
  evidence_bad=0; evidence_total=0; evidence_cmd=""
  while IFS="$(printf '\t')" read -r lp ex cmd; do
    [ -n "$cmd$lp$ex" ] || continue
    evidence_total=$((evidence_total + 1))
    if [ ! -s "$lp" ]; then
      evidence_bad=$((evidence_bad + 1)); [ -n "$evidence_cmd" ] || evidence_cmd=$cmd; continue
    fi
    last=$(tail -1 "$lp")
    [ "$last" = "exit=$ex" ] || { evidence_bad=$((evidence_bad + 1)); [ -n "$evidence_cmd" ] || evidence_cmd=$cmd; }
  done <<EOF
$(jq -r '(.verify.results // [])[] | [(.log // ""), (.exit // ""), (.command // "")] | @tsv' "$1" 2>/dev/null)
EOF
  # A PASS that verified nothing is not a PASS: no command, no log, no evidence.
  [ "$evidence_total" -gt 0 ] || { evidence_bad=1; evidence_cmd="(no verify results in the result file)"; }
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
elif git show-ref --verify --quiet "refs/remotes/origin/$LANDING"; then
  git switch -q -c "$LANDING" --track "origin/$LANDING" || { log "STOP: cannot track origin/$LANDING"; exit 1; }
  log "landing branch $LANDING exists on origin at $(git rev-parse --short HEAD); continuing on it"
else
  git switch -q -c "$LANDING" "origin/$BASE" || { log "STOP: cannot cut $LANDING from origin/$BASE"; exit 1; }
  log "landing branch $LANDING cut from origin/$BASE at $(git rev-parse --short HEAD)"
fi
switch_says_run || exit 0

# The queue is an array, not a `for` over the glob, so `requeue` can append to it.
queue=(); qn=0
for spec in "$SPECS"/*.md; do
  [ -f "$spec" ] || continue
  slug=$(basename "$spec" .md)
  if [ -n "$only" ]; then
    case ",$only," in *",$slug,"*) ;; *) continue ;; esac
  fi
  queue[$qn]=$spec; qn=$((qn + 1))
done
log "start: $NAME, run $stamp, base $BASE, queue $qn spec(s), deadline $DEADLINE, unit budget \$$UNIT_BUDGET, max $MAX_UNITS units$( [ $dry = 1 ] && echo ' (dry run)')"

# ---------- one unit ----------
unit_run() { # unit_run <spec-path> <unit-index> <check-verified 0|1> → writes $RUN/<slug>-u<n>.json, prints state
  local spec=$1 n=$2 cv=$3
  local out=$RUN/$slug-u$n.json
  local argsjson prompt head_before startedAt endedAt t_start t_end
  argsjson=$(jq -nc --arg repo "$CLONE" --arg spec "$spec" --arg branch "$branch" --arg landing "$LANDING" \
    --argjson unit "$n" --argjson max "$units" --arg runDir "$STATE/outcomes/$slug" --argjson cv "$( [ "$cv" = 1 ] && echo true || echo false )" --argjson dry "$( [ $dry = 1 ] && echo true || echo false )" \
    '{repo:$repo, spec:$spec, branch:$branch, landingBranch:$landing, unit:$unit, maxUnits:$max, runDir:$runDir, checkVerified:$cv, dryRun:$dry}')
  # The brief and the result files live per outcome, not per launch, so a relaunch
  # after a kill sees the unit that was in flight. A stale result from an earlier
  # launch must not be mistaken for this unit's, so it is removed first. The spec
  # is snapshotted per unit: an operator may edit it between units, and the
  # morning must read the exact contract the passing unit ran against.
  mkdir -p "$STATE/outcomes/$slug"; rm -f "$STATE/outcomes/$slug/u$n.result.json"
  cp "$spec" "$STATE/outcomes/$slug/u$n.spec.md"
  head_before=$(git rev-parse HEAD)
  prompt="Run the Workflow tool with scriptPath \"$here/nightwatch.mjs\" and args $argsjson (pass args as a JSON object, not a string). The workflow runs in the background and can take over an hour: do not answer while it is still running, and never invent its result. When it has returned, reply with the object it returned, as JSON, unchanged. If it throws or is aborted, reply with {\"state\":\"FAILED\",\"unitTitle\":\"\",\"summary\":\"<the error text>\",\"blockedReason\":\"\",\"commits\":[]}."
  # The child gets its own process group (set -m) so the watchdog can kill the
  # whole tree mid-unit: on the wall-clock cap, or when the repo variable stops
  # saying run. That is the phone kill; nothing in the old loop had it.
  startedAt=$(date -u +%FT%TZ); t_start=$(date +%s)
  set -m
  (env "${scrub[@]}" "${unsigned[@]}" "${noscrub[@]}" claude -p "$prompt" \
      --permission-mode auto --permission-prompts none --add-dir "$STATE" --add-dir "$SPECS" --add-dir "$here" \
      --allowedTools "Workflow,Agent,Read,Write,Edit,Bash,Glob,Grep,ToolSearch,Skill,WebFetch,WebSearch,StructuredOutput,advisor" \
      --setting-sources "$SETTING_SOURCES" --settings '{"env":{"CLAUDE_CODE_SUBPROCESS_ENV_SCRUB":"0"}}' --no-session-persistence \
      --max-budget-usd "$UNIT_BUDGET" --model "$MAIN_MODEL" --output-format json --json-schema "$UNIT_SCHEMA" \
      </dev/null) >"$out" 2>"$RUN/$slug-u$n.stderr" &
  local pid=$! t0 ticks=0 killed=""
  set +m
  t0=$(date +%s)
  while kill -0 "$pid" 2>/dev/null; do
    sleep "$POLL_S"; ticks=$((ticks+1))
    if [ $(( $(date +%s) - t0 )) -ge "$(secs "$UNIT_TIMEOUT")" ]; then killed="timeout $UNIT_TIMEOUT"; fi
    if [ $((ticks % 2)) -eq 0 ] && ! switch_says_run; then killed="kill switch"; fi
    if [ -n "$killed" ]; then
      kill -TERM -- "-$pid" 2>/dev/null; sleep 20; kill -KILL -- "-$pid" 2>/dev/null
      log "  $slug u$n: killed ($killed)"
      break
    fi
  done
  wait "$pid" 2>/dev/null
  endedAt=$(date -u +%FT%TZ); t_end=$(date +%s)
  local cost turns commits
  cost=$(jq -r '.total_cost_usd // 0' "$out" 2>/dev/null || echo 0)
  turns=$(jq -r '.num_turns // 0' "$out" 2>/dev/null || echo 0)
  # The unit's own record, written by the workflow's last agent; the driver's reply
  # is only a fallback for cost and turns. No file means the workflow never finished
  # — but commits on the branch mean it died with work done, which is PARTIAL, not
  # FAILED: the commits are kept and the next unit continues from them.
  local res=$STATE/outcomes/$slug/u$n.result.json
  if [ -s "$res" ]; then
    state=$(jq -r '.state // empty' "$res" 2>/dev/null)
    title=$(jq -r '.unitTitle // ""' "$res" 2>/dev/null)
    summary=$(jq -r '(.blockedReason // "") + " " + (.summary // "")' "$res" 2>/dev/null | tr '\n' ' ' | cut -c1-400)
    verify_evidence "$res"
    if [ "$state" = PASS ] && [ "$evidence_bad" -gt 0 ]; then
      state=PARTIAL; summary="verify evidence missing for $evidence_cmd"
    elif [ "$evidence_bad" -gt 0 ]; then
      log "  $slug u$n: $evidence_bad of $evidence_total verify commands have no log"
    fi
  else
    commits=$(git rev-list --count "$head_before"..HEAD 2>/dev/null || echo 0)
    title=""
    if [ "$commits" -gt 0 ]; then
      state=PARTIAL; summary="workflow died after $commits commit(s): $(grep -v '^$' "$RUN/$slug-u$n.stderr" 2>/dev/null | tail -1 | cut -c1-200)"
    else
      state=FAILED; summary="no result file from the workflow (killed, crashed, or the driver quit early): $(grep -v '^$' "$RUN/$slug-u$n.stderr" 2>/dev/null | tail -1 | cut -c1-200)"
    fi
  fi
  [ -n "$state" ] || state=FAILED
  log "  $slug u$n: $state — $title (\$$cost, $turns turns) $summary"
  record "$slug" "$n" "$state" "$out" "$startedAt" "$endedAt" "$((t_end - t_start))"
  echo "$state"
}

# ---------- the queue ----------
landed=0
i=0
# `while :` rather than a bounded loop: the boundary drain runs even when the
# queue looks exhausted, so a `requeue` appended during the last unit is seen.
while :; do
  drain_control
  wait_while_paused || break
  [ "$ctl_stop" = 1 ] && { log "STOP: control file said stop"; break; }
  [ "$i" -lt "$qn" ] || break
  spec=${queue[$i]}; i=$((i + 1))
  slug=$(basename "$spec" .md)
  case " $ctl_skip " in *" $slug "*) log "$slug: skipped (control file)"; continue ;; esac
  past_deadline && { log "STOP: deadline $DEADLINE reached before $slug"; break; }
  switch_says_run || break
  holds_lock || break
  branch=nw/$DATE/$slug   # not under $LANDING: a ref cannot be both a file and a directory
  git switch -q "$LANDING"
  deps_met "$spec" || { log "$slug: waiting on $dep_unmet"; continue; }
  units=$(spec_field "$spec" Units)
  case "$units" in ''|*[!0-9]*|0) units=$MAX_UNITS ;; esac
  if git show-ref --verify --quiet "refs/heads/$branch"; then
    git switch -q "$branch"; log "$slug: resuming branch $branch at $(git rev-parse --short HEAD)"
  else
    git switch -q -c "$branch"; log "$slug: branch $branch cut from $LANDING"
  fi
  cv=0; final=""
  for n in $(seq 1 "$units"); do
    if [ "$n" -gt 1 ]; then
      drain_control
      wait_while_paused || { final=PARTIAL; break; }
      [ "$ctl_stop" = 1 ] && { final=PARTIAL; break; }
      case " $ctl_skip " in *" $slug "*) log "  $slug: skipped mid-spec (control file); PARTIAL"; final=PARTIAL; break ;; esac
    fi
    past_deadline && { log "  $slug: deadline reached after unit $((n-1)); PARTIAL"; final=PARTIAL; break; }
    switch_says_run || { final=KILLED; break; }
    holds_lock || { final=KILLED; break; }
    st=$(unit_run "$spec" "$n" "$cv")
    case "$st" in
      CONTINUE) cv=1; continue ;;
      PASS|PARTIAL|BLOCKED|FAILED|DRYRUN) final=$st; break ;;
      *) final=FAILED; break ;;
    esac
  done
  [ -n "$final" ] || final=PARTIAL
  # Untracked, non-ignored files after a unit are artefacts an acceptance command wrote (a screenshot,
  # a report): the worker commits what it makes. Drop them; stash only tracked modifications.
  git clean -fdq || true
  [ -z "$(git status --porcelain)" ] || { log "  $slug: tree left dirty; stashing to nightwatch/$slug-dirty"; git stash push -q -m "nightwatch/$slug-dirty" || true; }
  case "$final" in
    PASS)
      git switch -q "$LANDING"
      base_sha=$(git rev-parse HEAD)
      if git merge -q --ff-only "$branch"; then
        landed=$((landed+1))
        printf '%s\t%s\t%s\t%s\t%s\n' "$slug" "$stamp" "$base_sha" "$(git rev-parse HEAD)" "$spec" >>"$LANDEDF"
        log "$slug: PASS, landed on $LANDING at $(git rev-parse --short HEAD)"; git branch -q -d "$branch"
      else log "$slug: PASS but fast-forward onto $LANDING failed; branch kept for the morning"; fi ;;
    DRYRUN) log "$slug: dry run complete"; git switch -q "$LANDING"; git branch -q -D "$branch" ;;
    KILLED) log "STOP: kill switch during $slug; branch $branch kept"; break ;;
    *) log "$slug: $final; branch $branch kept with $(git rev-list --count "$LANDING".."$branch") commit(s) for the morning" ;;
  esac
done
git switch -q "$LANDING" 2>/dev/null || true
ahead=$(git rev-list --count "origin/$BASE..$LANDING" 2>/dev/null || echo "?")
log "end: $landed outcome(s) landed on $LANDING; $ahead commit(s) ahead of origin/$BASE. Morning: git -C $CLONE push -u origin $LANDING && gh pr create"
