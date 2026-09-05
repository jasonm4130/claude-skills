# Nightwatch v1: after the first night

Written 2026-09-05 23:10 while the first unattended run (ambient, six specs) was in unit 1. Each item is shaped as an outcome with an acceptance check so it can become a spec under `docs/specs/` and be landed by Nightwatch itself. Order is by what the first night is most likely to need in the morning. Fill §0 from the journal before choosing.

## 0. What the night showed

Filled 2026-09-06 03:45 from `docs/research/2026-09-05-nightwatch-first-night.md`, which has the timeline and evidence.

- Landed 1 of 6 (live-asr, 6 commits, $24). Blocked 3 (ui-api on a typo, wer on a spec defect, ui-features on dependencies). Failed 2, both harness bugs (session-tools with its work complete; ui-shell before any work). Every harness bug fixed the same night: six commits on `nightwatch-redesign`.
- 16 units, ~$72.70, 4 h 44 min. Median unit ~21 min and ~$4.60; range $0.53 to $8.09. Roughly a third of each unit's wall clock is `scripts/check` (three runs per unit), the rest planner and worker time.
- No unit died to the 600 s ceiling; the result-file recorder held. Every unit's cost stayed under the $15 cap, so the cap was never tested.
- Eval: one high concern in 16 units (a CI-only typo check), correct but disproportionate as a block. Nine low concerns, two of them real small bugs on ui-api (`search` reachable over MCP; `limit: 0` returns one hit).
- The spec format worked: planners produced sensible unit sequences from the Outcome plus Acceptance and recognised done units from the branch log without a handoff file. The failures were in what specs said (bare `cargo run --`, vacuous `cargo test x::`, an acceptance that passes before the Outcome is done, a data assumption nobody checked) and in the engine's definitions (dirty, all-pass, done).
- Reordering this plan by what the night showed: item 1 (morning tool, reading the per-unit logs), then a new item for spec linting inside `nightwatch:spec` (test counts pinned, `--bin` named, acceptance-written files declared, must-fail commands marked), then item 2 (parallel outcomes with `Depends:`, which would have saved ui-features' $1.55 and let wer and live-asr run beside ui-api).

## 1. Morning tooling

**Outcome.** One command reads the night: journal since the last `start:` line, every outcome's state and branch, commits ahead of `origin/main` on the integration branch, cost, and the two commands to push and open the PR. It also writes the batch PR body: one section per landed outcome with the spec title, the acceptance commands and their captured output from the per-unit log files (`outcomes/<slug>/u<n>-logs/`, written by the commands themselves, not the agent's tail), and the commit range. It also records Jason's verdict per outcome (merged, reverted, overridden an eval concern, discarded) into `decisions.jsonl`, which is what makes the override rate measurable.
**Acceptance.** `nightwatch/morning.sh <clone>` prints the report for last night's run in under a second and writes `pr-body.md` beside the journal; `nightwatch/morning.sh <clone> --verdict <slug> <merged|reverted|overridden|discarded>` appends one line to `decisions.jsonl`; `node --test plugins/nightshift/nightwatch/*.test.mjs` covers both against a fixture journal.
**Non-goals.** No merging; the push and the PR stay Jason's.

## 2. Parallel outcomes

**Outcome.** Independent specs run at the same time. A spec may carry `Depends: <slug>[, <slug>]` under its title line; the launcher runs up to `SLOTS` specs whose dependencies have landed, each in its own clone (`<clone>`, `<clone>-2`, …) on its own outcome branch, and lands each onto the integration branch, which exists in exactly one place: the primary clone. A worker clone never touches it; when its outcome passes it pushes the outcome branch into the primary clone (`git push <primary> nw/<date>/<slug>`), and the primary launcher, the single owner of `nightwatch/<date>`, rebases that branch onto the integration branch and fast-forwards under a landing lock. A rebase conflict marks the outcome BLOCKED with the conflicting paths in the journal. A spec is claimed by a lock file `~/.local/state/nightwatch/<repo>/locks/<slug>` holding the launcher pid; a launcher that finds a live lock skips the spec and says so.
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

**Outcome.** `land.sh`, `task-brief`, `PROMPT.md`, `SKEPTIC.md`, the launchd plist and `nightshift:morning` are deleted from the plugin templates; `init.mjs` gains a removal list and a Nightwatch install path (today it never deletes and renders a fixed `LOOP_FILES` list); consumers take the deletion through `init.mjs --update`, and the plugin is renamed Nightwatch across `plugins/`, `docs/` and the marketplace manifest.
**Acceptance.** `init.mjs --check` in ambient and claude-skills reports nothing to update; `grep -ri nightshift docs plugins` returns only the changelog; the ambient `nightshift-*` worktrees are gone (landed or abandoned by Jason first).
**Non-goals.** Not before ambient's seven in-flight worktrees are drained, per decision 13.

## Open questions for Jason

1. Does the eval's "high" bar match what Jason would have blocked? If it blocked something he would have merged, lower it before adding parallelism; false blocks cost a whole outcome.
2. Is `UNIT_BUDGET=15` enforced under subscription billing? Compare `decisions.jsonl` costs against the cap; a unit that reports more than 15 says the cap is advisory.
3. Push `nightwatch/2026-09-05` as one PR, or one PR per landed outcome? One PR is the design; one per outcome is easier to revert. Decide after reading the first batch.
