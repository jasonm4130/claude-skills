# Nightwatch Review Clause and Prompt Guards Implementation Plan

**Goal:** the unattended stream reports the two numbers that say whether its output is trusted (reverts, human overrides), its guard stops denying text that is only being written down, and three prompt-level gates land in `plugins/gates` — a spec before any fan-out, a restated goal on the first prompt, and a closing demand for the command and output behind every "done".
**Architecture:** the Nightshift changes land in `plugins/nightshift/templates/**` only, never in this repo's `loop/` or `.claude/` copies (a human runs `init.mjs --update` afterwards). The gates changes follow that plugin's existing shape: one `.mjs` per hook, `lib.mjs` for hook I/O, per-session marker files under `resolveDataDir("gates-data")`, silent on every anomaly. Nothing new is compiled; `bin/ccguard` is untouched.
**Tech Stack:** stdlib `.mjs`, Node 24 `node --test`, bash 3.2-compatible shell in `land.sh`, `scripts/bump-plugin.mjs`, `claude plugin validate`.

## Global Constraints
- Any change under `plugins/<name>/` outside `README.md`, `CLAUDE.md`, `tests/`, `*.test.mjs` and `.claude-plugin/` MUST be followed by `node scripts/bump-plugin.mjs <name> patch` before the commit (those five are exempt per the header of `scripts/check-version-bumps.mjs`). The bump also rewrites the marketplace entry.
- `bash scripts/check` must end with `CHECK OK` before every commit. Never delete or rename a test file — `.claude/hooks/tests-are-readonly.mjs` denies that commit.
- Do not edit `.github/`, `.claude/`, `loop/` or `scripts/` unless the task names the file. `plugins/gates/hooks/hooks.json` and `plugins/nightshift/templates/**` are plugin payload and are in scope.
- Commit messages say why and end with `-m "Claude-Session: nightshift"`. Never write the literal text `gh pr merge` or `gh variable set` into a commit message or a PR body: `.claude/hooks/no-route-around-ci.mjs` reads the whole command and denies it.
- Write test files with the Write tool, not with a shell heredoc. Until Task 2 lands, a heredoc whose body quotes a merge command is denied by that same guard.

### Task 1: the skeptic's clean pass, and the trust signal beside the landed count

**Files:**
- Modify: `plugins/nightshift/templates/loop/SKEPTIC.md` (the "Be concrete" paragraph), `plugins/nightshift/templates/loop/land.sh` (argument loop ~57-66, new helpers after `task_done` ~118, final `stop` at line 394), `plugins/nightshift/templates/docs/landing.md` ("Reading the morning", ~48-56), `plugins/nightshift/README.md` (the journal paragraph).
- Test: `plugins/nightshift/tests/land-dry-run.test.mjs` (append one test), `plugins/nightshift/tests/fixtures.mjs` (one new arm in the `gh` shim).
- Bump: nightshift patch.

**Interfaces:**
- Consumes: `land.sh`'s existing `$repo`, `$BASE`, `$slug`, `$BRANCH_PREFIX`, `$BLOCKED_LABEL`, `$RETRY_LABEL` and `log()` (line 70, which writes to `$STATE_DIR/journal.md` and stderr).
- Produces: `stats_since()` → `date -u -v-30d +%F 2>/dev/null || date -u -d '30 days ago' +%F`. `night_stats <sinceDate>` prints `reverts<TAB>overrides`: **reverts** = `git -C "$repo" log "origin/$BASE" --since="$1" --grep='^Revert' --grep="$BRANCH_PREFIX/$slug-t" --all-match --format=%H | wc -l` (a revert of a landed task names its branch in the reverted subject); **overrides** = the union, `sort -u`, of `gh pr list --state merged --label "$BLOCKED_LABEL" --search "merged:>=$1" --json number --jq '.[].number'` (a human merged what the loop blocked) and `gh pr list --state all --label "$RETRY_LABEL" --search "created:>=$1" --json number --jq '.[].number'` (a human sent a task back), each wrapped in `|| true` so a `gh` failure reads as zero. New flag `--stats`: fetches, prints the line, exits 0 before the lock, so it never fights a running night. The night's last two journal lines become `reverts N, overrides M since <date>` then `STOP: done: K task(s) landed tonight`.
- Not `morning.mjs`: that script does not exist at HEAD (it is created by the gates-config plan). `land.sh` is what writes the journal today, so the counts go where the landed count already is.

- [ ] **Step 1:** in `fixtures.mjs`, add `*"--state merged"*) printf '%s\n' "${FAKE_GH_MERGED_PR:-}" | grep . ;;` as the first arm of the `"pr list")` case. In `land-dry-run.test.mjs` add a test: build `nightshiftRepo()`, commit `--allow-empty -m 'Revert "Merge pull request #1 from o/land/smoke-t1"'` on main and push, then run `bash loop/land.sh --stats` through the existing `dryRun` helper shape with `FAKE_GH_STATE: "run", FAKE_GH_MERGED_PR: "7"`; assert exit 0 and `assert.match(r.journal, /reverts 1, overrides 1 since \d{4}-\d{2}-\d{2}/)`. Run `node --test plugins/nightshift/tests/land-dry-run.test.mjs` → FAIL, stderr contains `unknown argument: --stats`.
- [ ] **Step 2:** implement `stats_since`, `night_stats`, the `--stats` arm (`--stats) stats=1; shift ;;` with `stats=0` beside `dry=0`), the early `--stats` block placed after the helper definitions and before the `# ---- the night` lock, and the `log "reverts $r, overrides $o since $since"` line immediately before line 394's `stop "done: …"`. Run `node --test plugins/nightshift/tests/*.test.mjs` → PASS (`# fail 0`).
- [ ] **Step 3:** `SKEPTIC.md`: replace `"I'm not sure this is right" is not a refutation; a diff you cannot fault is OK.` with `"I'm not sure this is right" is not a refutation. VERDICT: OK with zero findings is the expected result on a correct diff, not a failure to look hard enough — do not manufacture findings to prove you reviewed.` `templates/docs/landing.md` "Reading the morning": one bullet saying `loop/land.sh --stats` prints reverts and human overrides over the last 30 days, and that the override rate — not the landed count — is the signal that the night is trusted. Same sentence in `plugins/nightshift/README.md`.
- [ ] **Step 4:** `bash scripts/check` → `CHECK OK`. `node scripts/bump-plugin.mjs nightshift patch`; `git add plugins/nightshift .claude-plugin/marketplace.json && git commit -m "nightshift: a clean pass is the expected verdict, and the journal reports reverts and overrides beside the landed count" -m "Claude-Session: nightshift"`. (Consumers pick this up with `init.mjs --update`; this repo's own `loop/` copy is a human's commit.)

### Task 2: the guard reads a heredoc body as text, and a read-only pipeline as a read

**Files:**
- Modify: `plugins/nightshift/templates/hooks/no-route-around-ci.mjs` (header comment 20-24, `judge` at 66-102, `main` at 129).
- Test: `plugins/nightshift/templates/hooks/hooks.test.mjs` (append).
- Bump: nightshift patch.
- Rebase note: the gates-config plan's Task 3 edits the same `judge`. If it landed first, keep its `stripMessageArgs` and compose: `scan = stripMessageArgs(stripHeredocs(c))`. If it has not, `scan = stripHeredocs(c)` alone. Read the file before editing rather than assuming either shape.

**Interfaces:**
- Produces: `stripHeredocs(command) → string`, ported from `plugins/gates/scripts/pretooluse-guard-docs-sync.mjs:83-118` (`splitHeredocs`) but returning only the stripped text — this guard never needs the bodies. It consumes every introducer on a line in order (`cmd <<'A' <<'B'` queues two bodies), handles `<<EOF`, `<<'EOF'`, `<<"EOF"` and `<<-EOF` (tab-stripped terminator), and keeps the introducer line itself.
- Produces: `stripReadOnly(text) → string`. Split on newline, `;`, `&&`, `||` into statements; split each statement on `|` into stages; drop the whole statement when **every** stage's head binary is one of `cat sed awk grep rg ls jq head tail less printf echo` (after stripping leading `VAR=value` assignments and `sudo`). A pipeline with one non-read-only stage is kept in full, so `printf 'gh pr merge 12' | bash` still denies.
- `judge(command, stagedPaths, bases)` computes `scan` once and runs every textual rule (`gh pr merge`, `--admin`, `gh workflow`, `gh variable`, `git push`, `--no-verify`, `git commit`, `gh api`) against it. The staged-path rules are unchanged. `main` decides whether to call `staged()` from the same stripped form. Both helpers are exported for tests.

- [ ] **Step 1:** append tests to `hooks.test.mjs` (Write tool, not a heredoc): `judge("cat > index.py <<'EOF'\nprint('gh pr merge 12')\nEOF", [])` → `[]` (the real 2026-09-05 06:13:42Z denial); the same with `<<EOF` and with `<<-EOF` and a tab-indented terminator → `[]`; `judge("cat <<'A' <<'B'\ngh workflow disable ci\nA\ngh variable delete X\nB", [])` → `[]` (both bodies consumed); `judge("grep -n 'gh pr merge' loop/land.sh", [])` → `[]`; `judge("sed -n '1,20p' docs/nightshift.md", [])` → `[]`; `judge("printf 'gh pr merge 12' | bash", [])` → one reason; `judge("cat <<'EOF' > x\ntext\nEOF\ngh pr merge 12", [])` → one reason (a real command after the body still fires); `judge("gh pr merge 12", [])` → one reason; `judge("git push --force origin main", [])` → two reasons (unchanged). Run `node --test plugins/nightshift/templates/hooks/hooks.test.mjs` → FAIL, `# fail 1` or more.
- [ ] **Step 2:** implement both helpers and the `scan` wiring; update the header comment's "Everything else passes" paragraph to name the two exemptions and why (a body is text being written; a read-only pipeline cannot merge anything). Run `node --test plugins/nightshift/templates/hooks/hooks.test.mjs plugins/nightshift/tests/*.test.mjs` → PASS. `bash scripts/check` → `CHECK OK`.
- [ ] **Step 3:** `node scripts/bump-plugin.mjs nightshift patch`; `git add plugins/nightshift .claude-plugin/marketplace.json && git commit -m "nightshift guard: a heredoc body and a read-only pipeline are text, not a route to main" -m "Claude-Session: nightshift"`. (This repo's `.claude/hooks/` copy is a human's commit.)

### Task 3: a fan-out prompt is interviewed to a spec before it dispatches

**Files:**
- Create: `plugins/gates/scripts/userpromptsubmit-spec-before-fanout.mjs`.
- Modify: `plugins/gates/hooks/hooks.json` (a second entry in the existing `UserPromptSubmit` array), `plugins/gates/README.md` (a `## Prompt nudges` section), `plugins/gates/CLAUDE.md` (one bullet under "What this is").
- Test: `plugins/gates/tests/spec-before-fanout.test.mjs` (create).
- Bump: gates minor.

**Interfaces:**
- Consumes: `readStdin`, `safeJsonParse`, `resolveSessionId`, `resolveDataDir`, `emitAdditionalContext` from `plugins/gates/scripts/lib.mjs`; payload `{session_id, prompt, cwd}`.
- Produces: the hook fires when the prompt matches `/\b(workflow|ultracode|best in class|research|audit)\b/i` **and** contains no spec path (`/[\w./-]+\.md\b/` absent), and it has not already fired this session (marker `spec-nudge-<sessionId>.done` in `resolveDataDir("gates-data")`, written before the emit so a crash cannot re-fire it). It emits `emitAdditionalContext("UserPromptSubmit", …)` with: ask 5-8 forced-choice questions first; write the answers to a spec file in this repo and name its path; then run a two-minute pre-mortem — assume the work shipped and failed, name the three most likely causes — before any fan-out; nothing is blocked, and if a spec already exists, name it and carry on. Never blocks, never exits non-zero. Anomalies (unparseable payload, non-object, missing prompt, unwritable data dir) exit 0 silently, as every gates hook does. Name no skill in the text: `scripts/repo-consistency.test.mjs` requires any skill a hook names to be plugin-qualified.

- [ ] **Step 1:** write `plugins/gates/tests/spec-before-fanout.test.mjs`, modelled on `plugins/gates/tests/consolidation-hooks.test.mjs`: spawn the script with `CLAUDE_PLUGIN_DATA` set to a temp dir and stdin `{"session_id":"s1","prompt":"kick off a research fan-out over the plugins","cwd":"<tmp>"}` → stdout parses, `hookSpecificOutput.hookEventName === "UserPromptSubmit"`, `additionalContext` matches `/pre-mortem/` and `/spec file/`; the same payload again → stdout empty (fire-once); `{"prompt":"read docs/plans/x.md and audit it"}` → stdout empty (a spec path is named); `{"prompt":"fix the typo in the README"}` → stdout empty; stdin `not json` → stdout empty, exit 0. Run `node --test plugins/gates/tests/spec-before-fanout.test.mjs` → FAIL, `Cannot find module`.
- [ ] **Step 2:** implement the script with `// @ts-check` and a JSDoc `@typedef` for the payload, matching `check-consolidation-flag.mjs` line for line in structure. Test → PASS.
- [ ] **Step 3:** add the hooks.json entry `{"type":"command","command":"node \"${CLAUDE_PLUGIN_ROOT}/scripts/userpromptsubmit-spec-before-fanout.mjs\"","timeout":5}` after the existing `check-consolidation-flag.mjs` entry (shell form, never exec form — see `scripts/hook-runtime-guard.test.mjs`). `claude plugin validate plugins/gates` → `✔ Validation passed`. `node --test scripts/hook-runtime-guard.test.mjs scripts/repo-consistency.test.mjs` → PASS. `bash scripts/check` → `CHECK OK`.
- [ ] **Step 4:** README `## Prompt nudges`: the trigger words, the two silence conditions, once per session, never blocks. CLAUDE.md: one bullet naming the hook and the rule that it must not name a skill unqualified. `node scripts/bump-plugin.mjs gates minor`; `git add plugins/gates .claude-plugin/marketplace.json && git commit -m "gates: a fan-out word with no spec file gets an interview-then-spec nudge" -m "Claude-Session: nightshift"`.

### Task 4: the first prompt of a session restates the goal and its success criterion

**Files:**
- Modify: `plugins/gates/scripts/userpromptsubmit-spec-before-fanout.mjs`, `plugins/gates/README.md` (the `## Prompt nudges` section), `plugins/gates/CLAUDE.md` (the same bullet).
- Test: `plugins/gates/tests/spec-before-fanout.test.mjs` (append).
- Bump: gates patch.

**Interfaces:**
- Consumes: the same data dir the other gates hooks use, `resolveDataDir("gates-data")`; marker `first-prompt-<sessionId>.seen`.
- Produces: on the first prompt of a session (marker absent) the hook writes the marker and adds one paragraph to whatever it was already going to say: "Before acting, restate in one line what this is for and how we will both know it worked. If the prompt already says both, repeat them back in one line and continue." Both texts leave in a single `additionalContext` (one hook writes one JSON object), separated by a blank line. The fan-out clause is still gated on its own trigger, so a first prompt with no fan-out word gets only the restate line, and a fan-out prompt mid-session gets only the fan-out line.

- [ ] **Step 1:** append tests: fresh data dir, `{"session_id":"s2","prompt":"fix the typo in the README"}` → `additionalContext` matches `/success criter|know it worked/i` and does **not** match `/pre-mortem/`; the same session again with a plain prompt → stdout empty; a fresh session `{"session_id":"s3","prompt":"run a research fan-out"}` → one payload matching both `/know it worked/i` and `/pre-mortem/`; `{"session_id":"s3","prompt":"another research pass"}` → stdout empty (both markers spent). Run → FAIL, `# fail 1`.
- [ ] **Step 2:** implement; keep every anomaly silent and the marker write before the emit. Test → PASS. `bash scripts/check` → `CHECK OK`.
- [ ] **Step 3:** README and CLAUDE.md: the first-prompt clause, the marker names, and that a session id of `unknown` (payload without `session_id`) makes the nudge once-per-data-dir rather than once-per-session, which is the accepted cost of staying silent about anomalies. `node scripts/bump-plugin.mjs gates patch`; `git add plugins/gates .claude-plugin/marketplace.json && git commit -m "gates: the first prompt of a session restates the goal and its success criterion" -m "Claude-Session: nightshift"`.

### Task 5: a session that claims work is done pastes the command and the output

**Files:**
- Create: `plugins/gates/scripts/stop-demand-verification.mjs`.
- Modify: `plugins/gates/hooks/hooks.json` (a second entry in the existing `Stop` array), `plugins/gates/README.md`, `plugins/gates/CLAUDE.md` (a design-decision paragraph).
- Test: `plugins/gates/tests/stop-demand-verification.test.mjs` (create).
- Bump: gates minor.

**Interfaces:**
- Consumes: Stop payload `{session_id, transcript_path, stop_hook_active, cwd}`.
- Produces: at most one `{"decision":"block","reason":"<demand>"}` per eight assistant blocks. The demand: "Before you stop: for each thing you have said is done, paste the command you ran and the line of its output that shows it. Anything you did not run, list under 'unverified'. Then stop." The count comes from `transcript_path`: lines of JSONL whose parsed `type === "assistant"`. State is `verify-demand-<sessionId>.txt` in `resolveDataDir("gates-data")`, holding the count at the last fire; fire only when `count - last >= 8`, and write the new count before emitting.
- Silent — stdout empty, exit 0 — when `stop_hook_active === true` (this hook already spoke and the model is continuing; blocking again is the one way to build a loop), when the payload does not parse, when `transcript_path` is missing or unreadable, or when fewer than eight assistant blocks have accrued since the last fire.
- Composition: `gates`, `ship-gate`, `session-retro` and `domain-modeling` each register a Stop hook (`grep -n Stop plugins/*/hooks/hooks.json` shows four). Every existing one arms a flag and exits 0. This is the first that returns a decision, and it is a second entry alongside `stop-check-consolidation-drift.mjs`, not a replacement — the drift hook must keep running. `decision: block` is the channel that reaches the model; plain Stop stdout does not, which is why the consolidation hook writes a flag instead.

- [ ] **Step 1:** write the test: a temp transcript file of `n` lines of `{"type":"assistant"}` plus some `{"type":"user"}` noise; spawn the script with `CLAUDE_PLUGIN_DATA` at a temp dir. Seven assistant lines → stdout empty. Eight → `JSON.parse(stdout).decision === "block"` and `reason` matches `/unverified/`. Immediately again at eight → stdout empty. Grow the file to fifteen → stdout empty; to sixteen → blocks again. Eight lines with `"stop_hook_active":true` → stdout empty. `transcript_path` pointing at a missing file → stdout empty, exit 0. Malformed stdin → stdout empty, exit 0. Run → FAIL, `Cannot find module`.
- [ ] **Step 2:** implement (`// @ts-check`, JSDoc typedef, every anomaly `process.exit(0)`). Test → PASS.
- [ ] **Step 3:** hooks.json entry `{"type":"command","command":"node \"${CLAUDE_PLUGIN_ROOT}/scripts/stop-demand-verification.mjs\"","timeout":5}` appended to the `Stop` array's `hooks` list. `claude plugin validate plugins/gates` → `✔ Validation passed`; `node --test scripts/hook-runtime-guard.test.mjs` → PASS; `bash scripts/check` → `CHECK OK`.
- [ ] **Step 4:** CLAUDE.md: a paragraph saying that this hook, alone in the repo, returns `decision: block`, that the eight-block ceiling is what keeps a nag from becoming a wedge, and that `stop_hook_active` is checked first so the hook can never block its own continuation. README: the user-facing contract and how to switch it off (uninstall or `.claude/gates.json`, if the gates-config plan's Task 1 has landed). `node scripts/bump-plugin.mjs gates minor`; `git add plugins/gates .claude-plugin/marketplace.json && git commit -m "gates: at session close, demand the command and output behind every claim of done" -m "Claude-Session: nightshift"`.

### Task 6: every plugin carries a review date, and the test fails when it is past

**Files:**
- Modify: all nine of `plugins/{adr,codex-review,domain-modeling,gates,handoff,nightshift,session-retro,ship-gate,writing-artifacts}/.claude-plugin/plugin.json`, `scripts/repo-consistency.test.mjs` (append one test), `docs/developing.md` (one sentence in the plugin-conventions section).
- Bump: none. A change confined to `plugins/<name>/.claude-plugin/**` is exempt from the version-bump gate (see the header of `scripts/check-version-bumps.mjs`), and `bump-plugin.mjs` throws for any plugin without a marketplace entry.

**Interfaces:**
- Produces: `"metadata": { "reviewBy": "2026-12-05" }` in every plugin manifest, merged into an existing `metadata` object when one is there (the audit-docs plan moves `engines` under the same key). Top level is wrong: `claude plugin validate --strict plugins/gates` warns today with `Unknown field 'engines'` and fails, and `docs/research/2026-09-04-marketplace-audit.md:86` records that the same fields under `metadata` pass strict.
- Produces: a test `every plugin declares a reviewBy date that has not passed` in `scripts/repo-consistency.test.mjs`, iterating **plugin directories** (not marketplace entries, so a retired-but-present directory is still covered): each manifest has `metadata.reviewBy` matching `/^\d{4}-\d{2}-\d{2}$/`, and `reviewBy >= new Date().toISOString().slice(0, 10)` by string compare, with a failure message naming the plugin and telling the reader to re-read the plugin against the current model family and move the date or retire it.

- [ ] **Step 1:** verify the manifest key is accepted before writing nine of them. Add `"metadata": { "reviewBy": "2026-12-05" }` to `plugins/adr/.claude-plugin/plugin.json` only, then run `claude plugin validate --strict plugins/adr` → expect `✔ Validation passed` (that plugin passes strict at HEAD, so any new warning is this key's). If instead it prints a line containing `Unknown field 'metadata'`, revert that edit and carry the date in `.claude-plugin/marketplace.json` on each entry's own `metadata` object instead, with the test reading it from there and the developing.md sentence saying why. If `command -v claude` prints nothing, take the `metadata` path on the strength of the marketplace-audit finding cited above.
- [ ] **Step 2:** append the test to `scripts/repo-consistency.test.mjs`. Run `node --test scripts/repo-consistency.test.mjs` → FAIL, the message naming the eight plugins still missing the key.
- [ ] **Step 3:** add the key to the remaining eight manifests. Same command → PASS. `for p in plugins/*/; do claude plugin validate "$p" >/dev/null || echo "FAIL $p"; done` → prints nothing. `bash scripts/check` → `CHECK OK`.
- [ ] **Step 4:** `docs/developing.md`: one sentence saying every plugin carries `metadata.reviewBy`, that the first dates are 2026-12-05 and the review is quarterly or on a model-family upgrade, whichever comes first, that the repo-consistency test goes red on the day a date passes, and that the answer to a red test is a re-read and a new date or a retirement — never a bump of the date alone. `git add plugins docs/developing.md scripts/repo-consistency.test.mjs && git commit -m "plugins: a review date in every manifest, enforced by the repo-consistency test" -m "Claude-Session: nightshift"`.

## Open Questions
