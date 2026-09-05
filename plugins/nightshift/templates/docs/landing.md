---
title: "Landing work overnight"
sidebar:
  order: 32
---

# Landing work overnight

Nightshift lands a committed plan while nobody is watching: one task per pull
request, each judged by the verifier, a second model, and CI before it merges.
It runs from `loop/land.sh` on this Mac at 02:00, because the crate only builds
here and the repository's plan has no branch protection to lean on. In the
morning you read a journal and a few merged pull requests, or one draft PR that
says where it stopped.

## What a night looks like

1. `loop/land.sh` reads `loop/config` for the plan, checks the kill switch
   (repository variable `LANDING_STATE` must be `run`), and finds the first
   `# Task N` that has not landed. Landed means a merge commit on `main` names
   the branch `land/<plan>-tN`; nothing is stored anywhere else.
2. In its own worktree (`../{{NAME}}-nightshift`) it branches from `origin/main`,
   extracts the task's section with `loop/task-brief`, and runs a
   budget-capped `claude -p` in auto mode with `loop/PROMPT.md`. The generator
   commits and never pushes. Only the repository's own `.claude/settings.json`
   loads, so the allow rules and the two hooks under `.claude/hooks/` are the
   whole permission surface. Its commits are unsigned: a signing key behind an
   agent (1Password, gpg-agent) answers only while unlocked, and at 02:00 it is
   not. The merge commit is GitHub's and the PR is the audit trail.
3. `scripts/check` must end with `CHECK OK`. Then a read-only `claude -p` with
   `loop/SKEPTIC.md` reads the diff and the task and ends with `VERDICT: OK` or
   `VERDICT: REFUTED`.
4. A red verifier or a refutation goes back to the generator once. A second
   failure pushes the branch as a draft PR labelled `land:blocked` with the
   evidence in its body, and the night stops.
5. Otherwise the branch is pushed, a PR titled `[task N] …` opens with the
   label `land`, and `loop/merge-pr.sh --stay` waits for CI and merges it. CI red
   turns the PR into a blocked draft.
6. Repeat until `MAX` tasks have landed, the deadline passes, or something
   stops it.

Tasks land in plan order, and one task must merge before the next starts. An
open PR from a killed run is picked up on the next start; a blocked or
human-closed PR on any task stops the plan until someone acts.

## Reading the morning

- `~/.local/state/nightshift/{{NAME}}/journal.md` is one line per event, and
  every stop says why: `STOP: frozen`, `STOP: task 3 is blocked`,
  `STOP: done: 2 task(s) landed tonight`.
- Each task's run has a directory beside it, `YYYY-MM-DD-tN/`, holding the
  brief, every generator and skeptic transcript, the verifier log, and the
  merge log.
- `gh pr list --label land:blocked` is what needs a human. Read the PR body:
  the generator's report, the skeptic's findings and the verifier's tail are
  all there.

## What can stop it, and who can

| Stop | Set by | Cleared by |
| --- | --- | --- |
| `LANDING_STATE` is not `run` | `gh variable set LANDING_STATE --body frozen` | setting it back to `run` |
| `land:blocked` draft PR on a task | the loop, on a second red or a refutation | a human fixing or closing the PR |
| A closed, unmerged PR on a task | a human | labelling that PR `land:retry` (run it again from scratch) or removing the task from the plan |
| `MAX` tasks, or `DEADLINE` | `loop/config` | the next night |
| Budget | `--max-budget-usd` on each `claude -p` | nothing; a task that runs out of money produces no commits and the night stops |

The generator cannot lift any of these. `.claude/hooks/no-route-around-ci.mjs`
denies `gh pr merge`, `--admin`, `gh workflow`, `gh variable set`, any writing
`gh api` call (the REST merge endpoint is `gh pr merge` by another name), force
pushes, pushes to `main`, `--no-verify`, and any commit that stages a workflow
file or anything under `.claude/`. `.claude/hooks/tests-are-readonly.mjs`
denies a commit that removes more test markers than it adds or deletes a test
file. Both run before the permission check, in every permission mode, and both
fail open: the merge gate is still behind them. What they do not cover is a
generator that edits a hook file in its worktree and, in the same session,
runs the command that hook would have denied; the edit itself is discarded
(only committed work is judged, and a commit that stages `.claude/` is
refused), and the merge still needs CI and `loop/merge-pr.sh`, which re-reads
the kill switch before it merges.

## Cost

One task spends at most `(GEN_BUDGET + SKEPTIC_BUDGET) × (REPAIR_ROUNDS + 1)`
dollars on the API, which with the defaults in `loop/config` is $10, and a
night is capped at `MAX` tasks. CI cost is the usual per-PR run.

## Setting it up

1. Write the plan: a markdown file with `# Task N` headings, each section
   self-contained enough to implement without asking anything. Commit it and
   point `PLAN` in `loop/config` at it.
2. Try one task in daylight from the terminal and watch it:

   ```sh
   for l in land land:blocked land:retry; do gh label create "$l"; done
   gh variable set LANDING_STATE --body run
   MAX=1 loop/land.sh
   gh variable set LANDING_STATE --body frozen
   ```

   `loop/land.sh --dry-run` says which task it would pick and exits.
3. Install the schedule:

   ```sh
   sed -e "s|__REPO__|$PWD|g" -e "s|__HOME__|$HOME|g" -e "s|__NAME__|{{NAME}}|g" \
       -e "s|__PATH__|$PATH|g" loop/launchd.plist \
       > ~/Library/LaunchAgents/dev.nightshift.{{NAME}}.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.nightshift.{{NAME}}.plist
   launchctl kickstart gui/$(id -u)/dev.nightshift.{{NAME}}   # run it now, once
   ```

   A free proof that the launchd environment works: add `MAX` set to `0`
   under `EnvironmentVariables` in the installed plist, kickstart, and read
   `launchd.log` in the state directory. It should fetch, check the switch,
   and stop with `0 task(s) landed` in a few seconds. Remove the key and
   reload before the night.

   The Mac must be logged in: `claude` and `gh` use this user's credentials,
   and `caffeinate -i` only holds off idle sleep.
4. Set `LANDING_STATE` to `run` the evening you want it to work.

## Why it is shaped this way

Every piece exists because of a way unattended agents are known to go wrong.
The verifier is quiet because a verbose one eats the context of the model
reading it. The skeptic is a second, read-only model because a generator
grading its own work is the one thing every study of this finds unreliable.
Tests are read-only because deleting the failing test is the shortest path to
green. State lives only in git and GitHub because a ledger file is a second
source of truth that drifts from the first. Merging is CI's decision, not the
loop's, and the loop runs under budgets and a deadline because a loop that can
retry forever will.

The loop is deliberately narrow: one plan, one task at a time, one repair. The
things it cannot do, such as write its own plan, split a task, or decide a test
is wrong, are the things a human does at breakfast.
