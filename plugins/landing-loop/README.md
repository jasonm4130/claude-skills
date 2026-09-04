# landing-loop

Lands every task of a human-approved plan on `main` while nobody is watching. One task
per iteration, one pull request per task, CI green as the only gate, merged through the
repo's own merge command, with a ledger committed beside the plan. It drives
`subagent-driven-development`'s workflow for the implement → review → fix inner loop and
adds the outer loop that plugin deliberately leaves to a human: push, PR, CI wait,
merge, next task.

## Install

```
/plugin marketplace add jasonm4130/claude-skills
/plugin install landing-loop@jasonm4130-claude-skills
```

Requires `subagent-driven-development` 0.12.0 installed from the same marketplace, `gh`
authenticated, and Claude Code 2.1.259 or later (for `--permission-prompts none`).

## Use

```
/landing-loop:land docs/superpowers/plans/2026-09-04-example.md
```

Unattended, from a terminal that stays open:

```sh
claude --permission-mode auto -p "/goal Every task in <plan> is landed or blocked, shown by the ledger beside it; stop after 40 turns. Get there with /landing-loop:land <plan>" --permission-prompts none
```

The skill refuses at preflight unless all of these hold: the plan has `# Task N`
headings and no open questions, every task lists its files, the repo has a short check
command and a merge command that waits for CI, the tree is clean on an up-to-date
`main`, and the session cannot hang on a permission prompt.

## What it changes about the human gate

`subagent-driven-development` waits for "go" before dispatching and hands merging back
to the human. This plugin moves that gate upstream: invoking `/landing-loop:land` on a
plan *is* the approval, recorded in the ledger. After that, the only gates are the check
command, the pull request's CI, and the merge command. Review of the work happens where
practitioners running agents overnight put it — on the plan, not the diff — and the
research behind that choice is in
[docs/research/2026-09-04-unattended-agent-loops-research.md](https://github.com/jasonm4130/claude-skills/blob/main/docs/research/2026-09-04-unattended-agent-loops-research.md).

## What stops it

Two consecutive blocked tasks, `--max-tasks`, a gate that denies twice for the same
reason, a merge command failing for a reason other than red CI, or any permission
denial. A blocked task stays as a draft PR with the failing log in a comment; tasks that
depend on it are skipped. The final message lists landed, blocked, and "out of scope,
noticed" so a reader with no transcript knows where things stand.

## Status

Written 2026-09-04 against the September 2026 Claude Code surface. Not yet exercised
end to end; the first real run is the `ambient` repo's bootstrap plan, and this line
changes when that run has happened.
