# landing-loop

Lands every task of a human-approved plan on `main` while nobody is watching. One task
per iteration, one pull request per task, CI green as the only gate, merged through the
repo's own merge command, with a ledger committed beside the plan. The loop is a
deterministic Workflow script; per task it runs `subagent-driven-development`'s workflow
as a child for implement → review → fix, and adds the outer loop that plugin leaves to a
human: branch, verify, push, PR, wait for CI, merge, next task.

## Install

```
/plugin marketplace add jasonm4130/claude-skills
/plugin install landing-loop@jasonm4130-claude-skills
```

Requires `subagent-driven-development` 0.12.0 from the same marketplace, `gh`
authenticated, and Claude Code 2.1.259 or later (for `--permission-prompts none`).

## Use

```
/landing-loop:land docs/superpowers/plans/2026-09-04-example.md
```

Unattended, from a terminal that stays open:

```sh
claude --permission-mode auto --permission-prompts none -p "/goal Every task in <plan> is landed or blocked, shown by the ledger beside it and by gh pr list; stop after 40 turns. Get there with /landing-loop:land <plan>"
```

The skill refuses at preflight unless all of these hold: the plan is committed on `main`
with `# Task N` headings and no open questions, every task lists its files, the repo has
a short check command and a merge command that waits for CI, that merge command is in
the repo's `permissions.allow`, the tree is clean on an up-to-date `main`, and the
session cannot hang on a permission prompt.

## Shape

| Piece | Role |
| --- | --- |
| `skills/land/SKILL.md` | Controller: preflight, task enumeration and tiering, launch, verified final report |
| `workflows/land.mjs` | The loop as code: Orient → Implement (SDD child run) → Verify → Ship → Gate, one task at a time |
| `subagent-driven-development` 0.12.0 | The inner loop per task, resolved by pinned path |

The workflow's pure helpers (argument validation, dependency ordering, status
reconciliation from pull requests, next-task selection, halt rule, ledger rendering)
are tested in `workflows/land.test.mjs`. Everything that touches git or GitHub is an
agent with an explicit model and a structured-output schema; the script never trusts a
claimed sha it has not shape-checked.

## What it changes about the human gate

`subagent-driven-development` waits for "go" before dispatching and hands merging back
to the human. This plugin moves that gate upstream: the plan's own pull request is where
the human approved it, and invoking `/landing-loop:land` on it is recorded in the
ledger. After that the only gates are the check command, the pull request's CI, and the
merge command. Review of the work happens where practitioners running agents overnight
put it — on the plan, not the diff. The research behind that choice is in
[docs/research/2026-09-04-unattended-agent-loops-research.md](https://github.com/jasonm4130/claude-skills/blob/main/docs/research/2026-09-04-unattended-agent-loops-research.md).

## What stops it

Two consecutive blocked tasks, `limits.maxTasks`, an infrastructure failure at the gate
(checks never register, the merge command errors for a reason other than a red check),
or any permission denial. A blocked task stays as a draft PR with the failing log in a
comment; tasks that depend on it are skipped. A run that is interrupted resumes from
GitHub's state: merged PRs are landed, open drafts are blocked, open PRs go straight to
the gate.

Status is derived from `gh pr list` at every orientation, never from memory, and the
controller re-checks the returned landed and blocked lists against GitHub before
reporting them.

## Known constraint

Auto mode's classifier can deny the merge script itself. It denied `./merge-pr.sh` on
2026-09-04 in a session whose global rules allowed `gh` but not the script. An allow
rule in the repo's `.claude/settings.json` bypasses the classifier; the preflight checks
for one.

## Status

Written 2026-09-04 against the September 2026 Claude Code surface. Pure helpers tested;
not yet exercised end to end. The first real run is the `ambient` repo's bootstrap
plan, and this line changes when that run has happened.
