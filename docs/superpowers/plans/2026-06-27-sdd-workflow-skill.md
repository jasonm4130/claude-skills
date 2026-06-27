# Subagent-Driven Development Workflow Skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Note:** both execution skills are currently disabled in this environment and this plugin is their replacement, so the plan is executed inline by the controlling session.

**Goal:** Ship a self-contained `subagent-driven-development` plugin whose `SKILL.md` plans + confirms + hoists human decisions in the controller session, then hands a lightweight task list to a background `sdd.mjs` Workflow that enforces implement → review → fix → final-review as deterministic code, with ponytail discipline codified into the prompts.

**Architecture:** Thin Opus controller (SKILL.md) + fat background Workflow (`workflows/sdd.mjs`). The workflow runs a sequential per-task loop (tiered implementer → spec+quality+ponytail reviewer → bounded fix loop), a deterministic BLOCKED-escalation ladder and oscillation halt, then an explicit-Opus whole-branch final review. Long role prompts live as `prompts/*.md` read by the dispatched agents; short control prompts are built inline in the script. Bash helpers (`task-brief`, `review-package`, `sdd-workspace`) do git/file plumbing inside agents.

**Tech Stack:** Node.js (ES modules, `node:test`), Bash, Claude Code Workflow runtime (sealed sandbox: no imports, no fs, no `Date.now()`/`Math.random()` in the script; agents do all file/git work), Claude Code plugin/marketplace manifest.

## Global Constraints

- Plugin name: `subagent-driven-development`; lives at `plugins/subagent-driven-development/`.
- `sdd.mjs` MUST set `model:` on every `agent()` call (satisfies `workflow-model-guard`); no agent inherits the orchestrator model.
- Model tiers: implementer = controller-assigned `task.tier` (default `sonnet` floor); reviewer = `task.tier === "opus" ? "opus" : "sonnet"`; fixer = `sonnet`; final review = `opus`.
- The workflow script must NOT read files, run bash, or call `Date.now()`/`Math.random()`. All file/git work happens inside agents via the bash scripts. Absolute paths (`workdir`, `pluginDir`, `planPath`, `mergeBase`) arrive in `args`.
- Tasks run strictly sequentially in ONE shared worktree (no per-agent `isolation: "worktree"`); each task builds on the previous commit.
- Workspace dir: `.sdd/` at the worktree root, self-ignoring via `.sdd/.gitignore` containing `*`.
- BLOCKED ladder: escalate `haiku → sonnet → opus`, one attempt per tier below opus; at opus, up to `limits.escalateAttempts` (default 2); then halt the whole workflow.
- Oscillation: same actionable finding-class surviving across `2` consecutive review rounds → halt that task. Fix loop cap: `limits.fixRounds` (default 2).
- Counter-boundary (verbatim in implementer + reviewer prompts): never minimize away security, input validation, error handling, accessibility, or observability. "We know we need this → build it; we might need it someday → don't."
- Plan format dependency: `task-brief` extracts `^#+[ \t]+Task[ \t]+<n>` headings. The plan being executed must use `# Task N` / `## Task N` headings.

---

### Task 1: Plugin manifest + marketplace registration

**Files:**
- Create: `plugins/subagent-driven-development/.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json` (append one plugin entry)
- Test: `plugins/subagent-driven-development/.claude-plugin/manifest.test.mjs`

**Interfaces:**
- Produces: a registered plugin named `subagent-driven-development` discoverable by the marketplace.

- [ ] **Step 1: Write the failing test**

```js
// plugins/subagent-driven-development/.claude-plugin/manifest.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

test("plugin.json is valid and names the plugin", () => {
  const p = JSON.parse(readFileSync(join(here, "plugin.json"), "utf8"));
  assert.equal(p.name, "subagent-driven-development");
  assert.ok(p.description && p.description.length > 20);
  assert.ok(Array.isArray(p.keywords) && p.keywords.includes("subagent-driven-development"));
});

test("marketplace.json registers the plugin", () => {
  const m = JSON.parse(readFileSync(join(repoRoot, ".claude-plugin", "marketplace.json"), "utf8"));
  const entry = m.plugins.find((x) => x.name === "subagent-driven-development");
  assert.ok(entry, "marketplace entry exists");
  assert.equal(entry.source, "./plugins/subagent-driven-development");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/subagent-driven-development/.claude-plugin/manifest.test.mjs`
Expected: FAIL (ENOENT on plugin.json).

- [ ] **Step 3: Create `plugin.json`**

```json
{
  "name": "subagent-driven-development",
  "description": "Deterministic, workflow-driven subagent development loop: plan -> confirm -> background Workflow runs per-task implement/review/fix with tiered models, ponytail anti-over-engineering discipline, deterministic BLOCKED escalation and oscillation halt, then an Opus whole-branch final review. Replaces the model-driven superpowers post-plan suite.",
  "version": "0.1.0",
  "author": { "name": "Jason Matthew", "email": "jasonm4130@gmail.com" },
  "homepage": "https://github.com/jasonm4130/claude-skills",
  "repository": "https://github.com/jasonm4130/claude-skills",
  "license": "MIT",
  "keywords": ["subagent-driven-development", "sdd", "workflow", "tdd", "code-review", "ponytail", "model-tiering"]
}
```

- [ ] **Step 4: Append the marketplace entry** to the `plugins` array in `.claude-plugin/marketplace.json`:

```json
    {
      "name": "subagent-driven-development",
      "source": "./plugins/subagent-driven-development",
      "description": "Deterministic workflow-driven subagent development loop — plan/confirm in the controller, then a background Workflow enforces per-task implement/review/fix with tiered models and codified ponytail discipline.",
      "version": "0.1.0",
      "author": { "name": "Jason Matthew" },
      "license": "MIT",
      "keywords": ["subagent-driven-development", "sdd", "workflow", "code-review", "ponytail"],
      "category": "productivity"
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test plugins/subagent-driven-development/.claude-plugin/manifest.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add plugins/subagent-driven-development/.claude-plugin/ .claude-plugin/marketplace.json
git commit -m "feat(sdd): plugin manifest + marketplace registration"
```

---

### Task 2: Bash helper scripts (workspace, task-brief, review-package)

**Files:**
- Create: `plugins/subagent-driven-development/scripts/sdd-workspace`
- Create: `plugins/subagent-driven-development/scripts/task-brief`
- Create: `plugins/subagent-driven-development/scripts/review-package`
- Test: `plugins/subagent-driven-development/scripts/scripts.test.sh`

**Interfaces:**
- Produces: `sdd-workspace` prints the abs `.sdd` dir; `task-brief PLAN N` writes/echoes a brief file; `review-package BASE HEAD` writes/echoes a diff package file. Consumed by the workflow's agents.

- [ ] **Step 1: Write the failing smoke test**

```bash
#!/usr/bin/env bash
# plugins/subagent-driven-development/scripts/scripts.test.sh
set -euo pipefail
dir=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
git init -q && git config user.email t@t && git config user.name t

# sdd-workspace creates a self-ignoring workspace
ws=$("$dir/sdd-workspace")
[ -d "$ws" ] || { echo "FAIL: workspace dir missing"; exit 1; }
[ "$(cat "$ws/.gitignore")" = "*" ] || { echo "FAIL: gitignore not self-ignoring"; exit 1; }

# task-brief extracts a single Task block
printf '# Task 1\nalpha\n\n# Task 2\nbeta\n' > plan.md
out=$("$dir/task-brief" plan.md 2 | awk '{print $2}')
grep -q beta "$out" || { echo "FAIL: brief missing task 2 body"; exit 1; }
grep -q alpha "$out" && { echo "FAIL: brief leaked task 1"; exit 1; }

# review-package builds a 2-commit range package
echo a > f && git add f && git commit -qm a
base=$(git rev-parse HEAD)
echo b >> f && git commit -qam b
head=$(git rev-parse HEAD)
pkg=$("$dir/review-package" "$base" "$head" | sed 's/^wrote //; s/:.*//')
grep -q "## Diff" "$pkg" || { echo "FAIL: package missing diff section"; exit 1; }
echo "OK"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash plugins/subagent-driven-development/scripts/scripts.test.sh`
Expected: FAIL (sdd-workspace not found / not executable).

- [ ] **Step 3: Create `sdd-workspace`**

```bash
#!/usr/bin/env bash
# Resolve/ensure the working-tree dir for SDD short-lived artifacts: task
# briefs, implementer reports, review packages, progress ledger. Lives in the
# working tree (not .git/, which Claude Code protects from agent writes). A
# self-ignoring .gitignore keeps it out of git status and commits.
set -euo pipefail
root=$(git rev-parse --show-toplevel)
dir="$root/.sdd"
mkdir -p "$dir"
printf '*\n' > "$dir/.gitignore"
cd "$dir" && pwd
```

- [ ] **Step 4: Create `task-brief`**

```bash
#!/usr/bin/env bash
# Extract one task's full text from a plan into a file the implementer reads in
# one call, so the task text never passes through the controller's context.
# Usage: task-brief PLAN_FILE TASK_NUMBER [OUTFILE]
set -euo pipefail
if [ $# -lt 2 ] || [ $# -gt 3 ]; then
  echo "usage: task-brief PLAN_FILE TASK_NUMBER [OUTFILE]" >&2; exit 2
fi
plan=$1; n=$2
[ -f "$plan" ] || { echo "no such plan file: $plan" >&2; exit 2; }
if [ $# -eq 3 ]; then out=$3
else dir=$("$(cd "$(dirname "$0")" && pwd)/sdd-workspace"); out="$dir/task-${n}-brief.md"; fi
awk -v n="$n" '
  /^```/ { infence = !infence }
  !infence && /^#+[ \t]+Task[ \t]+[0-9]+/ {
    intask = ($0 ~ ("^#+[ \t]+Task[ \t]+" n "([^0-9]|$)"))
  }
  intask { print }
' "$plan" > "$out"
if [ ! -s "$out" ]; then
  echo "task ${n} not found in ${plan} (no heading matching 'Task ${n}')" >&2; exit 3
fi
echo "wrote ${out}: $(wc -l < "$out" | tr -d ' ') lines"
```

- [ ] **Step 5: Create `review-package`**

```bash
#!/usr/bin/env bash
# Generate a review package (commit list + stat summary + diff with extended
# context) to a file the reviewer reads in one call. Use the recorded per-task
# BASE (not HEAD~1, which silently drops all but the last commit).
# Usage: review-package BASE HEAD [OUTFILE]
set -euo pipefail
if [ $# -lt 2 ] || [ $# -gt 3 ]; then
  echo "usage: review-package BASE HEAD [OUTFILE]" >&2; exit 2
fi
base=$1; head=$2
git rev-parse --verify --quiet "$base" >/dev/null || { echo "bad BASE: $base" >&2; exit 2; }
git rev-parse --verify --quiet "$head" >/dev/null || { echo "bad HEAD: $head" >&2; exit 2; }
if [ $# -eq 3 ]; then out=$3
else dir=$("$(cd "$(dirname "$0")" && pwd)/sdd-workspace")
  out="$dir/review-$(git rev-parse --short "$base")..$(git rev-parse --short "$head").diff"; fi
{
  echo "# Review package: ${base}..${head}"; echo
  echo "## Commits"; git log --oneline "${base}..${head}"; echo
  echo "## Files changed"; git diff --stat "${base}..${head}"; echo
  echo "## Diff"; git diff -U10 "${base}..${head}"
} > "$out"
commits=$(git rev-list --count "${base}..${head}")
echo "wrote ${out}: ${commits} commit(s), $(wc -c < "$out" | tr -d ' ') bytes"
```

- [ ] **Step 6: Make scripts executable and run the smoke test**

Run:
```bash
chmod +x plugins/subagent-driven-development/scripts/sdd-workspace \
         plugins/subagent-driven-development/scripts/task-brief \
         plugins/subagent-driven-development/scripts/review-package
bash plugins/subagent-driven-development/scripts/scripts.test.sh
```
Expected: `OK`.

- [ ] **Step 7: Commit**

```bash
git add plugins/subagent-driven-development/scripts/
git commit -m "feat(sdd): bash helpers (sdd-workspace, task-brief, review-package)"
```

---

### Task 3: Workflow pure helpers (TDD)

**Files:**
- Create: `plugins/subagent-driven-development/workflows/sdd.mjs` (meta + PURE helper block only in this task)
- Test: `plugins/subagent-driven-development/workflows/sdd.test.mjs`

**Interfaces:**
- Produces (pure helpers, extracted between `// >>> PURE` / `// <<< PURE`): `validateArgs(input)`, `sequenceTasks(tasks)`, `nextTier(tier)`, `reviewerModel(taskTier)`, `maxAttemptsAtTier(tier, limits)`, `detectOscillation(roundClasses, cap?)`, `ledgerLine(n, base7, head7, verdict)`, and `const TIERS`.

- [ ] **Step 1: Write the failing tests**

```js
// plugins/subagent-driven-development/workflows/sdd.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Extract the PURE block from sdd.mjs and evaluate it (mirrors fanout.test.mjs).
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "sdd.mjs"), "utf8");
const pure = src.split("// >>> PURE")[1].split("// <<< PURE")[0];
const H = new Function(`${pure}; return { TIERS, validateArgs, sequenceTasks, nextTier, reviewerModel, maxAttemptsAtTier, detectOscillation, ledgerLine };`)();

const okArgs = () => ({
  planPath: "p.md", workdir: "/w", pluginDir: "/p", mergeBase: "abc",
  tasks: [{ n: 1, title: "a" }, { n: 2, title: "b", tier: "opus", deps: [1] }],
});

test("validateArgs accepts a valid object and defaults tiers/limits", () => {
  const c = H.validateArgs(okArgs());
  assert.equal(c.tasks[0].tier, "sonnet");
  assert.equal(c.tasks[1].tier, "opus");
  assert.deepEqual(c.limits, { fixRounds: 2, escalateAttempts: 2 });
});

test("validateArgs parses a JSON string", () => {
  const c = H.validateArgs(JSON.stringify(okArgs()));
  assert.equal(c.tasks.length, 2);
});

test("validateArgs rejects missing fields", () => {
  assert.throws(() => H.validateArgs({}), /planPath is required/);
  assert.throws(() => H.validateArgs({ planPath: "p", workdir: "w", pluginDir: "d", mergeBase: "m", tasks: [] }), /non-empty array/);
});

test("sequenceTasks sorts by n and rejects forward deps", () => {
  assert.deepEqual(H.sequenceTasks([{ n: 2, title: "b", deps: [1] }, { n: 1, title: "a", deps: [] }]).map((t) => t.n), [1, 2]);
  assert.throws(() => H.sequenceTasks([{ n: 1, title: "a", deps: [2] }, { n: 2, title: "b", deps: [] }]), /does not precede/);
});

test("nextTier walks haiku->sonnet->opus->null", () => {
  assert.equal(H.nextTier("haiku"), "sonnet");
  assert.equal(H.nextTier("sonnet"), "opus");
  assert.equal(H.nextTier("opus"), null);
});

test("reviewerModel bumps to opus only for opus tasks", () => {
  assert.equal(H.reviewerModel("haiku"), "sonnet");
  assert.equal(H.reviewerModel("sonnet"), "sonnet");
  assert.equal(H.reviewerModel("opus"), "opus");
});

test("maxAttemptsAtTier: opus gets the budget, others one", () => {
  assert.equal(H.maxAttemptsAtTier("sonnet", { escalateAttempts: 2 }), 1);
  assert.equal(H.maxAttemptsAtTier("opus", { escalateAttempts: 2 }), 2);
});

test("detectOscillation flags a class surviving two consecutive rounds", () => {
  assert.equal(H.detectOscillation([["x"]]), false);
  assert.equal(H.detectOscillation([["x"], ["y"]]), false);
  assert.equal(H.detectOscillation([["x"], ["x"]]), true);
  assert.equal(H.detectOscillation([["x"], ["y"], ["y"]]), true);
});

test("ledgerLine formats a stable record", () => {
  assert.equal(H.ledgerLine(3, "aaaaaaa", "bbbbbbb", "clean"), "Task 3: clean (commits aaaaaaa..bbbbbbb)");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.test.mjs`
Expected: FAIL (ENOENT on sdd.mjs).

- [ ] **Step 3: Create `sdd.mjs` with `meta` and the PURE block**

```js
// @ts-check
// Subagent-driven development loop. Self-contained Workflow script (sealed
// sandbox: no imports, no fs, no Date.now/Math.random; body wrapped in a fn).
// Pure helpers live between the PURE markers so sdd.test.mjs can extract them.
export const meta = {
  name: "subagent-driven-development",
  description:
    "Args-driven SDD loop: sequential per-task implement -> review (spec + quality + ponytail) -> bounded fix loop, with deterministic BLOCKED escalation and oscillation halt, then an Opus whole-branch final review. Returns task results + plan-conflicts + final review.",
  phases: [
    { title: "Implement", detail: "per-task implementer (tiered), TDD + ponytail ladder" },
    { title: "Review", detail: "spec + quality + over-engineering lens, bounded fix loop" },
    { title: "Final", detail: "whole-branch review on Opus", model: "opus" },
  ],
};

// >>> PURE
const TIERS = ["haiku", "sonnet", "opus"];

function validateArgs(input) {
  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch { throw new Error("args string is not valid JSON"); }
  }
  if (!input || typeof input !== "object") throw new Error("args must be an object");
  for (const k of ["planPath", "workdir", "pluginDir", "mergeBase"]) {
    if (typeof input[k] !== "string" || !input[k]) throw new Error(`args.${k} is required`);
  }
  if (!Array.isArray(input.tasks) || input.tasks.length === 0)
    throw new Error("args.tasks must be a non-empty array");
  const tasks = input.tasks.map((t, i) => {
    if (typeof t.n !== "number") throw new Error(`tasks[${i}].n must be a number`);
    if (typeof t.title !== "string" || !t.title) throw new Error(`tasks[${i}].title is required`);
    return {
      n: t.n,
      title: t.title,
      tier: TIERS.includes(t.tier) ? t.tier : "sonnet",
      deps: Array.isArray(t.deps) ? t.deps : [],
    };
  });
  const li = input.limits || {};
  const limits = {
    fixRounds: Number.isInteger(li.fixRounds) ? li.fixRounds : 2,
    escalateAttempts: Number.isInteger(li.escalateAttempts) ? li.escalateAttempts : 2,
  };
  return {
    planPath: input.planPath, workdir: input.workdir, pluginDir: input.pluginDir,
    globalConstraints: typeof input.globalConstraints === "string" ? input.globalConstraints : "",
    mergeBase: input.mergeBase, tasks, limits,
  };
}

function sequenceTasks(tasks) {
  const sorted = [...tasks].sort((a, b) => a.n - b.n);
  const seen = new Set();
  for (const t of sorted) {
    for (const d of t.deps) {
      if (!seen.has(d)) throw new Error(`task ${t.n} depends on ${d} which does not precede it`);
    }
    seen.add(t.n);
  }
  return sorted;
}

function nextTier(tier) {
  const i = TIERS.indexOf(tier);
  if (i < 0) return "sonnet";
  return i >= TIERS.length - 1 ? null : TIERS[i + 1];
}

function reviewerModel(taskTier) {
  return taskTier === "opus" ? "opus" : "sonnet";
}

function maxAttemptsAtTier(tier, limits) {
  return tier === "opus" ? Math.max(1, limits.escalateAttempts) : 1;
}

// roundClasses: array (one per review round) of arrays of finding-class strings.
// True if any class recurs across the most recent `cap` consecutive rounds.
function detectOscillation(roundClasses, cap = 2) {
  if (roundClasses.length < cap) return false;
  const recent = roundClasses.slice(-cap);
  const counts = new Map();
  for (const round of recent) for (const c of new Set(round)) counts.set(c, (counts.get(c) || 0) + 1);
  for (const v of counts.values()) if (v >= cap) return true;
  return false;
}

function ledgerLine(n, base7, head7, verdict) {
  return `Task ${n}: ${verdict} (commits ${base7}..${head7})`;
}
// <<< PURE
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.test.mjs`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/subagent-driven-development/workflows/sdd.mjs plugins/subagent-driven-development/workflows/sdd.test.mjs
git commit -m "feat(sdd): workflow pure helpers + unit tests"
```

---

### Task 4: Workflow orchestration body

**Files:**
- Modify: `plugins/subagent-driven-development/workflows/sdd.mjs` (append schemas + the `if (typeof phase === "function")` body after the PURE block)
- Test: `plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs`

**Interfaces:**
- Consumes: all pure helpers from Task 3.
- Produces: a runnable Workflow that returns `{ tasks, planConflicts, halted, finalReview, mergeBase, head, ledgerPath, meta }`. The body is guarded by `if (typeof phase === "function")` so importing the module for tests does not execute it.

- [ ] **Step 1: Write the failing structural test**

```js
// plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "sdd.mjs"), "utf8");

test("body is guarded so import does not execute it", () => {
  assert.match(src, /if \(typeof phase === "function"\)/);
});

test("every agent() call sets an explicit model", () => {
  const calls = src.match(/agent\([\s\S]*?\{[\s\S]*?\}\s*\)/g) || [];
  assert.ok(calls.length >= 4, "expected at least 4 agent() calls");
  for (const c of calls) assert.match(c, /model:/, `agent() without model: ${c.slice(0, 60)}`);
});

test("module imports cleanly (meta present, body inert without phase)", async () => {
  const mod = await import("./sdd.mjs");
  assert.equal(mod.meta.name, "subagent-driven-development");
  assert.equal(mod.meta.phases.length, 3);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs`
Expected: FAIL (guard / agent calls not present yet).

- [ ] **Step 3: Append schemas + orchestration body to `sdd.mjs`**

```js
const IMPL_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["status", "headSha", "testSummary", "concerns", "reportPath"],
  properties: {
    status: { type: "string", enum: ["DONE", "DONE_WITH_CONCERNS", "BLOCKED", "NEEDS_CONTEXT"] },
    headSha: { type: "string" }, testSummary: { type: "string" },
    concerns: { type: "string" }, reportPath: { type: "string" },
  },
};

const REVIEW_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["spec", "findings", "cannotVerify", "quality", "ponytail"],
  properties: {
    spec: { type: "string", enum: ["pass", "fail"] },
    findings: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["severity", "class", "file", "line", "what", "planMandated"],
        properties: {
          severity: { type: "string", enum: ["Critical", "Important", "Minor"] },
          class: { type: "string" }, file: { type: "string" }, line: { type: "string" },
          what: { type: "string" }, planMandated: { type: "boolean" },
        },
      },
    },
    cannotVerify: { type: "array", items: { type: "string" } },
    quality: { type: "string" },
    ponytail: {
      type: "object", additionalProperties: false,
      required: ["net", "items"],
      properties: { net: { type: "number" }, items: { type: "array", items: { type: "string" } } },
    },
  },
};

const FIX_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["headSha", "testSummary", "fixed"],
  properties: {
    headSha: { type: "string" }, testSummary: { type: "string" },
    fixed: { type: "array", items: { type: "string" } },
  },
};

const FINAL_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["verdict", "findings", "ponytailDebt"],
  properties: {
    verdict: { type: "string", enum: ["approve", "changes"] },
    findings: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["severity", "file", "line", "what"],
        properties: {
          severity: { type: "string", enum: ["Critical", "Important", "Minor"] },
          file: { type: "string" }, line: { type: "string" }, what: { type: "string" },
        },
      },
    },
    ponytailDebt: { type: "array", items: { type: "string" } },
  },
};

if (typeof phase === "function") {
  const cfg = validateArgs(args);
  const order = sequenceTasks(cfg.tasks);
  const P = cfg.pluginDir;
  const gc = cfg.globalConstraints || "(none stated)";

  const implPrompt = (task, tier, blocker) =>
    `You are implementing Task ${task.n} ("${task.title}") of an approved plan. Work in ${cfg.workdir}.
Read your full operating instructions first: ${P}/prompts/implementer.md — follow them exactly.
Get your task brief by running: ${P}/scripts/task-brief ${cfg.planPath} ${task.n}
Read the brief file it prints; implement THAT task only.
Global constraints that bind this task:\n${gc}
Write your full report to ${cfg.workdir}/.sdd/task-${task.n}-report.md.${
      blocker ? `\nPRIOR ATTEMPT WAS BLOCKED: ${blocker}\nA ${tier} model is now assigned — resolve the blocker or report BLOCKED again with specifics.` : ""
    }
Return per schema: status, headSha (run \`git rev-parse HEAD\` after committing), testSummary, concerns, reportPath.`;

  const reviewPrompt = (task, base, head) =>
    `You are reviewing Task ${task.n} ("${task.title}"). Work in ${cfg.workdir}; READ-ONLY on the tree.
Read your full operating instructions first: ${P}/prompts/reviewer.md — follow them exactly.
Build the diff: ${P}/scripts/review-package ${base} ${head}
Read the package file it prints. The implementer's report is at ${cfg.workdir}/.sdd/task-${task.n}-report.md (treat as unverified claims).
Global constraints that bind this task:\n${gc}
Return per schema: spec ("pass"/"fail"), findings[{severity,class,file,line,what,planMandated}], cannotVerify[], quality, ponytail{net,items}.
Set planMandated=true for any finding the plan/brief explicitly mandates. "class" is a short stable label for the finding kind (used to detect oscillation).`;

  const fixPrompt = (task, findings) =>
    `You are fixing review findings on Task ${task.n} ("${task.title}"). Work in ${cfg.workdir}.
Read your full operating instructions first: ${P}/prompts/fixer.md — follow them exactly.
Fix ALL of these findings in one commit:\n${JSON.stringify(findings, null, 2)}
Re-run the tests covering each change; append the results to ${cfg.workdir}/.sdd/task-${task.n}-report.md.
Return per schema: headSha (after committing), testSummary, fixed[].`;

  const finalPrompt = (mergeBase, head) =>
    `You are the whole-branch FINAL reviewer (most capable model). Work in ${cfg.workdir}; READ-ONLY.
Read your full operating instructions first: ${P}/prompts/final-reviewer.md — follow them exactly.
Build the branch diff: ${P}/scripts/review-package ${mergeBase} ${head}
Read the package. Also list any new \`ponytail:\` markers (grep the diff for 'ponytail:').
Global constraints:\n${gc}
Return per schema: verdict ("approve"/"changes"), findings[{severity,file,line,what}], ponytailDebt[].`;

  const finalFixPrompt = (findings) =>
    `Fix ALL of these whole-branch review findings in one commit, in ${cfg.workdir}. Read ${P}/prompts/fixer.md and follow it.
Findings:\n${JSON.stringify(findings, null, 2)}
Re-run covering tests; return per schema: headSha, testSummary, fixed[].`;

  const results = [];
  const planConflicts = [];
  let halted = null;

  async function runTask(task, base) {
    // Implement with the BLOCKED escalation ladder.
    let tier = task.tier, opusAttempts = 0, blocker = null, impl = null;
    while (true) {
      impl = await agent(implPrompt(task, tier, blocker), {
        label: `impl:t${task.n}`, phase: "Implement", model: tier, schema: IMPL_SCHEMA,
      });
      if (!impl) return { halt: { taskN: task.n, reason: "implementer returned no result", reportPath: "" } };
      if (impl.status === "DONE" || impl.status === "DONE_WITH_CONCERNS") break;
      blocker = impl.concerns || impl.status;
      if (tier !== "opus") { tier = nextTier(tier); continue; }
      opusAttempts++;
      if (opusAttempts < maxAttemptsAtTier("opus", cfg.limits)) continue;
      return { halt: { taskN: task.n, reason: `blocked after escalation: ${blocker}`, reportPath: impl.reportPath } };
    }

    // Review + bounded fix loop.
    let head = impl.headSha, rounds = 0, review = null;
    const roundClasses = [];
    while (true) {
      review = await agent(reviewPrompt(task, base, head), {
        label: `review:t${task.n}`, phase: "Review", model: reviewerModel(task.tier), schema: REVIEW_SCHEMA,
      });
      if (!review) return { halt: { taskN: task.n, reason: "reviewer returned no result", reportPath: impl.reportPath } };
      (review.findings || []).filter((f) => f.planMandated).forEach((c) => planConflicts.push({ taskN: task.n, ...c }));
      const actionable = (review.findings || []).filter((f) => !f.planMandated && (f.severity === "Critical" || f.severity === "Important"));
      roundClasses.push(actionable.map((f) => f.class));
      if (review.spec === "pass" && actionable.length === 0) break;
      if (rounds >= cfg.limits.fixRounds || detectOscillation(roundClasses)) {
        return { halt: { taskN: task.n, reason: "review did not converge (cap or oscillation)", reportPath: impl.reportPath } };
      }
      rounds++;
      const fix = await agent(fixPrompt(task, actionable), {
        label: `fix:t${task.n}.${rounds}`, phase: "Review", model: "sonnet", schema: FIX_SCHEMA,
      });
      if (!fix) return { halt: { taskN: task.n, reason: "fixer returned no result", reportPath: impl.reportPath } };
      head = fix.headSha || head;
    }
    return { task: { n: task.n, status: impl.status, headSha: head, reviewVerdict: review.spec, fixRounds: rounds } };
  }

  phase("Implement");
  let base = cfg.mergeBase;
  for (const task of order) {
    const r = await runTask(task, base);
    if (r.halt) { halted = r.halt; break; }
    results.push(r.task);
    base = r.task.headSha;
  }

  let finalReview = null;
  if (!halted && results.length) {
    phase("Final");
    finalReview = await agent(finalPrompt(cfg.mergeBase, base), {
      label: "final-review", phase: "Final", model: "opus", schema: FINAL_SCHEMA,
    });
    if (finalReview && (finalReview.findings || []).length) {
      await agent(finalFixPrompt(finalReview.findings), {
        label: "final-fix", phase: "Final", model: "sonnet", schema: FIX_SCHEMA,
      });
    }
  }

  log(halted ? `Halted at task ${halted.taskN}: ${halted.reason}` : `Completed ${results.length}/${order.length} tasks`);
  return {
    tasks: results, planConflicts, halted, finalReview,
    mergeBase: cfg.mergeBase, head: base, ledgerPath: `${cfg.workdir}/.sdd/progress.md`,
    meta: { tasksCompleted: results.length, tasksTotal: order.length, planConflicts: planConflicts.length },
  };
}
```

- [ ] **Step 4: Run the structural test + the pure-helper test**

Run:
```bash
node --test plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs
node --test plugins/subagent-driven-development/workflows/sdd.test.mjs
```
Expected: both PASS (smoke: 3 tests; pure: 9 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/subagent-driven-development/workflows/sdd.mjs plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs
git commit -m "feat(sdd): workflow orchestration body (loop, escalation, final review)"
```

---

### Task 5: Prompt templates

**Files:**
- Create: `plugins/subagent-driven-development/prompts/implementer.md`
- Create: `plugins/subagent-driven-development/prompts/reviewer.md`
- Create: `plugins/subagent-driven-development/prompts/fixer.md`
- Create: `plugins/subagent-driven-development/prompts/final-reviewer.md`
- Test: `plugins/subagent-driven-development/prompts/prompts.test.mjs`

**Interfaces:**
- Consumes: nothing (read by the agents the workflow dispatches). Each file is the full role instruction; the workflow's inline control prompt points the agent here and supplies task-specific paths/values.

Each prompt's required content is specified below. Write the final prose to satisfy these requirements (verbatim where quoted). The test asserts the load-bearing markers are present.

- [ ] **Step 1: Write the failing test**

```js
// plugins/subagent-driven-development/prompts/prompts.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, f), "utf8");
const COUNTER = /security[\s\S]*validation[\s\S]*error handling[\s\S]*accessibility[\s\S]*observability/i;

test("implementer prompt has ladder, counter-boundary, ponytail marker, TDD, report contract", () => {
  const s = read("implementer.md");
  assert.match(s, /ladder/i);
  assert.match(s, /two concrete uses/i);
  assert.match(s, /ponytail: <ceiling>, <upgrade>/);
  assert.match(s, /RED[\s\S]*GREEN/);
  assert.match(s, COUNTER);
  assert.match(s, /DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT/);
});

test("reviewer prompt has three verdicts, the over-engineering tags, net score, and the boundary", () => {
  const s = read("reviewer.md");
  assert.match(s, /spec compliance/i);
  assert.match(s, /code quality/i);
  assert.match(s, /delete[\s\S]*stdlib[\s\S]*native[\s\S]*yagni[\s\S]*shrink/);
  assert.match(s, /net .?N/i);
  assert.match(s, /do not flag[\s\S]*ponytail:/i);
  assert.match(s, /planMandated/);
  assert.match(s, COUNTER);
});

test("fixer prompt forbids scope creep and requires test re-run evidence", () => {
  const s = read("fixer.md");
  assert.match(s, /only the listed findings|do not.*beyond/i);
  assert.match(s, /re-run|covering test/i);
});

test("final reviewer prompt is whole-branch and harvests ponytail debt", () => {
  const s = read("final-reviewer.md");
  assert.match(s, /whole-branch|entire branch/i);
  assert.match(s, /ponytail:/);
  assert.match(s, /approve|changes/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test plugins/subagent-driven-development/prompts/prompts.test.mjs`
Expected: FAIL (ENOENT).

- [ ] **Step 3: Write `implementer.md`** — required content:
  - Role: implement exactly one task from the brief; nothing more.
  - **The ponytail ladder** (pre-write discipline, the 7 rungs): does it need to exist (YAGNI) → reuse what's already in the codebase → stdlib → native platform feature → already-installed dependency → one line → only then minimal code that works. State "climb the ladder after you understand the change, not instead of it."
  - **Simplicity directive:** "Write the minimum that satisfies the brief. No abstraction, mode flag, interface, or strategy object without **two concrete uses in this change**."
  - **`ponytail: <ceiling>, <upgrade>` markers** for deliberate shortcuts (name the ceiling and the upgrade trigger).
  - **One runnable check** behind non-trivial logic (assert-based self-check or one small test); trivial one-liners need none.
  - **TDD:** RED (write failing test, run it, show the failure) → GREEN (implement minimal, run, show pass). Run focused tests while iterating; the full suite once before committing.
  - **Counter-boundary (verbatim):** "Never minimize away security, input validation, error handling, accessibility, or observability. The rule is: we know we need this → build it; we might need it someday → don't."
  - Escalation: it is OK to stop. Report `BLOCKED` / `NEEDS_CONTEXT` with specifics rather than guessing.
  - Self-review before reporting (completeness, did-I-overbuild, tests verify behavior).
  - **Report contract:** write the full report to the given path; return only `status` (DONE/DONE_WITH_CONCERNS/BLOCKED/NEEDS_CONTEXT), `headSha`, `testSummary`, `concerns`, `reportPath`.

- [ ] **Step 4: Write `reviewer.md`** — required content:
  - Role: task-scoped gate (not a merge review); read the diff package once; do not crawl the codebase.
  - **Do not trust the report** — verify claims against the diff; a stated rationale never downgrades severity.
  - **Verdict 1 — spec compliance:** Missing / Extra / Misunderstood (Extra = over-engineering / unrequested). Output `spec: pass|fail`.
  - **Verdict 2 — code quality:** separation, error handling, DRY-without-premature-abstraction, edge cases, tests verify real behavior, file responsibility.
  - **Verdict 3 — ponytail over-engineering lens:** one line per finding using the tags `delete / stdlib / native / yagni / shrink`; end with `net −N lines possible` (or "Lean already").
  - **Bounded:** "do not flag the one smoke test, a `ponytail:`-marked deliberate shortcut, or genuinely-needed robustness." Plus the **counter-boundary (verbatim, as in implementer.md)**.
  - Severity calibration (Critical/Important/Minor); set `planMandated=true` when the plan/brief mandates the flagged thing; give each finding a short stable `class` label (for oscillation detection) and `file:line`.
  - Tests: do not re-run the suite the implementer already ran; one focused check only on a specific doubt.

- [ ] **Step 5: Write `fixer.md`** — required content:
  - Role: fix exactly the listed findings in one commit; **do not fix anything beyond the listed findings** (no scope creep, no opportunistic refactor).
  - Re-run the tests covering each change; append the command + output to the report file.
  - Respect the same ponytail ladder + counter-boundary as the implementer.
  - Return `headSha`, `testSummary`, `fixed[]`.

- [ ] **Step 6: Write `final-reviewer.md`** — required content:
  - Role: **whole-branch** review on the most capable model; read the branch diff package once.
  - Cross-cutting concerns are legitimate (lock ordering, shared contracts, API changes — check call sites).
  - Triage Minor findings rolled up from per-task reviews; decide `verdict: approve|changes`.
  - **Harvest `ponytail:` debt:** list every `ponytail:` marker introduced on the branch into `ponytailDebt[]` (ceiling + upgrade), flagging any with no upgrade trigger.
  - Return `verdict`, `findings[{severity,file,line,what}]`, `ponytailDebt[]`.

- [ ] **Step 7: Run the test to verify it passes**

Run: `node --test plugins/subagent-driven-development/prompts/prompts.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 8: Commit**

```bash
git add plugins/subagent-driven-development/prompts/
git commit -m "feat(sdd): implementer/reviewer/fixer/final-reviewer prompt templates"
```

---

### Task 6: Controller SKILL.md

**Files:**
- Create: `plugins/subagent-driven-development/skills/subagent-driven-development/SKILL.md`
- Test: `plugins/subagent-driven-development/skills/subagent-driven-development/skill.test.mjs`

**Interfaces:**
- Consumes: the workflow (`workflows/sdd.mjs`), prompts, and scripts via resolved absolute paths.
- Produces: the controller-facing entry point users invoke.

- [ ] **Step 1: Write the failing test**

```js
// plugins/subagent-driven-development/skills/subagent-driven-development/skill.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const s = readFileSync(join(here, "SKILL.md"), "utf8");

test("frontmatter has name and a trigger-rich description", () => {
  assert.match(s, /^---\nname: subagent-driven-development\n/);
  assert.match(s, /description:.*plan/i);
});

test("documents the controller flow and the hand-off contract", () => {
  assert.match(s, /pre-flight|conflict scan/i);
  assert.match(s, /worktree/i);
  assert.match(s, /go-ahead|wait for.*go/i);
  assert.match(s, /Workflow\(/);
  assert.match(s, /pluginDir/);
  assert.match(s, /finishing|merge\/PR/i);
});

test("warns about path resolution and the plan-heading dependency", () => {
  assert.match(s, /sort -V \| tail -1|glob/i);
  assert.match(s, /# Task N|## Task/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test plugins/subagent-driven-development/skills/subagent-driven-development/skill.test.mjs`
Expected: FAIL (ENOENT).

- [ ] **Step 3: Write `SKILL.md`** — required content:
  - **Frontmatter:** `name: subagent-driven-development`; `description:` triggering on "execute this plan / implement the plan / run the plan / subagent-driven development" once a written plan exists.
  - **When to use / not:** a written plan with `# Task N` headings and test coverage exists; not for ambiguous/brownfield (Verschlimmbesserung caution — recommend smaller tasks or manual).
  - **Controller process (numbered):**
    1. Read the plan; note Global Constraints verbatim.
    2. **Pre-flight conflict scan** — batch all conflicts into one question; if clean, proceed.
    3. **Ensure an isolated worktree** (never main/master without explicit consent) — inline git worktree steps (self-contained; do not call disabled skills).
    4. **Enumerate tasks** `{ n, title, tier, deps }`; assign tier via complexity signals (1–2 files w/ complete spec → cheap; multi-file integration → sonnet; design judgment → opus); Sonnet floor.
    5. **Show conflicts + task list + tiers; wait for explicit "go".**
    6. **Resolve install paths** by globbing the plugin cache (CLAUDE_PLUGIN_ROOT unavailable):
       ```bash
       ls -d "$HOME"/.claude/plugins/cache/jasonm4130-claude-skills/subagent-driven-development/*/workflows/sdd.mjs | sort -V | tail -1
       ```
       In local dev use `plugins/subagent-driven-development/...` directly. `pluginDir` is the dir containing `workflows/`, `prompts/`, `scripts/`.
    7. **Invoke** `Workflow({ scriptPath: "<sdd.mjs>", args: { planPath, workdir, pluginDir, globalConstraints, mergeBase, tasks, limits } })`. `mergeBase` = `git merge-base main HEAD`.
    8. **On return:** present `finalReview` + `planConflicts` (human adjudicates) + any `halted` state (resume via `runId` after fixing). Then drive **finishing** — merge/PR/cleanup, human-gated (irreversible).
  - **Model tiering table** (implementer/reviewer/fixer/final).
  - **Red flags:** never start on main without consent; never auto-merge; never paste task text into args; every agent gets an explicit model.
  - **Dependencies:** plan headings; `workflow-model-guard` compatibility; the nine superpowers skills stay disabled.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test plugins/subagent-driven-development/skills/subagent-driven-development/skill.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/subagent-driven-development/skills/
git commit -m "feat(sdd): controller SKILL.md"
```

---

### Task 7: README + full validation

**Files:**
- Create: `plugins/subagent-driven-development/README.md`

**Interfaces:**
- Produces: human-facing docs; final green test bar.

- [ ] **Step 1: Write `README.md`** — what it is (deterministic, workflow-driven SDD replacing the disabled superpowers post-plan suite), the controller↔workflow split, the args/return contract, model tiering, ponytail integration + counter-boundary, the BLOCKED/oscillation rules, and a one-paragraph "how to run" (invoke the skill on a written plan). Link the spec and research docs.

- [ ] **Step 2: Run the full test bar**

Run:
```bash
node --test plugins/subagent-driven-development/**/*.test.mjs
bash plugins/subagent-driven-development/scripts/scripts.test.sh
```
Expected: all node tests PASS (manifest 2, pure 9, smoke 3, prompts 4, skill 3 = 21) and `OK` from the bash smoke.

- [ ] **Step 3: Validate the plugin loads** (best-effort in this environment)

Run: `node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/marketplace.json')); console.log('marketplace OK')"`
Expected: `marketplace OK`. If a Claude Code plugin-validate command is available, run it; otherwise note it as a manual check.

- [ ] **Step 4: Commit**

```bash
git add plugins/subagent-driven-development/README.md
git commit -m "docs(sdd): plugin README + validation"
```

---

## Self-Review

**Spec coverage:** every spec section maps to a task — manifest/marketplace (T1), scripts (T2), pure helpers (T3), orchestration body incl. escalation/oscillation/HITL-return (T4), ponytail-bounded prompts (T5), controller flow incl. pre-flight/worktree/tiering/finishing (T6), README + validation (T7). The spec's `templateDir` is refined to `pluginDir` (one resolved root for `prompts/` + `scripts/`); the `args` contract is updated consistently in T4 and T6.

**Placeholder scan:** no "TBD"/"add error handling"/"similar to Task N". Prose files (T5/T6) specify exact required content + verbatim quotes and are gated by structural tests rather than full verbatim duplication (they are prose, not code, and the controller authors final wording at execution).

**Type consistency:** helper names match across tasks (`validateArgs`, `sequenceTasks`, `nextTier`, `reviewerModel`, `maxAttemptsAtTier`, `detectOscillation`, `ledgerLine`); schema field names (`status`, `headSha`, `spec`, `findings[].class`, `planMandated`, `verdict`, `ponytailDebt`) are used identically in the body and the prompt control strings; `pluginDir` is consistent in T4 and T6.
