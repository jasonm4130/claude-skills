# Nightwatch v1: after the first night

Written 2026-09-05 23:10 while the first unattended run (ambient, six specs) was in unit 1. Each item is shaped as an outcome with an acceptance check so it can become a spec under `docs/specs/` and be landed by Nightwatch itself. Order is by what the first night is most likely to need in the morning. Fill §0 from the journal before choosing.

## 0. What the night showed (fill in the morning)

- Outcomes landed / partial / blocked / failed, from `~/.local/state/nightwatch/ambient/journal.md`.
- Cost per unit and per landed outcome, from `decisions.jsonl` (`jq -s 'map(.cost) | add'`).
- Wall clock per unit, and how much of it was the three `scripts/check` runs (Reconcile at unit 1, the worker before commit, Verify).
- Any FAILED with "no result file": the workflow died; read the unit's stderr and the workflow journal under `~/.claude/projects/-Users-jasonmatthew-Work-Git-nightwatch-ambient/`.
- Eval concerns raised, and how many Jason agrees with after reading the diff.

## 1. Morning tooling

**Outcome.** One command reads the night: journal since the last `start:` line, every outcome's state and branch, commits ahead of `origin/main` on the integration branch, cost, and the two commands to push and open the PR. It also records Jason's verdict per outcome (merged, reverted, overridden an eval concern, discarded) into `decisions.jsonl`, which is what makes the override rate measurable.
**Acceptance.** `nightwatch/morning.sh <clone>` prints the report for last night's run in under a second; `nightwatch/morning.sh <clone> --verdict <slug> <merged|reverted|overridden|discarded>` appends one line to `decisions.jsonl`; `node --test plugins/nightshift/nightwatch/*.test.mjs` covers both against a fixture journal.
**Non-goals.** No merging; the push and the PR stay Jason's.

## 2. Parallel outcomes

**Outcome.** Independent specs run at the same time. A spec may carry `Depends: <slug>[, <slug>]` under its title line; the launcher runs up to `SLOTS` specs whose dependencies have landed, each in its own clone (`<clone>`, `<clone>-2`, …) on its own outcome branch, and lands each onto the integration branch by rebasing the outcome branch onto it first, then fast-forwarding. A rebase conflict marks the outcome BLOCKED with the conflicting paths in the journal.
**Acceptance.** With `SLOTS=2` and three specs where the third depends on the first, the launcher starts specs 1 and 2 together and starts 3 only after 1 lands (checked with stub specs whose acceptance is `true` and a fake `claude` on PATH that commits one file); `shellcheck -S warning run.sh` clean.
**Non-goals.** No parallelism inside a unit yet (item 6). No shared cargo target directory: each clone builds its own, which is the price of isolation and bounds `SLOTS` at 2 or 3 on the M5 Max.

## 3. Cost and trust metrics

**Outcome.** `scripts/cost-per-merged-pr.mjs` (decision D26) reads every `decisions.jsonl` under `~/.local/state/nightwatch/` and prints, per repo and per month: cost per landed non-reverted outcome, revert rate at 30 days, override rate (outcomes merged with an unresolved eval concern), and unit count per outcome. First report after three nights.
**Acceptance.** The script runs on a fixture directory with two repos and prints the table; a unit test covers the 30-day revert window edge.

## 4. The guards' trust boundary

**Outcome.** `no-route-around-ci.mjs` and `tests-are-readonly.mjs` judge a command when its cwd, any `-C <path>` or `--git-dir` argument, or any absolute path it names resolves inside a clone that carries a `.nightwatch` marker file at its root, and stay silent for Jason's own checkouts. Unresolvable means judged (fail closed). Both guards keep their current deny rules.
**Acceptance.** `node --test plugins/nightshift/templates/hooks/hooks.test.mjs` adds: a `git -C <marked clone> push` from an unmarked cwd is denied; `git commit` in an unmarked checkout touching `loop/` is allowed; a command with an unresolvable path is judged. `init.mjs --check` reports the template change to ambient and claude-skills.
**Non-goals.** No change to what is denied, only to where.

## 5. Specs live in the repo

**Outcome.** A spec is committed as `docs/specs/<date>-<slug>.md` on the outcome branch at launch, so the PR that lands the outcome carries the contract it was built against. A `nightwatch:spec` skill replaces `nightshift:plan`: it iterates the four headings with Jason in the session, refuses to finish without a runnable Acceptance command, writes the file, and prints the launch command. `nightshift:plan` and `task-brief` are retired in the same change.
**Acceptance.** `run.sh` copies the spec into the clone and commits it as the branch's first commit; the skill's `SKILL.md` carries the negative scope; `docs/nightshift.md` describes the spec, not the Task-N format.
**Non-goals.** No GitHub-issue entry point yet; that is a small follow-on once the file form has been used for a week.

## 6. Parallel units inside an outcome

**Outcome.** The planner may return up to three independent units per round; the workflow implements them in parallel with `isolation: 'worktree'`, merges the worktree branches onto the outcome branch, and runs one Verify on the result. A merge conflict falls back to sequential for that round.
**Acceptance.** A unit test of the merge step with two disjoint worktree commits and one conflicting pair; a live run on a claude-skills spec that touches two plugins.
**Non-goals.** Not before item 2 has run for a night; the two compound.

## 7. Launch into herdr

**Outcome.** When `HERDR_ENV=1`, `nightwatch run` splits a pane in the current tab, names it after the spec queue, and starts the launcher there with `caffeinate -i`, so the planning session never blocks and the sidebar shows the run's state. Outside herdr it prints the command to run.
**Acceptance.** Inside herdr, `nightwatch run <clone> <specs>` returns within two seconds and `herdr pane list` shows the new pane; outside herdr it prints the one-line command and exits 0.

## 8. Docker, then Brok

**Outcome.** The unit runs in a container with the clone bind-mounted, the OAuth token from `claude setup-token`, and a preflight that aborts if `ANTHROPIC_API_KEY` is set. The same image runs on Brok. Kill becomes `docker kill`.
**Acceptance.** One unit of the plumbing spec passes inside the container on the laptop; `docker ps` on Brok shows the same image running a dry run.
**Non-goals.** Not until items 1 to 4 have landed; the clone already gives the isolation that matters tonight.

## 9. Retire the old loop

**Outcome.** `land.sh`, `task-brief`, `PROMPT.md`, `SKEPTIC.md`, the launchd plist and `nightshift:morning` are deleted from the plugin templates, consumers take the deletion through `init.mjs --update`, and the plugin is renamed Nightwatch across `plugins/`, `docs/` and the marketplace manifest.
**Acceptance.** `init.mjs --check` in ambient and claude-skills reports nothing to update; `grep -ri nightshift docs plugins` returns only the changelog; the ambient `nightshift-*` worktrees are gone (landed or abandoned by Jason first).
**Non-goals.** Not before ambient's seven in-flight worktrees are drained, per decision 13.

## Open questions for Jason

1. Does the eval's "high" bar match what Jason would have blocked? If it blocked something he would have merged, lower it before adding parallelism; false blocks cost a whole outcome.
2. Is `UNIT_BUDGET=15` enforced under subscription billing? Compare `decisions.jsonl` costs against the cap; a unit that reports more than 15 says the cap is advisory.
3. Push `nightwatch/2026-09-05` as one PR, or one PR per landed outcome? One PR is the design; one per outcome is easier to revert. Decide after reading the first batch.
