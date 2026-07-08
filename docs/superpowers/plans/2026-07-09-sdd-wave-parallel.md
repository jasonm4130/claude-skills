# SDD Wave-Parallel Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deps-driven strict-wave scheduling in `sdd.mjs` — independent tasks run their implement → review → fix loops concurrently in per-task git worktrees, with a bounded-auto-repair merge gate per wave; sequential stays the zero-overhead degenerate case.

**Architecture:** A pure `computeWaves` helper turns `tasks[].deps` into topological levels. The orchestration loop iterates waves: singleton waves run exactly as today in the shared workdir; multi-task waves run each task in a sibling worktree (`<workdir>-t<N>`, branch `sdd/t<N>`) via a concurrency-capped pool, then one sonnet merge agent integrates branches in numeric order and runs the suite. Every prompt is a function of plan + args only (never completion order), preserving `resumeFromRunId` caching.

**Tech Stack:** Workflow-sandbox JavaScript (no imports/fs/Date.now/Math.random), bash scripts, `node --test`, prompt markdown.

**Spec:** `docs/superpowers/specs/2026-07-09-sdd-wave-parallel-design.md` — binding for all behavior.

## Global Constraints

- `sdd.mjs` is a sealed Workflow script: no imports, no filesystem, no `Date.now()`/`Math.random()`/argless `new Date()`. All git/file work happens inside agents via bash scripts.
- Pure helpers live between `// >>> PURE` and `// <<< PURE` markers in `sdd.mjs`; `sdd.test.mjs` extracts and evaluates that block with `new Function`. Any new helper must be added to the extractor's return list.
- Every `agent()` call sets an explicit `model:` (the `workflow-model-guard` hook rejects otherwise). The merge agent is `model: "sonnet"`.
- Prompts must be deterministic functions of plan + args (never of agent completion order).
- Bash scripts: `set -euo pipefail`, print exactly one artifact path on stdout as their contract.
- Test runners: `node --test <file>` for `.mjs`; `bash plugins/subagent-driven-development/scripts/scripts.test.sh` for scripts.
- Worktree naming is fixed: task N's worktree is `<workdir>-t<N>` (trailing slashes stripped), branch `sdd/t<N>`.
- `limits.maxParallel` default 4, integer ≥ 1 (invalid values fall back to 4, matching `fixRounds` style).
- New `halted` shape: `null | { wave, reason, failures: [{ taskN, reason, reportPath }] }`. New return field: `merges: [{ wave, merged, headSha, testSummary }]`.
- Plugin version bumps to `0.2.0` in this change.

---

### Task 1: Pure scheduling helpers

**Files:**
- Modify: `plugins/subagent-driven-development/workflows/sdd.mjs` (PURE block only, lines between `// >>> PURE` and `// <<< PURE`)
- Test: `plugins/subagent-driven-development/workflows/sdd.test.mjs`

**Interfaces:**
- Consumes: existing `sequenceTasks(tasks)` (already in the PURE block).
- Produces (Task 4 relies on these exact signatures):
  - `computeWaves(tasks) -> Task[][]` — index = wave number; validates via `sequenceTasks` internally.
  - `taskWorkdir(workdir, n) -> string` — `"<workdir>-t<n>"`, trailing slashes stripped.
  - `runPool(items, limit, fn) -> Promise<any[]>` — order-preserving; a thrown error becomes `{ poolError: string }` in that slot; never rejects.
  - `partitionWaveResults(wave, results) -> { succeeded: task[], failures: [{taskN, reason, reportPath}] }` — `succeeded` holds the `r.task` objects.
  - `validateArgs` additions: `cfg.limits.maxParallel` (default 4), `cfg.setupCmd` (default `""`), `cfg.testCmd` (default `""`).

- [ ] **Step 1: Write the failing tests**

In `plugins/subagent-driven-development/workflows/sdd.test.mjs`:

Update the extractor (line 11–13) to expose the new helpers:

```js
const H = new Function(
  `${pure}; return { TIERS, validateArgs, sequenceTasks, nextTier, reviewerModel, maxAttemptsAtTier, detectOscillation, ledgerLine, computeWaves, taskWorkdir, runPool, partitionWaveResults };`,
)();
```

Update the existing limits assertion (line 24) to include the new default:

```js
  assert.deepEqual(c.limits, { fixRounds: 2, escalateAttempts: 2, maxParallel: 4 });
```

Append these tests at the end of the file:

```js
test("validateArgs defaults maxParallel/setupCmd/testCmd and accepts overrides", () => {
  const c = H.validateArgs(okArgs());
  assert.equal(c.limits.maxParallel, 4);
  assert.equal(c.setupCmd, "");
  assert.equal(c.testCmd, "");
  const c2 = H.validateArgs({
    ...okArgs(), setupCmd: "npm ci", testCmd: "npx vitest run", limits: { maxParallel: 2 },
  });
  assert.equal(c2.limits.maxParallel, 2);
  assert.equal(c2.setupCmd, "npm ci");
  assert.equal(c2.testCmd, "npx vitest run");
});

test("validateArgs falls back to maxParallel 4 on invalid values", () => {
  assert.equal(H.validateArgs({ ...okArgs(), limits: { maxParallel: 0 } }).limits.maxParallel, 4);
  assert.equal(H.validateArgs({ ...okArgs(), limits: { maxParallel: 2.5 } }).limits.maxParallel, 4);
});

test("computeWaves groups independent tasks and respects deps (diamond)", () => {
  const waves = H.computeWaves([
    { n: 1, title: "a", deps: [] },
    { n: 2, title: "b", deps: [] },
    { n: 3, title: "c", deps: [1, 2] },
    { n: 4, title: "d", deps: [1] },
    { n: 5, title: "e", deps: [3, 4] },
  ]);
  assert.deepEqual(waves.map((w) => w.map((t) => t.n)), [[1, 2], [3, 4], [5]]);
});

test("computeWaves on a linear plan yields singleton waves", () => {
  const waves = H.computeWaves([
    { n: 1, title: "a", deps: [] },
    { n: 2, title: "b", deps: [1] },
    { n: 3, title: "c", deps: [2] },
  ]);
  assert.deepEqual(waves.map((w) => w.map((t) => t.n)), [[1], [2], [3]]);
});

test("taskWorkdir builds the sibling path and strips trailing slashes", () => {
  assert.equal(H.taskWorkdir("/w/repo", 3), "/w/repo-t3");
  assert.equal(H.taskWorkdir("/w/repo/", 3), "/w/repo-t3");
});

test("runPool caps concurrency and preserves order", async () => {
  let inFlight = 0, peak = 0;
  const out = await H.runPool([1, 2, 3, 4, 5], 2, async (x) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setImmediate(r));
    inFlight--;
    return x * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50]);
  assert.ok(peak <= 2, `peak was ${peak}`);
});

test("runPool converts a thrown error into poolError and keeps siblings running", async () => {
  const out = await H.runPool([1, 2, 3], 2, async (x) => {
    if (x === 2) throw new Error("boom");
    return x;
  });
  assert.equal(out[0], 1);
  assert.equal(out[1].poolError, "boom");
  assert.equal(out[2], 3);
});

test("partitionWaveResults splits successes, halts, and pool errors", () => {
  const wave = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }];
  const { succeeded, failures } = H.partitionWaveResults(wave, [
    { task: { n: 1, status: "DONE", headSha: "aaa" } },
    { halt: { taskN: 2, reason: "blocked after escalation: x", reportPath: "/w-t2/.sdd/task-2-report.md" } },
    { poolError: "boom" },
    null,
  ]);
  assert.deepEqual(succeeded.map((t) => t.n), [1]);
  assert.deepEqual(failures.map((f) => [f.taskN, f.reason]), [
    [2, "blocked after escalation: x"],
    [3, "boom"],
    [4, "task agent returned no result"],
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.test.mjs`
Expected: FAIL — `computeWaves is not defined` (from the extractor return list) and the limits deepEqual mismatch.

- [ ] **Step 3: Implement the helpers**

In `plugins/subagent-driven-development/workflows/sdd.mjs`, inside the PURE block:

Replace the `limits` construction in `validateArgs` (currently the `const limits = {...}` block) with:

```js
  const limits = {
    fixRounds: Number.isInteger(li.fixRounds) ? li.fixRounds : 2,
    escalateAttempts: Number.isInteger(li.escalateAttempts) ? li.escalateAttempts : 2,
    maxParallel: Number.isInteger(li.maxParallel) && li.maxParallel >= 1 ? li.maxParallel : 4,
  };
```

Add `setupCmd`/`testCmd` to `validateArgs`'s return object (alongside `globalConstraints`):

```js
    setupCmd: typeof input.setupCmd === "string" ? input.setupCmd : "",
    testCmd: typeof input.testCmd === "string" ? input.testCmd : "",
```

Add these helpers before `// <<< PURE`:

```js
// Topological levels from deps: wave 0 = no deps, else 1 + max(dep waves).
// sequenceTasks validates deps precede numerically, which guarantees a DAG.
function computeWaves(tasks) {
  const sorted = sequenceTasks(tasks);
  const waveOf = new Map();
  const waves = [];
  for (const t of sorted) {
    const w = t.deps.length ? 1 + Math.max(...t.deps.map((d) => waveOf.get(d))) : 0;
    waveOf.set(t.n, w);
    if (!waves[w]) waves[w] = [];
    waves[w].push(t);
  }
  return waves;
}

// Deterministic sibling-worktree path for task n (matches scripts/sdd-worktree).
function taskWorkdir(workdir, n) {
  return `${workdir.replace(/\/+$/, "")}-t${n}`;
}

// Run fn over items with at most `limit` in flight. Order-preserving; a
// thrown error becomes { poolError } in that slot so siblings always finish.
async function runPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        results[i] = { poolError: String((e && e.message) || e) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

// Split a wave's runTask results into merge candidates and failure entries.
function partitionWaveResults(wave, results) {
  const succeeded = [];
  const failures = [];
  wave.forEach((task, i) => {
    const r = results[i];
    if (r && r.task) succeeded.push(r.task);
    else if (r && r.halt) failures.push(r.halt);
    else failures.push({
      taskN: task.n,
      reason: (r && r.poolError) || "task agent returned no result",
      reportPath: "",
    });
  });
  return { succeeded, failures };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.test.mjs`
Expected: PASS — all tests including the pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add plugins/subagent-driven-development/workflows/sdd.mjs plugins/subagent-driven-development/workflows/sdd.test.mjs
git commit -m "sdd: pure wave-scheduling helpers (computeWaves, runPool, partitionWaveResults)"
```

---

### Task 2: sdd-worktree script

**Files:**
- Create: `plugins/subagent-driven-development/scripts/sdd-worktree`
- Test: `plugins/subagent-driven-development/scripts/scripts.test.sh`

**Interfaces:**
- Produces (Task 4's implementer prompt invokes this): `sdd-worktree <workdir> <baseSha> <n>` — ensures worktree `<workdir>-t<n>` on branch `sdd/t<n>` at/descended-from `<baseSha>`; prints the worktree path as its only stdout line. Reuse iff existing tip descends from base; stale → remove and recreate; branch-without-worktree → re-add from branch.

- [ ] **Step 1: Write the failing tests**

In `plugins/subagent-driven-development/scripts/scripts.test.sh`, worktrees are siblings of the repo, so the repo must live one level below `$tmp` for the EXIT trap to clean them. Replace the line `cd "$tmp"` with:

```bash
mkdir "$tmp/repo" && cd "$tmp/repo"
```

Append before the final `echo "OK"`:

```bash
# sdd-worktree: fresh create on the sdd/tN branch
repo=$(pwd)
base=$(git rev-parse HEAD)
wt=$("$dir/sdd-worktree" "$repo" "$base" 7)
[ "$wt" = "${repo}-t7" ] || { echo "FAIL: unexpected worktree path: $wt"; exit 1; }
[ -d "$wt" ] || { echo "FAIL: worktree missing"; exit 1; }
[ "$(git -C "$wt" rev-parse --abbrev-ref HEAD)" = "sdd/t7" ] || { echo "FAIL: wrong branch"; exit 1; }
[ "$(git -C "$wt" rev-parse HEAD)" = "$base" ] || { echo "FAIL: not at base"; exit 1; }

# sdd-worktree: reuse when the tip descends from base (escalation re-entry)
echo x > "$wt/x" && git -C "$wt" add x && git -C "$wt" commit -qm x
tip=$(git -C "$wt" rev-parse HEAD)
wt2=$("$dir/sdd-worktree" "$repo" "$base" 7)
[ "$(git -C "$wt2" rev-parse HEAD)" = "$tip" ] || { echo "FAIL: reuse lost commits"; exit 1; }

# sdd-worktree: stale worktree (tip does not descend from new base) is recreated
echo c >> f && git commit -qam c
nb=$(git rev-parse HEAD)
wt3=$("$dir/sdd-worktree" "$repo" "$nb" 7)
[ "$(git -C "$wt3" rev-parse HEAD)" = "$nb" ] || { echo "FAIL: stale worktree not recreated"; exit 1; }

# sdd-worktree: branch survives worktree removal -> re-added from the branch
git worktree remove --force "$wt3"
wt4=$("$dir/sdd-worktree" "$repo" "$nb" 7)
[ "$(git -C "$wt4" rev-parse HEAD)" = "$nb" ] || { echo "FAIL: branch-only re-add failed"; exit 1; }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bash plugins/subagent-driven-development/scripts/scripts.test.sh`
Expected: FAIL — `sdd-worktree: No such file or directory` (existing assertions still pass first).

- [ ] **Step 3: Write the script**

Create `plugins/subagent-driven-development/scripts/sdd-worktree`:

```bash
#!/usr/bin/env bash
# Ensure the sibling worktree for one SDD task: <workdir>-t<N> on branch
# sdd/t<N> starting at <baseSha>. Reuse iff the existing tip descends from
# base (same-run escalation re-entry / resume); anything else is stale debris
# from an older run and is removed and recreated. Prints the worktree path.
set -euo pipefail
workdir=$1; base=$2; n=$3
path="${workdir%/}-t${n}"
branch="sdd/t${n}"
cd "$workdir"

if git worktree list --porcelain | grep -qxF "worktree $path"; then
  tip=$(git -C "$path" rev-parse HEAD)
  if git merge-base --is-ancestor "$base" "$tip"; then
    echo "$path"; exit 0
  fi
  git worktree remove --force "$path"
fi

if git show-ref --verify --quiet "refs/heads/$branch"; then
  if git merge-base --is-ancestor "$base" "$branch"; then
    git worktree add "$path" "$branch" >/dev/null
  else
    git branch -D "$branch" >/dev/null
    git worktree add -b "$branch" "$path" "$base" >/dev/null
  fi
else
  git worktree add -b "$branch" "$path" "$base" >/dev/null
fi
echo "$path"
```

Make it executable: `chmod +x plugins/subagent-driven-development/scripts/sdd-worktree`

- [ ] **Step 4: Run tests to verify they pass**

Run: `bash plugins/subagent-driven-development/scripts/scripts.test.sh`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add plugins/subagent-driven-development/scripts/sdd-worktree plugins/subagent-driven-development/scripts/scripts.test.sh
git commit -m "sdd: sdd-worktree script — deterministic per-task sibling worktrees"
```

---

### Task 3: Merger prompt + implementer worktree entry

**Files:**
- Create: `plugins/subagent-driven-development/prompts/merger.md`
- Modify: `plugins/subagent-driven-development/prompts/implementer.md`
- Test: `plugins/subagent-driven-development/prompts/prompts.test.mjs`

**Interfaces:**
- Produces: `prompts/merger.md` (Task 4's merge agent reads it); implementer section "0. Enter your task worktree" (Task 4's dispatch prompt references `sdd-worktree` and an optional setup command).

- [ ] **Step 1: Write the failing tests**

Append to `plugins/subagent-driven-development/prompts/prompts.test.mjs`:

```js
test("merger prompt merges in task order, bounds repair, cleans up, reports suite verdict", () => {
  const s = read("merger.md");
  assert.match(s, /ascending|numeric task order/i);
  assert.match(s, /ONE repair attempt/i);
  assert.match(s, /worktree remove/);
  assert.match(s, /branch -d/);
  assert.match(s, /conflictsResolved/);
  assert.match(s, /"green" \| "red"/);
  assert.match(s, /full suite/i);
});

test("implementer prompt covers task-worktree entry and the setup command", () => {
  const s = read("implementer.md");
  assert.match(s, /sdd-worktree/);
  assert.match(s, /setup command/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test plugins/subagent-driven-development/prompts/prompts.test.mjs`
Expected: FAIL — `ENOENT ... merger.md` and no `sdd-worktree` match in implementer.md.

- [ ] **Step 3: Write the prompt content**

Create `plugins/subagent-driven-development/prompts/merger.md`:

```markdown
# Merger — operating instructions

You integrate one wave of parallel task branches into the integration branch.
You are the only agent that merges. Work in the integration worktree you were
given; the task branches were reviewed and approved individually — your job is
textual integration plus catching what per-branch review cannot see.

## 1. Merge in ascending numeric task order

For each task branch you were given (`sdd/t<N>`, ascending N):

1. `git merge --no-ff sdd/t<N>` — one merge commit per task keeps the trail.
2. On conflict: resolve it yourself. The task reports you were given describe
   what each branch built — read both sides' intent. Keep both behaviors
   unless they are genuinely exclusive; if they are, prefer the later task's
   brief and record that in `conflictsResolved`.
3. After the merge commit, copy that task's report
   (`<task worktree>/.sdd/task-<N>-report.md`) into the integration
   worktree's `.sdd/`.
4. Clean up: `git worktree remove --force <task worktree>` then
   `git branch -d sdd/t<N>`.

## 2. Run the suite

Run the suite command you were given; if none was given, use the test
commands named in the implementers' reports. Run the full suite, not a
subset — the point of this gate is integration breakage that no single
branch's tests could see.

## 3. Bounded repair

If the suite is red you get ONE repair attempt: fix the integration breakage,
commit, re-run the suite. Do not refactor beyond the breakage and do not
touch task-internal logic the suite does not flag. Still red after the
attempt → report `suite: "red"` honestly and stop; the workflow halts and a
human takes over.

## 4. Report

Return per schema:
- `headSha`: `git rev-parse HEAD` after your last commit
- `merged`: task numbers merged, in order
- `conflictsResolved`: one line per conflict (file + how you resolved it)
- `testSummary`: one line — suite command + result
- `suite`: "green" | "red"
```

In `plugins/subagent-driven-development/prompts/implementer.md`, insert this section between the title block (ends "...build only what the brief asks.") and `## 1. Understand before you touch anything`:

```markdown
## 0. Enter your task worktree (parallel waves only)

If your dispatch prompt names a task worktree, set it up first: run the
`sdd-worktree` command you were given — it prints your worktree path, and ALL
your work happens there, not in the shared workdir. Then run the setup
command if one was given (dependency install; it is safe to re-run). If your
prompt names no worktree, you are in a sequential wave: work directly in the
given workdir as usual.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test plugins/subagent-driven-development/prompts/prompts.test.mjs`
Expected: PASS — all tests including the six pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add plugins/subagent-driven-development/prompts/merger.md plugins/subagent-driven-development/prompts/implementer.md plugins/subagent-driven-development/prompts/prompts.test.mjs
git commit -m "sdd: merger prompt + implementer worktree-entry section"
```

---

### Task 4: Wave orchestration in sdd.mjs

**Files:**
- Modify: `plugins/subagent-driven-development/workflows/sdd.mjs` (meta block, `MERGE_SCHEMA`, and the whole `if (typeof phase === "function")` body)
- Test: `plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs`

**Interfaces:**
- Consumes: Task 1's helpers exactly as specified (`computeWaves`, `taskWorkdir`, `runPool`, `partitionWaveResults`, `cfg.limits.maxParallel`, `cfg.setupCmd`, `cfg.testCmd`); Task 2's `sdd-worktree` CLI (`<workdir> <baseSha> <n>` → prints path); Task 3's `prompts/merger.md`.
- Produces: the new return contract — `halted: null | { wave, reason, failures: [{taskN, reason, reportPath}] }` and `merges: [{ wave, merged, headSha, testSummary }]` (Task 5 documents these).

- [ ] **Step 1: Write the failing tests**

In `plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs`, replace the `meta is declared with three phases` test with:

```js
test("meta is declared with four phases including Merge", () => {
  assert.match(src, /name:\s*"subagent-driven-development"/);
  const phaseTitles = [...src.matchAll(/title:\s*"(Implement|Review|Merge|Final)"/g)];
  assert.equal(phaseTitles.length, 4);
});
```

Update the agent-call count in `every agent() call sets an explicit model` from `>= 4` to `>= 5` (the merge agent adds one). Then append:

```js
test("wave machinery is wired: schema, worktree script, pool, merge label", () => {
  assert.match(src, /MERGE_SCHEMA/);
  assert.match(src, /sdd-worktree/);
  assert.match(src, /runPool\(/);
  assert.match(src, /computeWaves\(/);
  assert.match(src, /label: `merge:w\$\{/);
  assert.match(src, /model: "sonnet", schema: MERGE_SCHEMA/);
});

test("halted carries wave and failures; return includes merges", () => {
  assert.match(src, /failures/);
  assert.match(src, /merges,/);
  assert.match(src, /suite === "red"/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs`
Expected: FAIL — phase count is 3, no `MERGE_SCHEMA`/`runPool(` in source.

- [ ] **Step 3: Implement the orchestration**

In `plugins/subagent-driven-development/workflows/sdd.mjs`:

**(a)** Update the meta block — description and phases:

```js
export const meta = {
  name: "subagent-driven-development",
  description:
    "Args-driven SDD loop: deps-driven waves — per-task implement -> review (spec + quality + ponytail) -> bounded fix loop run concurrently per wave in sibling worktrees (sequential = singleton waves), a per-wave merge gate with bounded repair, deterministic BLOCKED escalation and oscillation halt, then an Opus whole-branch final review. Returns task results + merges + plan-conflicts + final review.",
  phases: [
    { title: "Implement", detail: "per-task implementer (tiered), TDD + ponytail ladder" },
    { title: "Review", detail: "spec + quality + over-engineering lens, bounded fix loop" },
    { title: "Merge", detail: "per-wave integration: ordered merges, full suite, bounded repair" },
    { title: "Final", detail: "whole-branch review on Opus", model: "opus" },
  ],
};
```

**(b)** Add `MERGE_SCHEMA` after `FIX_SCHEMA`:

```js
const MERGE_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["headSha", "merged", "conflictsResolved", "testSummary", "suite"],
  properties: {
    headSha: { type: "string" },
    merged: { type: "array", items: { type: "number" } },
    conflictsResolved: { type: "array", items: { type: "string" } },
    testSummary: { type: "string" },
    suite: { type: "string", enum: ["green", "red"] },
  },
};
```

**(c)** Replace the entire `if (typeof phase === "function") { ... }` block with:

```js
if (typeof phase === "function") {
  const cfg = validateArgs(args);
  const order = sequenceTasks(cfg.tasks);
  const waves = computeWaves(order);
  const P = cfg.pluginDir;
  const gc = cfg.globalConstraints || "(none stated)";

  // Parallel-wave dispatches prepend worktree entry; sequential waves don't.
  const worktreePreamble = (task, base, wd) =>
    wd === cfg.workdir ? "" : `FIRST create/enter your task worktree: run ${P}/scripts/sdd-worktree ${cfg.workdir} ${base} ${task.n}
It prints your worktree path (${wd}); ALL work happens there, not in ${cfg.workdir}.${
      cfg.setupCmd ? `\nThen run the setup command (safe to re-run): ${cfg.setupCmd}` : ""
    }
`;

  const implPrompt = (task, tier, blocker, base, wd) =>
    `You are implementing Task ${task.n} ("${task.title}") of an approved plan. Work in ${wd}.
${worktreePreamble(task, base, wd)}Read your full operating instructions first: ${P}/prompts/implementer.md — follow them exactly.
Get your task brief by running: ${P}/scripts/task-brief ${cfg.planPath} ${task.n}
Read the brief file it prints; implement THAT task only.
Global constraints that bind this task:\n${gc}
Write your full report to ${wd}/.sdd/task-${task.n}-report.md.${
      blocker ? `\nPRIOR ATTEMPT WAS BLOCKED: ${blocker}\nA ${tier} model is now assigned — resolve the blocker or report BLOCKED again with specifics.` : ""
    }
Return per schema: status, headSha (run \`git rev-parse HEAD\` after committing), testSummary, concerns, reportPath.`;

  const reviewPrompt = (task, base, head, wd) =>
    `You are reviewing Task ${task.n} ("${task.title}"). Work in ${wd}; READ-ONLY on the tree.
Read your full operating instructions first: ${P}/prompts/reviewer.md — follow them exactly.
Build the diff: ${P}/scripts/review-package ${base} ${head}
Read the package file it prints. The implementer's report is at ${wd}/.sdd/task-${task.n}-report.md (treat as unverified claims).
Global constraints that bind this task:\n${gc}
Return per schema: spec ("pass"/"fail"), findings[{severity,class,file,line,what,planMandated}], cannotVerify[], quality, ponytail{net,items}.
Set planMandated=true for any finding the plan/brief explicitly mandates. "class" is a short stable label for the finding kind (used to detect oscillation).`;

  const fixPrompt = (task, findings, wd) =>
    `You are fixing review findings on Task ${task.n} ("${task.title}"). Work in ${wd}.
Read your full operating instructions first: ${P}/prompts/fixer.md — follow them exactly.
Fix ALL of these findings in one commit:\n${JSON.stringify(findings, null, 2)}
Re-run the tests covering each change; append the results to ${wd}/.sdd/task-${task.n}-report.md.
Return per schema: headSha (after committing), testSummary, fixed[].`;

  const mergePrompt = (w, waveBase, merged) =>
    `You are the wave-${w} MERGER. Work in ${cfg.workdir} (the integration worktree).
Read your full operating instructions first: ${P}/prompts/merger.md — follow them exactly.
Merge these task branches into the current branch in ascending task order:
${merged
      .map((t) => `- Task ${t.n}: branch sdd/t${t.n} at ${t.headSha}, worktree ${taskWorkdir(cfg.workdir, t.n)}, report ${taskWorkdir(cfg.workdir, t.n)}/.sdd/task-${t.n}-report.md`)
      .join("\n")}
Wave base was ${waveBase}.
${cfg.testCmd ? `Suite command: ${cfg.testCmd}` : "No suite command given — use the test commands named in the implementers' reports."}
Global constraints:\n${gc}
Return per schema: headSha, merged, conflictsResolved, testSummary, suite ("green"/"red").`;

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

  const finalFixPrompt = (findings) =>
    `Fix ALL of these whole-branch review findings in one commit, in ${cfg.workdir}. Read ${P}/prompts/fixer.md and follow it.
Findings:\n${JSON.stringify(findings, null, 2)}
Re-run covering tests; return per schema: headSha, testSummary, fixed[].`;

  const results = [];
  const planConflicts = [];
  const merges = [];
  let halted = null;

  async function runTask(task, base, wd) {
    // Implement with the BLOCKED escalation ladder.
    let tier = task.tier, opusAttempts = 0, blocker = null, impl = null;
    while (true) {
      impl = await agent(implPrompt(task, tier, blocker, base, wd), {
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
      review = await agent(reviewPrompt(task, base, head, wd), {
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
      const fix = await agent(fixPrompt(task, actionable, wd), {
        label: `fix:t${task.n}.${rounds}`, phase: "Review", model: "sonnet", schema: FIX_SCHEMA,
      });
      if (!fix) return { halt: { taskN: task.n, reason: "fixer returned no result", reportPath: impl.reportPath } };
      head = fix.headSha || head;
    }
    return { task: { n: task.n, status: impl.status, headSha: head, reviewVerdict: review.spec, fixRounds: rounds } };
  }

  phase("Implement");
  let base = cfg.mergeBase;

  for (let w = 0; w < waves.length && !halted; w++) {
    const wave = waves[w];

    if (wave.length === 1) {
      // Degenerate case: exactly the pre-wave behavior — shared workdir, no merge.
      const r = await runTask(wave[0], base, cfg.workdir);
      if (r.halt) { halted = { wave: w, reason: "task failure(s) in wave", failures: [r.halt] }; break; }
      results.push(r.task);
      base = r.task.headSha;
      continue;
    }

    const waveBase = base;
    const poolOut = await runPool(wave, cfg.limits.maxParallel, (task) =>
      runTask(task, waveBase, taskWorkdir(cfg.workdir, task.n)));
    const { succeeded, failures } = partitionWaveResults(wave, poolOut);

    if (succeeded.length) {
      const merge = await agent(mergePrompt(w, waveBase, succeeded), {
        label: `merge:w${w}`, phase: "Merge", model: "sonnet", schema: MERGE_SCHEMA,
      });
      if (!merge) {
        halted = { wave: w, reason: "merge agent returned no result", failures };
      } else {
        merges.push({ wave: w, merged: merge.merged, headSha: merge.headSha, testSummary: merge.testSummary });
        if (merge.suite === "red") {
          halted = { wave: w, reason: "merge gate red after repair", failures };
        } else {
          base = merge.headSha;
          succeeded.forEach((t) => results.push(t));
        }
      }
    }
    if (!halted && failures.length) {
      halted = { wave: w, reason: "task failure(s) in wave", failures };
    }
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

  log(halted
    ? `Halted in wave ${halted.wave}: ${halted.reason} (${halted.failures.length} failure(s))`
    : `Completed ${results.length}/${order.length} tasks across ${waves.length} wave(s)`);
  return {
    tasks: results, planConflicts, halted, finalReview,
    mergeBase: cfg.mergeBase, head: base, merges,
    ledgerPath: `${cfg.workdir}/.sdd/progress.md`,
    meta: { tasksCompleted: results.length, tasksTotal: order.length, waves: waves.length, planConflicts: planConflicts.length },
  };
}
```

- [ ] **Step 4: Run all workflow tests to verify they pass**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.test.mjs plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs`
Expected: PASS — every test in both files.

- [ ] **Step 5: Commit**

```bash
git add plugins/subagent-driven-development/workflows/sdd.mjs plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs
git commit -m "sdd: wave-parallel orchestration — per-task worktrees + per-wave merge gate"
```

---

### Task 5: Documentation, contract text, version bump

**Files:**
- Modify: `plugins/subagent-driven-development/skills/subagent-driven-development/SKILL.md`
- Modify: `plugins/subagent-driven-development/skills/subagent-driven-development/skill.test.mjs`
- Modify: `plugins/subagent-driven-development/README.md`
- Modify: `plugins/adr/skills/adr/SKILL.md`
- Modify: `plugins/subagent-driven-development/.claude-plugin/plugin.json`

**Interfaces:**
- Consumes: Task 4's return contract (`halted` shape, `merges[]`) and args (`setupCmd`, `testCmd`, `limits.maxParallel`) — document them exactly as implemented.

- [ ] **Step 1: Write the failing test**

Append to `plugins/subagent-driven-development/skills/subagent-driven-development/skill.test.mjs`:

```js
test("documents waves: deps contract, parallel args, and the new halted shape", () => {
  assert.match(s, /deps.*parallel|parallel.*deps/i);
  assert.match(s, /maxParallel/);
  assert.match(s, /setupCmd/);
  assert.match(s, /testCmd/);
  assert.match(s, /failures/);
  assert.match(s, /merges/);
  assert.match(s, /don't invent independence|do not invent independence/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/subagent-driven-development/skills/subagent-driven-development/skill.test.mjs`
Expected: FAIL — no `maxParallel` in SKILL.md.

- [ ] **Step 3: Update the docs**

In `plugins/subagent-driven-development/skills/subagent-driven-development/SKILL.md`:

**(a)** Replace the step-4 heading and intro paragraph (`### 4. Enumerate tasks with tier hints` through the sentence ending "self-corrects a mis-tier at runtime.") with:

```markdown
### 4. Enumerate tasks with tier hints and honest deps

Turn the plan into a lightweight list — **no pasted task text**, just
`{ n, title, tier, deps }`. Assign `tier` per task with the complexity signals:

| Signal | Tier |
|--------|------|
| 1–2 files, complete spec, transcription/mechanical | `haiku` |
| multi-file, integration concerns (default floor) | `sonnet` |
| design judgment, broad codebase understanding | `opus` |

Default to the `sonnet` floor when unsure; the BLOCKED escalation ladder
self-corrects a mis-tier at runtime.

**`deps` is the parallelism contract.** Tasks whose deps are all satisfied run
concurrently in sibling worktrees (waves), so mark a dep wherever task B
touches files task A creates/changes or builds on its behavior. Prefer
file-disjoint decomposition when the plan allows it. When unsure, mark the
dep — sequential is the safe default.
```

**(b)** In step 5, replace "Present the batched conflicts (if any) and the task list with tiers." with:

```markdown
Present the batched conflicts (if any) and the task list with tiers **and the
computed waves** (group tasks by dependency level), so the human sees exactly
what will run in parallel before saying "go".
```

**(c)** In step 6, replace the `Workflow({ ... })` args block with:

```markdown
```
Workflow({ scriptPath: "<resolved sdd.mjs>", args: {
  planPath: "<abs plan path>",
  workdir: "<worktree root>",
  pluginDir: "<plugin root>",
  globalConstraints: "<verbatim Global Constraints>",
  mergeBase: "<git merge-base main HEAD>",
  tasks: [ { n: 1, title: "...", tier: "sonnet", deps: [] }, ... ],
  setupCmd: "<optional: per-worktree env setup, e.g. 'npm ci'>",
  testCmd: "<optional: suite command for the merge gate; recommended when the repo has a canonical one>",
  limits: { fixRounds: 2, escalateAttempts: 2, maxParallel: 4 }
}})
```

Tasks whose deps are all satisfied run concurrently (capped at
`limits.maxParallel`), each in a sibling worktree `<workdir>-t<N>`; a sonnet
merge agent integrates each wave in task order and runs the suite (`testCmd`,
or inferred from implementer reports), with one bounded repair attempt.
Linear plans (every task depending on the previous) run exactly as before.
```

**(d)** In step 7, replace the `halted` bullet with:

```markdown
- **`halted`** → `{ wave, reason, failures: [{ taskN, reason, reportPath }] }`.
  A wave can produce multiple failures (siblings run to completion and
  successful ones are merged before the halt). Wave-level `reason` covers
  merge-gate failures ("merge gate red after repair"); `failures[]` covers
  task-level ones. Failed tasks keep their worktree and branch for
  inspection. After you fix the plan/blocker, resume with
  `Workflow({ scriptPath, resumeFromRunId })` (completed tasks return cached).
- **`merges`** → `[{ wave, merged, headSha, testSummary }]` — what each
  wave's merge gate did.
```

**(e)** Add to the "Red flags — never" list:

```markdown
- Invent independence: don't invent independence to force parallelism — when
  unsure whether task B depends on task A, mark the dep.
```

In `plugins/subagent-driven-development/README.md`:

**(f)** Update "The contract" to:

```markdown
**args (controller → workflow):**
`{ planPath, workdir, pluginDir, globalConstraints, mergeBase, tasks:[{n,title,tier,deps}], setupCmd?, testCmd?, limits:{fixRounds,escalateAttempts,maxParallel} }`

**return:**
`{ tasks, planConflicts, halted, finalReview, mergeBase, head, merges, ledgerPath, meta }`
```

**(g)** Append to the "Deterministic failure handling" section:

```markdown
- **Wave scheduling:** tasks whose `deps` are all satisfied run concurrently
  (capped at `limits.maxParallel`, default 4), each in a sibling worktree
  `<workdir>-t<N>` on branch `sdd/t<N>`. A sonnet merge gate integrates each
  wave in task order, runs the full suite, and gets one bounded repair
  attempt; red after repair halts the run. Task failures don't cancel
  siblings — successful siblings are merged before the halt. Linear plans
  degenerate to singleton waves: identical to sequential execution.
```

In `plugins/adr/skills/adr/SKILL.md`, after the `pluginDir` explanation sentence ("...The loop runs per-task implement → review → fix (model-tiered, ponytail-lensed)"), extend that sentence to read:

```markdown
`pluginDir` is the directory **containing** `workflows/`, `prompts/`, and
`scripts/`. The loop runs per-task implement → review → fix (model-tiered,
ponytail-lensed) — Decomposition tasks whose `deps` allow it run as parallel
waves with a per-wave merge gate, so mark deps honestly there — then judges
the whole branch against the ADR's Success criteria (oracle gates + a checker
agent).
```

In `plugins/subagent-driven-development/.claude-plugin/plugin.json`: set `"version": "0.2.0"` and in `description` replace "background Workflow runs per-task implement/review/fix with tiered models" with "background Workflow runs per-task implement/review/fix with tiered models in deps-driven parallel waves (per-task worktrees + per-wave merge gate)".

- [ ] **Step 4: Run the full plugin test suite**

Run: `node --test plugins/subagent-driven-development/**/*.test.mjs && bash plugins/subagent-driven-development/scripts/scripts.test.sh`
Expected: PASS everywhere; scripts test prints `OK`.

- [ ] **Step 5: Commit**

```bash
git add plugins/subagent-driven-development plugins/adr/skills/adr/SKILL.md
git commit -m "sdd: document wave-parallel contract; bump plugin to 0.2.0"
```
