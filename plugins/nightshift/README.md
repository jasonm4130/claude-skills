# nightshift

Plan by day, land by night, triage in the morning.

Nightshift lands an approved plan while nobody is watching: one `# Task N`
per pull request, each written by a budget-capped generator, checked by a quiet
verifier, read by a skeptic that can only refute, and merged by CI. It runs
from launchd at 02:00 and remembers nothing between nights: done is a merge
commit on the base branch, in flight is an open PR, blocked is a draft PR
with a label. A kill switch is a repository variable a human sets.

The loop is committed **in your repo**, not in this plugin. It runs
`claude -p --setting-sources project`, where installed plugins never load, so
the two guards only bite when they live under the repo's own `.claude/`. The
plugin is the scaffolder that puts them there, plus the three daytime skills.

## Install

```
/plugin marketplace add jasonm4130/claude-skills
/plugin install nightshift@jasonm4130-claude-skills
```

Requirements: `gh` (authenticated), Node 18+, coreutils `timeout` (macOS:
`brew install coreutils`), macOS for the launchd schedule (the loop itself is
bash and runs anywhere).

## Nightwatch

Nightwatch is the newer, spec-driven way to run an overnight session: one
outcome, one spec, one clone, no plan file. A spec walks Outcome →
Acceptance → Non-goals → Context; the launcher runs it as a queue of
headless `claude -p` units in a clone that never pushes, landing each PASS
onto one integration branch and leaving one PR for the morning.

### Set up a repo

Say "initialize nightwatch" (or `/nightwatch-init`) in a session opened on
the repo. `nightwatch/init.mjs` does every step idempotently — preflight,
a clone at `~/Work/Git/nightwatch/<name>` that never pushes, a trust entry
in `~/.claude.json` so the headless child never sees a trust dialog, a check
command (the repo's own `scripts/check`, or one generated in the state
directory from CI's steps and proved once before it's trusted), the state
directory and `config`, the kill switch, and a dry run that proves the
engine can reconcile a branch and run the acceptance commands in the clone.
It never touches the repo's branches, GitHub, or CI, commits nothing and
opens no pull request: the only push anywhere in Nightwatch is the morning
one. Every check — the repo's own, the generated one, and the launcher's own
re-check before it lands anything — ends its output with `CHECK OK` as its
last line; that's the one contract every consumer reads for. The two
PreToolUse guards reach the headless child through `--settings` JSON built
fresh by `run.sh`, not through the repo's `.claude/`, so a Nightwatch clone
needs no scaffolding of its own the way the old loop does. The two agents the
engine dispatches, `worker` (Sonnet, medium effort, Implement and repair) and
`verifier` (Sonnet, low effort, Reconcile and Verify, with Write and Edit
disabled by the runtime), ship in this plugin's `agents/` and reach the child
through `--agents` the same way, so a night resolves them on any machine.

```
spec (Outcome/Acceptance/Non-goals/Context) → clone → units (Reconcile →
Implement → Verify → Eval, one claude -p each) → land onto an integration
branch on PASS → one PR in the morning
```

A spec header carries four lines above the first `## ` heading — only
`Repo:` is required, the rest apply when they do:

| Header | Meaning |
|---|---|
| `Repo:` | where the outcome lives (documentation; the clone is the launcher's first argument) |
| `Depends: <slug>[, ...]` | don't start until each named spec has a landed SHA the landing branch (or `origin/<BASE>`) can reach |
| `Units: <n>` | cap this spec at `n` units, overriding the launcher's default |
| `Writes: <path>[, ...]` | files an acceptance command creates, so the morning's PR body can quote their logs |

The launcher (`nightwatch/run.sh <name-or-clone> [<specs-dir>] [--dry-run]
[--only <slug>[,...]]`) takes a repo name once init has run — the config at
`~/.local/state/nightwatch/<name>/config` supplies the clone, specs dir,
base branch and check command — or the old two-positional form unchanged.
It also takes its knobs from the environment: `STATE_VAR`
(`LANDING_STATE`), `DEADLINE` (`7h`), `UNIT_BUDGET` (`$8`), `UNIT_TIMEOUT`
(`150m`), `MAX_UNITS` (`8`, unless the spec says `Units:`), `MAIN_MODEL`
(`sonnet`), `BASE` (`main`). While it runs, `$STATE/control` (append-only,
`>>` only) takes `stop`, `skip <slug>` and `requeue <slug>` at the next unit
boundary, and a `$STATE/pause` file holds the queue there until it is
removed.

Four commands, no plan file:

- `node nightwatch/init.mjs [--report]` — sets a repo up end to end (clone,
  trust, check command, state dir, switch) and proves it with a dry run;
  `--report` changes nothing and only shows the status table.
- `node nightwatch/lint-spec.mjs --specs-dir <dir> --check <cmd> [spec.md]` —
  catches a spec defect before it costs a night: an unnamed `cargo run --`
  binary, an unpinned `cargo test` filter, an artifact missing its `Writes:`
  line, a dependency cycle.
- `nightwatch/run.sh <name-or-clone> [<specs-dir>]` — the launcher.
- `node nightwatch/morning.mjs <name-or-state-dir> [--clone <path>]` — reads
  the journal and every outcome's result and verify logs, reports each
  spec's state, cost and eval concerns, writes `pr-body.md`, and (with
  `--verdict <slug>[@<sha>] <merged|reverted|overridden|discarded>`) records
  what happened to a landing afterward.

Three skills: `nightwatch-init` sets a repo up for Nightwatch;
`nightwatch:spec` writes and lints a spec with the user; `nightwatch:watch`
runs preflight, launches `run.sh`, arms the journal and workflow-journal
monitors, and knows the interventions above. Design:
[`2026-09-05-nightwatch-redesign.md`](https://github.com/jasonm4130/claude-skills/blob/main/docs/research/2026-09-05-nightwatch-redesign.md).
First-night log:
[`2026-09-05-nightwatch-first-night.md`](https://github.com/jasonm4130/claude-skills/blob/main/docs/research/2026-09-05-nightwatch-first-night.md).

Nightwatch will replace the task-per-PR loop below once the loop's existing
worktrees are drained; until then both run side by side.

## A night

```
02:00  launchd → loop/land.sh
       kill switch LANDING_STATE == run?            no → STOP: frozen
       for each # Task N not yet merged into main:
         branch land/<plan>-tN from origin/main, fresh worktree
         generator  claude -p, auto mode, $GEN_BUDGET, commits, never pushes
         verifier   scripts/check must end with CHECK OK
         skeptic    read-only claude -p → VERDICT: OK | REFUTED
         one repair round on red or REFUTED, then draft PR labelled land:blocked
         push, gh pr create, ./loop/merge-pr.sh waits for CI and merges
       stop on: switch off, a blocked or closed PR (unless labelled land:retry), MAX tasks, DEADLINE
07:00  /nightshift:morning
```

Everything project-specific is in `loop/config`; the journal is in
`~/.local/state/nightshift/<repo>/journal.md`, with one
`YYYY-MM-DD-HHMMSS-<plan>-tN/` directory per run of a task beside it.

## The three loop skills

| Skill | When | What it leaves behind |
|---|---|---|
| `nightshift:plan` | an idea that is more than one sitting | `docs/plans/YYYY-MM-DD-<slug>.md` as its own PR: self-contained tasks, empty Open Questions, one Codex pass |
| `nightshift:init` | a repo with no `loop/` | `loop/`, `.claude/hooks/`, `scripts/check`, the landing doc, a merged `.claude/settings.json`, a smoke plan; dry run and preflight run; the switch left off |
| `nightshift:morning` | the morning after | per stop: what happened, what it costs to ignore, the fix; then offers one |

## What the guards refuse

Two PreToolUse hooks, denying in every permission mode, so the generator
cannot loosen them by editing permissions:

- **no-route-around-ci** — `gh pr merge`, `--admin`, `gh workflow`, `gh variable set`,
  a writing `gh api`, a force push, any push to the base branch,
  `commit --no-verify`, and a commit that stages `.github/workflows/` or `.claude/`.
  It matches `command git`, `env X=y git`, `/usr/bin/git` and global options
  like `git -C dir push`, and it is still a textual guard: branch protection
  on the base branch is the gate, and preflight warns when there is none.
- **tests-are-readonly** — deleting a test file or removing test markers.

## The generator's environment

`claude -p` runs with the parent session's `CLAUDE*` variables scrubbed (a
claude started inside another Claude Code session is forced into default
permission mode, where every edit is a prompt nobody answers), with
`commit.gpgsign=false` (a signing key behind 1Password or gpg-agent does not
answer at 02:00), with `/dev/null` on stdin (it reads stdin even given a
prompt, and would eat the loop's task list), and with `--add-dir` on the run
directory so it can read its brief. The PR is the audit trail.

## Merging

`loop/merge-pr.sh` never uses `gh pr merge --auto`: a merge queued on
GitHub's side cannot be cancelled by the kill switch. It waits for the named
checks to register and pass, re-reads the switch, and merges once.
`MERGE_MODE=protected` reads the required check names from branch
protection; `MERGE_MODE=wait` uses `EXPECTED_CHECKS` from `loop/config`,
which `init` pre-fills only when a `gate` CI job exists (job ids are not
check names; a matrix job is `name (os)`). `preflight.mjs` lists the names
GitHub actually reports so the human can fill the rest. It also checks that the
three labels (`land`, `land:blocked`, `land:retry`) exist: `gh pr create --label`
fails outright on an unknown label, and the failure line carries the
`gh label create` commands.

## Cost

A task costs at most `(GEN_BUDGET + 2 × SKEPTIC_BUDGET) × (REPAIR_ROUNDS + 1)` (the skeptic runs twice in a round only when its first verdict is empty)
dollars: with the defaults, $10. `MAX=3` tasks a night, `DEADLINE=6h`.

## Keeping a repo current

```
node <plugin>/scripts/init.mjs --check    # unchanged / modified locally / template newer
node <plugin>/scripts/init.mjs --update   # overwrite only files still at their stamped hash
```

`loop/.nightshift` records the plugin version and a hash per scaffolded file.

## Tests

`node --test plugins/nightshift/tests/*.test.mjs` scaffolds throwaway repos
with a bare origin and a fake `gh` on PATH: init and its settings merge,
`--check`/`--update`, preflight's failure modes, both hooks as registered
processes, `task-brief`, and `land.sh --dry-run` through the kill switch,
done-detection and the blocked/closed/open PR paths.
