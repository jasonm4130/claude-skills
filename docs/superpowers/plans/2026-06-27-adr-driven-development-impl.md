# ADR-Driven Development Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `adr` front-end skill and extend the `sdd.mjs` loop so `/adr "<intent>"` produces a grounded, cited, build-ready ADR that hands off to the existing subagent-driven-development loop (`adr → sdd`).

**Architecture:** A new thin `adr` plugin (skill-only, no workflow) authors `docs/adr/YYYY-MM-DD-<slug>.md` and invokes the **existing** `sdd.mjs` Workflow. The loop gains three small, backward-compatible additions: an `adrPath` input alias, a `successCriteria` done-oracle threaded into the whole-branch checker, and a mid-loop load-bearing-decision halt (prompt-level). Determinism stays in the workflow; the skill stays prose.

**Tech Stack:** Node ESM (`.mjs`), `node:test` + `node:assert/strict`, Claude Code plugins/skills, bash helper scripts. No build pipeline, no new dependencies.

## Global Constraints

- **No new dependencies, ever.** Tests use only `node:test` + `node:assert/strict`; run with `node --test <file…>`.
- **`sdd.mjs` is a sealed Workflow sandbox:** no `import`, no `fs`, no `Date.now`/`Math.random`. Pure helpers stay between the `// >>> PURE` and `// <<< PURE` markers. The body stays guarded by `if (typeof phase === "function")`.
- **Every `agent()` call in `sdd.mjs` keeps an explicit `model:` property** (the `workflow-model-guard` + smoke test require it).
- **Backward compatibility is hard:** the existing `planPath` + `# Task N` flow stays unchanged. `validateArgs({})` MUST still throw an error whose message contains the substring `planPath is required`. All 21 existing SDD tests stay green.
- **Names are exact:** the new plugin and skill are both named `adr`. ADR documents live at `docs/adr/YYYY-MM-DD-<slug>.md`.
- **Manifest house style:** `"version": "0.1.0"`, `"author": { "name": "Jason Matthew", "email": "jasonm4130@gmail.com" }`, `"license": "MIT"`, `"homepage"`/`"repository": "https://github.com/jasonm4130/claude-skills"`. Marketplace entries use `"author": { "name": "Jason Matthew" }` and `"category": "productivity"`.
- **ADR Decomposition uses thin `### Task N: <title>` subsections, placed as the LAST section of the ADR** so `task-brief`'s awk extracts each cleanly with no trailing-section bleed.
- **Citation rule (hard, in the `adr` skill):** a codebase claim cites a file/symbol; an external claim cites a dated source; an ungrounded claim does not enter the ADR.
- Match existing prompt/skill/test/manifest file conventions exactly. Author prose at the existing files' altitude.

## File Map

**New (`adr` plugin):**
- `plugins/adr/.claude-plugin/plugin.json` — manifest.
- `plugins/adr/.claude-plugin/manifest.test.mjs` — manifest + marketplace registration test.
- `plugins/adr/skills/adr/SKILL.md` — the four-phase front-end orchestrator.
- `plugins/adr/skills/adr/skill.test.mjs` — skill-body contract test.
- `plugins/adr/README.md` — short plugin readme.

**Modified (`sdd` loop):**
- `plugins/subagent-driven-development/workflows/sdd.mjs` — `validateArgs` adapter, `FINAL_SCHEMA`, `finalPrompt`.
- `plugins/subagent-driven-development/workflows/sdd.test.mjs` — new `validateArgs` cases.
- `plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs` — successCriteria-threading source check.
- `plugins/subagent-driven-development/prompts/final-reviewer.md` — ADR done-oracle checker section.
- `plugins/subagent-driven-development/prompts/implementer.md` — load-bearing-decision halt.
- `plugins/subagent-driven-development/prompts/prompts.test.mjs` — assertions for both prompt additions.
- `plugins/subagent-driven-development/skills/subagent-driven-development/SKILL.md` — document the ADR-driven dispatch.
- `.claude-plugin/marketplace.json` — register the `adr` plugin.

---

## Tasks

### Task 1: ADR input adapter in `validateArgs`

**Files:**
- Modify: `plugins/subagent-driven-development/workflows/sdd.mjs` (the `validateArgs` function, currently lines 19–49)
- Test: `plugins/subagent-driven-development/workflows/sdd.test.mjs`

**Interfaces:**
- Produces: `validateArgs(input)` now accepts `input.adrPath` as an alias for `input.planPath`, and an optional `input.successCriteria` string. Returns an object that additionally carries `successCriteria` (defaulting to `""`). `planPath` in the returned object is `input.planPath || input.adrPath`.

- [ ] **Step 1: Write the failing tests**

Add these tests to `sdd.test.mjs` (after the existing `validateArgs rejects missing fields` test). They reuse the file's existing `okArgs()` helper:

```js
test("validateArgs accepts adrPath as an alias for planPath", () => {
  const { planPath: _drop, ...rest } = okArgs();
  const c = H.validateArgs({ ...rest, adrPath: "docs/adr/2026-06-27-x.md" });
  assert.equal(c.planPath, "docs/adr/2026-06-27-x.md");
});

test("validateArgs still requires a path when neither planPath nor adrPath is given", () => {
  assert.throws(() => H.validateArgs({}), /planPath is required/);
  const { planPath: _drop, ...rest } = okArgs();
  assert.throws(() => H.validateArgs(rest), /planPath is required/);
});

test("validateArgs threads successCriteria, defaulting to empty string", () => {
  assert.equal(H.validateArgs(okArgs()).successCriteria, "");
  const c = H.validateArgs({ ...okArgs(), successCriteria: "GET /x returns 200 with shape Y" });
  assert.equal(c.successCriteria, "GET /x returns 200 with shape Y");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.test.mjs`
Expected: FAIL — `validateArgs` does not yet read `adrPath` (planPath comes back `undefined`) and does not return `successCriteria`.

- [ ] **Step 3: Edit `validateArgs` in `sdd.mjs`**

Replace the required-keys block and the `return` of `validateArgs`. The current function does:

```js
  for (const k of ["planPath", "workdir", "pluginDir", "mergeBase"]) {
    if (typeof input[k] !== "string" || !input[k]) throw new Error(`args.${k} is required`);
  }
```

Change it to pull `planPath` from either key first, then validate the rest:

```js
  // ADR adapter: adrPath is an alias for planPath — the file task-brief reads.
  // The `# Task N` planPath flow is unchanged; an ADR supplies its tasks via its
  // `### Task N` Decomposition section, read by the same task-brief script.
  const planPath = input.planPath || input.adrPath;
  if (typeof planPath !== "string" || !planPath) {
    throw new Error("args.planPath is required (or pass adrPath)");
  }
  for (const k of ["workdir", "pluginDir", "mergeBase"]) {
    if (typeof input[k] !== "string" || !input[k]) throw new Error(`args.${k} is required`);
  }
```

Then change the `return` object to use the local `planPath` and add `successCriteria`:

```js
  return {
    planPath, workdir: input.workdir, pluginDir: input.pluginDir,
    globalConstraints: typeof input.globalConstraints === "string" ? input.globalConstraints : "",
    successCriteria: typeof input.successCriteria === "string" ? input.successCriteria : "",
    mergeBase: input.mergeBase, tasks, limits,
  };
```

Leave everything else in `validateArgs` (the JSON-string parse, the object check, the tasks `.map`, the limits block) exactly as is.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.test.mjs`
Expected: PASS — including the existing `validateArgs rejects missing fields` test (the `{}` case still throws a message containing `planPath is required`).

- [ ] **Step 5: Run the full SDD suite to confirm nothing regressed**

Run:
```bash
node --test \
  plugins/subagent-driven-development/workflows/sdd.test.mjs \
  plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs \
  plugins/subagent-driven-development/prompts/prompts.test.mjs \
  plugins/subagent-driven-development/.claude-plugin/manifest.test.mjs \
  plugins/subagent-driven-development/skills/subagent-driven-development/skill.test.mjs
```
Expected: PASS, `fail 0` (24 tests now: 21 prior + 3 new).

- [ ] **Step 6: Commit**

```bash
git add plugins/subagent-driven-development/workflows/sdd.mjs \
        plugins/subagent-driven-development/workflows/sdd.test.mjs
git commit -m "sdd: accept adrPath alias + successCriteria in validateArgs"
```

---

### Task 2: Done-oracle checker at the whole-branch step

**Files:**
- Modify: `plugins/subagent-driven-development/workflows/sdd.mjs` (`FINAL_SCHEMA` ~139–157; `finalPrompt` ~192–198)
- Modify: `plugins/subagent-driven-development/prompts/final-reviewer.md`
- Modify: `plugins/subagent-driven-development/prompts/prompts.test.mjs`
- Modify: `plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs`
- Modify: `plugins/subagent-driven-development/skills/subagent-driven-development/SKILL.md`

**Interfaces:**
- Consumes: `cfg.successCriteria` (from Task 1).
- Produces: when the run is ADR-driven, the final reviewer judges the branch against the ADR Success criteria and returns optional `criteria[]` + `holistic`; any unmet criterion is also emitted as a `findings[]` entry so the existing final-fix path repairs it. No new loop machinery; single-pass final review + human ratification is unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `prompts.test.mjs` (a new test; keep the existing `final reviewer prompt is whole-branch…` test untouched):

```js
test("final reviewer documents the ADR success-criteria done-oracle", () => {
  const s = read("final-reviewer.md");
  assert.match(s, /success criteria/i);
  assert.match(s, /done-oracle|done oracle/i);
  assert.match(s, /holistic/i);
  assert.match(s, /do not re-run|don't re-run|do not rerun/i);
});
```

Add to `sdd.smoke.test.mjs` (it already reads the source as `src`):

```js
test("finalPrompt threads ADR success criteria into the whole-branch review", () => {
  assert.match(src, /successCriteria/);
  assert.match(src, /holistic/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test plugins/subagent-driven-development/prompts/prompts.test.mjs plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs`
Expected: FAIL — `final-reviewer.md` has no success-criteria section yet, and `sdd.mjs` does not reference `successCriteria`/`holistic`.

- [ ] **Step 3: Extend `FINAL_SCHEMA` in `sdd.mjs`**

Add two **optional** properties (NOT in `required`, to stay backward-compatible with plan-mode runs) inside `FINAL_SCHEMA.properties`, after `ponytailDebt`:

```js
    criteria: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["criterion", "kind", "verdict"],
        properties: {
          criterion: { type: "string" },
          kind: { type: "string", enum: ["oracle", "checker"] },
          verdict: { type: "string", enum: ["met", "unmet", "cannot-verify"] },
          evidence: { type: "string" },
        },
      },
    },
    holistic: { type: "string" },
```

Leave `required: ["verdict", "findings", "ponytailDebt"]` unchanged.

- [ ] **Step 4: Thread `successCriteria` into `finalPrompt` in `sdd.mjs`**

Replace the `finalPrompt` arrow (currently lines ~192–198) with:

```js
  const finalPrompt = (mergeBase, head) =>
    `You are the whole-branch FINAL reviewer (most capable model). Work in ${cfg.workdir}; READ-ONLY.
Read your full operating instructions first: ${P}/prompts/final-reviewer.md — follow them exactly.
Build the branch diff: ${P}/scripts/review-package ${mergeBase} ${head}
Read the package. Also list any new \`ponytail:\` markers (grep the diff for 'ponytail:').
Global constraints:\n${gc}${
      cfg.successCriteria
        ? `\n\nADR SUCCESS CRITERIA — judge the branch against these (the done-oracle the human ratifies):\n${cfg.successCriteria}\nFor each: set kind ("oracle" if it names a test/CI/assertion, else "checker"); set verdict ("met"/"unmet"/"cannot-verify"). Judge "checker" criteria against the diff; for "oracle" criteria confirm the test/assertion is present and satisfied but do NOT re-run suites. Add any UNMET criterion to findings[] so it gets fixed. Then one holistic judgment in "holistic": do these changes add up to the stated intent? Return criteria[] and holistic.`
        : ""
    }
Return per schema: verdict ("approve"/"changes"), findings[{severity,file,line,what}], ponytailDebt[]${cfg.successCriteria ? ", criteria[], holistic" : ""}.`;
```

(`cfg` is already in scope where `finalPrompt` is defined.)

- [ ] **Step 5: Add the done-oracle section to `final-reviewer.md`**

Insert this section after the `## Harvest ponytail debt` section and before `## Verdict`:

```markdown
## ADR success criteria (done-oracle — only when the run is ADR-driven)

When the dispatch includes ADR **Success criteria**, judge the whole branch
against them — this is the done-oracle the human ratifies.

- Each criterion is either **oracle-backed** (it names a test, CI signal, or a
  concrete assertion) or **[checker]** (no oracle — a statement only a reader can
  judge). For oracle-backed criteria, confirm the test/assertion is present and
  satisfied on the branch; **do not re-run** suites the per-task gates already ran.
  For **[checker]** criteria, judge them against the diff.
- One **holistic** pass: do these changes add up to the stated intent?
- Any criterion you judge **unmet** also goes in `findings[]` so it gets fixed —
  the structured `criteria[]` is for the human's ratification; the finding is what
  drives the fix.
- Record each in `criteria[]` as `{criterion, kind, verdict, evidence}` (kind:
  `oracle`|`checker`; verdict: `met`|`unmet`|`cannot-verify`) and the holistic
  judgment in `holistic`.

When the dispatch carries no ADR criteria, omit `criteria[]`/`holistic` and review
exactly as below.
```

- [ ] **Step 6: Document the ADR-driven dispatch in the sdd `SKILL.md`**

In `plugins/subagent-driven-development/skills/subagent-driven-development/SKILL.md`, add this subsection immediately after section `### 6. Resolve install paths and invoke the Workflow` (before `### 7.`):

```markdown
### 6a. ADR-driven dispatch (optional)

The `adr` skill drives this same Workflow from an ADR instead of a `# Task N`
plan. It passes `adrPath` (an alias for `planPath` — the file `task-brief` reads,
whose `### Task N` Decomposition supplies the tasks) and `successCriteria` (the
ADR's Success-criteria block, judged at the whole-branch step as the done-oracle).
Everything else — tiering, escalation, the per-task gate, finishing — is identical.
```

- [ ] **Step 7: Run the tests to verify they pass**

Run:
```bash
node --test \
  plugins/subagent-driven-development/prompts/prompts.test.mjs \
  plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs \
  plugins/subagent-driven-development/workflows/sdd.test.mjs \
  plugins/subagent-driven-development/skills/subagent-driven-development/skill.test.mjs
```
Expected: PASS, `fail 0`. The existing `final reviewer prompt is whole-branch…`, smoke `every agent() call sets an explicit model`, and `skill.test` assertions all still pass.

- [ ] **Step 8: Commit**

```bash
git add plugins/subagent-driven-development/workflows/sdd.mjs \
        plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs \
        plugins/subagent-driven-development/prompts/final-reviewer.md \
        plugins/subagent-driven-development/prompts/prompts.test.mjs \
        plugins/subagent-driven-development/skills/subagent-driven-development/SKILL.md
git commit -m "sdd: ADR success-criteria done-oracle at the whole-branch checker"
```

---

### Task 3: Mid-loop load-bearing-decision halt

**Files:**
- Modify: `plugins/subagent-driven-development/prompts/implementer.md`
- Modify: `plugins/subagent-driven-development/prompts/prompts.test.mjs`

**Interfaces:**
- Produces: the implementer is instructed to report `BLOCKED` (rather than decide) when a task forces a *new* load-bearing decision — a new dependency, a public-API change, or a schema/data-model change — not already settled by the brief/constraints. This rides the existing `BLOCKED` halt path in `sdd.mjs` (no code change).

- [ ] **Step 1: Write the failing test**

Add to `prompts.test.mjs`:

```js
test("implementer halts on new load-bearing decisions instead of deciding them", () => {
  const s = read("implementer.md");
  assert.match(s, /load-bearing/i);
  assert.match(s, /new dependency/i);
  assert.match(s, /schema|data-model/i);
  assert.match(s, /BLOCKED/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test plugins/subagent-driven-development/prompts/prompts.test.mjs`
Expected: FAIL — `implementer.md` has no load-bearing-decision instruction.

- [ ] **Step 3: Edit `implementer.md`**

In section `## 7. When you're in over your head`, append this paragraph after the existing text:

```markdown
**New load-bearing decisions are not yours to make.** If implementing this task
forces a decision the brief and global constraints did not already settle — a
**new dependency**, a **public-API change**, or a **schema / data-model change** —
do NOT pick one and proceed. Report `BLOCKED`, naming the decision and the options
you see. The controller (with the human) decides it, records it, and resumes. This
is the same halt path as any blocker: a load-bearing fork silently decided is the
expensive kind of wrong.
```

Do not alter the existing section-7 text or any other section (the ladder, two-concrete-uses, `ponytail:` marker, RED/GREEN, and counter-boundary assertions must stay green).

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test plugins/subagent-driven-development/prompts/prompts.test.mjs`
Expected: PASS — including the existing `implementer prompt has ladder, counter-boundary…` test.

- [ ] **Step 5: Commit**

```bash
git add plugins/subagent-driven-development/prompts/implementer.md \
        plugins/subagent-driven-development/prompts/prompts.test.mjs
git commit -m "sdd: implementer halts on new load-bearing decisions"
```

---

### Task 4: `adr` plugin scaffold (manifest + marketplace registration)

**Files:**
- Create: `plugins/adr/.claude-plugin/plugin.json`
- Create: `plugins/adr/.claude-plugin/manifest.test.mjs`
- Modify: `.claude-plugin/marketplace.json`

**Interfaces:**
- Produces: an installable `adr` plugin directory and its marketplace registration, so Task 5's skill resolves under `plugins/adr/skills/adr/`.

- [ ] **Step 1: Write the failing test**

Create `plugins/adr/.claude-plugin/manifest.test.mjs` (modeled on the sdd manifest test):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

test("plugin.json is valid and names the plugin", () => {
  const p = JSON.parse(readFileSync(join(here, "plugin.json"), "utf8"));
  assert.equal(p.name, "adr");
  assert.ok(p.description && p.description.length > 20);
  assert.ok(Array.isArray(p.keywords) && p.keywords.includes("adr"));
});

test("marketplace.json registers the plugin", () => {
  const m = JSON.parse(readFileSync(join(repoRoot, ".claude-plugin", "marketplace.json"), "utf8"));
  const entry = m.plugins.find((x) => x.name === "adr");
  assert.ok(entry, "marketplace entry exists");
  assert.equal(entry.source, "./plugins/adr");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test plugins/adr/.claude-plugin/manifest.test.mjs`
Expected: FAIL — `plugin.json` does not exist and the marketplace has no `adr` entry.

- [ ] **Step 3: Create `plugin.json`**

Create `plugins/adr/.claude-plugin/plugin.json`:

```json
{
  "name": "adr",
  "description": "Turns an intent into a grounded, cited, build-ready ADR (docs/adr/YYYY-MM-DD-<slug>.md) — every claim cited, load-bearing decisions surfaced to the human — then hands it to the subagent-driven-development loop. Front-end for adr → sdd.",
  "version": "0.1.0",
  "author": { "name": "Jason Matthew", "email": "jasonm4130@gmail.com" },
  "homepage": "https://github.com/jasonm4130/claude-skills",
  "repository": "https://github.com/jasonm4130/claude-skills",
  "license": "MIT",
  "keywords": ["adr", "architecture-decision-record", "grounding", "subagent-driven-development", "sdd"]
}
```

- [ ] **Step 4: Register the plugin in `marketplace.json`**

Append this object to the `plugins` array in `.claude-plugin/marketplace.json` (after the `subagent-driven-development` entry — mind the comma):

```json
    {
      "name": "adr",
      "source": "./plugins/adr",
      "description": "Turns an intent into a grounded, cited, build-ready ADR with load-bearing decisions surfaced to the human, then hands it to the subagent-driven-development loop. Front-end for adr → sdd.",
      "version": "0.1.0",
      "author": { "name": "Jason Matthew" },
      "license": "MIT",
      "keywords": ["adr", "architecture-decision-record", "grounding", "subagent-driven-development", "sdd"],
      "category": "productivity"
    }
```

- [ ] **Step 5: Run the test + validate JSON**

Run:
```bash
node --test plugins/adr/.claude-plugin/manifest.test.mjs
jq -e . .claude-plugin/marketplace.json > /dev/null && echo "marketplace.json valid"
jq -e . plugins/adr/.claude-plugin/plugin.json > /dev/null && echo "plugin.json valid"
```
Expected: tests PASS; both `valid` lines print.

- [ ] **Step 6: Commit**

```bash
git add plugins/adr/.claude-plugin/plugin.json \
        plugins/adr/.claude-plugin/manifest.test.mjs \
        .claude-plugin/marketplace.json
git commit -m "adr: scaffold plugin manifest + marketplace registration"
```

---

### Task 5: the `adr` skill body + README

**Files:**
- Create: `plugins/adr/skills/adr/SKILL.md`
- Create: `plugins/adr/skills/adr/skill.test.mjs`
- Create: `plugins/adr/README.md`

**Interfaces:**
- Consumes: the sdd Workflow contract — `adrPath`, `successCriteria`, `globalConstraints`, `tasks: [{n,title,tier,deps}]`, `mergeBase`, `pluginDir`, `workdir`, `limits` (from Tasks 1–2 and the existing loop).
- Produces: `/adr "<intent>"` → a committed `docs/adr/YYYY-MM-DD-<slug>.md` and a hand-off into the sdd loop.

**The skill body must encode (these are pinned by `skill.test.mjs`):**

1. **Frontmatter:** `name: adr` and a trigger-rich `description` mentioning ADR and the build hand-off.
2. **Phase 1 — Ground (scaled).** Inline by default; escalate to a `deep-dive` fan-out only when the change is novel, cross-cutting, or the user asks. State grounding: LSP (symbols/types/refs), `graphify` if a `graphify-out/graph.json` exists, `git` history, an `Explore` agent for breadth. Research grounding: `context7` for library docs, the cloudflare MCP for CF, `deep-dive` for novel/cross-cutting. Record which mode was used. Output: a grounding brief feeding the ADR.
3. **Phase 2 — Author the ADR** at `docs/adr/YYYY-MM-DD-<slug>.md` (create `docs/adr/` if absent) using the template below. **Citation rule (hard):** codebase claim → file/symbol; external claim → dated source; ungrounded → excluded. **Success criteria must be checkable**, each marked oracle-backed or `[checker]`. **Decomposition is thin `### Task N` subsections, placed LAST.**
4. **Phase 3 — Tiered decision gate.** Always-surface (blocking) set: **new dependency · public-API change · schema/data-model change · architecture-shaping choice** — presented as explicit choices the human picks before anything builds. Reversible decisions: recorded as *"assuming X — override if wrong"* defaults, non-blocking. Hard gate: nothing implements until the human approves the ADR.
5. **Phase 4 — Handoff.** On approval, resolve `sdd.mjs` and invoke the Workflow with the ADR (snippet below). **Loud-fail guard:** if the Decomposition has no parseable `### Task N` entries, stop and fix the ADR — do not hand off (mirrors `task-brief`'s "task N not found" guard).
6. **Scope guard:** the skill stays thin; one ADR doc, not a multi-file apparatus; the loop is for bounded, test-covered work — large ambiguous brownfield → smaller ADRs or manual.

**Embed this ADR template verbatim in the skill (Decomposition LAST):**

```markdown
# <Title>
**Status:** Proposed | Accepted | Superseded   **Date:** YYYY-MM-DD

## Context            <!-- grounded; every claim cites a file/symbol or dated source -->
## Decisions          <!-- each load-bearing decision: options + the choice; these bind every task as global constraints -->
## Success criteria   <!-- CHECKABLE; each marked oracle-backed or [checker]; this is the loop's done-oracle -->
## Consequences       <!-- incl. hard-to-reverse bets / risks -->
## Grounding sources  <!-- files/symbols read + external sources WITH dates -->

## Decomposition      <!-- LAST section; thin `### Task N` subsections so task-brief extracts each -->
### Task 1: <title>
<2–4 lines: what to build, which files, deps, tier hint>
### Task 2: <title>
…
```

**Embed this Phase-4 hand-off snippet in the skill** (resolve the path with the same glob the sdd skill uses):

````markdown
Resolve the loop and invoke it:

```bash
ls -d "$HOME"/.claude/plugins/cache/jasonm4130-claude-skills/subagent-driven-development/*/workflows/sdd.mjs | sort -V | tail -1
```

```
Workflow({ scriptPath: "<resolved sdd.mjs>", args: {
  adrPath: "<abs path to docs/adr/YYYY-MM-DD-<slug>.md>",
  workdir: "<worktree root>",
  pluginDir: "<plugin root containing workflows/ prompts/ scripts/>",
  globalConstraints: "<the ADR Decisions, verbatim>",
  successCriteria: "<the ADR Success criteria block, verbatim>",
  mergeBase: "<git merge-base main HEAD>",
  tasks: [ { n: 1, title: "...", tier: "sonnet", deps: [] }, ... ],   // from the Decomposition
  limits: { fixRounds: 2, escalateAttempts: 2 }
}})
```
````

- [ ] **Step 1: Write the failing test**

Create `plugins/adr/skills/adr/skill.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const s = readFileSync(join(here, "SKILL.md"), "utf8");

test("frontmatter names the adr skill with a trigger-rich description", () => {
  assert.match(s, /^---\nname: adr\n/);
  assert.match(s, /description:.*adr/i);
});

test("documents the four phases and the ADR document shape", () => {
  assert.match(s, /ground/i);
  assert.match(s, /docs\/adr\/.*<slug>|YYYY-MM-DD-<slug>/);
  assert.match(s, /success criteria/i);
  assert.match(s, /decomposition/i);
  assert.match(s, /### Task N|### Task 1|# Task N/);
});

test("enforces grounding citations and surfaces load-bearing decisions", () => {
  assert.match(s, /cite|citation/i);
  assert.match(s, /new dependency/i);
  assert.match(s, /public[- ]api/i);
  assert.match(s, /schema/i);
});

test("hands off to the subagent-driven-development workflow with the ADR", () => {
  assert.match(s, /subagent-driven-development|sdd\.mjs/i);
  assert.match(s, /adrPath/);
  assert.match(s, /successCriteria/);
  assert.match(s, /sort -V \| tail -1|glob/i);
  assert.match(s, /parseable|stop and fix|do not hand off/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test plugins/adr/skills/adr/skill.test.mjs`
Expected: FAIL — `SKILL.md` does not exist.

- [ ] **Step 3: Author `SKILL.md`**

Write `plugins/adr/skills/adr/SKILL.md` encoding the six requirements above, embedding the ADR template and the Phase-4 hand-off snippet verbatim. Keep it a thin orchestrator (prose + the two embedded blocks); the determinism lives in `sdd.mjs`, not here. Frontmatter:

```markdown
---
name: adr
description: Use when the user knows what they want built and says "/adr", "write an ADR for X", "decide and build X", or "ADR-driven". Turns an intent into a grounded, cited, build-ready ADR at docs/adr/YYYY-MM-DD-<slug>.md — load-bearing decisions surfaced to the human — then hands off to the subagent-driven-development loop. For exploratory "not sure what I want yet" work use brainstorming first; for visual planning use visual-plan.
---
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test plugins/adr/skills/adr/skill.test.mjs`
Expected: PASS (all four tests).

- [ ] **Step 5: Write the README**

Create `plugins/adr/README.md` — a short readme modeled on the other plugins': one-paragraph what-it-is, the `adr → sdd` arc, the four phases in a sentence each, and a pointer to the design spec at `docs/superpowers/specs/2026-06-27-adr-driven-development-design.md`. No test covers the README.

- [ ] **Step 6: Run the whole repo's node tests to confirm green**

Run:
```bash
node --test \
  plugins/adr/.claude-plugin/manifest.test.mjs \
  plugins/adr/skills/adr/skill.test.mjs \
  plugins/subagent-driven-development/workflows/sdd.test.mjs \
  plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs \
  plugins/subagent-driven-development/prompts/prompts.test.mjs \
  plugins/subagent-driven-development/.claude-plugin/manifest.test.mjs \
  plugins/subagent-driven-development/skills/subagent-driven-development/skill.test.mjs
```
Expected: PASS, `fail 0`.

- [ ] **Step 7: Commit**

```bash
git add plugins/adr/skills/adr/SKILL.md \
        plugins/adr/skills/adr/skill.test.mjs \
        plugins/adr/README.md
git commit -m "adr: author the front-end skill body + README"
```
