# Reviewer, Report Contract and Cost Metric Implementation Plan

**Goal:** the paid cross-vendor reviewer stops spending rounds on nothing, every report has to run the command behind a negative claim and ends in a numbered decision list, every decision record says what was rejected and when to re-read it, and one script answers the monthly question — plan-equivalent dollars per merged pull request.
**Architecture:** the reviewer changes are three surgical edits to one 866-line script and its tests, all behaviour reachable through exported functions so nothing needs a live Codex call. The report contract has no workflow template to live in — none exists in `plugins/` at HEAD — so it lands in the `writing-artifacts` skill and `docs/developing.md`. The cost metric is a new stdlib `.mjs` under `scripts/`, tested against a fixture transcript and a `gh` shim, never against the real `~/.claude/projects`.
**Tech Stack:** stdlib `.mjs`, Node 24 `node --test`, `gh`, `scripts/bump-plugin.mjs`, `claude plugin eval` (maintainer-only, early access).

## Global Constraints
- Any change under `plugins/<name>/` outside `README.md`, `CLAUDE.md`, `tests/`, `*.test.mjs` and `.claude-plugin/` MUST be followed by `node scripts/bump-plugin.mjs <name> patch` before the commit (those five are exempt per the header of `scripts/check-version-bumps.mjs`). The bump also rewrites the marketplace entry.
- `bash scripts/check` must end with `CHECK OK` before every commit. Never delete or rename a test file — `.claude/hooks/tests-are-readonly.mjs` denies that commit. Changing an assertion inside an existing test file is expected where a task says so.
- Do not edit `.github/`, `.claude/` or `loop/`. `scripts/` is in scope only where a task names the file.
- Commit messages say why and end with `-m "Claude-Session: nightshift"`. Never write the literal text `gh pr merge` or `gh variable set` into a commit message or a PR body: `.claude/hooks/no-route-around-ci.mjs` reads the whole command and denies it.
- Write test files with the Write tool, not with a shell heredoc; a heredoc body quoting a merge command is denied by that same guard.

### Task 1: the reviewer caps its findings, stops on a dry round, and resumes an open chain

**Files:**
- Modify: `plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs` — `REVIEW_BODY` (line 46, the findings paragraph at 50), `DIFF_BODY` (line 90, the findings paragraph at 99), `reserveChain`'s auto guard (485-493) and its race arm (516-527), the round cap block (757-771).
- Test: `plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs` — append new tests, and update the two existing tests that assert the old refusal: `reserveChain: auto refuses on existing non-aborted hash…` (line 162) and `e2e: second auto review of same content refuses (guard); --force proceeds` (line 403).
- Modify: `plugins/codex-review/skills/codex-plan-review/SKILL.md` (the round protocol), `plugins/codex-review/README.md` (the same two sentences).
- Bump: codex-review patch.

**Interfaces:**
- Produces (cap): both prompt bodies gain, in the findings paragraph, `Report at most 5 findings, ranked most-confident first; if you have more, the five you would defend are the five to send.` The audit prompts already say `Report at most 5 findings` (lines 61 and 123) — match that wording so the three read alike.
- Produces (dry round): `export function chainIsSpent(lines, chainId, mode)` → true when the last log line for that chain and mode has `findings` whose `p1 + p2 + p3` is 0. `runRound` calls it beside the existing `MAX_REVIEW_ROUNDS` check, before `runCodex` is spawned, and `die`s with exit 6: `chain <id> produced no findings in round <n> — the chain is done. Run the audit, or close it with \`note --outcome cap-revise\`.` `MAX_REVIEW_ROUNDS` stays 3.
- Produces (resume): `reserveChain` under `trigger === "auto"` returns `{ chainId: <existing>, ts, resumed: true }` when a matching chain (same `repoKey` + `artifact` + `contentHash`) is **open** — has no note. A chain with a non-aborted note still throws `CHAIN_EXISTS`: that one was reviewed to a conclusion, and re-reviewing it is the repeat the guard exists to stop. An aborted note still unblocks, as today. The round number then continues from the log (line 757), so a resumed chain lands on round 2 and the cap still applies. The resumed round runs a fresh Codex session unless the caller passes `--resume <sessionId>`; the point is that five same-hash retries stop paying for a refusal. `runRound` puts `resumedChain: true` in the result JSON when that happens.

- [ ] **Step 1:** tests first. New: `buildReviewPrompt("p.md")` and `buildDiffPrompt("a..b", ["f.mjs"])` both match `/at most 5 findings, ranked/`. New: `chainIsSpent` over synthetic log lines — a last round with `{p1:0,p2:0,p3:0}` → true; with `{p1:0,p2:0,p3:1}` → false; a different mode → false; no lines → false. Update line 162's test so a second `reserveChain(base)` returns the same `chainId` with `resumed === true`, then `appendResult(logPath, {chainId, mode:"review", verdict:"REVISE", findings:{p1:1,p2:0,p3:0}})` + `appendNote(logPath, {chainId, unique:1, outcome:"cap-revise"})` and assert a third `reserveChain(base)` throws `CHAIN_EXISTS` (the closed-chain guard survives). Update line 403's e2e so the second `--auto` run exits 0, its stdout JSON carries the first run's `chainId`, and the log holds two `mode:"review"` lines for it. Run `node --test plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs` → FAIL, `# fail 4` or more.
- [ ] **Step 2:** implement the three changes. Keep the post-append race arm at 516-527 throwing `CHAIN_EXISTS` — losing a reservation race is not a resume, and the loser has already written its own aborted note. Same command → PASS, `# fail 0`.
- [ ] **Step 3:** SKILL.md and README: the protocol is still 3 rounds plus 1 audit, but a round that returns nothing new ends it; a second automatic review of unchanged content resumes the open chain instead of refusing; a chain that already closed still refuses. `bash scripts/check` → `CHECK OK`.
- [ ] **Step 4:** `node scripts/bump-plugin.mjs codex-review patch`; `git add plugins/codex-review .claude-plugin/marketplace.json && git commit -m "codex-review: five ranked findings, a dry round ends the chain, an open chain resumes" -m "Claude-Session: nightshift"`.

### Task 2: a report proves its negative claims and ends in a decision list

**Files:**
- Modify: `plugins/writing-artifacts/skills/writing-artifacts/SKILL.md` (new section before `## Self-check`), `plugins/writing-artifacts/README.md` (one sentence), `docs/developing.md` (a `## Report contract` paragraph).
- Test: `plugins/writing-artifacts/skills/writing-artifacts/skill.test.mjs` (create, modelled on `plugins/adr/skills/adr/skill.test.mjs`).
- Bump: writing-artifacts patch.

**Interfaces:**
- Consumes: nothing. Checked first — `find plugins -type d -name workflows` returns nothing at HEAD, and the only skills that produce reports are `writing-artifacts` and `adr`. There is no workflow output template in the repo after the SDD retirement, so the contract lands in the skill that owns report prose and in the repo's own developing guide.
- Produces: a `## Reports and research write-ups` section with two rules. (1) Positive check: any claim that a thing does not exist, cannot be found, or is an unresolvable gap must name the command that enumerates the space, run it, and quote its output in the report; an unenumerated negative is not a finding, it is a failure to look. (2) Numbered decision list: every report ends with a numbered list of decisions the reader must make, each answerable in one word, each carrying its evidence and its cost.

- [ ] **Step 1:** write `skill.test.mjs`: read `SKILL.md`, assert `/does not exist/i`, `/enumerat/i`, `/numbered decision list/i` and `/one word/i` all match. Run `node --test plugins/writing-artifacts/skills/writing-artifacts/skill.test.mjs` → FAIL, `# fail 1`.
- [ ] **Step 2:** write the section. Keep it to one short paragraph per rule — the skill is 53 lines and its value is that it is read whole. Test → PASS. `bash scripts/check` → `CHECK OK`.
- [ ] **Step 3:** `docs/developing.md` `## Report contract`: the same two rules, stated as applying to everything under `docs/research/` and to any fan-out report, plus the reason — an unchecked "X does not exist" is the most persistent failure this repo's reviews have found, and a report with no decision list gets read and forgotten. `plugins/writing-artifacts/README.md`: one sentence that the skill now carries the report contract.
- [ ] **Step 4:** `node scripts/bump-plugin.mjs writing-artifacts patch`; `git add plugins/writing-artifacts docs/developing.md .claude-plugin/marketplace.json && git commit -m "writing-artifacts: a negative claim runs its enumerating command, and a report ends in a decision list" -m "Claude-Session: nightshift"`.

### Task 3: five lines that make a decision re-readable

**Files:**
- Modify: `plugins/adr/skills/adr/SKILL.md` (the `## Decisions` line of the embedded template, line 61), `plugins/nightshift/skills/plan/SKILL.md` (the header block of the embedded plan template, ~lines 44-47), both plugins' `README.md`.
- Test: `plugins/adr/skills/adr/skill.test.mjs` (append), `plugins/nightshift/tests/plan-skill.test.mjs` (create).
- Bump: adr patch, nightshift patch.

**Interfaces:**
- Produces: the same five lines in both templates, verbatim, so a plan and an ADR record a decision the same way — `**Decision:**` the one choice this artifact encodes; `**Alternatives rejected:**` the next-best option and why not; `**Evidence:**` what makes the choice true (a file, a measurement, a dated source); `**Reversibility:**` cheap or costly, and what undoing it would take; `**Review date:**` YYYY-MM-DD, when to re-read this decision.
- In the ADR template they are the shape of each entry under `## Decisions` (which today reads only "options + the choice"). In the plan template they sit under `**Tech Stack:**` in the header block, so `loop/task-brief` — which extracts from `### Task N` headings down — never has to read them.

- [ ] **Step 1:** append to `plugins/adr/skills/adr/skill.test.mjs` a test `the decision record names alternatives, reversibility and a review date` asserting `/Alternatives rejected/`, `/Reversibility/` and `/Review date/` against `SKILL.md`. Create `plugins/nightshift/tests/plan-skill.test.mjs` reading `plugins/nightshift/skills/plan/SKILL.md` with the same three assertions plus `/\*\*Tech Stack:\*\*/` (the header block still exists). Run `node --test plugins/adr/skills/adr/skill.test.mjs plugins/nightshift/tests/plan-skill.test.mjs` → FAIL, `# fail 2`.
- [ ] **Step 2:** edit both templates. Keep the ADR's one-page prose budget intact by folding the five lines into the existing `## Decisions` comment rather than adding a new section. Tests → PASS. `bash scripts/check` → `CHECK OK`.
- [ ] **Step 3:** one sentence in each README that a decision record now carries its alternatives, its reversibility and the date to re-read it. `node scripts/bump-plugin.mjs adr patch && node scripts/bump-plugin.mjs nightshift patch`; `git add plugins/adr plugins/nightshift .claude-plugin/marketplace.json && git commit -m "adr and nightshift plan: a decision records what it rejected, how reversible it is, and when to re-read it" -m "Claude-Session: nightshift"`.

### Task 4: one number a month — dollars per merged pull request

**Files:**
- Create: `scripts/cost-per-merged-pr.mjs`, `scripts/cost-per-merged-pr.test.mjs`.
- Modify: `docs/developing.md` (a `## Cost per merged PR` paragraph).
- Bump: none (nothing under `plugins/` changes).

**Interfaces:**
- Produces: `node scripts/cost-per-merged-pr.mjs [--month YYYY-MM] [--json] [<repo dir> …]`. Repos default to the current repo root. `--month` defaults to the current month.
- Consumes: `$CLAUDE_PROJECTS_DIR` or `~/.claude/projects` as the transcript root, and `<root>/<sanitized>/*.jsonl` where `sanitized` is the repo's absolute path with every `/` and `.` replaced by `-` (verified against the live directory names, e.g. `/Users/jasonmatthew/.local/share/chezmoi` → `-Users-jasonmatthew--local-share-chezmoi`). Every line is parsed with a try/catch; a bad line is counted, not fatal.
- Consumes: usage from lines whose `type === "assistant"`, keyed by `message.id` — one assistant line per content block repeats the same usage object, so the first line for an id counts and every later one is skipped. Only lines whose timestamp falls in the month count. Tokens summed: `usage.output_tokens` and `usage.cache_creation_input_tokens` (input and cache-read are excluded deliberately: they are the cheap majority and the number exists to compare months, not to reconcile a bill).
- Produces: a rate table at the top of the file, USD per million tokens, keyed by a model-id substring, with a comment naming the source and the date it was read — `opus` 75 output / 18.75 cache-create; `sonnet` 15 / 3.75; `haiku` 5 / 1.25. An unmatched model id uses the sonnet row and prints one `warn: unknown model <id>, priced as sonnet` line on stderr.
- Consumes: `gh pr list --repo <owner/name> --state merged --search "merged:<YYYY-MM-01>..<YYYY-MM-last>" --limit 500 --json number --jq 'length'`, run with `execFileSync` in a try/catch; a failure means 0 and one stderr line.
- Produces: one table row per repo — repo, dollars, merged PRs, dollars per merged PR (`n/a` when the count is 0) — then a total row. `--json` prints `{month, repos: [{repo, usd, merged, perMerged}], total: {...}}`. Exit 0 always; the number is plan-equivalent spend, not billed spend.

- [ ] **Step 1:** write `scripts/cost-per-merged-pr.test.mjs`: build a temp projects root holding one sanitized dir for a temp repo, with a fixture `.jsonl` — two assistant lines sharing `message.id: "m1"` and identical usage (`output_tokens: 1000`, `cache_creation_input_tokens: 2000`, `model: "claude-opus-4-5"`), one assistant line `m2` with `output_tokens: 500`, one user line, one junk line, and one assistant line timestamped in the previous month. Put a `gh` shim first on PATH that prints `2`. Assert `--json`: the deduped cost is `(1000 + 500)/1e6*75 + 2000/1e6*18.75` = `0.15` (assert to 6 decimal places), `merged === 2`, `perMerged` = half the cost, and that the previous-month line is excluded. Run `node --test scripts/cost-per-merged-pr.test.mjs` → FAIL, `Cannot find module`.
- [ ] **Step 2:** implement, stdlib only (`node:fs`, `node:path`, `node:os`, `node:process`, `node:child_process`, `node:util`'s `parseArgs`). Test → PASS. Then run it for real once: `node scripts/cost-per-merged-pr.mjs` → one table row for this repo, a dollar figure and a merged count; if `gh` is unavailable it prints the row with `merged 0` and `n/a`, still exit 0.
- [ ] **Step 3:** `docs/developing.md` `## Cost per merged PR`: run it on the first of the month, the two token classes it prices and why the other two are left out, that the rate table is hand-maintained and dated, that the figure is plan-equivalent rather than billed, and that the number to watch is the trend across months and the tooling-versus-product split, not the absolute dollar. `bash scripts/check` → `CHECK OK`; `git add scripts/cost-per-merged-pr.mjs scripts/cost-per-merged-pr.test.mjs docs/developing.md && git commit -m "scripts: plan-equivalent cost per merged PR, from the transcripts and the merge history" -m "Claude-Session: nightshift"`.

### Task 5: the handoff plugin leaves the marketplace, its directory stays

**Files:**
- Modify: `.claude-plugin/marketplace.json` (remove the `handoff` entry, lines ~85-100), `README.md` (remove the `handoff` row at line 34), `scripts/repo-consistency.test.mjs` (the bijection test), `plugins/handoff/README.md` (a retirement note — a plugin-root README is exempt from the version-bump gate), `docs/developing.md` (one sentence).
- Bump: none.

**Interfaces:**
- Consumes: the verification behind this task, already done and recorded here so nobody repeats it. The emitOffer nesting from decision 15 is **fixed at HEAD**: `grep -rl emitOffer plugins` returns only `domain-modeling` and `session-retro`, and both build `{ systemMessage, hookSpecificOutput: { hookEventName, additionalContext } }` since PR #102 (commit 807ec80), with regression tests asserting the root position. `ship-gate` emits `emitAdditionalContext` only and never used `systemMessage`; the gates docs-consolidate pair (`stop-check-consolidation-drift.mjs` arms a flag, `check-consolidation-flag.mjs` emits `additionalContext`) never used it either. There is no nesting bug left to fix, so this plan carries no task for one.
- Produces: `const RETIRED = new Set(["handoff"]);` in `scripts/repo-consistency.test.mjs`, applied only to the directories-versus-entries bijection: a retired directory may have no entry, and an entry with no directory is still a failure. Every other test in that file iterates `entries` and needs no change.
- Does **not** produce: any deletion. `plugins/handoff/` and `plugins/handoff/tests/` stay exactly as they are — `.claude/hooks/tests-are-readonly.mjs` denies a commit that deletes a test file, so removing the directory is a human's commit after this one. Say so in the commit body.

- [ ] **Step 1:** edit `scripts/repo-consistency.test.mjs` first: the bijection test becomes `assert.deepEqual(entries.map(e => e.name).sort(), dirs.filter(d => !RETIRED.has(d)).sort())` with a comment saying a retired plugin keeps its directory until a human removes it, because the loop cannot delete tests. Run `node --test scripts/repo-consistency.test.mjs` → FAIL, the deepEqual diff showing `handoff` present in the entries and absent from the expectation.
- [ ] **Step 2:** remove the `handoff` object from `.claude-plugin/marketplace.json` and the `handoff` row from `README.md:34`. Same command → PASS. `bash scripts/check` → `CHECK OK` (`plugins/handoff/tests/*.test.mjs` still run and still pass; that is intended).
- [ ] **Step 3:** `plugins/handoff/README.md`: a first paragraph saying the plugin is retired from the marketplace as of 2026-09-05, that auto-fire has been off since 2026-08-08, that the code stays here for reference until someone removes it, and that installing it is no longer supported. `docs/developing.md`: one sentence that a retirement is two commits — the marketplace entry and README row by the loop, the directory by a human.
- [ ] **Step 4:** `git add .claude-plugin/marketplace.json README.md scripts/repo-consistency.test.mjs plugins/handoff/README.md docs/developing.md && git commit -m "handoff: retired from the marketplace; the directory waits for a human" -m "The loop cannot delete plugins/handoff/ or its tests: the tests-are-readonly hook denies any commit that removes a test file. Removing the directory is a follow-up commit by hand." -m "Claude-Session: nightshift"`.

### Task 6: the ablation number, and how to read it

**Files:**
- Modify: `docs/developing.md` (the `## Evals` section, or create it), and — only where they exist — `plugins/{adr,writing-artifacts}/evals/*/graders/*.md`.
- Test: append to `scripts/eval-cases.test.mjs` if it exists, else create `scripts/eval-ablation.test.mjs`. Decide with `test -f scripts/eval-cases.test.mjs && echo append || echo create` and follow the answer.
- Bump: only the plugins whose `evals/` files actually change, patch each (`evals/` is plugin payload).

**Interfaces:**
- Consumes: `claude plugin eval --help` on v2.1.261, read for this plan. `--ablation` defaults to `with-without` **whenever a plugin resolves**, so an `llm` grader is already scored in both arms and the delta is already computed; no per-case flag is needed for that. Under `with-without`, "graders marked with-only, incl. `tool_used: Skill`, are a plugin-fired indicator rather than part of the score" — which is exactly why a trace grader needs `arm: both` to count, as `docs/research/2026-09-04-marketplace-audit.md:151` records from the Δ=0 pilot. Re-run `claude plugin eval --help | sed -n '1,20p'` before writing the paragraph and quote what it says; if the CLI is absent, use those two recorded sources.
- Produces: a test `every tool_used grader is scored in both arms` over `plugins/*/evals/*/graders/*.md` — any grader whose frontmatter has `type: tool_used` must also have `arm: both`, with a message saying an unscored indicator makes `meanDelta` measure nothing. It passes vacuously when no eval case exists yet, and goes red the moment one is written without the key.
- Produces: the `## Evals` ablation paragraph in `docs/developing.md`: `meanDelta` is the number to read, not `overallScore`; both arms run by default, so the whole run command is `CLAUDE_CODE_WALNUT_SPIRE=1 claude plugin eval plugins/<name> --runs 3 --no-publish --output-dir <outside plugins/> --json <path>`; `--ablation with-without` states the default explicitly and `--ablation none` is for routing-only cases; `meanDelta ≈ 0` on a case with an `llm` grader means the no-plugin baseline passed the same rubric and the case measures nothing.

- [ ] **Step 1:** run the branch command above and write the test into the file it names. Run `node --test <that file>` → PASS (vacuously if no `evals/` directory exists yet; the assertion is the point, not the current count).
- [ ] **Step 2:** `ls -d plugins/adr/evals plugins/writing-artifacts/evals 2>/dev/null`. For each directory that exists, add `arm: both` to the frontmatter of every `graders/*.md` with `type: tool_used` that lacks it, and leave `llm` graders alone — they are scored in both arms already. Re-run the test → PASS. If neither directory exists, change no plugin file and skip the bump; the gates-config plan's eval task creates the cases, and the test above will hold them to this rule when it lands.
- [ ] **Step 3:** write the `docs/developing.md` paragraph (appending to `## Evals` if the section is there, creating the section with a one-line statement of the two tiers if it is not: `tests/` = does the code work, run by CI; `evals/` = does the skill fire and shape the work, maintainer-run, never a required check). `bash scripts/check` → `CHECK OK`.
- [ ] **Step 4:** bump patch for each plugin whose `evals/` files changed, if any; `git add docs/developing.md scripts plugins .claude-plugin/marketplace.json && git commit -m "evals: meanDelta is the number, and a trace grader that is not scored in both arms fails the test" -m "Claude-Session: nightshift"`.

## Open Questions
