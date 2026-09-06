# Nightwatch first night: running log

Live record of the first unattended Nightwatch v0 run (ambient, six specs), kept so the morning session starts warm. Appended as the night goes; timestamps are local. The engine is `plugins/nightshift/nightwatch/{nightwatch.mjs,run.sh}` on branch `nightwatch-redesign`; the design is `2026-09-05-nightwatch-redesign.md`; the follow-on plan is `docs/plans/2026-09-06-nightwatch-v1.md`.

## Where everything is

- Clone: `~/Work/Git/nightwatch/ambient`. Integration branch `nightwatch/2026-09-05` (cut from `origin/main` at `e5e2de5`). Outcome branches `nw/2026-09-05/<slug>`.
- State: `~/.local/state/nightwatch/ambient/`: `journal.md` (one line per event), `decisions.jsonl` (one JSON per unit with cost), `specs/0{1..6}-*.md` (the queue), `runs/20260905-225514/<slug>/` (this launch: `active-unit.md`, `u<n>.result.json`, `u<n>-logs/`). The committed launcher now writes under `outcomes/<slug>/` instead; the running one predates that.
- Workflow journals: `~/.claude/projects/-Users-jasonmatthew-Work-Git-nightwatch-ambient/*/subagents/workflows/wf_*/journal.jsonl`, one directory per unit.
- Launcher: pid 98455 under `caffeinate -i`, `UNIT_BUDGET=15`, in a herdr pane. Kill switch: repo variable `LANDING_STATE` on ambient, must read `run`.
- Morning push: `git -C ~/Work/Git/nightwatch/ambient push -u origin nightwatch/2026-09-05 && gh pr create` (from the clone; PR body from the result files and `u<n>-logs`).

## Timeline

| time | event |
|---|---|
| 22:53 | dry run of the throwaway plumbing spec: DRYRUN, $0.37. Proved result-file recording and the print-mode ceiling override. |
| 22:55 | live launch, queue 6 specs, deadline 7h, max 8 units. |
| 22:55–23:15 | ui-api unit 1, "One dispatcher: src/api.rs behind ambient mcp": CONTINUE, $6.46, commit `6545df3`. `scripts/check` green, 16 mcp tests green. Eval: three low concerns (see below). |
| 23:16 | ui-api unit 2 Reconcile: clean at `6545df3`; the planner read the done unit-1 brief and correctly chose unit 2, "`search` across every transcript". |
| 23:22 | unit 2 Implement started. First unit to run under the launcher-owned command logs (`u2-logs/reconcile-{1..4}.log`, each ending `exit=0`). |
| 23:35 | ui-api unit 2, "`search` across every transcript": commit `e8003cd`, check green, Eval four low concerns. |
| 23:38 | Spec fix while running: acceptance lines in specs 01 and 02 said `cargo run -- <verb>`, which exits 101 (15 binaries, no `default-run`), so those outcomes could never reach PASS. Rewritten to `cargo run --bin ambient -- <verb>`; the launcher re-reads the spec each unit. |
| 23:55 | ui-api unit 3, "Session metadata: name, tags, notes, pinned": commit `0cb8887`, check green, Eval "ok". Only `cargo test session::delete` (the delete unit) still fails acceptance. |
| 00:19 | ui-api unit 4, "delete a session, never a live one; writers take the lock": commit `e949ad1`, $8.09, check green, delete lands with 7 tests. Eval raised one HIGH: `unparseable` in a doc comment fails `crate-ci/typos` in CI, which `scripts/check` does not run. Engine rule high → BLOCKED fired: **ui-api BLOCKED** with 4 commits kept, launcher moved to session-tools. |
| 00:20 | Typo fixed on the blocked branch from a worktree: `68b4723 session: spell unparsable the way typos wants it` (`typos src/session.rs` clean). Resume ui-api in the morning with `--only 01-ui-api`; two units remain (export; config/roster/speakers). |
| 00:21 | Engine: `95f00b2` adds one eval-repair round (worker fixes the named high concerns, re-verify, re-eval) before BLOCKED. Live from the next unit that starts after it; session-tools unit 1 started on the old script. |
| 00:31 | session-tools unit 1, "Extract session::model_files": `c30e884`, $3.82, eval ok. |
| 00:46 | session-tools unit 2, "src/doctor.rs, the pure ten-check run": `c4a1731`, $4.42, eval ok. |
| 00:57 | session-tools unit 3, "the doctor CLI arm, USAGE line, two docs sections": the worker committed `28b1c93 doctor: wire the verb up` (the last unit the spec needs) and then omitted the schema's required `blockedReason` field five times; the StructuredOutput retry cap threw out of the workflow, no result file was written, and the launcher recorded **session-tools FAILED** ($2.99) with 3 commits kept. The branch is very likely complete; nothing verified it. Launcher moved to ui-shell (unit 7 of 8). |
| 00:59 | Engine: schemas now require only load-bearing fields (`status`/`commits`/`summary` for Implement, and so on) and the script fills the rest with defaults. Live from the unit after ui-shell unit 1. |
| 01:01 | **ui-shell FAILED at unit 1 in four minutes ($0.53), zero commits.** Its acceptance command `cargo run --bin uicheck` writes `uicheck.png` to the repo root; Reconcile saw an untracked file, reported the tree dirty, and the engine's "not clean at start of unit 1" rule failed the outcome. Launcher moved to ui-features (unit 8 of 8, the last), whose acceptance writes the same file. |
| 01:02 | Stop-gap for the running unit: `/uicheck.png` and `/windowcheck.png` added to the clone's `.git/info/exclude`, in place before ui-features' Reconcile ran the command (the file appeared at 01:03 with `git status` clean). Engine fix committed: the launcher runs `git clean -fdq` after every unit and both prompts say an acceptance-written file is not dirt. |
| 01:06 | ui-features BLOCKED at planning ($1.55): spec 04 depends on 01, 02 and 03, none landed on the integration branch. Correct, and the `Depends:` line of v1 item 2 would have skipped it for free. Launcher moved to 05-wer, the first unit on the fully patched engine. |
| 01:32 | wer unit 1, "`wer --via <rate>`: does the resampler cost words": `b45ca46`, $5.55, eval ok (one low note: the transcode cache keys on rate and speaker only). First clean unit on the fully patched engine. |
| 01:34 | wer unit 2 Reconcile reported every acceptance command passing at `b45ca46`; the planner still chose a unit (the `calls` fixture set) because the Outcome asks for more than the acceptance tests. A spec whose acceptance passes before its Outcome is done is a spec gap: `nightwatch:spec` should refuse it. |
| 01:45 | **wer BLOCKED at unit 2 on a real spec defect.** Acceptance item 5 builds each Earnings-21 reference from tokens with `ts` under 300 s, but every `.nlp` reference file has empty `ts`/`endTs` columns. The worker made no edits and left the facts: media is plain (not LFS), the first three sorted ids are 4320211, 4330115, 4341191, header order is `token|speaker|ts|endTs|punctuation|case|tags|wer_tags`, lines are CRLF. Jason decides the replacement rule (truncate audio to 300 s and use the whole reference, or drop the bound). |
| 02:05 | live-asr unit 1, "src/bench.rs, the pure queue arithmetic and its tests": `5f1f9be` + `aa9ee26`, eval ok. |
| 02:26 | live-asr unit 2, "asrbench binary: replay in blocks, time each stage, feed the queue simulation": `0957844`, eval ok, no concerns. Remaining: the three dated sections in `docs/developing/measurements.md` (unit 3, needs a real benchmark run on the symlinked models). |
| 02:56 | live-asr unit 3, "drainbench waits for the decoder and counts its passes": `e875439`, $4.58, eval ok. |
| 03:15 | Engine: `07b88a2`. live-asr unit 4 had every acceptance item passing but Verify said `allPass: false` because two commands the spec says must fail exit non-zero; the prompt defined a pass as exit 0. Fixed, and the planner's "done" now needs Reconcile's own all-pass as evidence instead of being trusted (it used to fabricate `allPass: true`). |
| 03:18 | live-asr unit 4, "the measurements sections and the verdict": `982db41`, $4.41, three low concerns (rounding artefacts in the shown arithmetic, Verdict subsection undated, overshoot number in the second sentence). |
| 03:39 | **live-asr PASS** at unit 5 (`4597105`, $4.21): `allPass: true`, eval ok, no concerns. Fast-forwarded onto `nightwatch/2026-09-05`, six commits ahead of `origin/main`. Run ended: 1 of 6 outcomes landed, 4 h 44 min, 16 units. |

## Fixed before launch (all in the engine now)

1. Print mode kills background tasks at 600 s and the driver then invents a result. Fix: `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` in the child env, and the workflow's last agent writes `u<n>.result.json`; the launcher reads that file and treats a missing file as FAILED. Cost of learning it: one $3.11 fabricated CONTINUE.
2. User settings' `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` forced default permission mode in the child. Fix: `--settings '{"env":{"CLAUDE_CODE_SUBPROCESS_ENV_SCRUB":"0"}}'`.
3. Fresh clone is an untrusted workspace, so project settings and hooks were ignored. Fix: `hasTrustDialogAccepted: true` for the clone path in `~/.claude.json`.
4. `log` through `tee` polluted stdout, which carries the unit state. Fix: journal plus stderr.
5. Outcome branches cannot live under `nightwatch/<date>/` (ref conflict with the integration branch). Fix: `nw/<date>/<slug>`.
6. Per-launch run dir lost `active-unit.md` across a relaunch. Fix: per-outcome dir (effective next launch).

## Fixed after launch (commits on `nightwatch-redesign`)

- `20a0f74`: every Reconcile and Verify command runs through `bash -c '<cmd>' > <log> 2>&1; echo exit=$?` into `u<n>-logs/`, so the morning reads real output, not the agent's tail. Live from unit 2 because the Workflow re-reads the script per unit. Also folded Codex round 3 (single integration-branch owner for parallel clones; terminal states are local branches plus journal, no draft PRs).
- `ec6090d`: `run.sh` takes `launcher.lock` per repo; a second launcher on the same repo exits 2 with the owning pid. Answers the Codex audit's P1 (two launchers would both build `nightwatch/<date>` and only one could push). Not active in the running launcher.
- Codex chain e8145224000a closed: rounds 1–3 REVISE (3+3, 3+4, 2+1 findings), audit CONCERNS with that one P1, outcome `audit-concerns-unattended`, 11 counted unique. Jason's disposition of the P1 is still owed; the lock is my proposed answer.

## How the night ended

| outcome | state | commits | cost | what the morning does |
|---|---|---|---|---|
| 06-live-asr | PASS, landed | 6 | $24.07 | nothing; it is on the integration branch |
| 01-ui-api | BLOCKED (typo, fixed by hand as `68b4723`) | 5 | $27.00 | `--only 01-ui-api`: two units left (export; config/roster/speakers) |
| 02-session-tools | FAILED (schema bug; work complete) | 3 | $11.23 | `--only 02-session-tools`: expect PASS on Reconcile |
| 05-wer | BLOCKED (spec defect: no `ts` in Earnings-21) | 1 | $8.34 | fix acceptance item 5, then `--only 05-wer` |
| 03-ui-shell | FAILED (artefact counted as dirt) | 0 | $0.53 | `--only 03-ui-shell` after 01 and 02 land (it depends on them) |
| 04-ui-features | BLOCKED (depends on 01–03) | 0 | $1.55 | last, after 03 |

Live run total: 16 units, ~$72.70, 22:55 to 03:39. Every failure but one (the Earnings-21 timestamps) was the harness, and every harness failure has a fix committed on `nightwatch-redesign` (`20a0f74`, `ec6090d`, `95f00b2`, `ac5c32f`, `88b5dc9`, `07b88a2`). The patched engine ran live-asr's five units and wer's unit 1 without a harness fault. Code quality per the evaluator: 16 units, one high concern (the typo), the rest low and mostly cosmetic.

## Day after: batch 1 and the relaunch

- 07:00–07:45: v1 batch 1 (`docs/plans/2026-09-06-nightwatch-v1-batch1.md`) built by a native Workflow in a worktree: launcher orders (`Depends:`, `Units:`, `Writes:`, append-only control file with offset, `pause`, `landed` rows with ancestry check, PARTIAL when the workflow dies with work, PASS needs verified logs), `lint-spec.mjs` + `nightwatch:spec`, `morning.mjs` (+ legacy `runs/` layout), `nightwatch:watch` playbook, docs, version bump. Codex plan review: 3 rounds + audit (9 unique findings folded, two audit concerns amended at Jason's choice). Codex diff review: 3 rounds + audit, 7 findings folded (empty-verify PASS, remote landing branch, PR base, three rounds on the launcher lock). 60 tests green, shellcheck clean.
- Specs re-linted to `SPEC OK (6 specs)`: test counts pinned from the night's logs, `Writes:` on wer, `Depends:` on ui-shell (01) and ui-features (01, 02, 03), wer item 5 rewritten (first 300 s of audio, whole `.nlp` reference), ui-api items 11 and 12 for the two eval bugs.
- 07:50 relaunch, detached (`Popen` with its own session; a background Bash call has a 10-minute ceiling and was stopped before it spent a unit): `DATE=2026-09-05` so the kept `nw/2026-09-05/*` branches resume and everything lands on `nightwatch/2026-09-05`; queue 01, 02, 03, 04, 05; `landed` backfilled with live-asr's row so 03/04's `Depends:` can be satisfied by the ancestry check.

## Eval concerns so far (all low, none blocking)

Unit 1: two error-message strings drifted on `-32602` paths no test pins (`no such method` vs `no such tool`; missing `arguments` wording); `docs/developing/api.md`'s `sessions` example omits the `dir` field that `SessionSummary` always serialises; the spec's "every method has a JSON example and a test that feeds it" constraint is only met via the mcp tests for `sessions` and `transcript`. Later units inherit the third.

Unit 2: `search` is callable over MCP even though `tools/list` hides it, because `tools/call` routes any name into `api::call` without checking `MCP_TOOLS` (the comment claims otherwise); `limit: 0` returns one hit (push before the length check); the `search` reply example in `docs/developing/api.md` shows `index: 3` where the test fixture yields 0; and the bare `cargo run --` acceptance form (fixed in the spec, above). The first two are real small bugs worth a fix-up commit before the PR.

## Observations and what to change (v1 candidates, ranked)

1. **`MAX_UNITS=8` is per outcome, and the deadline is the run's cap.** At ~20 min and ~$6.50 per unit an outcome can spend ~2.7 h and ~$52 before the launcher moves on; six specs in a 7 h night means two or three get real time unless they finish early. Per-spec unit caps in the spec header (`Units: 4`) would let a small spec stop hogging a night.
2. **Three `scripts/check` runs per unit** (Reconcile at unit 1, worker before commit, Verify). Reconcile after unit 1 could skip `check` when the branch head equals the last verified head; Verify must keep it.
3. **The planner reads a done brief and infers the next unit.** It worked at unit 2, but Record should overwrite `active-unit.md` with a "done: <title>, next: <hint>" stub so the inference is not load-bearing.
4. **Eval concerns vanish unless someone reads the journals.** Item 1 of the v1 plan (morning tool) should print them per unit; the result file already carries them.
5. **Cost per unit is in `decisions.jsonl`, wall clock is not.** Add `startedAt`/`endedAt` to the record line.
6. **Verify skipped a command and reported a guessed exit code.** Unit 3's verifier wrote "not independently verified" for `cargo test session::delete` and `u3-logs/` has no log for it (nine verify logs for ten commands). The schema should require a log path per result and the workflow should refuse a result whose log is missing; cheap, and it closes the gap the command logs were added for.
7. **A high eval concern blocked a whole outcome over a one-word typo.** The evaluator was right (CI would fail) and the rule did what the design said, but the cost was the remaining ui-api units tonight. Fixed in `95f00b2` with a repair round. The deeper fix is in ambient: `scripts/check` should run `typos` when installed so local check equals CI; that is a spec for tomorrow.
8. **Vacuous acceptance commands.** `cargo test export::` exits 0 with zero tests; the spec's acceptance line cannot tell "passed" from "nothing ran". The verifier caught it by judgment, which is the thing we are trying not to depend on. Specs should pin counts (`cargo test export:: 2>&1 | grep -q '7 passed'`), and `nightwatch:spec` (v1 item 5) should refuse a bare `cargo test <filter>`.
9. **A thrown agent error leaves no result file, which reads as a dead unit.** The record step is the last `agent()` call; anything that throws before it (schema retry cap, agent killed) skips it. Two fixes, both v1: the launcher should treat "no result file but new commits on the branch" as PARTIAL-with-work rather than FAILED, and the script should catch at the top level and still record. The Workflow runtime forbids wrapping top-level `return`s in `try`, so the record-on-throw has to be a launcher-side fallback that reads the driver's stderr for the error text.
10. **"Dirty" needs a definition that excludes what acceptance commands write.** Tonight it cost an outcome for $0.53 and would have cost a second. Untracked files at the start of a unit cannot be work (the worker commits what it makes), so the launcher now cleans them; a spec whose acceptance writes a file should say so, and `nightwatch:spec` should ask.
11. **Parallel outcomes** (v1 item 2) are where the sequential frustration goes; the lock and single-owner rule from tonight are the prerequisites and are in.

## Open for Jason in the morning

- Fix spec 05's acceptance item 5 (no per-token timestamps in Earnings-21 `.nlp` files) then `--only 05-wer`.
- Resume ui-shell too: `--only 03-ui-shell` (branch exists with zero commits; it costs nothing to keep).
- Resume order matters for the fast-forward: 02 first (three commits, all-pass expected), then 01, then 03, then 04, then 05 once its spec is fixed. Each resume is one `run.sh <clone> <specs> --only <slug>`.
- Resume both kept branches: `run.sh <clone> <specs> --only 02-session-tools` (should PASS on Reconcile plus Verify: all three units are committed), then `--only 01-ui-api` (two units left). Both before the batch push.
- Disposition of the Codex audit P1 (launcher lock as the answer, or something else).
- Whether the three unit-1 eval concerns should be fixed on the branch before the PR.
- One PR for the batch or one per landed outcome (v1 plan open question 3).
- The docs-consolidate nudge has been firing (117 commits); deferred, not run.

## Day two, 2026-09-06: batch 2, "initialize nightwatch"

Goal set by Jason: open a session in transcoder, say "initialize nightwatch", and have it work without us. Plan: `docs/plans/2026-09-06-nightwatch-v1-batch2-init.md` (Codex chain `b1de5b71a909`: three REVISE rounds and an audit, nine unique findings, all folded). Decisions worth keeping:

- **Init touches nothing on GitHub.** Jason asked whether setup would burn CI as ambient's macOS job did the day before. The first draft opened a `scripts/check` PR per repo; dropped. A repo without a check gets a generated one in `~/.local/state/nightwatch/<name>/check`, and the engine, linter and spec skill take the command from the config.
- **The launcher runs the check itself before landing** (Codex twice: a hash around the unit is bypassable by swap-run-restore). For a generated check it verifies `CHECK_SHA` then runs it; for a repo-owned check it runs the base branch's copy and flags a changed script for the morning (Jason's disposition of the audit P1).
- **Guards travel with the launcher** via `--settings` hooks (probe: a settings hook denied a command in a headless `claude -p`), paths double-quoted because the engine's wrapper is `bash -c '<command>'`.
- **Preflight is step 1** and covers `timeout` and `ANTHROPIC_API_KEY`, the two things the launcher and engine refuse.
- Landing branch untouched since cut is moved to `origin/<base>` at launch; a dry run must show `verify.allPass` and `clean` before the launcher says `dry run complete`.

Implementation: Workflow `wf_6aadb516-60d` in worktree `scratchpad/nw-v2`, branch `nightwatch-v1-batch2` (Opus on Tasks 1 and 2, Sonnet worker on 3). Then diff review, merge into `nightwatch-redesign`, PR to main, plugin publish, and the headless acceptance in transcoder.
