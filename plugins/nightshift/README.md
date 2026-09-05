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

## The three skills

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
