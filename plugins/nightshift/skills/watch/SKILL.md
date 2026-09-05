---
name: watch
description: "Use when a Nightwatch spec queue is about to run, or is already running, and someone needs to fire it, watch it, and steer it — \"launch nightwatch\", \"watch the run\", \"/nightwatch:watch\", \"pause it\", \"skip that spec\". Runs preflight, launches run.sh, arms the journal and workflow-journal monitors, knows what is safe to change mid-run, and reads the interventions (control file, pause file, kill switch) plus when to hand off to morning.mjs. Do NOT use to write a spec (nightwatch:spec) or to implement the outcome's code yourself — the launcher's `claude -p` units do that, never this session."
---

# Watch a Nightwatch run

The first night failed five ways in the harness and once in the code: a
print-mode timeout that fabricated a result, an env var that silently forced
default permission mode, an untrusted clone that dropped project settings, a
`tee` that polluted the state channel, and a dirty-tree false positive on a
file the acceptance command itself wrote — against one real spec defect (an
Earnings-21 reference file with empty timestamp columns). All five harness
failures are fixed in the engine now; this playbook is for the failures a
fixed engine still can't prevent — a blocked branch, a spec that needs an
edit mid-run, a night that needs to stop early — and for reading the state a
running launcher writes so nothing has to be guessed.

Announce: "Using nightwatch:watch to launch and steer the run."

## 1. Preflight

Before starting `run.sh`, confirm all of:

- The clone is clean (`git status --porcelain` empty) and trusted (`claude
  -p` in it reads project settings — an untrusted workspace silently drops
  them).
- `gh variable get LANDING_STATE` (from inside the clone; the launcher's
  default `STATE_VAR`) prints exactly `run`.
- `node <plugin>/nightwatch/lint-spec.mjs --specs-dir <specs-dir>` prints
  `SPEC OK (<n> specs)` for the whole queue — a spec defect caught here is
  free; caught at 2 a.m. it costs a unit.
- 1Password is unlocked if any command in the queue needs a secret.
- `$HOME/.local/state/nightwatch/<clone-basename>/launcher.lock` is absent,
  or holds a pid that is no longer alive (`kill -0 <pid>` fails) — a live
  lock means another launcher already owns this clone.

## 2. Launch

```
caffeinate -i <plugin>/nightwatch/run.sh <clone> <specs-dir>
```

In a `herdr` pane when `HERDR_ENV` is set, so the run has its own pane and
this session never blocks on it; otherwise background it with stdin from
`/dev/null` (the child reads stdin even given a prompt, and would otherwise
eat this session's own input). `--only <slug>[,<slug>...]` narrows the queue
for a resume or a single-spec relaunch.

State lives at `$HOME/.local/state/nightwatch/<clone-basename>` — keyed on
the clone's directory name, not the repo name. `<state>/journal.md` is the
event log; `<state>/runs/<stamp>/` holds this launch's per-unit files.

## 3. Arm two monitors

- The journal: `tail -f <state>/journal.md` — one line per event (`start:`,
  a unit's state, `control:`, `paused:`, `end:`).
- The workflow journals: `~/.claude/projects/<sanitised clone
  path>/*/subagents/workflows/wf_*/journal.jsonl` — one event per phase
  result (Reconcile, Implement, Verify, Eval), useful when a unit is quiet
  in the launcher journal but still running.

## 4. What's safe to change mid-run, and when it lands

- **Spec files** are re-read at the start of every unit (the launcher
  snapshots the spec into `<state>/outcomes/<slug>/u<n>.spec.md` right
  before it runs the unit) — edit a spec in place and the next unit reads
  the edit. This is how the first night's `cargo run --` fix landed live.
- **`nightwatch.mjs`** (the Workflow script) is invoked fresh by each unit's
  `claude -p`, so an edit takes effect on the next unit that starts.
- **`run.sh` must never be edited in place while a launcher is running** —
  bash reads the script incrementally as it executes, and a mid-file edit
  can corrupt the running process. Write a replacement to a temp file and
  `mv` it over the original; the change then applies only to the *next*
  launch, not the one in flight.

## 5. Interventions

| Need | Command |
|---|---|
| Fix a blocked branch (typo, small edit) | `git worktree add <dir> <branch>` in a **separate** worktree of the same clone's repo, fix, commit, remove the worktree; never touch the launcher's own checkout while it is running |
| Skip a spec without stopping the night | `echo "skip <slug>" >> <state>/control` — if it's the current spec, it ends after this unit as PARTIAL |
| Run a spec again (e.g. after fixing it) | `echo "requeue <slug>" >> <state>/control` — appends it to the queue even if it already ran; a kept branch is resumed |
| End the night after the current unit | `echo "stop" >> <state>/control` |
| Hold the queue without ending the night | `touch <state>/pause` — the launcher waits at the next unit boundary, polling every 30s, and still honours the deadline and the kill switch while paused; `rm <state>/pause` resumes it |
| Hard stop, right now | `gh variable set LANDING_STATE --body frozen` (from the clone) — the launcher checks this before every spec and unit |

`<state>/control` is append-only: always `>>`, never truncate or rewrite it
— the launcher tracks how many bytes it has consumed and a rewrite loses
that offset.

## 6. Keep a running log

Keep a timeline table and a findings list in
`docs/research/<date>-nightwatch-<name>.md` **in the claude-skills
checkout**, never in the launch clone — a file committed there would ride
whatever outcome branch is active straight into that outcome's PR, and an
uncommitted file fails Reconcile's "clone is dirty" check at the next unit.
Commit the log as it grows, the way the first night's log
([`2026-09-05-nightwatch-first-night.md`](https://github.com/jasonm4130/claude-skills/blob/main/docs/research/2026-09-05-nightwatch-first-night.md))
did.

## 7. At the `end:` line

Run `node <plugin>/nightwatch/morning.mjs <state> [--clone <clone>]` and hand
its report to the user — it reads the journal, the outcomes, and the verify
logs, and writes `<state>/pr-body.md` with the exact commands to push the
landing branch and open the PR. This skill launches and steers the run;
`morning.mjs` is what reads it afterward, not `nightshift:morning` (that
skill reads the old task-per-PR loop's journal, a different state shape
entirely).
