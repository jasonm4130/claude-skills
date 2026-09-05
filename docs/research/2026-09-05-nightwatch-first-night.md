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

## Eval concerns so far (all low, none blocking)

Unit 1: two error-message strings drifted on `-32602` paths no test pins (`no such method` vs `no such tool`; missing `arguments` wording); `docs/developing/api.md`'s `sessions` example omits the `dir` field that `SessionSummary` always serialises; the spec's "every method has a JSON example and a test that feeds it" constraint is only met via the mcp tests for `sessions` and `transcript`. Later units inherit the third.

Unit 2: `search` is callable over MCP even though `tools/list` hides it, because `tools/call` routes any name into `api::call` without checking `MCP_TOOLS` (the comment claims otherwise); `limit: 0` returns one hit (push before the length check); the `search` reply example in `docs/developing/api.md` shows `index: 3` where the test fixture yields 0; and the bare `cargo run --` acceptance form (fixed in the spec, above). The first two are real small bugs worth a fix-up commit before the PR.

## Observations and what to change (v1 candidates, ranked)

1. **`MAX_UNITS=8` is the binding cap, not time or money.** At ~20 min and ~$6.50 per unit, eight units are ~2.7 h and ~$52 against a 7 h deadline and $15 per unit. ui-api alone needs three or four units, so tonight touches two or three of six specs. Make the cap per spec (`MAX_UNITS_PER_SPEC`) and let the deadline bound the run.
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

- Resume ui-shell too: `--only 03-ui-shell` (branch exists with zero commits; it costs nothing to keep).
- Resume both kept branches: `run.sh <clone> <specs> --only 02-session-tools` (should PASS on Reconcile plus Verify: all three units are committed), then `--only 01-ui-api` (two units left). Both before the batch push.
- Disposition of the Codex audit P1 (launcher lock as the answer, or something else).
- Whether the three unit-1 eval concerns should be fixed on the branch before the PR.
- One PR for the batch or one per landed outcome (v1 plan open question 3).
- The docs-consolidate nudge has been firing (117 commits); deferred, not run.
