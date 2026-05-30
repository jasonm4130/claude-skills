# Deep-Research Hybrid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the `deep-research` skill's fan-out + verification from model-driven prose dispatch into a shipped, args-driven `fanout.mjs` Workflow script, keeping the interactive gate and final synthesis in the main session.

**Architecture:** The skill (main session) stays the interactive gate — triage, DAG planning with core/background/follow-up tagging, confirmation. On "go" it resolves the script path by versioned glob, builds an `args` object, and calls `Workflow({scriptPath, args})`. The self-contained `fanout.mjs` runs a two-wave research→verify pipeline (factored tier-1 verifier + uncertainty-gated tier-2 escalation) and returns schema-validated `{reports, verification, meta}`. The main session then does the critic + final synthesis on Opus.

**Tech Stack:** Node 20 ES modules (`.mjs`), `node:test` + `node:assert/strict`, the Claude Code Workflow runtime (sealed sandbox — no imports, body wrapped in a function, injected `agent`/`pipeline`/`parallel`/`phase`/`log`/`args` globals).

**Reference:** Design spec at `docs/superpowers/specs/2026-05-30-deep-research-hybrid-design.md`. Runtime constraints there were empirically probed — read that section before starting.

---

## File Structure

- **Create** `plugins/deep-research/workflows/fanout.mjs` — self-contained workflow script. Pure helpers between `// >>> PURE` / `// <<< PURE` markers; orchestration fenced behind `if (typeof phase === "function")`.
- **Create** `plugins/deep-research/workflows/fanout.test.mjs` — extracts the PURE block via `new Function` and tests it with `node:test`.
- **Modify** `plugins/deep-research/skills/deep-research/SKILL.md` — surgical splice of §2–§4 + cost-defaults bullet + scout-mode note.
- **Modify** `plugins/deep-research/.claude-plugin/plugin.json` — version `0.1.0 → 0.2.0`.
- **Modify** `.claude-plugin/marketplace.json` — deep-research version `0.1.0 → 0.2.0`.

All work happens on branch `feat/deep-research-hybrid` (already created; the spec is committed there).

---

## Task 1: Pure helpers in fanout.mjs (wave partition + args validation)

**Files:**
- Create: `plugins/deep-research/workflows/fanout.mjs`
- Test: `plugins/deep-research/workflows/fanout.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `plugins/deep-research/workflows/fanout.test.mjs`:

```js
// @ts-check
// Tests the PURE helper block extracted from fanout.mjs. fanout.mjs cannot be
// imported (top-level return → SyntaxError in node:test), so we read it as text,
// slice the // >>> PURE ... // <<< PURE block, and eval it with new Function to get
// the actual shipped helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "fanout.mjs"), "utf8");
const block = src.split("// >>> PURE")[1]?.split("// <<< PURE")[0];
assert.ok(block, "fanout.mjs must contain a // >>> PURE ... // <<< PURE block");
const PURE = new Function(
  block +
    "\nreturn { partitionWaves, validateArgs, shouldEscalate, tallyMeta, researchPrompt, verifyPrompt };"
)();

test("partitionWaves: empty deps -> wave 1, non-empty deps -> wave 2", () => {
  const angles = [
    { id: "a", deps: [] },
    { id: "b", deps: [] },
    { id: "c", deps: ["a"] },
  ];
  const { wave1, wave2 } = PURE.partitionWaves(angles);
  assert.deepEqual(wave1.map((x) => x.id), ["a", "b"]);
  assert.deepEqual(wave2.map((x) => x.id), ["c"]);
});

test("partitionWaves: missing deps treated as wave 1", () => {
  const { wave1, wave2 } = PURE.partitionWaves([{ id: "a" }]);
  assert.deepEqual(wave1.map((x) => x.id), ["a"]);
  assert.equal(wave2.length, 0);
});

test("validateArgs: rejects missing topic", () => {
  assert.throws(() => PURE.validateArgs({ angles: [{ id: "a", question: "q" }] }), /topic/);
});

test("validateArgs: rejects empty angles", () => {
  assert.throws(() => PURE.validateArgs({ topic: "t", angles: [] }), /angles/);
});

test("validateArgs: defaults mode=deep and angle.model=sonnet", () => {
  const out = PURE.validateArgs({ topic: "t", angles: [{ id: "a", question: "q" }] });
  assert.equal(out.mode, "deep");
  assert.equal(out.angles[0].model, "sonnet");
  assert.equal(out.angles[0].kind, "core");
  assert.deepEqual(out.angles[0].deps, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/deep-research/workflows/fanout.test.mjs`
Expected: FAIL — `ENOENT` (fanout.mjs does not exist) or the PURE-block assertion fails.

- [ ] **Step 3: Write minimal implementation**

Create `plugins/deep-research/workflows/fanout.mjs`:

```js
// @ts-check
// Deep-research fan-out + tiered verification. Self-contained Workflow script
// (the runtime is a sealed sandbox: no imports, body wrapped in a function).
// Pure helpers live between the PURE markers so fanout.test.mjs can extract them.
export const meta = {
  name: "deep-research-fanout",
  description:
    "Args-driven deep-research fan-out: two-wave research with factored tier-1 verification and uncertainty-gated tier-2 escalation; returns schema-validated reports + verification + meta.",
  phases: [
    { title: "Research", detail: "wave-1 + conditional wave-2 gather, per-angle Sonnet workers" },
    { title: "Verify", detail: "factored verifier per angle, blind to draft" },
  ],
};

// >>> PURE
function partitionWaves(angles) {
  const wave1 = angles.filter((a) => !a.deps || a.deps.length === 0);
  const wave2 = angles.filter((a) => a.deps && a.deps.length > 0);
  return { wave1, wave2 };
}

function validateArgs(input) {
  if (!input || typeof input !== "object") throw new Error("args must be an object");
  if (typeof input.topic !== "string" || input.topic.length === 0)
    throw new Error("args.topic is required");
  if (!Array.isArray(input.angles) || input.angles.length === 0)
    throw new Error("args.angles must be a non-empty array");
  const mode = input.mode === "scout" ? "scout" : "deep";
  const angles = input.angles.map((a, i) => {
    if (typeof a.question !== "string" || a.question.length === 0)
      throw new Error(`angle[${i}].question is required`);
    return {
      id: typeof a.id === "string" && a.id ? a.id : `angle-${i + 1}`,
      question: a.question,
      kind: ["core", "background", "follow-up"].includes(a.kind) ? a.kind : "core",
      model: a.model === "haiku" ? "haiku" : "sonnet",
      deps: Array.isArray(a.deps) ? a.deps : [],
    };
  });
  const escalateOn = input.verify && input.verify.escalateOn === "low" ? "low" : "low";
  return { topic: input.topic, mode, angles, verify: { escalateOn } };
}

function shouldEscalate(verification, escalateOn) {
  return verification && verification.reliability === (escalateOn || "low");
}

function tallyMeta(mode, wavesRun, results) {
  const completed = results.filter(Boolean);
  return {
    mode,
    wavesRun,
    anglesCompleted: completed.length,
    anglesFailed: results.length - completed.length,
    escalations: completed.filter((r) => r && r.escalated).length,
  };
}

function researchPrompt(topic, angle, mode, waveCtx) {
  const depth =
    mode === "scout"
      ? "BREADTH MODE: skim 8-10 sources for coverage; one brief note per source."
      : "DEPTH MODE: read 2-4 sources DEEPLY; prefer primary/official docs.";
  const ctx = waveCtx
    ? `\n\nWAVE-1 FINDINGS to build directly on (use these, do not re-gather):\n${waveCtx}`
    : "";
  return `Research angle "${angle.question}". Part of: "${topic}".
${depth}
Use the Exa and Tavily MCP tools (any mcp__exa__* and mcp__tavily__* tool), plus WebSearch and WebFetch.
Cite EVERY claim with a real URL + title + date from a search result. Never invent URLs.
Return per schema: angleId="${angle.id}", kind="${angle.kind}", a <=120-word summary, and load-bearing findings.${ctx}`;
}

function verifyPrompt(angle, research) {
  const findings = (research.findings || [])
    .map((f, i) => `${i + 1}. ${f.claim} — ${f.sourceTitle} (${f.sourceUrl}, ${f.sourceDate})`)
    .join("\n");
  return `You are an INDEPENDENT tier-2 verifier. You did NOT do the original research. For the angle "${angle.question}", verify the 4-5 most load-bearing claims below by re-fetching each cited URL with WebFetch (and one corroborating search if a source is weak). Judge each: supported / partial / unsupported / unreachable. Flag single-source claims and any where the page does not actually support the claim. Be adversarial.

${findings}

Return per schema: angleId="${angle.id}", overallReliability (high/medium/low), and the per-claim flags.`;
}
// <<< PURE
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/deep-research/workflows/fanout.test.mjs`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/deep-research/workflows/fanout.mjs plugins/deep-research/workflows/fanout.test.mjs
git commit -m "feat(deep-research): pure helpers for fanout workflow (wave partition, args validation)"
```

---

## Task 2: Escalation + meta accounting tests

**Files:**
- Modify: `plugins/deep-research/workflows/fanout.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `plugins/deep-research/workflows/fanout.test.mjs`:

```js
test("shouldEscalate: true only when reliability is low", () => {
  assert.equal(PURE.shouldEscalate({ reliability: "low" }, "low"), true);
  assert.equal(PURE.shouldEscalate({ reliability: "medium" }, "low"), false);
  assert.equal(PURE.shouldEscalate({ reliability: "high" }, "low"), false);
  assert.equal(PURE.shouldEscalate(null, "low"), false);
});

test("tallyMeta: counts completed, failed, escalated", () => {
  const results = [
    { angleId: "a", escalated: false },
    { angleId: "b", escalated: true },
    null,
  ];
  const m = PURE.tallyMeta("deep", 2, results);
  assert.equal(m.mode, "deep");
  assert.equal(m.wavesRun, 2);
  assert.equal(m.anglesCompleted, 2);
  assert.equal(m.anglesFailed, 1);
  assert.equal(m.escalations, 1);
});

test("researchPrompt: deep vs scout wording, and wave context", () => {
  const deep = PURE.researchPrompt("T", { id: "a", question: "Q", kind: "core" }, "deep", null);
  assert.match(deep, /DEPTH MODE/);
  const scout = PURE.researchPrompt("T", { id: "a", question: "Q", kind: "core" }, "scout", null);
  assert.match(scout, /BREADTH MODE/);
  const withCtx = PURE.researchPrompt("T", { id: "a", question: "Q", kind: "core" }, "deep", "PRIOR");
  assert.match(withCtx, /WAVE-1 FINDINGS/);
  assert.match(withCtx, /PRIOR/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/deep-research/workflows/fanout.test.mjs`
Expected: The 3 new tests would FAIL only if helpers were missing — but `shouldEscalate`, `tallyMeta`, `researchPrompt` already exist from Task 1, so they should PASS immediately. If they pass, that's expected (the helpers were defined in Task 1). Proceed to verify all pass.

- [ ] **Step 3: (No new implementation needed)**

The helpers already exist. If any test fails, fix the helper in `fanout.mjs` to match the assertion.

- [ ] **Step 4: Run test to verify all pass**

Run: `node --test plugins/deep-research/workflows/fanout.test.mjs`
Expected: PASS — 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/deep-research/workflows/fanout.test.mjs
git commit -m "test(deep-research): cover escalation trigger, meta accounting, prompt builders"
```

---

## Task 3: Schemas + orchestration glue in fanout.mjs

**Files:**
- Modify: `plugins/deep-research/workflows/fanout.mjs`

This adds the runtime-only orchestration. It is NOT unit-tested (the sandbox forbids importing the module); it is verified by the live smoke run in Task 4. Keep it behind the `typeof phase === "function"` guard so the test's `new Function` extraction never touches it.

- [ ] **Step 1: Add schemas + orchestration block**

Append to `plugins/deep-research/workflows/fanout.mjs` (after the `// <<< PURE` line):

```js
const RESEARCH_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["angleId", "kind", "summary", "findings"],
  properties: {
    angleId: { type: "string" },
    kind: { type: "string", enum: ["core", "background", "follow-up"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["claim", "sourceUrl", "sourceTitle", "sourceDate"],
        properties: {
          claim: { type: "string" }, sourceUrl: { type: "string" },
          sourceTitle: { type: "string" }, sourceDate: { type: "string" },
        },
      },
    },
  },
};

const VERIFY_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["angleId", "overallReliability", "flags"],
  properties: {
    angleId: { type: "string" },
    overallReliability: { type: "string", enum: ["high", "medium", "low"] },
    flags: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["claim", "verdict", "note"],
        properties: {
          claim: { type: "string" },
          verdict: { type: "string", enum: ["supported", "partial", "unsupported", "unreachable"] },
          note: { type: "string" },
        },
      },
    },
  },
};

if (typeof phase === "function") {
  const cfg = validateArgs(args);
  const { wave1, wave2 } = partitionWaves(cfg.angles);
  const wavesRun = cfg.mode === "scout" || wave2.length === 0 ? 1 : 2;

  // Run one angle fully: research -> tier-1 verify -> conditional tier-2 escalation.
  async function runAngle(angle, waveCtx) {
    const research = await agent(researchPrompt(cfg.topic, angle, cfg.mode, waveCtx), {
      label: `research:${angle.id}`, phase: "Research", model: angle.model, schema: RESEARCH_SCHEMA,
    });
    if (!research) return null;
    let verify = await agent(verifyPrompt(angle, research), {
      label: `verify:${angle.id}`, phase: "Verify", model: "sonnet", schema: VERIFY_SCHEMA,
    });
    let escalated = false;
    if (cfg.mode !== "scout" && verify && shouldEscalate(verify, cfg.verify.escalateOn)) {
      const recheck = await agent(
        `Independently re-verify ONLY these flagged claims for "${angle.question}" using a fresh search and WebFetch; correct the verdicts where warranted. Prior flags:\n${JSON.stringify(verify.flags)}`,
        { label: `escalate:${angle.id}`, phase: "Verify", model: "sonnet", schema: VERIFY_SCHEMA }
      );
      if (recheck) { verify = recheck; escalated = true; }
    }
    return { angle, research, verify, escalated };
  }

  phase("Research");
  const wave1Results = (await parallel(wave1.map((a) => () => runAngle(a, null)))).filter(Boolean);

  let wave2Results = [];
  if (wavesRun === 2) {
    const digest = wave1Results
      .map((r) => `### ${r.angle.question}\n${r.research.summary}`)
      .join("\n\n");
    wave2Results = (await parallel(wave2.map((a) => () => runAngle(a, digest)))).filter(Boolean);
  }

  const all = [...wave1Results, ...wave2Results];
  log(`Completed ${all.length}/${cfg.angles.length} angles (${wavesRun} wave(s))`);

  return {
    reports: all.map((r) => ({
      angleId: r.research.angleId, kind: r.research.kind,
      summary: r.research.summary, findings: r.research.findings,
    })),
    verification: all.map((r) => ({
      angleId: r.verify.angleId, reliability: r.verify.overallReliability, flags: r.verify.flags,
    })),
    meta: tallyMeta(cfg.mode, wavesRun, all),
  };
}
```

- [ ] **Step 2: Verify the unit tests still pass (PURE block untouched)**

Run: `node --test plugins/deep-research/workflows/fanout.test.mjs`
Expected: PASS — 8 tests still pass (the orchestration block is outside the PURE markers).

- [ ] **Step 3: Lint-check the file parses as a module**

Run: `node --check plugins/deep-research/workflows/fanout.mjs`
Expected: A SyntaxError about top-level `return`. THAT IS EXPECTED — the Workflow runtime wraps the body in a function so `return` is legal there, but `node --check` parses it as a plain module. Confirm the only error is the top-level-return one; any *other* syntax error is a real bug to fix.

- [ ] **Step 4: Commit**

```bash
git add plugins/deep-research/workflows/fanout.mjs
git commit -m "feat(deep-research): two-wave research + tiered verify orchestration in fanout.mjs"
```

---

## Task 4: Live smoke run

**Files:** none (verification only)

- [ ] **Step 1: Invoke the real workflow via scriptPath with a tiny topic**

Use the Workflow tool:
```
Workflow({
  scriptPath: "<repo>/plugins/deep-research/workflows/fanout.mjs",
  args: {
    topic: "What are the two most recent Claude model releases and their headline capability?",
    mode: "deep",
    angles: [
      { id: "models", question: "Most recent Claude model releases in 2026 and their headline capabilities", kind: "core", deps: [] },
      { id: "compare", question: "Given those releases, which is positioned for agentic coding?", kind: "follow-up", deps: ["models"] }
    ]
  }
})
```

- [ ] **Step 2: Confirm the return shape**

Expected: a `{ reports, verification, meta }` object where `reports.length === 2`, each `verification[i].reliability` is one of high/medium/low, `meta.wavesRun === 2`, `meta.anglesCompleted === 2`. If `args` was undefined or the path failed to resolve, the run errors — fix before proceeding.

- [ ] **Step 3: Record the result in the plan and commit nothing (no code change)**

Note the `meta` object in your task report. If the shape is wrong, the orchestration block (Task 3) needs fixing.

---

## Task 5: Splice SKILL.md — dispatch (§2) and synthesis (§4)

**Files:**
- Modify: `plugins/deep-research/skills/deep-research/SKILL.md`

- [ ] **Step 1: Replace §2 "Dispatch root angles in parallel"**

Find the section starting `### 2. Dispatch root angles in parallel (wave 1)` through the end of its bullet list (it currently begins "Spawn one `Agent` per root angle…"). Replace the whole `### 2` body with:

```markdown
### 2. Dispatch via the fanout workflow

Once the user says "go", do NOT spawn `Agent` calls yourself. Build an `args` object from the
confirmed DAG and hand it to the shipped workflow.

1. Resolve the script's absolute path (`${CLAUDE_PLUGIN_ROOT}` is not available in this
   session, so glob the install and pick the highest version):

   ```bash
   ls -d "$HOME"/.claude/plugins/cache/jasonm4130-claude-skills/deep-research/*/workflows/fanout.mjs | sort -V | tail -1
   ```

   In local development, use the repo path `plugins/deep-research/workflows/fanout.mjs` directly.

2. Build `args` and invoke:

   ```
   Workflow({ scriptPath: "<resolved path>", args: {
     topic: "<the research topic>",
     mode: "deep",                       // or "scout" for a cheap breadth-first scoping pass
     angles: [
       { id, question, kind: "core"|"background"|"follow-up", model: "sonnet", deps: [] },
       // wave-2 angles carry deps: ["<id>"]; default workers to "sonnet" — only use "haiku"
       // for pure list/URL enumeration (it misses subtle cross-source contradictions).
     ],
     verify: { escalateOn: "low" }
   }})
   ```

The workflow runs wave-1, then any wave-2 (dependent) angles built on wave-1 findings, runs a
factored tier-1 verifier per angle (blind to the draft, re-fetches sources), escalates to a
tier-2 cross-check only on low-reliability angles, and returns
`{ reports, verification, meta }`.
```

- [ ] **Step 2: Update §3 and §4 to reflect the split**

Replace the `### 3. Dispatch dependent angles (wave 2, optional)` heading body with a one-liner
(the workflow now owns waves):

```markdown
### 3. Waves are handled by the workflow

Wave-2 (dependent) angles are declared via each angle's `deps` in the `args` above; the workflow
runs them automatically after wave-1. You do not dispatch them manually.
```

In `### 4. Synthesize`, replace the **citation-quality judge** bullet block with:

```markdown
**Citation verification (handled by the workflow):**
- The workflow already ran a factored tier-1 verifier (and tier-2 on low-reliability angles).
  Read `verification[]`: each angle carries a `reliability` and per-claim `flags`
  (supported/partial/unsupported/unreachable).
- In your synthesis, DOWNWEIGHT or explicitly flag any claim marked partial/unsupported/
  unreachable, and warn on any `reliability: "low"` angle. Do not silently drop them.
```

Leave the critic pass and final-judge pass bullets as-is (they run here, in this session).

- [ ] **Step 3: No automated test — verify by reading**

Run: `git diff plugins/deep-research/skills/deep-research/SKILL.md`
Confirm: §2 now describes the workflow dispatch, §3 is the one-liner, §4 references `verification[]`, and the triage table / §1 / source-diversity / tool-prefs / debate / common-mistakes sections are UNCHANGED.

- [ ] **Step 4: Commit**

```bash
git add plugins/deep-research/skills/deep-research/SKILL.md
git commit -m "feat(deep-research): SKILL.md dispatches via fanout workflow, reads verification[]"
```

---

## Task 6: Splice SKILL.md — planning tags (§1), cost defaults, scout mode

**Files:**
- Modify: `plugins/deep-research/skills/deep-research/SKILL.md`

- [ ] **Step 1: Add core/background/follow-up tagging to §1**

In `### 1. Plan the angles as a DAG, then ASK`, after the existing item that lists 3–5 angles,
add a sub-bullet:

```markdown
4. Tag each angle **core** (directly answers the question), **background** (context needed to
   answer), or **follow-up** (implications). When you show the DAG at the gate, show which
   **core** sub-questions are covered — core coverage is the quality bar. Aim to cover every
   core sub-question before dispatch.
```

- [ ] **Step 2: Fix the cost-defaults guidance**

Find the bullet under §2 (now moved) or the "Cost-aware defaults" list that reads
`model="haiku"` for recall-style angles. Replace the haiku/sonnet guidance with:

```markdown
- Default workers to `model="sonnet"`. An in-repo orchestration experiment found Haiku workers
  missed a load-bearing cross-source contradiction that Sonnet workers caught — so only use
  `model="haiku"` for genuinely pure enumeration (gathering lists/URLs), and accept the
  correctness risk on fine-grained claims.
- Reserve `opus` for this orchestrator session (planning + synthesis), not sub-agents.
```

(If this list was already removed by the Task 5 §2 replacement, add the two bullets to §2's
`args` guidance instead.)

- [ ] **Step 3: Add a scout-mode note**

At the end of the Triage section, add:

```markdown
**Scout mode:** for an open-ended "map the option space" question, you may run a cheap first
pass with `mode: "scout"` (breadth, single wave, no escalation) to discover the angles, then
run a full `mode: "deep"` pass. Depth-vs-breadth was a wash in testing for well-scoped
questions, so default to `deep`; use `scout` only for scoping.
```

- [ ] **Step 4: Verify by reading**

Run: `git diff plugins/deep-research/skills/deep-research/SKILL.md`
Confirm §1 has the tagging bullet, the cost guidance now defaults to Sonnet, and the scout-mode
note is present.

- [ ] **Step 5: Commit**

```bash
git add plugins/deep-research/skills/deep-research/SKILL.md
git commit -m "feat(deep-research): core/bg/follow-up tagging, Sonnet-default workers, scout mode"
```

---

## Task 7: Version bumps

**Files:**
- Modify: `plugins/deep-research/.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

- [ ] **Step 1: Bump plugin.json**

In `plugins/deep-research/.claude-plugin/plugin.json`, change `"version": "0.1.0"` to
`"version": "0.2.0"`.

- [ ] **Step 2: Bump marketplace.json**

In `.claude-plugin/marketplace.json`, in the `deep-research` plugin entry, change
`"version": "0.1.0"` to `"version": "0.2.0"`.

- [ ] **Step 3: Verify both parse as JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('plugins/deep-research/.claude-plugin/plugin.json','utf8')); JSON.parse(require('fs').readFileSync('.claude-plugin/marketplace.json','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add plugins/deep-research/.claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore(deep-research): bump to 0.2.0"
```

---

## Task 8: Full test pass + finish

**Files:** none

- [ ] **Step 1: Run the full deep-research test suite**

Run: `node --test plugins/deep-research/workflows/`
Expected: PASS — all tests green (8 from Tasks 1–2).

- [ ] **Step 2: Confirm the branch diff is the intended surface**

Run: `git diff main --stat`
Expected files: `fanout.mjs`, `fanout.test.mjs`, `SKILL.md`, `plugin.json`, `marketplace.json`,
plus the spec + plan docs. No stray files.

- [ ] **Step 3: Hand off**

Use `superpowers:finishing-a-development-branch` to decide merge / PR. The first real exercise
of the new workflow (the code-review plugin research) is the planned smoke test and can be a
follow-up.

---

## Self-Review (completed by plan author)

**Spec coverage:** packaging (Tasks 1+3+5), surgical splice (Tasks 5–6), split synthesis
(Task 5 §4), two-wave (Task 3), Sonnet default (Task 6), tiered verification (Task 3),
core/bg/follow-up gate (Task 6), args + return contracts (Tasks 1+3), scout mode (Tasks 3+6),
testing via extract-and-eval (Tasks 1–2), live smoke (Task 4), version bumps (Task 7),
non-goals respected (no lib.mjs, no self-consistency, no debate-in-workflow). All covered.

**Placeholder scan:** every code/test/command step contains literal content; no TBD/TODO.

**Type consistency:** `partitionWaves`/`validateArgs`/`shouldEscalate`/`tallyMeta`/
`researchPrompt`/`verifyPrompt` names match between the PURE block (Task 1), the tests
(Tasks 1–2), and the orchestration (Task 3). `RESEARCH_SCHEMA`/`VERIFY_SCHEMA` field names
(`angleId`, `overallReliability`, `flags`) match the return-mapping in Task 3 and the spec's
return contract. `args` shape in Task 4/Task 5 matches `validateArgs` in Task 1.
