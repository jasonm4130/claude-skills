# Nightshift Smoke Plan

**Goal:** three small, real documentation fixes from the 2026-09-04 marketplace audit, landed one per pull request by the overnight loop, so the loop is proven on this repo before it is trusted with a feature.
**Architecture:** each task edits one plugin's prose (and one adds a test), bumps that plugin's version with the repo's bump script, and leaves everything else alone.
**Tech Stack:** Markdown, Node 24 (`node --test`), `scripts/bump-plugin.mjs`.

## Global Constraints
- Every task that changes a file under `plugins/<name>/` other than its `README.md`, `CLAUDE.md` or `tests/` MUST run `node scripts/bump-plugin.mjs <name> patch` (bumps `plugin.json` and `.claude-plugin/marketplace.json` together). CI's `version-bump-check` fails otherwise. README/CLAUDE.md/tests-only changes need no bump, but a bump is harmless — when in doubt, bump.
- `scripts/check` must end with `CHECK OK` before every commit.
- Do not edit any file under `.github/`, `.claude/`, `loop/`, or `scripts/` except as a task says.
- Commit messages say why, and end with the line `Claude-Session: nightshift`.

### Task 1: codex-plan-review step 7 lists every outcome the script accepts

**Files:**
- Modify: `plugins/codex-review/skills/codex-plan-review/SKILL.md` (the line beginning `7. **Always close the chain**`)
- Test: `plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs` (append one test)
- Bump: `node scripts/bump-plugin.mjs codex-review patch`

**Interfaces:**
- Consumes: `OUTCOMES` exported by `plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs` (an array of six strings including `audit-concerns-unattended`).
- Produces: nothing other tasks use.

Why: step 5 of the skill mandates `--outcome audit-concerns-unattended` for unattended runs, and the script accepts it, but step 7's enumeration `<audit-pass|audit-concerns-user-approved|audit-concerns-dismissed|cap-revise|aborted>` omits it, so an agent following step 7 is steered into a label that asserts a human disposition that never happened.

- [ ] **Step 1: Write the failing test.** Append to `codex-review.test.mjs` (it already imports `test`, `assert`, `readFileSync`, `join`; it resolves the skill directory as `__dirname`-style via `fileURLToPath` — read its first 30 lines and reuse the same path helper to locate `../SKILL.md`):

```js
test("SKILL.md step 7 enumerates every outcome the script accepts", async () => {
  const { OUTCOMES } = await import("./codex-review.mjs");
  const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
  const m = skill.match(/--outcome <([^>]+)>/);
  assert.ok(m, "step 7 carries an --outcome <a|b|c> enumeration");
  const listed = new Set(m[1].split("|"));
  for (const o of OUTCOMES) assert.ok(listed.has(o), `SKILL.md step 7 omits outcome "${o}"`);
});
```

where `SKILL_DIR` is `dirname(fileURLToPath(import.meta.url))` joined with `..` (define it near the top of the test file if no equivalent constant exists; `import { dirname } from "node:path"` and `import { fileURLToPath } from "node:url"` as needed).

- [ ] **Step 2: Run it, expect FAIL.** `node --test plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs` — the new test fails with `SKILL.md step 7 omits outcome "audit-concerns-unattended"`.
- [ ] **Step 3: Fix the skill.** In `SKILL.md`, change the enumeration in step 7 to `<audit-pass|audit-concerns-user-approved|audit-concerns-dismissed|audit-concerns-unattended|cap-revise|aborted>`. Change nothing else on that line.
- [ ] **Step 4: Run it, expect PASS.** Same command; then `bash scripts/check` → last line `CHECK OK`.
- [ ] **Step 5: Bump and commit.** `node scripts/bump-plugin.mjs codex-review patch`, then `git add plugins/codex-review .claude-plugin/marketplace.json && git commit -m "codex-review: step 7 lists audit-concerns-unattended, with a test that keeps it in sync with OUTCOMES" -m "Claude-Session: nightshift"`.

### Task 2: session-retro documents six hooks, not five

**Files:**
- Modify: `plugins/session-retro/README.md` (line reading `Five hooks + one skill. …`)
- Modify: `plugins/session-retro/CLAUDE.md` (line 9 `Five hooks log activity…` and the tree line `│   └── hooks.json            — 5 events: SessionStart, PostToolUse, Stop, PreCompact, UserPromptSubmit`)
- Bump: `node scripts/bump-plugin.mjs session-retro patch`

**Interfaces:** none.

Why: `plugins/session-retro/hooks/hooks.json` registers six events — `SessionStart`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `PreCompact`, `UserPromptSubmit` — and the two docs say five. Verify with:

```bash
node -e 'const h=require("./plugins/session-retro/hooks/hooks.json");console.log(Object.keys(h.hooks))'
```

- [ ] **Step 1:** In `README.md`, `Five hooks + one skill.` → `Six hooks + one skill.`
- [ ] **Step 2:** In `CLAUDE.md`, `Five hooks log activity` → `Six hooks log activity`; the tree line becomes `│   └── hooks.json            — 6 events: SessionStart, PostToolUse, PostToolUseFailure, Stop, PreCompact, UserPromptSubmit`. `CLAUDE.md` must not gain a line: it is already over the 200-line budget, so change words on existing lines only.
- [ ] **Step 3:** `grep -n "Five hooks\|5 events" plugins/session-retro/README.md plugins/session-retro/CLAUDE.md` → no output. `bash scripts/check` → `CHECK OK`.
- [ ] **Step 4: Bump and commit.** `node scripts/bump-plugin.mjs session-retro patch`, then `git add plugins/session-retro .claude-plugin/marketplace.json && git commit -m "session-retro: the docs count six hooks, matching hooks.json" -m "Claude-Session: nightshift"`.

### Task 3: handoff README states the O_NOFOLLOW guarantee for the platforms that have it

**Files:**
- Modify: `plugins/handoff/README.md` (the paragraph beginning `The marker may only name a **bare filename**`)
- Bump: `node scripts/bump-plugin.mjs handoff patch`

**Interfaces:** none.

Why: `plugins/handoff/scripts/lib.mjs` sets both `O_NOFOLLOW` and `O_NONBLOCK` to 0 on Windows (the constants are undefined there) and relies on an `lstat` pre-check instead, but the README states the flags unconditionally. The outcome (a symlink is refused) still holds on Windows; only the atomicity of the check is lost.

- [ ] **Step 1:** In that paragraph, change `file is opened with \`O_NOFOLLOW | O_NONBLOCK\` — so a marker naming` to `file is opened with \`O_NOFOLLOW | O_NONBLOCK\` on POSIX (on Windows, where those flags do not exist, a non-atomic \`lstat\` pre-check refuses the same targets) — so a marker naming`. Keep the rest of the paragraph verbatim.
- [ ] **Step 2:** `grep -c "on POSIX (on Windows" plugins/handoff/README.md` → `1`. `bash scripts/check` → `CHECK OK`.
- [ ] **Step 3: Bump and commit.** `node scripts/bump-plugin.mjs handoff patch`, then `git add plugins/handoff .claude-plugin/marketplace.json && git commit -m "handoff: README scopes the O_NOFOLLOW|O_NONBLOCK guarantee to POSIX and names the Windows fallback" -m "Claude-Session: nightshift"`.

## Open Questions
