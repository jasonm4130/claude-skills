# Audit Backlog, Part 1: Code Fixes Implementation Plan

**Goal:** land the code defects the 2026-09-04 marketplace audit confirmed, one pull request each, so the nudge channels can be measured instead of guessed at.
**Architecture:** each task edits one plugin's scripts and its tests, bumps that plugin's version, and leaves the docs pass (part 2) and the gates config work (part 3) alone. `scripts/lib-drift.test.mjs` requires every function exported by two or more `plugins/*/scripts/lib.mjs` files to be byte-identical, so a shared function is edited in every copy in the same commit.
**Tech Stack:** stdlib-only `.mjs`, Node 24 `node --test`, `scripts/bump-plugin.mjs`.

## Global Constraints
- Any change under `plugins/<name>/` outside `README.md`, `CLAUDE.md`, `tests/` MUST be followed by `node scripts/bump-plugin.mjs <name> patch` before the commit (CI `version-bump-check`). Bumping for a docs-only change is harmless.
- `bash scripts/check` must end with `CHECK OK` before every commit.
- Do not edit `.github/`, `.claude/`, `loop/`, or `scripts/` unless the task names the file.
- Existing tests may be edited only where the task shows the edit; never delete a test.
- Commit messages say why and end with the line `Claude-Session: nightshift`.

### Task 1: emitOffer puts systemMessage where Claude Code reads it

**Files:**
- Modify: `plugins/domain-modeling/scripts/lib.mjs` (function `emitOffer`, ~lines 110-119) and `plugins/session-retro/scripts/lib.mjs` (~114-123) — identical edits.
- Modify: `plugins/session-retro/README.md` (the blockquote under "When the hook offers you a retro", ~lines 56-61).
- Test: `plugins/domain-modeling/tests/context-md-nudge.test.mjs`, `plugins/session-retro/tests/check-retro-flag.test.mjs`, `plugins/session-retro/tests/integration.test.mjs`.
- Bump: domain-modeling patch, session-retro patch.

**Interfaces:**
- Produces: hook stdout `{"systemMessage": <string>, "hookSpecificOutput": {"hookEventName": <name>, "additionalContext": <string>}}`. `systemMessage` at the root is what Claude Code shows in the transcript; nested under `hookSpecificOutput` it is dropped, which is why no human has ever seen this offer.

- [ ] **Step 1: Failing tests.** Append to `plugins/domain-modeling/tests/context-md-nudge.test.mjs`, using its existing `mkRepo`, `mkDataDir`, `editAndStop`, `run`, `consumeScript` helpers exactly as the test `consumer emits context…` (~line 115) does:
```js
test("the offer's systemMessage is at the payload root, where Claude Code reads it", (t) => {
  const repo = mkRepo(["CLAUDE.md"]);
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const dataDir = mkDataDir(t);
  editAndStop(repo, "s9", dataDir);
  const parsed = JSON.parse(run(consumeScript, { session_id: "s9" }, dataDir));
  assert.match(parsed.systemMessage, /has a CLAUDE\.md but no CONTEXT\.md/);
  assert.equal(parsed.hookSpecificOutput.systemMessage, undefined);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
});
```
  Append the same shape to `check-retro-flag.test.mjs`: copy the body of `EOD offer fires: past RETRO_EOD_HOUR, 3 worthy, no offer today` (~line 183: its `env(tmp)` helper, worthy-log seeding and `runScript` call), name it `the EOD offer's systemMessage is at the payload root`, and assert `parsed.systemMessage` matches `/retro-worthy sessions have accrued/` and `parsed.hookSpecificOutput.systemMessage === undefined`.
- [ ] **Step 2:** `node --test plugins/domain-modeling/tests/*.test.mjs plugins/session-retro/tests/*.test.mjs` → the two new tests fail (`systemMessage` undefined at root).
- [ ] **Step 3: Implement**, identically in both `lib.mjs`:
```js
export function emitOffer(eventName, systemMessage, additionalContext) {
  const payload = {
    systemMessage,
    hookSpecificOutput: { hookEventName: eventName, additionalContext },
  };
  process.stdout.write(JSON.stringify(payload) + "\n");
}
```
  Keep the JSDoc; update its sentence about where `systemMessage` lives.
- [ ] **Step 4: Re-point the existing assertions** — every `parsed.hookSpecificOutput.systemMessage` / `out.hookSpecificOutput.systemMessage` (any variable name) becomes `<var>.systemMessage`; `additionalContext` and `hookEventName` assertions stay as they are. Sites: `context-md-nudge.test.mjs` ~126-127, 154; `check-retro-flag.test.mjs` ~194-205, 250-251, 302-303, 331-332, 427, 476-477, 495-496, 515-516; `integration.test.mjs` ~182, 184. `grep -rn "hookSpecificOutput.systemMessage" plugins/` must return nothing afterwards.
- [ ] **Step 5:** README: replace the blockquote with the string `check-retro-flag.mjs` actually emits (the `[session-retro] N retro-worthy sessions have accrued (…). Want me to run the retro now…` text, `N` = 3) and change "gets a Claude-authored line like" to "gets a line from the hook like". Run the two test globs → PASS; `node --test scripts/lib-drift.test.mjs` → PASS; `bash scripts/check` → `CHECK OK`.
- [ ] **Step 6: Witness the host, once.** The tests prove the JSON shape, not that Claude Code shows it. In a temp dir write `.claude/settings.json` = `{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"node -e 'console.log(JSON.stringify({systemMessage:\"WITNESS-OK\",hookSpecificOutput:{hookEventName:\"UserPromptSubmit\",additionalContext:\"ignore\"}}))'"}]}]}}` and run `claude -p "reply with the single word done" --setting-sources project --output-format stream-json --verbose --max-turns 1 </dev/null | grep -c WITNESS-OK`. Expect `1` or more (the message appears as a system event in the stream). Put the command and its count in the commit body. `0` means the host dropped it: stop and report instead of committing.
- [ ] **Step 7:** bump both plugins patch; `git add plugins/domain-modeling plugins/session-retro .claude-plugin/marketplace.json && git commit -m "emitOffer: systemMessage at the payload root so the offer is shown to a human" -m "Host witness: <the claude -p … | grep -c WITNESS-OK command from Step 6> → <count>" -m "Claude-Session: nightshift"`.

### Task 2: codex-plan-review step 7 lists every outcome; one timeout constant

**Files:**
- Modify: `plugins/codex-review/skills/codex-plan-review/SKILL.md` (list item 7 of `## Flow`, the `--outcome <…>` enumeration).
- Modify: `plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs` (~line 827: the CLI default `"300"` for `--timeout`).
- Test: `plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs` (append).
- Bump: codex-review patch.

**Interfaces:**
- Consumes: `OUTCOMES` (array of six strings) and `DEFAULT_TIMEOUT_S` (300) exported by `codex-review.mjs`.

- [ ] **Step 1:** append to the test file (it already imports `test`, `assert`, `readFileSync`, `join`; add `dirname`/`fileURLToPath` if absent and define `const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..")`):
```js
test("SKILL.md item 7 enumerates every outcome the script accepts", async () => {
  const { OUTCOMES } = await import("./codex-review.mjs");
  const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
  const m = skill.match(/--outcome <([^>]+)>/);
  assert.ok(m, "item 7 carries an --outcome <a|b|c> enumeration");
  const listed = new Set(m[1].split("|"));
  for (const o of OUTCOMES) assert.ok(listed.has(o), `SKILL.md omits outcome "${o}"`);
});
```
- [ ] **Step 2:** `node --test plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs` → fails with `omits outcome "audit-concerns-unattended"`.
- [ ] **Step 3:** in SKILL.md the enumeration becomes `<audit-pass|audit-concerns-user-approved|audit-concerns-dismissed|audit-concerns-unattended|cap-revise|aborted>`; nothing else on the line changes. In `codex-review.mjs` the literal `"300"` default of the `--timeout` option becomes `String(DEFAULT_TIMEOUT_S)`.
- [ ] **Step 4:** same test command → PASS; `bash scripts/check` → `CHECK OK`.
- [ ] **Step 5:** `node scripts/bump-plugin.mjs codex-review patch`; `git add plugins/codex-review .claude-plugin/marketplace.json && git commit -m "codex-review: item 7 lists audit-concerns-unattended; one source for the timeout default" -m "Claude-Session: nightshift"`.

### Task 3: session-retro sweeps its data dir by age

**Files:**
- Modify: `plugins/session-retro/scripts/mark-session-start.mjs` (after the `writeFileSync(outPath, nowIso())` block).
- Modify: `plugins/session-retro/README.md` (env var paragraph, the line starting `Set \`RETRO_EOD_HOUR\``).
- Test: `plugins/session-retro/tests/mark-session-start.test.mjs` (append).
- Bump: session-retro patch.

**Interfaces:**
- Consumes: `resolveDataDir("session-retro-data")` from `../scripts/lib.mjs`; env `RETRO_RETENTION_DAYS` (integer days, default 30, `0` disables).
- Produces: on every session start, files in the data dir named `events-*.jsonl`, `retro-nudge-*.flag`, `session-start-*.txt`, `shipgate-*` are unlinked when their mtime is older than the retention. Nothing else is touched (`retro-worthy.jsonl`, `retro-processed.jsonl`, `last-retro.txt`, `eod-offer-*` stay).

- [ ] **Step 1:** append to the test file (reuse `runScript`; the file sets `CLAUDE_PLUGIN_DATA` to a temp dir):
```js
test("mark-session-start: sweeps per-session files older than RETRO_RETENTION_DAYS", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-sweep-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const old = new Date(Date.now() - 40 * 86400_000);
  const stale = ["events-old.jsonl", "retro-nudge-old.flag", "session-start-old.txt"];
  for (const f of [...stale, "events-new.jsonl", "retro-worthy.jsonl"]) writeFileSync(path.join(tmp, f), "x");
  for (const f of [...stale, "retro-worthy.jsonl"]) utimesSync(path.join(tmp, f), old, old);
  const { code } = await runScript(SCRIPT, JSON.stringify({ session_id: "sweep" }), { CLAUDE_PLUGIN_DATA: tmp });
  assert.equal(code, 0);
  for (const f of stale) assert.ok(!existsSync(path.join(tmp, f)), `${f} swept`);
  assert.ok(existsSync(path.join(tmp, "events-new.jsonl")), "recent file kept");
  assert.ok(existsSync(path.join(tmp, "retro-worthy.jsonl")), "the worthy log is never swept");
});
```
  Add `writeFileSync`, `utimesSync` to the `node:fs` import.
- [ ] **Step 2:** `node --test plugins/session-retro/tests/mark-session-start.test.mjs` → FAIL (`events-old.jsonl swept`).
- [ ] **Step 3:** implement in `mark-session-start.mjs`, best-effort, after the start-file write:
```js
const days = Number.parseInt(process.env.RETRO_RETENTION_DAYS ?? "30", 10);
if (Number.isFinite(days) && days > 0) {
  const cutoff = Date.now() - days * 86400_000;
  const SWEEP = /^(events-.*\.jsonl|retro-nudge-.*\.flag|session-start-.*\.txt|shipgate-.*)$/;
  try {
    for (const name of readdirSync(dataDir)) {
      if (!SWEEP.test(name)) continue;
      const p = path.join(dataDir, name);
      try { if (statSync(p).mtimeMs < cutoff) unlinkSync(p); } catch { /* another session may have won */ }
    }
  } catch { /* best-effort — never block a session start */ }
}
```
  Import `readdirSync`, `statSync`, `unlinkSync` from `node:fs`.
- [ ] **Step 4:** README env paragraph gains: `RETRO_RETENTION_DAYS` (default 30; per-session event logs, nudge flags and start stamps older than this are removed at session start; `0` disables) and `RETRO_BATCH_MAX_SESSIONS` (default 12; how many accrued sessions one retro reads, oldest first — the rest wait for the next retro). Same test → PASS; `bash scripts/check` → `CHECK OK`.
- [ ] **Step 5:** bump session-retro patch; `git add plugins/session-retro .claude-plugin/marketplace.json && git commit -m "session-retro: age-based sweep of per-session data files (RETRO_RETENTION_DAYS)" -m "Claude-Session: nightshift"`.

### Task 4: handoff's pending-marker snippet is self-contained, and tested

**Files:**
- Modify: `plugins/handoff/skills/handoff/SKILL.md` (frontmatter `description`; `## Output location` path line ~24; the bash block under `## After writing` ~124-128; the trailing `Note: if the user has the handoff plugin installed…` paragraph ~135-137).
- Modify: `plugins/handoff/README.md` (paragraph beginning `The marker may only name a **bare filename**`).
- Test: `plugins/handoff/tests/pending-snippet.test.mjs` (create).
- Bump: handoff patch.

**Interfaces:**
- Consumes: `HANDOFF_PATH`, the path of the handoff file the agent just wrote. Nothing sets it today: the skill's block uses it and `$PROJECT_ROOT` without defining either, so the block fails or writes to the wrong place when run as shown. The new block's first line makes the requirement explicit and loud.
- Produces: `<dirname HANDOFF_PATH>/.pending` containing exactly `basename HANDOFF_PATH`, which `scripts/load-pending-handoff.mjs` reads (bare filename only).

- [ ] **Step 1:** create the test:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "handoff", "SKILL.md");

test("the After-writing snippet registers the marker from HANDOFF_PATH alone", (t) => {
  const src = readFileSync(SKILL, "utf8");
  const block = src.split("## After writing")[1].match(/```bash\n([\s\S]*?)```/)[1];
  assert.doesNotMatch(block, /PROJECT_ROOT/, "the snippet must not depend on a variable the skill never sets");
  const root = mkdtempSync(join(tmpdir(), "handoff-snippet-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, ".claude", "handoffs", "2026-09-05T01-02-03-x.md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "# handoff\n");
  const env = { ...process.env };
  delete env.HANDOFF_PATH;
  assert.throws(() => execFileSync("bash", ["-euo", "pipefail", "-c", block], { env, cwd: tmpdir(), stdio: "pipe" }), /HANDOFF_PATH/, "unset HANDOFF_PATH fails loudly, never writes a stray marker");
  execFileSync("bash", ["-euo", "pipefail", "-c", block], { env: { ...env, HANDOFF_PATH: file }, cwd: tmpdir() });
  assert.equal(readFileSync(join(root, ".claude", "handoffs", ".pending"), "utf8"), "2026-09-05T01-02-03-x.md");
});
```
- [ ] **Step 2:** `node --test plugins/handoff/tests/pending-snippet.test.mjs` → FAIL on the `PROJECT_ROOT` assertion.
- [ ] **Step 3:** SKILL.md edits. The bash block becomes:
```bash
HANDOFF_PATH="${HANDOFF_PATH:?set HANDOFF_PATH to the handoff file you just wrote, e.g. .claude/handoffs/2026-05-25T14-32-00-auth-token-bug.md}"
mkdir -p "$(dirname "$HANDOFF_PATH")"
printf "%s" "$(basename "$HANDOFF_PATH")" > "$(dirname "$HANDOFF_PATH")/.pending"
```
  and the sentence above it reads `Run this with \`HANDOFF_PATH\` set to the file you just wrote (\`HANDOFF_PATH=.claude/handoffs/<file> bash -c '…'\` or export it first):`. The `## Output location` path reads `<repo root>/.claude/handoffs/<ISO-timestamp>-<slug>.md`. Delete the `Note: if the user has the handoff plugin installed…` paragraph entirely (this skill *is* that plugin). In the description, replace `or when context is high and you want to preserve state before /compact or /clear` with `or before /clear when the next session must continue this one` — keep every trigger phrase that follows.
- [ ] **Step 4:** README: change `file is opened with \`O_NOFOLLOW | O_NONBLOCK\` — so a marker naming` to `file is opened with \`O_NOFOLLOW | O_NONBLOCK\` on POSIX (on Windows, where those flags do not exist, a non-atomic \`lstat\` pre-check refuses the same targets) — so a marker naming`. `node --test plugins/handoff/tests/*.test.mjs` → PASS; `bash scripts/check` → `CHECK OK`.
- [ ] **Step 5:** bump handoff patch; `git add plugins/handoff .claude-plugin/marketplace.json && git commit -m "handoff: the pending-marker snippet needs only HANDOFF_PATH, and a test runs it" -m "Claude-Session: nightshift"`.

### Task 5: ship-gate stays silent in a repo with no remote

**Files:**
- Modify: `plugins/ship-gate/scripts/stop-check-unshipped.mjs` (before the `@{upstream}` block, ~line 57).
- Modify: `plugins/ship-gate/README.md` (trigger list ~15-32; the sentence citing `scripts/hook-runtime-guard.test.mjs` ~61).
- Test: `plugins/ship-gate/tests/stop-check-unshipped.test.mjs` (edit one test, add one).
- Bump: ship-gate patch.

**Interfaces:**
- Consumes: the file's `git(args, cwd)` helper (returns stdout or `null`).
- Produces: `git remote` empty → exit 0, no flag. Behaviour with a remote is unchanged.

- [ ] **Step 1:** two existing tests build a repo with **no remote** and expect a nudge, which is the case this task silences: `non-main branch with no upstream → nudge flag written` (~line 56, `mkRepo("feature-x")`) and `same HEAD nudges once; new commit re-arms` (~line 74, `mkRepo("feature-y")`). In each, directly after the `mkRepo(...)` line insert `execFileSync("git", ["remote", "add", "origin", mkdtempSync(path.join(tmpdir(), "bare-"))], { cwd: repo });` (a remote that was never pushed to — still no upstream, so the nudge they assert is unchanged). Then add:
```js
test("repo with no remote at all → silent", (t) => {
  const repo = mkRepo("feature-local");
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const dataDir = runHook(repo, "sid-noremote");
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  assert.ok(!existsSync(path.join(dataDir, "shipgate-nudge-sid-noremote.flag")), "nothing to ship to, nothing to nudge about");
});
```
- [ ] **Step 2:** `node --test plugins/ship-gate/tests/*.test.mjs` → the new test fails (flag written).
- [ ] **Step 3:** in the script, before the `aheadRaw` block: `const remotes = git(["remote"], cwd); if (remotes === null || remotes.trim() === "") process.exit(0); // nowhere to ship to`.
- [ ] **Step 4:** README: add a trigger-list line "A repo with no remote never nudges." and rewrite the bare citation as `[scripts/hook-runtime-guard.test.mjs](https://github.com/jasonm4130/claude-skills/blob/main/scripts/hook-runtime-guard.test.mjs)`. Tests → PASS; `bash scripts/check` → `CHECK OK`.
- [ ] **Step 5:** bump ship-gate patch; `git add plugins/ship-gate .claude-plugin/marketplace.json && git commit -m "ship-gate: silent when the repo has no remote" -m "Claude-Session: nightshift"`.

### Task 6: resolveSessionId rejects ids that are not safe path segments

**Files:**
- Modify: `resolveSessionId` in `plugins/session-retro/scripts/lib.mjs`, `plugins/ship-gate/scripts/lib.mjs`, `plugins/domain-modeling/scripts/lib.mjs`, `plugins/gates/scripts/lib.mjs` — identical bodies (the drift test enforces it).
- Modify: `plugins/session-retro/scripts/collect-batch-sessions.mjs` (~42-49) and `plugins/session-retro/scripts/mark-retro-done.mjs` (~27-35): both take a session id from `process.argv[2]` ahead of `resolveSessionId` and interpolate it into a file name unsanitised.
- Test: `plugins/session-retro/tests/lib.test.mjs`, `plugins/session-retro/tests/mark-retro-done.test.mjs`, `plugins/session-retro/tests/collect-batch-sessions.test.mjs` (append one test each).
- Bump: session-retro, ship-gate, domain-modeling, gates — patch each.

**Interfaces:**
- Produces: a session id matching `/^[A-Za-z0-9_-]{1,64}$/`, else `"unknown"`. Every caller builds file names from it (`events-<sid>.jsonl`, `retro-nudge-<sid>.flag`, `shipgate-nudge-<sid>.flag`), so `../`, `/`, spaces and over-long ids never reach the filesystem.

- [ ] **Step 1:** append to `lib.test.mjs`:
```js
test("resolveSessionId: an id that is not a safe path segment resolves to 'unknown'", () => {
  const prev = process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  try {
    for (const bad of ["../etc", "a/b", "a b", "", "x".repeat(65)]) assert.equal(resolveSessionId({ session_id: bad }), "unknown", JSON.stringify(bad));
    process.env.CLAUDE_SESSION_ID = "../env";
    assert.equal(resolveSessionId(null), "unknown");
    assert.equal(resolveSessionId({ session_id: "7c70b045-5571-4242-966a-af5b619b865f" }), "7c70b045-5571-4242-966a-af5b619b865f");
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_SESSION_ID; else process.env.CLAUDE_SESSION_ID = prev;
  }
});
```
  Append to `mark-retro-done.test.mjs` and `collect-batch-sessions.test.mjs` (each already spawns its script with `CLAUDE_PLUGIN_DATA` pointing at a temp dir; pass the id as `process.argv[2]`, i.e. as the script's first CLI argument, with empty stdin and `CLAUDE_SESSION_ID` deleted from the env):
```js
test("a traversal-bearing argv session id is not used in a file name", async (t) => {
  // spawn <script> "../../escape" with the temp data dir; then:
  assert.ok(!existsSync(path.join(tmp, "..", "..", "escape")), "nothing written outside the data dir");
  assert.ok(readdirSync(tmp).every((f) => !f.includes("..")), "no file name carries the raw argv");
});
```
  (For `mark-retro-done` assert `retro-fired-unknown.flag` exists; for `collect-batch-sessions` assert its output names `unknown`.) Neither test file imports `readdirSync` today: add it to each file's `node:fs` import line.
- [ ] **Step 2:** `node --test plugins/session-retro/tests/lib.test.mjs plugins/session-retro/tests/mark-retro-done.test.mjs plugins/session-retro/tests/collect-batch-sessions.test.mjs` → FAIL on `"../etc"` and on the argv tests.
- [ ] **Step 3:** in all four files:
```js
const SAFE_SID = /^[A-Za-z0-9_-]{1,64}$/;
export function resolveSessionId(payload) {
  if (payload && typeof payload.session_id === "string" && SAFE_SID.test(payload.session_id)) return payload.session_id;
  const envSid = process.env.CLAUDE_SESSION_ID;
  if (typeof envSid === "string" && SAFE_SID.test(envSid)) return envSid;
  return "unknown";
}
```
  Place `SAFE_SID` immediately above the function in each file, identically. In `plugins/session-retro/scripts/lib.mjs` only, `unprocessedWorthySessions` (~271-300) also skips any persisted row whose `sid` fails `SAFE_SID` (`if (!e || typeof e.sid !== "string" || !SAFE_SID.test(e.sid)) continue;` replacing the length check at ~295), so a legacy or hostile `retro-worthy.jsonl` row such as `../../outside` never reaches `aggregateSession`'s `events-${sid}.jsonl` read; add to `lib.test.mjs` a test that writes a worthy log with one such row and one valid row and asserts only the valid sid is returned. In the two argv scripts, the argv branch becomes `const argSid = typeof process.argv[2] === "string" && process.argv[2].length > 0 ? resolveSessionId({ session_id: process.argv[2] }) : null;` so an unsafe argument resolves through the same rule (and, if it fails, to the env id or `"unknown"`, never to the raw text).
- [ ] **Step 4:** `node --test scripts/lib-drift.test.mjs plugins/session-retro/tests/*.test.mjs` → PASS; `bash scripts/check` → `CHECK OK`.
- [ ] **Step 5:** bump the four plugins patch; `git add plugins/session-retro plugins/ship-gate plugins/domain-modeling plugins/gates .claude-plugin/marketplace.json && git commit -m "resolveSessionId: only a safe path segment is a session id" -m "Claude-Session: nightshift"`.

## Open Questions
