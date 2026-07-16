# Superpowers Fork Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the owned `subagent-driven-development` Workflow to implement this plan task-by-task (per-task implement → review → fix, then a whole-branch review). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the deny-list dependency on upstream `superpowers` with two owned plugins (`superpowers-core` + a fresh `frontend-design`), so the process-skill surface is owned, the dispatcher matches house style, and the 9-entry `permissions.deny` blocklist is deleted.

**Architecture:** Vendor 5 MIT skills verbatim from superpowers 6.1.1, rewrite every `superpowers:` cross-reference to the new namespace (or redirect dropped ones), add an owned `using-skills` SessionStart dispatcher, re-tier `brainstorming`, enhance `writing-plans`, ship a fresh `frontend-design` gate, then cut over settings. Tasks 1–7 build inside the `claude-skills` repo (SDD-executable). Task 8 is a **supervised** cutover of live `~/.claude/settings.json` — not a background SDD task.

**Tech Stack:** Markdown skills, JSON plugin/marketplace/settings, a POSIX `sh` SessionStart hook, `node --test` for `.mjs` regression tests, `jq`/`grep` validation.

**Content source of truth:** the committed spec `docs/superpowers/specs/2026-07-16-superpowers-fork.md`. Where a step needs a large verbatim body (dispatcher kernel text, tiering rules), it names the exact spec section; critical exact values (namespace map, hook matcher, deny lines) are inlined here.

## Global Constraints

- Vendor **only** from `~/.claude/plugins/cache/claude-plugins-official/superpowers/6.1.1/` — never `6.0.3`/`6.1.0`.
- Vendor each skill's **entire directory** (all support files/scripts/assets), not just `SKILL.md`. Expected non-`SKILL.md` file counts: brainstorming 7, systematic-debugging 10, writing-plans 1, writing-skills 6, test-driven-development 1.
- After Task 3, `grep -rE 'superpowers:' plugins/superpowers-core/skills` returns **zero** matches (`superpowers-core:` is fine — it does not match `superpowers:`).
- `superpowers-core` retains the MIT `LICENSE` and attributes Jesse Vincent in `plugin.json`.
- SessionStart hook matcher is exactly `startup|resume|clear|compact`.
- Dispatcher = match-and-proportion + specificity-wins + user-suppress (Part A) and currency/verification (Part B), verbatim from spec §"The dispatcher — `using-skills`".
- Do not modify any other owned plugin.
- `.mjs` tests run with `node --test`.
- **Repo-consistency invariant** (`scripts/repo-consistency.test.mjs`, runs under `node --test`): every `plugins/<name>` dir must have a matching `marketplace.json` entry (same `version`, `source: ./plugins/<name>`) **and** a backtick-wrapped `` `<name>` `` mention in root `README.md` — an exact bijection. Any task that adds a plugin updates dir + marketplace + README **together**, or the suite goes red.

---

## File Structure

```
plugins/superpowers-core/
  .claude-plugin/plugin.json        # T1  metadata + Jesse Vincent attribution
  LICENSE                            # T1  vendored MIT © 2025 Jesse Vincent
  skills/brainstorming/…             # T2 copy, T3 ref-rewrite, T5 re-tier+enhance
  skills/systematic-debugging/…      # T2 copy, T3 ref-rewrite
  skills/writing-plans/…             # T2 copy, T3 ref-rewrite, T6 enhance
  skills/writing-skills/…            # T2 copy, T3 ref-rewrite
  skills/test-driven-development/…   # T2 copy (no refs to rewrite)
  skills/using-skills/SKILL.md       # T4  owned dispatcher
  hooks/hooks.json                   # T4  SessionStart matcher
  hooks/session-start                # T4  emits kernel via additionalContext
  tests/namespace-lint.test.mjs      # T3  asserts zero superpowers: refs
  tests/session-start.test.mjs       # T4  asserts valid JSON + matcher
plugins/frontend-design/
  .claude-plugin/plugin.json         # T7
  skills/frontend-design/SKILL.md    # T7  light inline / heavy -> browser brief
.claude-plugin/marketplace.json      # T1 (+T7) register both plugins
~/.claude/settings.json              # T8 SUPERVISED cutover (live config)
```

---

### Task 1: `superpowers-core` plugin skeleton + marketplace registration

**Files:**
- Create: `plugins/superpowers-core/.claude-plugin/plugin.json`
- Create: `plugins/superpowers-core/LICENSE`
- Modify: `.claude-plugin/marketplace.json` (add the `superpowers-core` plugin entry to the `plugins` array)

**Interfaces:**
- Produces: plugin name `superpowers-core`, registered in the `jasonm4130-claude-skills` marketplace.

- [ ] **Step 1: Write `plugin.json`** with attribution:

```json
{
  "name": "superpowers-core",
  "description": "Owned fork of the superpowers process skills (brainstorming, systematic-debugging, writing-plans, writing-skills, test-driven-development) plus the using-skills dispatcher.",
  "version": "0.1.0",
  "author": { "name": "Jason Matthew" },
  "license": "MIT",
  "keywords": ["skills", "process", "brainstorming", "tdd", "claude-code"]
}
```

- [ ] **Step 2: Vendor the MIT LICENSE** — copy upstream verbatim (retains the original copyright):

```bash
cp "$HOME/.claude/plugins/cache/claude-plugins-official/superpowers/6.1.1/LICENSE" \
   plugins/superpowers-core/LICENSE
grep -q "Jesse Vincent" plugins/superpowers-core/LICENSE && echo OK
```
Expected: `OK`

- [ ] **Step 3: Register in the marketplace** — add to the `plugins` array in `.claude-plugin/marketplace.json` (match the existing entry shape; source `./plugins/superpowers-core`, version `0.1.0`, author Jason Matthew, license MIT).

- [ ] **Step 4: Document in `README.md`** — add a backtick-wrapped `` `superpowers-core` `` mention to the root `README.md` plugin list (required by the repo-consistency bijection), with a one-line description in the existing README style.

- [ ] **Step 5: Validate — JSON + repo-consistency**

```bash
jq -e '.plugins[] | select(.name=="superpowers-core")' .claude-plugin/marketplace.json >/dev/null && \
jq -e . plugins/superpowers-core/.claude-plugin/plugin.json >/dev/null && echo VALID
node --test scripts/repo-consistency.test.mjs
```
Expected: `VALID`; repo-consistency tests PASS (dir ↔ marketplace ↔ README bijection holds).

- [ ] **Step 6: Commit**

```bash
git add plugins/superpowers-core/.claude-plugin/plugin.json plugins/superpowers-core/LICENSE .claude-plugin/marketplace.json README.md
git commit -m "feat(superpowers-core): plugin skeleton + marketplace + README"
```

---

### Task 2: Vendor the 5 skill directories verbatim (from 6.1.1)

**Files:**
- Create: `plugins/superpowers-core/skills/{brainstorming,systematic-debugging,writing-plans,writing-skills,test-driven-development}/` (full trees)

**Interfaces:**
- Produces: the 5 vendored skill directories consumed by Tasks 3, 5, 6.

- [ ] **Step 1: Copy all five full directories**

```bash
SP="$HOME/.claude/plugins/cache/claude-plugins-official/superpowers/6.1.1/skills"
for s in brainstorming systematic-debugging writing-plans writing-skills test-driven-development; do
  cp -R "$SP/$s" "plugins/superpowers-core/skills/$s"
done
```

- [ ] **Step 2: Verify full-directory vendoring (support-file counts)**

```bash
for s in brainstorming:7 systematic-debugging:10 writing-plans:1 writing-skills:6 test-driven-development:1; do
  name=${s%:*}; want=${s#*:}
  got=$(find "plugins/superpowers-core/skills/$name" -type f ! -name SKILL.md | wc -l | tr -d ' ')
  [ "$got" = "$want" ] && echo "$name OK ($got)" || echo "$name MISMATCH got=$got want=$want"
done
```
Expected: five `… OK` lines.

- [ ] **Step 3: Commit**

```bash
git add plugins/superpowers-core/skills
git commit -m "feat(superpowers-core): vendor 5 skills verbatim from superpowers 6.1.1"
```

---

### Task 3: Rewrite the `superpowers:` namespace + add a lint test

**Files:**
- Modify: `plugins/superpowers-core/skills/systematic-debugging/SKILL.md`, `.../writing-plans/SKILL.md`, `.../writing-skills/SKILL.md`
- Create: `plugins/superpowers-core/tests/namespace-lint.test.mjs`

**Interfaces:**
- Produces: a zero-`superpowers:`-reference vendored tree; a regression test guarding it.

Complete rewrite map (from spec §"Cross-reference rewrites"; `brainstorming` and `test-driven-development` carry none):

| File | Old ref (count) | Rewrite to |
|---|---|---|
| systematic-debugging | `superpowers:test-driven-development` (2) | `superpowers-core:test-driven-development` |
| systematic-debugging | `superpowers:verification-before-completion` (1) | rewrite the prose to point at the global CLAUDE.md `## Verification before claiming complete` discipline — **no skill reference** |
| writing-plans | `superpowers:subagent-driven-development` (2) | `subagent-driven-development` |
| writing-plans | `superpowers:executing-plans` (2) | `subagent-driven-development` |
| writing-plans | `superpowers:using-git-worktrees` (1) | rewrite prose: the owned `subagent-driven-development` loop handles worktree isolation |
| writing-skills | `superpowers:test-driven-development` (4) | `superpowers-core:test-driven-development` |
| writing-skills | `superpowers:systematic-debugging` (1) | `superpowers-core:systematic-debugging` |

Leave `elements-of-style:writing-clearly-and-concisely` untouched (optional, not owned).

- [ ] **Step 1: Write the failing lint test** `tests/namespace-lint.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../skills/", import.meta.url).pathname;
function walk(dir) {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
test("no superpowers: cross-references remain in vendored skills", () => {
  const offenders = [];
  for (const f of walk(ROOT)) {
    const text = readFileSync(f, "utf8");
    // match `superpowers:` but NOT `superpowers-core:`
    if (/superpowers:(?!-)/.test(text) || /\bsuperpowers:[a-z]/.test(text)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `dangling superpowers: refs in:\n${offenders.join("\n")}`);
});
```

- [ ] **Step 2: Run it — expect FAIL** (refs still present)

```bash
node --test plugins/superpowers-core/tests/namespace-lint.test.mjs
```
Expected: FAIL, offenders lists systematic-debugging / writing-plans / writing-skills.

- [ ] **Step 3: Apply the rewrite map** to the three SKILL.md files (table above). For the two prose redirects (`verification-before-completion`, `using-git-worktrees`), rewrite the sentence so it reads naturally without naming a dropped skill.

- [ ] **Step 4: Run the test — expect PASS**

```bash
node --test plugins/superpowers-core/tests/namespace-lint.test.mjs
grep -rE 'superpowers:[a-z]' plugins/superpowers-core/skills && echo "LEAK" || echo "CLEAN"
```
Expected: test PASS; `CLEAN`.

- [ ] **Step 5: Commit**

```bash
git add plugins/superpowers-core/skills plugins/superpowers-core/tests/namespace-lint.test.mjs
git commit -m "fix(superpowers-core): rewrite superpowers: namespace refs + lint guard"
```

---

### Task 4: `using-skills` dispatcher + SessionStart hook

**Files:**
- Create: `plugins/superpowers-core/skills/using-skills/SKILL.md`
- Create: `plugins/superpowers-core/hooks/hooks.json`
- Create: `plugins/superpowers-core/hooks/session-start`
- Create: `plugins/superpowers-core/tests/session-start.test.mjs`

**Interfaces:**
- Consumes: dispatcher kernel text from spec §"The dispatcher — `using-skills`" (Parts A + B) and §"Injection guardrail".
- Produces: the SessionStart-injected behavioral kernel.

- [ ] **Step 1: Write `SKILL.md`** — frontmatter `name: using-skills`, a negative-scoped description, and the body = Part A (match-and-proportion, specificity-wins, user-suppress, announce, negative-scoping authoring rule) + Part B (currency & verification) + the injection guardrail, **verbatim from the spec**.

- [ ] **Step 2: Write `hooks/hooks.json`** with the exact matcher:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/session-start\"", "async": false }
        ]
      }
    ]
  }
}
```

- [ ] **Step 3: Write `hooks/session-start`** (POSIX `sh`, executable) — emits the kernel as `additionalContext`. Keep the kernel text in a heredoc; emit JSON:

```sh
#!/bin/sh
# Injects the using-skills behavioral kernel at SessionStart.
KERNEL=$(cat <<'KERNEL_EOF'
[Part A + Part B kernel text, verbatim from spec — same content as SKILL.md body]
KERNEL_EOF
)
# JSON-encode via a tiny node shim to stay dependency-free and quoting-safe:
CONTEXT="$KERNEL" node -e 'const c=process.env.CONTEXT; process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:c}}))'
```

- [ ] **Step 4: `chmod +x`**

```bash
chmod +x plugins/superpowers-core/hooks/session-start
```

- [ ] **Step 5: Write the failing test** `tests/session-start.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const HOOK = new URL("../hooks/session-start", import.meta.url).pathname;
const HOOKS_JSON = new URL("../hooks/hooks.json", import.meta.url).pathname;

test("hook emits valid JSON with non-empty additionalContext", () => {
  const out = execFileSync(HOOK, { encoding: "utf8", env: { ...process.env, CLAUDE_PLUGIN_ROOT: "" } });
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  assert.ok(parsed.hookSpecificOutput.additionalContext.length > 200);
  assert.match(parsed.hookSpecificOutput.additionalContext, /specificity/i);
});

test("matcher covers all four SessionStart sources", () => {
  const cfg = JSON.parse(readFileSync(HOOKS_JSON, "utf8"));
  assert.equal(cfg.hooks.SessionStart[0].matcher, "startup|resume|clear|compact");
});
```

- [ ] **Step 6: Run — expect PASS** (implement in Steps 1–4 already satisfies it; if it fails, fix the hook)

```bash
node --test plugins/superpowers-core/tests/session-start.test.mjs
```
Expected: 2 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/superpowers-core/skills/using-skills plugins/superpowers-core/hooks plugins/superpowers-core/tests/session-start.test.mjs
git commit -m "feat(superpowers-core): using-skills dispatcher + SessionStart kernel hook"
```

---

### Task 5: Re-tier `brainstorming` + fold in planning enhancements

**Files:**
- Modify: `plugins/superpowers-core/skills/brainstorming/SKILL.md`

**Interfaces:**
- Consumes: spec §"Artifact model" (tiering) and §"Planning enhancements".

- [ ] **Step 1: Remove the always-design HARD-GATE.** Delete the "Anti-Pattern: This Is Too Simple To Need A Design" mandate and any "Every project goes through this process… a config change — all of them" language.

- [ ] **Step 2: Add the size gate at the top** (verbatim intent from spec): trivial → skip (no artifact); medium → straight to a lean plan with a 2–3 line "why" header (no separate spec); large/ambiguous → full spec. Ambiguity/complexity — not size alone — is the trigger.

- [ ] **Step 3: Fold in the elicitation enhancements** (spec §"Planning enhancements"): tree-not-list questioning; always offer a recommended default; auto-resolve-first (check codebase/docs before asking); the doc-grounded assumption check (context7/WebFetch, surfaced as one question); inline evidence logging; stop = no unresolved items.

- [ ] **Step 4: Verify the edits**

```bash
grep -qi "Every project goes through this process" plugins/superpowers-core/skills/brainstorming/SKILL.md && echo "STILL HAS GATE" || echo "GATE REMOVED"
grep -qiE "recommended default|auto-resolve|trivial.*medium.*large|doc-ground" plugins/superpowers-core/skills/brainstorming/SKILL.md && echo "ENHANCED"
grep -rE 'superpowers:[a-z]' plugins/superpowers-core/skills/brainstorming && echo LEAK || echo CLEAN
```
Expected: `GATE REMOVED`, `ENHANCED`, `CLEAN`.

- [ ] **Step 5: Commit**

```bash
git add plugins/superpowers-core/skills/brainstorming/SKILL.md
git commit -m "feat(superpowers-core): re-tier brainstorming (size gate) + grill-style elicitation"
```

---

### Task 6: `writing-plans` — open-questions list + first-class Codex gate

**Files:**
- Modify: `plugins/superpowers-core/skills/writing-plans/SKILL.md`

**Interfaces:**
- Consumes: spec §"Artifact model" (disposable plan) and §"Codex review — first-class".

- [ ] **Step 1: Frame the plan as a disposable derivative** of the spec (regenerated, not maintained) where a spec exists.

- [ ] **Step 2: Add a required "Open questions / unresolved assumptions" output section** to every plan the skill produces (gives the Codex reviewer concrete targets).

- [ ] **Step 3: Rewrite the execution handoff** to invoke the owned `subagent-driven-development`, and add the terminal Codex gate: finalize plan → emit open-questions → invoke `codex-plan-review` (checks soundness **and** spec-fidelity) → loop on verdict. On unavailable Codex: **disclose the skip, do not block**; the review status travels into SDD.

- [ ] **Step 4: Keep it lean** — do NOT add spec-kit constitutional gates, EARS, PR-FAQ, or pre-mortem role-play (the Codex gate covers adversarial review).

- [ ] **Step 5: Verify**

```bash
grep -qiE "open questions|unresolved assumptions" plugins/superpowers-core/skills/writing-plans/SKILL.md && echo "OPENQ"
grep -qi "codex-plan-review" plugins/superpowers-core/skills/writing-plans/SKILL.md && echo "GATE"
grep -qi "disclose" plugins/superpowers-core/skills/writing-plans/SKILL.md && echo "DISCLOSE"
grep -rE 'superpowers:[a-z]' plugins/superpowers-core/skills/writing-plans && echo LEAK || echo CLEAN
```
Expected: `OPENQ`, `GATE`, `DISCLOSE`, `CLEAN`.

- [ ] **Step 6: Commit**

```bash
git add plugins/superpowers-core/skills/writing-plans/SKILL.md
git commit -m "feat(superpowers-core): writing-plans open-questions list + first-class Codex gate"
```

---

### Task 7: Fresh `frontend-design` plugin (light inline / heavy → browser brief)

**Files:**
- Create: `plugins/frontend-design/.claude-plugin/plugin.json`
- Create: `plugins/frontend-design/skills/frontend-design/SKILL.md`
- Modify: `.claude-plugin/marketplace.json` (register `frontend-design`)

**Interfaces:**
- Consumes: spec §"Plugin 2 — `frontend-design`".

- [ ] **Step 1: Write `plugin.json`** (name `frontend-design`, author Jason Matthew, MIT, version `0.1.0`, description naming the light-inline / heavy→browser gate).

- [ ] **Step 2: Write `SKILL.md`** (fresh, in-voice) with a negative-scoped description and two branches:
  - Light/surgical design → inline guidance (ground-it-in-the-subject → principles → explore → self-critique).
  - Wide/detailed design → recommend Claude Design in the browser and emit a paste-ready brief:

```markdown
# Design brief: <feature>
**Goal / job-to-be-done:** …
**Users & context:** …
**Constraints:** (brand, platform, a11y, perf) …
**Screens / components:** …
**Existing patterns to match:** …
**References / inspiration:** …
```

- [ ] **Step 3: Register in marketplace** (add `frontend-design` entry to the `plugins` array; `source: ./plugins/frontend-design`, version `0.1.0`).

- [ ] **Step 4: Document in `README.md`** — add a backtick-wrapped `` `frontend-design` `` mention to the root `README.md` plugin list (required by the repo-consistency bijection), one-line description in existing style.

- [ ] **Step 5: Validate — JSON + brief + repo-consistency**

```bash
jq -e '.plugins[] | select(.name=="frontend-design")' .claude-plugin/marketplace.json >/dev/null && \
jq -e . plugins/frontend-design/.claude-plugin/plugin.json >/dev/null && echo VALID
grep -qi "design brief" plugins/frontend-design/skills/frontend-design/SKILL.md && echo "BRIEF"
node --test scripts/repo-consistency.test.mjs
```
Expected: `VALID`, `BRIEF`; repo-consistency PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/frontend-design .claude-plugin/marketplace.json README.md
git commit -m "feat(frontend-design): owned gate + README"
```

---

### Task 8: Cutover — SUPERVISED, not a background SDD task

> **Do not run this as a background SDD subagent.** It edits **live** `~/.claude/settings.json`, which changes the running Claude Code environment (disabling superpowers mid-session affects available skills). The orchestrator performs it with the user present, after Tasks 1–7 are merged and the whole-branch review has passed.

**Files:**
- Modify: `~/.claude/settings.json`

- [ ] **Step 1: Back up** `cp ~/.claude/settings.json ~/.claude/settings.json.bak`
- [ ] **Step 2: `enabledPlugins`** — set `superpowers-core@jasonm4130-claude-skills: true` and `frontend-design@jasonm4130-claude-skills: true`; set `superpowers@claude-plugins-official: false` and `frontend-design@claude-plugins-official: false`.
- [ ] **Step 3: Delete all 9 `permissions.deny` entries** — every `Skill(superpowers:*)` line (subagent-driven-development, executing-plans, dispatching-parallel-agents, test-driven-development, using-git-worktrees, finishing-a-development-branch, requesting-code-review, receiving-code-review, verification-before-completion).
- [ ] **Step 4: Validate + confirm**

```bash
jq -e '.permissions.deny | map(select(startswith("Skill(superpowers:"))) | length == 0' ~/.claude/settings.json && echo "DENY CLEAR"
jq -e '.enabledPlugins["superpowers-core@jasonm4130-claude-skills"] == true and .enabledPlugins["superpowers@claude-plugins-official"] == false' ~/.claude/settings.json && echo "CUTOVER OK"
```
Expected: `DENY CLEAR`, `CUTOVER OK`.
- [ ] **Step 5:** Restart/`/clear` a session and confirm the `using-skills` kernel is injected, no `superpowers:*` skills are offered, and the owned `subagent-driven-development` resolves.

---

## Open questions / unresolved assumptions

*(For the Codex diff-review gate before the PR — concrete targets.)*

1. **Skill-invocation resolution after cutover:** does Claude Code resolve a bare `subagent-driven-development` (from a vendored `writing-plans` handoff) unambiguously once `superpowers` is disabled, or is a `plugin:skill` prefix needed? Verify at Task 8 Step 5.
2. **`${CLAUDE_PLUGIN_ROOT}` in the SessionStart hook:** confirmed available for SessionStart command hooks? The test stubs it empty; real injection depends on Claude Code setting it. Validate in a live session.
3. **Vendored brainstorming visual-companion scripts** (`server.cjs` etc.) — kept as-is in Task 2; the re-tier (Task 5) doesn't touch them. Assumed still functional unvendored; not independently tested.
4. **Node availability in the hook:** `session-start` shells out to `node` for JSON encoding. Assumed present (repo already depends on node). If not guaranteed at hook time, replace with a pure-`sh` JSON emitter.

---

## Self-review

Run after writing (checklist, not a subagent): spec-coverage (every spec section → a task), placeholder scan, type/naming consistency across tasks. Fix inline.
