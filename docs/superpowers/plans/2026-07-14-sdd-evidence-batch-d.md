# SDD Evidence-Based Gates (Batch D) — Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `sdd.mjs` from advancing its state on unchecked agent claims. Three defects
from the Codex/Terra audit, all in `plugins/subagent-driven-development/workflows/sdd.mjs`:

- **D1 (P1):** the final fixer runs and its result is **thrown away** — `head` is not updated,
  the suite is not rerun. **Confirmed live** on 2026-07-14: run `wf_e69a9e74-22e` returned
  `head: 6dfb959` while the fixer had already committed `3949fdf` on top of it. A final fix
  that breaks the branch is reported as a clean, approved run.
- **D2 (P2):** the wave merge agent returns `headSha` and `suite: "green"` as *strings* and the
  workflow believes them — nothing resolves the SHA or runs the suite before advancing `base`.
  One hallucinated "green" poisons every wave after it.
- **D3 (P2):** `validateArgs` accepts duplicate and non-integer task numbers. Two tasks with
  `n: 1` race on the same `sdd/t1` branch, `<workdir>-t1` worktree, and report path.

## What "verification" can and cannot mean here (read before Task 3)

`sdd.mjs` runs in the sealed Workflow sandbox: **no `import`, no `fs`, no `child_process`.**
The script cannot run `git` or the test suite itself. So an in-workflow verifier is necessarily
another `agent()` — and an agent's structured output is a *claim*, not a captured process exit
code. Calling a second agent's report "evidence" would be exactly the confusion this batch
exists to fix (Codex review, round 1, P1).

So the design is two layers, each honest about what it is:

1. **In-workflow: an independent check** (this plan's Tasks 3-4). A fresh `sonnet` verifier with
   a read-only, adversarial prompt, no stake in the outcome, and no knowledge of the implementer's
   reasoning re-resolves the claimed SHA and re-runs the suite. This is a *confidence check*, not
   proof: it catches a mistyped SHA, a merger that skipped a task branch, and a lazy or
   fabricated "green" — the actual observed failure modes — and it does so *during* the run, so a
   bad base cannot poison the next wave. It cannot defeat a verifier that fabricates in the same
   direction. **Say "independently checked", never "proven".**
2. **At the controller: trusted execution** (Task 6). The controller — this session, with real
   Bash — re-runs `git rev-parse` and the suite against the returned `head` **before** presenting
   results or doing anything irreversible. That is a real process exit code, and it is the gate
   that actually holds. It is post-hoc, which is exactly why layer 1 exists as well.

The in-workflow check is also *structurally* strengthened so a lazy verifier has less room. The
verifier reports **the two SHAs git actually printed** (the resolved claim, and the resolved
`HEAD`) and the workflow compares them itself — a boolean like `headMatchesClaim` would just be
another string the agent could set. And for a merge, every **succeeded task's commit** must be an
ancestor of that head. Note *commit*, not branch: `prompts/merger.md:21` runs
`git branch -d sdd/t<N>` before returning, so a branch-name ancestry check would fail on every
wave (Codex review, round 2, P1). Checking the immutable commit SHA the implementer reported is
both correct and stronger.

**Tech Stack:** Node 18+ ESM, stdlib only, `// @ts-check`. Tests: `node --test`.

## Global Constraints

- Plugin version becomes `0.3.0` (behavior change: runs now halt on an unverifiable merge or
  final fix) in BOTH `plugins/subagent-driven-development/.claude-plugin/plugin.json` AND the
  `subagent-driven-development` entry in `.claude-plugin/marketplace.json`
  (`scripts/repo-consistency.test.mjs` asserts they match).
- **`sdd.mjs` runs in a sealed sandbox:** no `import`, no `fs`, no `child_process`, no
  `Date.now()`, no `Math.random()`. Do not add an import to this file.
- **Every `agent()` call must set an explicit `model:`.** `sdd.smoke.test.mjs` asserts this by
  source inspection; `workflow-model-guard` enforces it at runtime.
- New pure helpers go **inside the `// >>> PURE` … `// <<< PURE` markers** and must be added to
  the `return { … }` list at the end of that block, or `sdd.test.mjs` cannot extract them.
- Run the suite with `bash scripts/run-node-tests.sh`, never `node --test <dir>` (Node 24
  regressed bare-directory invocation). Single files are fine.
- All commits on branch `fix/sdd-evidence`. Every commit message ends with:
  `Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw`

---

## Task 1: Reject duplicate and non-integer task numbers (D3)

**Files:**
- Modify: `plugins/subagent-driven-development/workflows/sdd.mjs:37` (inside `validateArgs`)
- Test: `plugins/subagent-driven-development/workflows/sdd.test.mjs`

**Interfaces:** none new. `validateArgs` keeps its signature and throw-on-invalid contract.

**Background:** `validateArgs` checks `typeof t.n !== "number"`, which admits `1.5`, `-1`, `0`,
`NaN`, and — critically — two tasks both numbered `1`. Task numbers name the branch (`sdd/t{n}`),
the worktree (`<workdir>-t{n}`), and the report path, so duplicates mean two concurrent
implementers writing to the same three places.

- [ ] **Step 1: Write the failing test**

In `sdd.test.mjs`, append:

```js
test("validateArgs rejects non-integer, non-positive, and duplicate task numbers", () => {
  const withTasks = (tasks) => ({ planPath: "p.md", workdir: "/w", pluginDir: "/p", mergeBase: "abc", tasks });
  assert.throws(
    () => H.validateArgs(withTasks([{ n: 1, title: "a" }, { n: 1, title: "b" }])),
    /duplicate/i,
    "two tasks numbered 1 would race on sdd/t1, <workdir>-t1, and one report path",
  );
  assert.throws(() => H.validateArgs(withTasks([{ n: 1.5, title: "a" }])), /integer/i);
  assert.throws(() => H.validateArgs(withTasks([{ n: 0, title: "a" }])), /integer|positive/i);
  assert.throws(() => H.validateArgs(withTasks([{ n: -1, title: "a" }])), /integer|positive/i);
  assert.throws(() => H.validateArgs(withTasks([{ n: NaN, title: "a" }])), /integer/i);
  assert.equal(H.validateArgs(withTasks([{ n: 1, title: "a" }, { n: 2, title: "b" }])).tasks.length, 2);
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.test.mjs`
Expected: FAIL — no throw for the duplicate or the fractional/zero/negative cases.

- [ ] **Step 3: Tighten `validateArgs`**

Replace the `n` check inside the `input.tasks.map(...)` callback:

```js
    if (!Number.isInteger(t.n) || t.n <= 0) {
      throw new Error(`tasks[${i}].n must be a positive integer (got ${JSON.stringify(t.n)})`);
    }
```

Immediately after the `const tasks = input.tasks.map(...)` block closes, add:

```js
  const seen = new Set();
  for (const t of tasks) {
    if (seen.has(t.n)) {
      // n names the branch (sdd/t{n}), the worktree (<workdir>-t{n}) and the report path —
      // two tasks sharing it would race on all three.
      throw new Error(`duplicate task number ${t.n}: task numbers must be unique`);
    }
    seen.add(t.n);
  }
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.test.mjs`
Expected: PASS, including the pre-existing `validateArgs` tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/subagent-driven-development/workflows/sdd.mjs \
        plugins/subagent-driven-development/workflows/sdd.test.mjs
git commit -m "fix(sdd): reject duplicate and non-integer task numbers (D3)

Task numbers name the branch (sdd/t{n}), the worktree (<workdir>-t{n}) and the report path,
so two tasks numbered 1 raced on all three. validateArgs now requires a positive integer and
enforces uniqueness.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Task 2: An orchestration test harness that actually runs the workflow body

**Files:**
- Create: `plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs`

**Interfaces:**
- Produces: `runWorkflow({ args, respond })` → `{ result, calls }`. Tasks 3 and 4 test their
  orchestration through it.

**Background (Codex review, round 1, P2):** the existing tests cannot catch the bugs this batch
fixes. `sdd.test.mjs` unit-tests *pure helpers*; `sdd.smoke.test.mjs` runs regexes over the
*source text*. Neither can tell you that `base` advanced before verification or that the final
fixer's result reached `head` — those are orchestration properties, and a regex asserting "the
source contains `verify:final-fix`" passes happily while the wiring around it is wrong.

The file cannot be `import()`ed: a Workflow script has a top-level `return` (the runtime wraps the
body in a function). So the harness reconstructs that wrapper — strip `export const meta`, wrap the
rest in an async `Function` whose parameters are the runtime globals — and drives it with an
`agent` mock keyed by each call's `label`.

**Two facts the harness must respect, or its tests are worthless:**
- **Wave indices start at 0.** The loop is `for (let w = 0; ...)`, so the first wave's merge label
  is `merge:w0`, not `merge:w1`.
- **A single-task wave never reaches the merge gate.** `sdd.mjs` short-circuits `wave.length === 1`
  to a shared-workdir path with no merge agent. **A merge test therefore needs at least two
  dependency-free tasks** (Codex review, round 2, P1) — a one-task fixture would silently test
  nothing.

- [ ] **Step 1: Write the harness and a baseline test that passes against the CURRENT sdd.mjs**

Create `plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs`:

```js
// @ts-check
// Orchestration tests: run the ACTUAL workflow body with a mocked agent() so we can assert
// ordering and state transitions. sdd.test.mjs covers pure helpers; sdd.smoke.test.mjs greps the
// source; neither can catch "base advanced before verification".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "sdd.mjs"), "utf8");

// A Workflow script has a top-level `return` (the runtime wraps the body in a function), so it
// cannot be import()ed. Rebuild that wrapper.
const body = src.replace(/export const meta\s*=\s*\{[\s\S]*?\n\};/, "");

const SHA = (c) => c.repeat(40);

/**
 * @param {{args: any, respond: (label: string, prompt: string) => any}} opts
 * @returns {Promise<{result: any, calls: {label: string, model: string}[], prompts: Record<string,string>}>}
 */
async function runWorkflow({ args, respond }) {
  /** @type {{label: string, model: string}[]} */
  const calls = [];
  /** @type {Record<string,string>} */
  const prompts = {};
  const agent = async (prompt, opts = {}) => {
    const label = opts.label || "(unlabeled)";
    assert.ok(opts.model, `agent(${label}) must set an explicit model`);
    calls.push({ label, model: opts.model });
    prompts[label] = prompt;
    return respond(label, prompt);
  };
  const phase = () => {};
  const log = () => {};
  const parallel = (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)));
  const pipeline = async (items, ...stages) => {
    const out = [];
    for (let i = 0; i < items.length; i++) {
      let v = items[i];
      for (const s of stages) v = await s(v, items[i], i);
      out.push(v);
    }
    return out;
  };
  const fn = new Function(
    "agent", "phase", "log", "parallel", "pipeline", "args",
    `return (async () => { ${body} })();`,
  );
  const result = await fn(agent, phase, log, parallel, pipeline, args);
  return { result, calls, prompts };
}

// TWO dependency-free tasks: a single-task wave short-circuits past the merge gate entirely, so a
// one-task fixture cannot test merge verification at all.
const waveArgs = () => ({
  planPath: "p.md", workdir: "/w", pluginDir: "/p", mergeBase: SHA("0"),
  branchTip: SHA("1"), testCmd: "npm test",
  tasks: [
    { n: 1, title: "one", tier: "sonnet", deps: [] },
    { n: 2, title: "two", tier: "sonnet", deps: [] },
  ],
});

const soloArgs = () => ({
  planPath: "p.md", workdir: "/w", pluginDir: "/p", mergeBase: SHA("0"),
  branchTip: SHA("1"), testCmd: "npm test",
  tasks: [{ n: 1, title: "one", tier: "sonnet", deps: [] }],
});

const MERGED = SHA("b");

/** Scripted happy path; override any single label. Wave indices start at 0 → `merge:w0`. */
function happyResponder(overrides = {}) {
  return (label) => {
    if (label in overrides) return overrides[label];
    if (label.startsWith("impl:t")) {
      const n = label.slice("impl:t".length);
      return { status: "DONE", headSha: SHA(n === "1" ? "a" : "c"), testSummary: "1 pass", concerns: "", reportPath: `/w/.sdd/task-${n}-report.md` };
    }
    if (label.startsWith("review:t")) {
      return { spec: "pass", findings: [], cannotVerify: [], quality: "fine", ponytail: { net: 0, items: [] } };
    }
    if (label.startsWith("merge:w")) {
      return { headSha: MERGED, merged: [1, 2], conflictsResolved: [], testSummary: "2 pass", suite: "green" };
    }
    if (label.startsWith("verify:")) {
      // Default: the verifier confirms whatever was claimed. Tests override to inject disagreement.
      return { claimSha: MERGED, headSha: MERGED, missingCommits: [], suite: "green", evidence: "2 pass, 0 fail" };
    }
    if (label === "final-review") return { verdict: "approve", findings: [], ponytailDebt: [] };
    throw new Error(`unscripted agent label: ${label}`);
  };
}

test("harness: a two-task wave runs implement -> review -> merge and completes", async () => {
  const { result, calls } = await runWorkflow({ args: waveArgs(), respond: happyResponder() });
  assert.equal(result.halted, null, JSON.stringify(result.halted));
  assert.equal(result.tasks.length, 2);
  const labels = calls.map((c) => c.label);
  assert.ok(labels.includes("impl:t1") && labels.includes("impl:t2"), "both tasks implemented");
  assert.ok(labels.includes("merge:w0"), "a two-task wave reaches the merge gate (indices start at 0)");
});
```

**Note on the baseline:** run this against the *current* `sdd.mjs`, before Task 3. It must pass.
The `verify:` branch in `happyResponder` is unused until Task 3 adds those calls — that is fine and
expected. If the baseline fails for any other reason, fix the **harness**, not `sdd.mjs`, and report
what the wrapper got wrong: a harness that does not faithfully run the real body is worse than none.

- [ ] **Step 2: Run it**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs`
Expected: PASS against the current, unmodified `sdd.mjs`.

- [ ] **Step 3: Commit**

```bash
git add plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs
git commit -m "test(sdd): orchestration harness that runs the real workflow body

Pure-helper unit tests and source-regex smoke tests cannot catch orchestration bugs — that base
advanced before verification, or that an agent's result was discarded. This rebuilds the runtime's
function wrapper (a Workflow script has a top-level return, so it cannot be imported) and drives
the real body with a scripted agent() mock. Uses a two-task wave: a single-task wave
short-circuits past the merge gate, so a one-task fixture would test nothing.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Task 3: Check every state advance against an independent verifier (D2 + the singleton path)

**Files:**
- Modify: `plugins/subagent-driven-development/workflows/sdd.mjs` — add `VERIFY_SCHEMA` beside
  `MERGE_SCHEMA` (~line 215); add `isSha` + `acceptVerification` to the PURE block; add
  `verifyPrompt` beside `mergePrompt` (~line 303); rewire **both** the singleton path (~lines
  384-391) and the merge gate (~lines 399-411)
- Test: `plugins/subagent-driven-development/workflows/sdd.test.mjs`
- Test: `plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs`

**Interfaces:**
- Produces (Task 4 consumes all):
  - `isSha(s)` → `true` only for a full 40-char lowercase hex SHA. Pure.
  - `acceptVerification(v, testCmd)` → `{ ok, reason, headSha }`. Pure. `headSha` is **only ever
    the SHA the verifier observed** — never a fallback to the claim.
  - `verifyPrompt(claimedSha, claim, expectCommits)` → prompt for a read-only verifier.
    `expectCommits` is `[{ n, sha }]` — task commits that must be contained in HEAD.
  - `VERIFY_SCHEMA` — `{ claimSha, headSha, missingCommits, suite, evidence }`.

**Background:** two places advance `base` on an unchecked claim.

- **The merge gate** (`sdd.mjs:405-409`) pushes the merger's self-reported `headSha` into `merges`
  and sets `base = merge.headSha` whenever `suite !== "red"`. Nothing resolves the SHA; nothing
  runs `testCmd`.
- **The singleton path** (`sdd.mjs:388-390`) — `base = r.task.headSha`, straight from the
  *implementer's* claim, with no merge agent involved at all. This is the **common** case: a linear
  plan is all singleton waves, so before this fix a linear run was entirely unchecked (Codex review,
  round 2, P1). Fixing only the merge gate would leave the majority of real runs unprotected.

Four structural requirements. A weaker check is worse than none, because it manufactures
confidence:

1. **The verifier reports the two SHAs git printed; the workflow compares them.** Not a boolean —
   `headMatchesClaim: true` is a string an agent can emit without looking at anything.
   `acceptVerification` requires `claimSha === headSha`, both full 40-hex.
2. **Never fall back to the claimed SHA.** If the verifier reports no resolved head, reject. A
   fallback would advance to precisely the value under suspicion.
3. **Every *succeeded* task's commit must be an ancestor of HEAD** — checked by **commit SHA**, not
   branch name (`prompts/merger.md:21` deletes `sdd/t<N>`), and derived from the **workflow's own**
   `succeeded` list, not the merger's `merged` array (which is itself an untrusted claim — a merger
   could omit task 2 from `merged` and the verifier would never look for it).
4. **`suite: "unknown"` is legitimate only when no `testCmd` was configured.** With one, an
   unconfirmable suite is not evidence of green.

- [ ] **Step 1: Write the failing tests**

In `sdd.test.mjs`, add `isSha` and `acceptVerification` to the destructured `H` list in the
`new Function(...)` call, then append:

```js
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const ok = (over = {}) => ({
  claimSha: SHA_A, headSha: SHA_A, missingCommits: [], suite: "green",
  evidence: "294 pass, 0 fail", ...over,
});

test("isSha accepts only a full 40-char hex sha", () => {
  assert.equal(H.isSha(SHA_A), true);
  assert.equal(H.isSha(""), false);
  assert.equal(H.isSha("abc123"), false, "a short sha is not a resolved, normalized commit");
  assert.equal(H.isSha("z".repeat(40)), false);
  assert.equal(H.isSha(undefined), false);
});

test("acceptVerification: accepts a confirmed claim and returns the OBSERVED head", () => {
  const r = H.acceptVerification(ok(), "npm test");
  assert.equal(r.ok, true);
  assert.equal(r.headSha, SHA_A);
});

test("acceptVerification: rejects a head that is not the claimed commit", () => {
  // The verifier resolved the claim to one commit and HEAD to another: the claimant named a
  // commit that is not the branch head. We compare the SHAs ourselves — no agent boolean.
  const r = H.acceptVerification(ok({ claimSha: SHA_A, headSha: SHA_B }), "npm test");
  assert.equal(r.ok, false);
  assert.match(r.reason, /head/i);
});

test("acceptVerification: never falls back to the claim when no head was resolved", () => {
  const r = H.acceptVerification(ok({ headSha: "" }), "npm test");
  assert.equal(r.ok, false);
  assert.equal(r.headSha, "", "advancing to the claimed sha here would advance to the untrusted value");
});

test("acceptVerification: rejects an unresolvable claim, a red suite, and an unconfirmable suite", () => {
  assert.equal(H.acceptVerification(ok({ claimSha: "" }), "npm test").ok, false);
  assert.equal(H.acceptVerification(ok({ suite: "red" }), "npm test").ok, false);
  // With a testCmd configured, "unknown" is not evidence of green …
  assert.equal(H.acceptVerification(ok({ suite: "unknown" }), "npm test").ok, false);
  // … without one, it is all we can ask for.
  assert.equal(H.acceptVerification(ok({ suite: "unknown" }), "").ok, true);
});

test("acceptVerification: rejects a head that does not contain a succeeded task's commit", () => {
  const r = H.acceptVerification(ok({ missingCommits: [2] }), "npm test");
  assert.equal(r.ok, false, "a green head that does not contain task 2 is not a merged wave");
  assert.match(r.reason, /2/);
});

test("acceptVerification: a missing verifier result is rejected", () => {
  assert.equal(H.acceptVerification(null, "npm test").ok, false);
});
```

In `sdd.orchestration.test.mjs`, append — these catch the actual bugs:

```js
test("merge gate: base advances to the verifier's resolved head, and only after verification", async () => {
  const { result, calls } = await runWorkflow({ args: waveArgs(), respond: happyResponder() });
  assert.equal(result.halted, null);
  assert.equal(result.head, MERGED);
  const order = calls.map((c) => c.label);
  assert.ok(order.indexOf("merge:w0") < order.indexOf("verify:w0"), "verification follows the merge");
  assert.equal(result.merges[0].verified, true);
});

test("merge gate: a claimed-green merge the verifier finds red halts the run", async () => {
  const { result } = await runWorkflow({
    args: waveArgs(),
    respond: happyResponder({
      "verify:w0": { claimSha: MERGED, headSha: MERGED, missingCommits: [], suite: "red", evidence: "3 failing" },
    }),
  });
  assert.ok(result.halted, "an unverified merge must halt, not poison the next wave's base");
  assert.match(result.halted.reason, /unverified/i);
  assert.equal(result.tasks.length, 0, "an unverified wave's tasks are not recorded as done");
});

test("merge gate: a merger naming a commit that is not the branch head halts the run", async () => {
  const { result } = await runWorkflow({
    args: waveArgs(),
    respond: happyResponder({
      "verify:w0": { claimSha: MERGED, headSha: SHA("f"), missingCommits: [], suite: "green", evidence: "ok" },
    }),
  });
  assert.ok(result.halted);
  assert.match(result.halted.reason, /head/i);
});

test("merge gate: the verifier is asked about EVERY succeeded task, not the merger's list", async () => {
  // A merger that omits task 2 from `merged` must not shrink what gets checked.
  const { prompts } = await runWorkflow({
    args: waveArgs(),
    respond: happyResponder({
      "merge:w0": { headSha: MERGED, merged: [1], conflictsResolved: [], testSummary: "1 pass", suite: "green" },
    }),
  });
  assert.match(prompts["verify:w0"], /task 2/i, "task 2 succeeded, so the verifier must check it");
});

test("singleton wave: a linear task's claimed head is verified before base advances", async () => {
  // The common case: a linear plan is all singleton waves, and they never touch the merge gate.
  const { result, calls } = await runWorkflow({
    args: soloArgs(),
    respond: happyResponder({
      "verify:t1": { claimSha: SHA("a"), headSha: SHA("a"), missingCommits: [], suite: "green", evidence: "1 pass" },
    }),
  });
  assert.equal(result.halted, null);
  assert.equal(result.head, SHA("a"));
  assert.ok(calls.some((c) => c.label === "verify:t1"), "a singleton task is verified too");
});

test("singleton wave: an unverifiable task halts instead of advancing base", async () => {
  const { result } = await runWorkflow({
    args: soloArgs(),
    respond: happyResponder({
      "verify:t1": { claimSha: SHA("a"), headSha: SHA("a"), missingCommits: [], suite: "red", evidence: "1 failing" },
    }),
  });
  assert.ok(result.halted);
  assert.match(result.halted.reason, /unverified/i);
});
```

- [ ] **Step 2: Run them and verify they fail**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.test.mjs plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs`
Expected: FAIL — `isSha`/`acceptVerification` are undefined, and no `verify:*` agent is dispatched,
so the orchestration tests see an unverified `head` and no halts.

- [ ] **Step 3: Add `isSha` and `acceptVerification` to the PURE block**

Inside `// >>> PURE` (after `partitionWaveResults`):

```js
function isSha(s) {
  return typeof s === "string" && /^[0-9a-f]{40}$/.test(s);
}

/**
 * Decide whether a verifier's observation supports an agent's claim.
 *
 * An INDEPENDENT CHECK, not proof: sdd.mjs runs in a sandbox with no child_process, so the
 * verifier is another agent and its report is another claim. What it buys is a fresh, read-only
 * agent with no stake in the outcome, plus structural requirements a lazy report cannot satisfy by
 * accident. The controller's post-run re-run of git and the suite is the gate that actually holds.
 *
 * We compare the two SHAs the verifier says git printed — never a boolean it could simply set.
 */
function acceptVerification(v, testCmd) {
  const no = (reason) => ({ ok: false, reason, headSha: "" });
  if (!v) return no("verifier returned no result");
  if (!isSha(v.claimSha)) return no("the claimed head did not resolve to a commit");
  // Never fall back to the claimed sha: it is the value we do not trust.
  if (!isSha(v.headSha)) return no(`verifier reported no resolved branch head (got ${JSON.stringify(v.headSha)})`);
  if (v.claimSha !== v.headSha) return no(`claimed commit ${v.claimSha} is not the branch head ${v.headSha}`);
  const missing = Array.isArray(v.missingCommits) ? v.missingCommits : [];
  if (missing.length) return no(`head ${v.headSha} does not contain task(s) ${missing.join(", ")}`);
  if (testCmd && v.suite !== "green") return no(`suite is ${v.suite} at ${v.headSha}`);
  return { ok: true, reason: "", headSha: v.headSha };
}
```

Add both to the `return { … }` list at the end of the PURE block, or `sdd.test.mjs` cannot extract them.

- [ ] **Step 4: Add `VERIFY_SCHEMA` and `verifyPrompt`**

`VERIFY_SCHEMA` goes beside `MERGE_SCHEMA` (~line 215) — it is already written in this plan's
"Interfaces" section above; use exactly that shape.

`verifyPrompt` goes beside `mergePrompt` (~line 303, in the scope closing over `cfg`):

```js
  const verifyPrompt = (claimedSha, claim, expectCommits = []) => `You are a VERIFIER. Do not fix
anything, do not commit, do not write or edit any file. Observe, then report only what you saw.

Working directory: ${cfg.workdir}

Another agent claims: ${claim}
Claimed head SHA: ${claimedSha}

Run exactly these and report what they actually print:

1. \`git -C ${cfg.workdir} rev-parse --verify ${claimedSha}^{commit}\`
   Report the full 40-character SHA it prints as claimSha. If it fails, claimSha="", put the error
   text in evidence, and stop.
2. \`git -C ${cfg.workdir} rev-parse HEAD\`
   Report the full 40-character SHA it prints as headSha. Report what git printed — do not echo
   back the claimed SHA.
${expectCommits.length
  ? `3. Each of these task commits must be contained in HEAD. For each, run:
${expectCommits.map((c) => `   task ${c.n}: \`git -C ${cfg.workdir} merge-base --is-ancestor ${c.sha} HEAD\` (exit 0 = contained)`).join("\n")}
   Put the task number of every commit NOT contained in HEAD into missingCommits.
   (Check the commit SHAs, not sdd/t<N> branches — the merger deletes those branches.)`
  : `3. No task commits to check for this claim: missingCommits=[].`}
${cfg.testCmd
  ? `4. Run the suite VERBATIM from ${cfg.workdir}:
   \`${cfg.testCmd}\`
   Read its real output. suite="green" ONLY if it ran to completion with zero failures. Failures, a
   crash, or a command that would not run are all "red". Quote the real pass/fail summary line in
   evidence.`
  : `4. No test command was configured for this run: suite="unknown", and put the rev-parse output
   in evidence.`}

Never report a result you did not observe. A claim you could not confirm is not confirmed.`;
```

- [ ] **Step 5: Rewire the singleton path**

Replace the `if (wave.length === 1) { … }` block (~lines 384-391):

```js
    if (wave.length === 1) {
      // Degenerate case: shared workdir, no merge — but the implementer's claimed head still has to
      // be checked, or a linear plan (all singleton waves) advances entirely on unverified claims.
      const r = await runTask(wave[0], base, cfg.workdir);
      if (r.halt) { halted = { wave: w, reason: "task failure(s) in wave", failures: [r.halt] }; break; }
      const verify = await agent(
        verifyPrompt(r.task.headSha, `task ${wave[0].n} is complete and its commit is the branch head`),
        { label: `verify:t${wave[0].n}`, phase: "Merge", model: "sonnet", schema: VERIFY_SCHEMA },
      );
      const acc = acceptVerification(verify, cfg.testCmd);
      if (!acc.ok) {
        halted = { wave: w, reason: `task ${wave[0].n} unverified: ${acc.reason}`, failures: [] };
        break;
      }
      results.push(r.task);
      base = acc.headSha;
      continue;
    }
```

- [ ] **Step 6: Rewire the merge gate**

Replace the merge-result `else` branch (~lines 405-411). Note `expect` comes from the workflow's own
`succeeded` list — **not** from `merge.merged`, which is the merger's own claim:

```js
      } else {
        // The workflow's own record of what succeeded — a merger that omits a task from `merged`
        // must not shrink what gets checked.
        const expect = succeeded.map((t) => ({ n: t.task.n, sha: t.task.headSha }));
        const verify = await agent(
          verifyPrompt(
            merge.headSha,
            `wave ${w} merged task(s) ${expect.map((e) => e.n).join(", ")} and left the suite ${merge.suite}`,
            expect,
          ),
          { label: `verify:w${w}`, phase: "Merge", model: "sonnet", schema: VERIFY_SCHEMA },
        );
        const acc = acceptVerification(verify, cfg.testCmd);
        merges.push({
          wave: w, merged: merge.merged,
          headSha: acc.ok ? acc.headSha : merge.headSha,
          testSummary: merge.testSummary,
          verified: acc.ok,
          evidence: verify ? verify.evidence : "",
        });
        if (merge.suite === "red") {
          halted = { wave: w, reason: "merge gate red after repair", failures };
        } else if (!acc.ok) {
          // The merger claimed green; an independent check could not confirm it. Do not let an
          // unverified base poison every wave after this one.
          halted = { wave: w, reason: `merge gate unverified: ${acc.reason}`, failures };
        } else {
          base = acc.headSha;
          succeeded.forEach((t) => results.push(t));
        }
      }
```

**Check `succeeded`'s shape before writing this:** `partitionWaveResults` returns entries the code
already pushes as `results.push(t)` and reads as `t.task.headSha` elsewhere. Confirm whether each
entry is `{ task }` or the task itself, and use whichever `runTask`'s result actually provides — the
existing `succeeded.forEach((t) => results.push(t))` and `r.task.headSha` in the singleton path are
the two references to reconcile. If the shapes differ, adapt; do not guess.

- [ ] **Step 7: Run the tests**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.test.mjs plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs`
Expected: PASS — including the pre-existing smoke assertion that every `agent()` call sets an
explicit model (both new `verify:*` calls set `model: "sonnet"`).

- [ ] **Step 8: Commit**

```bash
git add plugins/subagent-driven-development/workflows/sdd.mjs \
        plugins/subagent-driven-development/workflows/sdd.test.mjs \
        plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs
git commit -m "fix(sdd): check every state advance against an independent verifier (D2)

Two places advanced base on an unchecked claim: the wave merge gate (headSha and suite:'green' were
just strings the merger emitted) and — the common case — the singleton path, where a linear plan
advanced straight from each implementer's self-reported head with no merge agent involved at all.

A fresh read-only sonnet verifier now re-resolves the claimed SHA, reports the SHA git printed for
HEAD, confirms every SUCCEEDED task's commit is an ancestor of it (by commit, not branch name — the
merger deletes sdd/t<N>), and re-runs the suite. The workflow compares the two SHAs itself rather
than trusting a boolean. base advances only to the verifier's resolved head, never by falling back
to the claim, and an unconfirmable claim halts the run.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Task 4: Capture and check the final fixer's work; halt on a missing final review (D1)

**Files:**
- Modify: `plugins/subagent-driven-development/workflows/sdd.mjs:420-440` (the `Final` phase and the
  returned result object)
- Test: `plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs`
- Test: `plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs`

**Interfaces:**
- Consumes `acceptVerification`, `verifyPrompt`, `VERIFY_SCHEMA` from Task 3.
- Produces `finalFix` on the return value — `{ headSha, fixed, testSummary, verified: true } | null`.

**Background:** at `sdd.mjs:425-428` the workflow dispatches the final fixer and **discards its
return value**. `head` still points at the pre-fix commit, and neither the review nor the suite is
re-run — so a final fix that breaks the branch is reported as an approved, green run. Observed live:
`wf_e69a9e74-22e` returned `head: 6dfb959` while the fixer had committed `3949fdf` on top.

A second gap (Codex review, round 1, P2): if `finalReview` comes back `null` — the agent died — the
current code skips the whole final gate and returns `halted: null`, i.e. a *clean* run with no final
review at all. "The final review did not run" is not "the branch is fine".

Bounded on purpose: **check once, do not re-review.** Re-running the whole-branch Opus review after
every fix turns a one-shot fix into an unbounded review→fix→review loop.

- [ ] **Step 1: Write the failing tests**

In `sdd.orchestration.test.mjs`, append:

```js
const FIXED = SHA("e");

test("final fix: head advances past the fixer's commit and finalFix is reported", async () => {
  // The live D1 bug: wf_e69a9e74-22e returned head 6dfb959 while the fixer had committed 3949fdf.
  const { result, calls } = await runWorkflow({
    args: waveArgs(),
    respond: happyResponder({
      "final-review": { verdict: "approve", findings: [{ severity: "Minor", file: "a.mjs", line: "1", what: "x" }], ponytailDebt: [] },
      "final-fix": { headSha: FIXED, testSummary: "294 pass", fixed: ["x"] },
      "verify:final-fix": { claimSha: FIXED, headSha: FIXED, missingCommits: [], suite: "green", evidence: "294 pass, 0 fail" },
    }),
  });
  assert.equal(result.halted, null);
  assert.equal(result.head, FIXED, "head must point PAST the final fix");
  assert.notEqual(result.head, MERGED, "this is the exact bug: head left at the pre-fix commit");
  assert.equal(result.finalFix.headSha, FIXED);
  assert.equal(result.meta.finalFixApplied, true);
  assert.ok(calls.some((c) => c.label === "verify:final-fix"), "the fix is checked, not assumed");
});

test("final fix: a fix that leaves the suite red halts instead of reporting an approved run", async () => {
  const { result } = await runWorkflow({
    args: waveArgs(),
    respond: happyResponder({
      "final-review": { verdict: "approve", findings: [{ severity: "Minor", file: "a.mjs", line: "1", what: "x" }], ponytailDebt: [] },
      "final-fix": { headSha: FIXED, testSummary: "claims green", fixed: ["x"] },
      "verify:final-fix": { claimSha: FIXED, headSha: FIXED, missingCommits: [], suite: "red", evidence: "2 failing" },
    }),
  });
  assert.ok(result.halted, "a final fix that breaks the branch must not be reported as approved");
  assert.match(result.halted.reason, /final fix unverified/i);
});

test("final review: a missing final review halts rather than passing as a clean run", async () => {
  const { result } = await runWorkflow({
    args: waveArgs(),
    respond: happyResponder({ "final-review": null }),
  });
  assert.ok(result.halted, "'the final review did not run' is not 'the branch is fine'");
  assert.match(result.halted.reason, /final review/i);
});
```

In `sdd.smoke.test.mjs`, append:

```js
test("the final fixer's result is captured, not discarded", () => {
  assert.doesNotMatch(src, /\n\s*await agent\(finalFixPrompt\(/, "the fixer's result must be captured");
  assert.match(src, /label: "verify:final-fix"/);
});
```

- [ ] **Step 2: Run them and verify they fail**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs`
Expected: FAIL — `result.head` is the merged SHA, `result.finalFix` is undefined, a null final
review returns `halted: null`, and the source still has a bare `await agent(finalFixPrompt(`.

- [ ] **Step 3: Capture, check, and advance**

Replace the `Final` phase block (~lines 420-430):

```js
  let finalReview = null;
  let finalFix = null;
  if (!halted && results.length) {
    phase("Final");
    finalReview = await agent(finalPrompt(cfg.mergeBase, base), {
      label: "final-review", phase: "Final", model: "opus", schema: FINAL_SCHEMA,
    });
    if (!finalReview) {
      // "The final review did not run" is not "the branch is fine".
      halted = { wave: "final", reason: "final review returned no result", failures: [] };
    } else if ((finalReview.findings || []).length) {
      const fix = await agent(finalFixPrompt(finalReview.findings), {
        label: "final-fix", phase: "Final", model: "sonnet", schema: FIX_SCHEMA,
      });
      if (!fix) {
        halted = { wave: "final", reason: "final fixer returned no result", failures: [] };
      } else {
        // Bounded on purpose: check once, do NOT re-run the whole-branch review — that turns a
        // one-shot fix into an unbounded review -> fix -> review loop.
        const verify = await agent(
          verifyPrompt(
            fix.headSha,
            `the final fixer addressed ${finalReview.findings.length} finding(s) and left the suite: ${fix.testSummary}`,
          ),
          { label: "verify:final-fix", phase: "Final", model: "sonnet", schema: VERIFY_SCHEMA },
        );
        const acc = acceptVerification(verify, cfg.testCmd);
        if (!acc.ok) {
          halted = { wave: "final", reason: `final fix unverified: ${acc.reason}`, failures: [] };
        } else {
          // head must point PAST the fix — the old code left it at the pre-fix commit.
          base = acc.headSha;
          finalFix = { headSha: acc.headSha, fixed: fix.fixed, testSummary: fix.testSummary, verified: true };
        }
      }
    }
  }
```

- [ ] **Step 4: Return `finalFix`**

In the returned object, add `finalFix` beside `finalReview`, and `finalFixApplied` to `meta`:

```js
  return {
    tasks: results, planConflicts, halted, finalReview, finalFix,
    mergeBase: cfg.mergeBase, head: base, merges,
    ledgerPath: `${cfg.workdir}/.sdd/progress.md`,
    meta: {
      tasksCompleted: results.length, tasksTotal: order.length, waves: waves.length,
      planConflicts: planConflicts.length,
      finalFixApplied: Boolean(finalFix),
    },
  };
```

`halted.wave` is now sometimes the string `"final"` rather than a wave number — intentional (a halt
in the Final phase is not a wave); the controller only prints it.

- [ ] **Step 5: Run the plugin's tests**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.test.mjs plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs`
Expected: PASS, all of them.

- [ ] **Step 6: Commit**

```bash
git add plugins/subagent-driven-development/workflows/sdd.mjs \
        plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs \
        plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs
git commit -m "fix(sdd): capture and check the final fixer's work; halt on a missing final review (D1)

The final fixer ran and its result was discarded: head stayed at the pre-fix commit and the suite
was never re-run, so a final fix that broke the branch was reported as an approved, green run.
Observed live in wf_e69a9e74-22e, which returned head 6dfb959 while the fixer had already committed
3949fdf on top of it. A null final review also passed as a clean run; it now halts.

The fix is checked once (rev-parse + suite), head advances to the SHA the verifier resolved, an
unconfirmable fix halts the run, and the result reports finalFix.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Task 5: Controller-level trusted verification + docs + version bump to 0.3.0

**Files:**
- Modify: `plugins/subagent-driven-development/skills/subagent-driven-development/SKILL.md`
  (section "### 7. On return: present, adjudicate, finish", and the `testCmd` line in section 6)
- Modify: `plugins/subagent-driven-development/README.md`
- Modify: `plugins/subagent-driven-development/.claude-plugin/plugin.json` (→ `0.3.0`)
- Modify: `.claude-plugin/marketplace.json` (`subagent-driven-development` entry → `0.3.0`)
- Test: `scripts/repo-consistency.test.mjs` and the plugin's `skill.test.mjs` must keep passing.

**Background:** the in-workflow verifier is an agent checking an agent — a confidence check, not
proof (Codex review, round 1, P1). The layer that actually holds is the **controller**, which has
real Bash. It must re-run the checks itself, and the skill must say so, or `verified: true` will be
read as a guarantee it is not.

- [ ] **Step 1: Make `testCmd` effectively required, and say what happens without it**

In section 6 (the `Workflow({...})` invocation), change the `testCmd` line from "recommended" to:

> `testCmd` — **strongly recommended; pass it whenever the repo has a canonical suite command.**
> Without it, every verifier reports `suite: "unknown"` and the workflow can only check that the
> claimed commit resolves and is the branch head — it cannot check that anything still passes. If
> you omit it, say so explicitly when you present results; do not imply the branch is green.

(Codex review, round 2, P2: the controller instruction below is undefined when `testCmd` is empty,
so define it here rather than leaving the controller to improvise.)

- [ ] **Step 2: Add the trusted-verification step to SKILL.md**

In "### 7. On return: present, adjudicate, finish", add this as the FIRST thing the controller does,
before presenting anything:

> **Verify the returned head yourself before presenting or finishing.** The workflow's
> `verified: true` flags come from a verifier *agent* — an independent check, not proof (the
> Workflow sandbox has no `child_process`, so nothing in the run captured a real exit code). You
> have Bash. Run, in the workdir:
>
> ```bash
> git -C <workdir> rev-parse --verify <result.head>^{commit}   # the head resolves
> git -C <workdir> rev-parse HEAD                              # …and it IS the branch head
> <testCmd>                                                    # …and the suite is actually green
> ```
>
> If no `testCmd` was passed, determine the repo's canonical suite command and run that. If the repo
> has none, say so plainly — "the suite was not run" — rather than presenting the run as green.
>
> Quote the real pass/fail line back to the user. If any check disagrees with the workflow's report,
> say so and stop: a run that reports `halted: null` while the suite is red is exactly what this
> gate exists to catch.

Then add `finalFix` to the returned-keys list and note the new halt reasons:

- `**finalFix**` → `{ headSha, fixed, testSummary, verified }` — what the final fixer changed,
  re-checked against git and the suite. `head` points past it. `null` when the final review found
  nothing to fix.
- Under `halted`: a halt can now come from the **Final** phase (`wave: "final"`) — a missing final
  review, a missing fixer result, or a final fix that could not be confirmed — from a **merge gate**
  whose claimed green the verifier could not confirm, and from a **singleton task** whose claimed
  head could not be confirmed.

- [ ] **Step 3: Same in the plugin README**

Two or three sentences where the merge gate and final review are described: every state advance —
each singleton task, each wave merge, and the final fix — is now re-checked by an independent
verifier (the claimed commit resolves, it IS the branch head, it contains every succeeded task's
commit, and the suite is green), and the workflow advances only to the SHA the verifier resolved.
The controller re-runs git and the suite itself before finishing, because an agent checking an agent
is a confidence check, not proof. Do not restructure the README.

- [ ] **Step 4: Bump the version in both registries**

`plugins/subagent-driven-development/.claude-plugin/plugin.json`: `"version": "0.2.2"` → `"0.3.0"`.
`.claude-plugin/marketplace.json`, `subagent-driven-development` entry: same bump.

Minor, not patch: runs that previously completed on an unverifiable claim now halt, and every task
now costs one extra `sonnet` verifier call.

- [ ] **Step 5: Run the full suite**

Run: `bash scripts/run-node-tests.sh`
Expected: PASS, 0 fail — including `scripts/repo-consistency.test.mjs`'s
plugin.json↔marketplace.json version match (fails if only one bump landed).

- [ ] **Step 6: Commit**

```bash
git add plugins/subagent-driven-development/skills/subagent-driven-development/SKILL.md \
        plugins/subagent-driven-development/README.md \
        plugins/subagent-driven-development/.claude-plugin/plugin.json \
        .claude-plugin/marketplace.json
git commit -m "docs(sdd): controller-level trusted verification, evidence gates, bump to 0.3.0

The in-workflow verifier is an agent checking an agent — an independent check, not proof, because
the Workflow sandbox has no child_process. The controller has real Bash, so it now re-runs rev-parse
and the suite against the returned head before presenting or finishing, and the skill says so rather
than letting 'verified: true' read as a guarantee. Also defines what happens when no testCmd is
passed (suite: unknown everywhere — say so, do not imply green). Documents finalFix and the new halt
reasons. Minor bump: runs that previously completed on an unverifiable claim now halt.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Out of scope

- Batch C (`deep-dive`: schema-valid junk, silently dropped angles) — separate branch.
- Batch B2 (handoff statusline redesign) and B3 (handoff provenance/injection).
- The `adversarial-agents` README/SKILL contradiction (A3).
- Re-running the whole-branch review after a final fix. Deliberately excluded: it turns a bounded
  one-shot fix into an unbounded review→fix→review loop. One check is the contract.
