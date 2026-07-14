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

The in-workflow check is also *structurally* strengthened so a lazy verifier has less room:
the claimed SHA must equal the observed `HEAD`, and for a merge, every merged task's branch tip
must be an ancestor of that head. A merger cannot satisfy that by naming some old green commit.

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
- Produces: `runWorkflow({ args, respond })` → the workflow's return value, plus the recorded
  call log. Tasks 3 and 4 test their orchestration through it.

**Background (Codex review, round 1, P2):** the existing tests cannot catch the bugs this batch
fixes. `sdd.test.mjs` extracts and unit-tests *pure helpers*; `sdd.smoke.test.mjs` runs regexes
over the *source text*. Neither can tell you that `base` advanced before verification, that a
verifier ran at all, or that the final fixer's result reached `head` — those are orchestration
properties, and a regex asserting "the source contains `verify:final-fix`" passes happily while
the wiring around it is wrong.

The file cannot be `import()`ed: a Workflow script has a top-level `return` (the runtime wraps the
body in a function). So the harness reconstructs that wrapper — strip the `export const meta`
declaration, wrap the rest in an async `Function` whose parameters are the runtime globals
(`agent`, `phase`, `log`, `parallel`, `pipeline`, `args`), and drive it with a scripted `agent`
mock keyed by each call's `label`.

- [ ] **Step 1: Write the harness and a baseline test that must pass today**

Create `plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs`:

```js
// @ts-check
// Orchestration tests: run the ACTUAL workflow body with a mocked agent() so we can assert
// ordering and state transitions. sdd.test.mjs covers pure helpers; sdd.smoke.test.mjs greps
// the source; neither can catch "base advanced before verification".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "sdd.mjs"), "utf8");

// A Workflow script has a top-level `return` (the runtime wraps the body in a function), so it
// cannot be import()ed. Rebuild that wrapper: drop the `export const meta = {...};` declaration
// and run the remainder as an async function whose params are the runtime globals.
const body = src.replace(/export const meta\s*=\s*\{[\s\S]*?\n\};/, "");

/**
 * @param {{args: any, respond: (label: string, prompt: string) => any}} opts
 * @returns {Promise<{result: any, calls: {label: string, model: string, phase?: string}[]}>}
 */
async function runWorkflow({ args, respond }) {
  /** @type {{label: string, model: string, phase?: string}[]} */
  const calls = [];
  const agent = async (prompt, opts = {}) => {
    const label = opts.label || "(unlabeled)";
    assert.ok(opts.model, `agent(${label}) must set an explicit model`);
    calls.push({ label, model: opts.model, phase: opts.phase });
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
  return { result, calls };
}

const baseArgs = () => ({
  planPath: "p.md", workdir: "/w", pluginDir: "/p", mergeBase: "base000",
  branchTip: "tip000", testCmd: "npm test",
  tasks: [{ n: 1, title: "one", tier: "sonnet", deps: [] }],
});

// A scripted happy path: implementer DONE, reviewer passes, merge green, verifier confirms,
// final review clean. Individual tests override single labels via `overrides`.
function happyResponder(overrides = {}) {
  return (label) => {
    if (label in overrides) return overrides[label];
    if (label.startsWith("impl")) {
      return { status: "DONE", headSha: "a".repeat(40), testSummary: "1 pass", concerns: "", reportPath: "/w/.sdd/task-1-report.md" };
    }
    if (label.startsWith("review")) {
      return { spec: "pass", findings: [], cannotVerify: [], quality: "fine", ponytail: { net: 0, items: [] } };
    }
    if (label.startsWith("merge")) {
      return { headSha: "b".repeat(40), merged: [1], conflictsResolved: [], testSummary: "1 pass", suite: "green" };
    }
    if (label.startsWith("verify")) {
      return { shaExists: true, headSha: "b".repeat(40), headMatchesClaim: true, missingTaskTips: [], suite: "green", evidence: "1 pass, 0 fail" };
    }
    if (label === "final-review") return { verdict: "approve", findings: [], ponytailDebt: [] };
    throw new Error(`unscripted agent label: ${label}`);
  };
}

test("harness: the happy path completes and every agent call has a model", async () => {
  const { result, calls } = await runWorkflow({ args: baseArgs(), respond: happyResponder() });
  assert.equal(result.halted, null);
  assert.equal(result.tasks.length, 1);
  assert.ok(calls.length >= 3, "implementer, reviewer, merge at minimum");
});
```

- [ ] **Step 2: Run it — the baseline must pass against the CURRENT sdd.mjs**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs`
Expected: PASS. This proves the harness faithfully drives the real body before you change any
behavior with it. If the happy path throws `unscripted agent label: verify:w1`, that is expected
**only after** Task 3 lands — right now nothing verifies, so no verify label is requested.

If it fails for any other reason, fix the harness (not `sdd.mjs`) and report what the wrapper got
wrong — a harness that does not run the real body is worse than no harness.

- [ ] **Step 3: Commit**

```bash
git add plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs
git commit -m "test(sdd): orchestration harness that runs the real workflow body

Pure-helper unit tests and source-regex smoke tests cannot catch orchestration bugs — that
base advanced before verification, or that an agent's result was discarded. This rebuilds the
runtime's function wrapper (a Workflow script has a top-level return, so it cannot be imported)
and drives the real body with a scripted agent() mock.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Task 3: Independently check the merge gate's claim before advancing `base` (D2)

**Files:**
- Modify: `plugins/subagent-driven-development/workflows/sdd.mjs` (add `VERIFY_SCHEMA` beside
  `MERGE_SCHEMA` ~line 215; add `isSha` + `acceptVerification` inside the PURE block; add a
  `verifyPrompt` builder beside `mergePrompt` ~line 303; rewire the merge gate ~lines 399-411)
- Test: `plugins/subagent-driven-development/workflows/sdd.test.mjs`
- Test: `plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs`

**Interfaces:**
- Produces (Task 4 consumes all three):
  - `isSha(s)` → `true` for a full 40-char hex commit SHA. Pure.
  - `acceptVerification(v, claimedSha, testCmd, expectTasks)` →
    `{ ok: boolean, reason: string, headSha: string }`. Pure. `headSha` is **only ever the SHA the
    verifier observed** — never a fallback to the claim.
  - `verifyPrompt(claimedSha, claim, taskTips)` → prompt for a read-only verifier agent.
  - `VERIFY_SCHEMA` — `{ shaExists, headSha, headMatchesClaim, missingTaskTips, suite, evidence }`.

**Background:** at `sdd.mjs:405-409` the workflow pushes the merge agent's self-reported `headSha`
into `merges` and sets `base = merge.headSha` whenever `merge.suite !== "red"`. Nothing resolves
the SHA against git; nothing runs `testCmd`.

Three structural requirements, each from a review finding — a weaker check is worse than none,
because it manufactures false confidence:

1. **The observed head must be a real, normalized SHA.** If the verifier reports `headSha: ""`,
   reject. Never fall back to the claimed SHA — that would advance to exactly the unverified value
   this whole task exists to distrust (Codex review, round 1, P1).
2. **The claimed SHA must BE the branch head** (`headMatchesClaim`). Otherwise a merger can name
   any old green commit while the branch head is something else entirely.
3. **For a merge, every merged task's branch tip must be an ancestor of that head**
   (`missingTaskTips` empty). Otherwise a merger can drop a task branch, leave a green unrelated
   head, and the workflow still records every `succeeded` task as merged.

`suite: "unknown"` is legitimate **only** when no `testCmd` was configured. With one, an
unconfirmable suite is not evidence of green.

- [ ] **Step 1: Write the failing tests**

In `sdd.test.mjs`, add `isSha` and `acceptVerification` to the destructured `H` list in the
`new Function(...)` call, then append:

```js
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const good = (over = {}) => ({
  shaExists: true, headSha: SHA_A, headMatchesClaim: true, missingTaskTips: [],
  suite: "green", evidence: "294 pass, 0 fail", ...over,
});

test("isSha accepts a full hex sha and rejects everything else", () => {
  assert.equal(H.isSha(SHA_A), true);
  assert.equal(H.isSha(""), false);
  assert.equal(H.isSha("abc123"), false, "a short sha is not a normalized resolved commit");
  assert.equal(H.isSha("z".repeat(40)), false);
  assert.equal(H.isSha(undefined), false);
});

test("acceptVerification: the observed head is used, and is NEVER a fallback to the claim", () => {
  const r = H.acceptVerification(good(), SHA_A, "npm test", [1]);
  assert.equal(r.ok, true);
  assert.equal(r.headSha, SHA_A);
  // The D2-shaped trap: verifier confirms but reports no head. Advancing to the claim here
  // would advance to precisely the value we do not trust.
  const empty = H.acceptVerification(good({ headSha: "" }), SHA_A, "npm test", [1]);
  assert.equal(empty.ok, false);
  assert.equal(empty.headSha, "");
});

test("acceptVerification: rejects an unresolvable sha, a red suite, and an unconfirmable suite", () => {
  assert.equal(H.acceptVerification(good({ shaExists: false }), SHA_A, "npm test", [1]).ok, false);
  assert.equal(H.acceptVerification(good({ suite: "red" }), SHA_A, "npm test", [1]).ok, false);
  // With a testCmd configured, "unknown" is not evidence of green.
  assert.equal(H.acceptVerification(good({ suite: "unknown" }), SHA_A, "npm test", [1]).ok, false);
  // Without one, it is all we can ask for.
  assert.equal(H.acceptVerification(good({ suite: "unknown" }), SHA_A, "", [1]).ok, true);
});

test("acceptVerification: rejects a head that is not the claimed commit", () => {
  const r = H.acceptVerification(good({ headSha: SHA_B, headMatchesClaim: false }), SHA_A, "npm test", [1]);
  assert.equal(r.ok, false, "a merger must not name one commit while the branch head is another");
  assert.match(r.reason, /head/i);
});

test("acceptVerification: rejects a merge that dropped a task branch", () => {
  const r = H.acceptVerification(good({ missingTaskTips: [2] }), SHA_A, "npm test", [1, 2]);
  assert.equal(r.ok, false, "a green head that does not contain task 2 is not a merged wave");
  assert.match(r.reason, /2/);
});

test("acceptVerification: a missing verifier result is rejected", () => {
  assert.equal(H.acceptVerification(null, SHA_A, "npm test", [1]).ok, false);
});
```

In `sdd.orchestration.test.mjs`, append — these are the tests that actually catch the bug:

```js
test("merge gate: base advances to the VERIFIER's head, not the merger's claim", async () => {
  const MERGER_CLAIM = "c".repeat(40);
  const REAL_HEAD = "d".repeat(40);
  const { result, calls } = await runWorkflow({
    args: baseArgs(),
    respond: happyResponder({
      "merge:w1": { headSha: MERGER_CLAIM, merged: [1], conflictsResolved: [], testSummary: "1 pass", suite: "green" },
      "verify:w1": { shaExists: true, headSha: REAL_HEAD, headMatchesClaim: true, missingTaskTips: [], suite: "green", evidence: "294 pass" },
    }),
  });
  assert.equal(result.halted, null);
  assert.equal(result.head, REAL_HEAD, "head must be what the verifier resolved");
  const order = calls.map((c) => c.label);
  assert.ok(order.indexOf("merge:w1") < order.indexOf("verify:w1"), "verification follows the merge");
});

test("merge gate: a claimed-green merge the verifier cannot confirm halts the run", async () => {
  const { result } = await runWorkflow({
    args: baseArgs(),
    respond: happyResponder({
      "verify:w1": { shaExists: true, headSha: "b".repeat(40), headMatchesClaim: true, missingTaskTips: [], suite: "red", evidence: "3 failing" },
    }),
  });
  assert.ok(result.halted, "an unverified merge must halt, not poison the next wave's base");
  assert.match(result.halted.reason, /unverified/i);
  assert.equal(result.tasks.length, 0, "an unverified wave's tasks are not recorded as done");
});
```

- [ ] **Step 2: Run them and verify they fail**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.test.mjs plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs`
Expected: FAIL — `isSha` / `acceptVerification` are undefined, and the orchestration tests fail
because no verifier is dispatched (`result.head` is the merger's claim).

- [ ] **Step 3: Add `isSha` and `acceptVerification` to the PURE block**

Inside `// >>> PURE` (after `partitionWaveResults`):

```js
function isSha(s) {
  return typeof s === "string" && /^[0-9a-f]{40}$/.test(s);
}

/**
 * Decide whether a verifier's observation supports an agent's claim.
 *
 * This is an INDEPENDENT CHECK, not proof: sdd.mjs runs in a sandbox with no child_process, so
 * the verifier is another agent, and its report is another claim. What it buys is a fresh,
 * read-only agent with no stake in the outcome and structural requirements a lazy report cannot
 * satisfy by accident. Never call the result "proven" — the controller's post-run re-run of git
 * and the suite is the gate that actually holds.
 *
 * `expectTasks` is the task numbers a merge claims to have integrated ([] for a non-merge check).
 */
function acceptVerification(v, claimedSha, testCmd, expectTasks = []) {
  const no = (reason) => ({ ok: false, reason, headSha: "" });
  if (!v) return no("verifier returned no result");
  if (!v.shaExists) return no(`claimed head ${claimedSha} does not resolve to a commit`);
  // Never fall back to claimedSha: that is the value we do not trust.
  if (!isSha(v.headSha)) return no(`verifier reported no resolved head sha (got ${JSON.stringify(v.headSha)})`);
  if (v.headMatchesClaim === false) {
    return no(`claimed head ${claimedSha} is not the branch head ${v.headSha}`);
  }
  const missing = Array.isArray(v.missingTaskTips) ? v.missingTaskTips : [];
  if (missing.length) {
    return no(`head ${v.headSha} does not contain task tip(s) ${missing.join(", ")}`);
  }
  if (testCmd && v.suite !== "green") return no(`suite is ${v.suite} at ${v.headSha}`);
  return { ok: true, reason: "", headSha: v.headSha };
}
```

Add both to the `return { … }` list at the end of the PURE block.

- [ ] **Step 4: Add `VERIFY_SCHEMA` and `verifyPrompt`**

Beside `MERGE_SCHEMA` (~line 215):

```js
const VERIFY_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["shaExists", "headSha", "headMatchesClaim", "missingTaskTips", "suite", "evidence"],
  properties: {
    shaExists: { type: "boolean" },
    headSha: { type: "string" },
    headMatchesClaim: { type: "boolean" },
    missingTaskTips: { type: "array", items: { type: "number" } },
    suite: { type: "string", enum: ["green", "red", "unknown"] },
    evidence: { type: "string" },
  },
};
```

Beside `mergePrompt` (~line 303, in the scope that closes over `cfg`):

```js
  const verifyPrompt = (claimedSha, claim, taskTips = []) => `You are a VERIFIER. Do not fix
anything, do not commit, do not write or edit any file. Observe, then report only what you saw.

Working directory: ${cfg.workdir}

Another agent claims: ${claim}
Claimed head SHA: ${claimedSha}

Run exactly these and report what they actually print:

1. \`git -C ${cfg.workdir} rev-parse --verify ${claimedSha}^{commit}\`
   If it fails: shaExists=false, put the error text in evidence, stop.
2. \`git -C ${cfg.workdir} rev-parse HEAD\`
   Report the full 40-character SHA it prints as headSha. Do NOT echo back the claimed SHA —
   report what git printed. Set headMatchesClaim=true only if step 1 and step 2 resolved to the
   SAME commit.
${taskTips.length
  ? `3. For each task number below, check its branch tip is an ancestor of HEAD:
${taskTips.map((n) => `   \`git -C ${cfg.workdir} merge-base --is-ancestor sdd/t${n} HEAD\` (exit 0 = contained)`).join("\n")}
   Put every task number whose branch is NOT contained in HEAD into missingTaskTips.`
  : `3. No task tips to check for this claim: missingTaskTips=[].`}
${cfg.testCmd
  ? `4. Run the suite VERBATIM from ${cfg.workdir}:
   \`${cfg.testCmd}\`
   Read its real output. suite="green" ONLY if it ran to completion with zero failures. Failures,
   a crash, or a command that would not run are all "red". Quote the real pass/fail summary line
   in evidence.`
  : `4. No test command was configured for this run: suite="unknown", put the rev-parse output in
   evidence.`}

Never report a result you did not observe. A claim you could not confirm is not confirmed.`;
```

- [ ] **Step 5: Rewire the merge gate**

Replace the merge-result `else` branch (~lines 405-411):

```js
      } else {
        const verify = await agent(
          verifyPrompt(
            merge.headSha,
            `wave ${w} merged task(s) ${merge.merged.join(", ")} and left the suite ${merge.suite}`,
            merge.merged,
          ),
          { label: `verify:w${w}`, phase: "Merge", model: "sonnet", schema: VERIFY_SCHEMA },
        );
        const acc = acceptVerification(verify, merge.headSha, cfg.testCmd, merge.merged);
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

- [ ] **Step 6: Run the tests and verify they pass**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.test.mjs plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs`
Expected: PASS — including the pre-existing smoke assertion that every `agent()` call sets an
explicit model (the new `verify:w${w}` call sets `model: "sonnet"`).

- [ ] **Step 7: Commit**

```bash
git add plugins/subagent-driven-development/workflows/sdd.mjs \
        plugins/subagent-driven-development/workflows/sdd.test.mjs \
        plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs
git commit -m "fix(sdd): independently check the merge gate's claim before advancing base (D2)

The wave merger returned headSha and suite:'green' as strings and the workflow believed them —
nothing resolved the SHA against git, nothing ran testCmd, so one hallucinated 'green' poisoned
the base of every subsequent wave. A fresh read-only sonnet verifier now re-resolves the SHA,
confirms it IS the branch head, confirms every merged task's branch tip is an ancestor of it, and
re-runs the suite. base advances to the SHA the verifier resolved — never to the claim, and never
by falling back to it. An unconfirmable claim halts the run.

This is an independent check, not proof: the workflow sandbox has no child_process, so the
verifier is another agent. The controller's post-run re-run of git and the suite is the gate that
actually holds.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Task 4: Capture and check the final fixer's work; halt on a missing final review (D1)

**Files:**
- Modify: `plugins/subagent-driven-development/workflows/sdd.mjs:420-440` (the `Final` phase and
  the returned result object)
- Test: `plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs`
- Test: `plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs`

**Interfaces:**
- Consumes: `acceptVerification`, `verifyPrompt`, `VERIFY_SCHEMA` from Task 3.
- Produces: `finalFix` on the return value — `{ headSha, fixed: string[], testSummary, verified: true } | null`.

**Background:** at `sdd.mjs:425-428` the workflow dispatches the final fixer and **discards its
return value**. `head` still points at the pre-fix commit, and neither the review nor the suite is
re-run — so a final fix that breaks the branch is reported as an approved, green run. Observed
live: `wf_e69a9e74-22e` returned `head: 6dfb959` while the fixer had committed `3949fdf` on top.

A second gap (Codex review, round 1, P2): if `finalReview` comes back `null` — the agent died —
the current code skips the whole final gate and returns `halted: null`, i.e. a *clean* run with no
final review at all. That must halt: "the final review did not run" is not "the branch is fine".

The fix pass is bounded on purpose: **check once, do not re-review.** Re-running the whole-branch
Opus review after every fix turns a one-shot fix into an unbounded review→fix→review loop.

- [ ] **Step 1: Write the failing tests**

In `sdd.orchestration.test.mjs`, append:

```js
test("final fix: head advances past the fixer's commit and finalFix is reported", async () => {
  // The live D1 bug: wf_e69a9e74-22e returned head 6dfb959 while the fixer had committed 3949fdf.
  const MERGED = "b".repeat(40);
  const FIXED = "e".repeat(40);
  const { result, calls } = await runWorkflow({
    args: baseArgs(),
    respond: happyResponder({
      "final-review": { verdict: "approve", findings: [{ severity: "Minor", file: "a.mjs", line: "1", what: "x" }], ponytailDebt: [] },
      "final-fix": { headSha: FIXED, testSummary: "294 pass", fixed: ["x"] },
      "verify:final-fix": { shaExists: true, headSha: FIXED, headMatchesClaim: true, missingTaskTips: [], suite: "green", evidence: "294 pass, 0 fail" },
    }),
  });
  assert.equal(result.halted, null);
  assert.equal(result.head, FIXED, "head must point PAST the final fix, not at the pre-fix commit");
  assert.notEqual(result.head, MERGED, "this is the exact bug: head left at the pre-fix commit");
  assert.equal(result.finalFix.headSha, FIXED);
  assert.equal(result.meta.finalFixApplied, true);
  assert.ok(calls.some((c) => c.label === "verify:final-fix"), "the fix is checked, not assumed");
});

test("final fix: a fix that leaves the suite red halts instead of reporting an approved run", async () => {
  const { result } = await runWorkflow({
    args: baseArgs(),
    respond: happyResponder({
      "final-review": { verdict: "approve", findings: [{ severity: "Minor", file: "a.mjs", line: "1", what: "x" }], ponytailDebt: [] },
      "final-fix": { headSha: "e".repeat(40), testSummary: "claims green", fixed: ["x"] },
      "verify:final-fix": { shaExists: true, headSha: "e".repeat(40), headMatchesClaim: true, missingTaskTips: [], suite: "red", evidence: "2 failing" },
    }),
  });
  assert.ok(result.halted, "a final fix that breaks the branch must not be reported as approved");
  assert.match(result.halted.reason, /final fix unverified/i);
});

test("final review: a missing final review halts rather than passing as a clean run", async () => {
  const { result } = await runWorkflow({
    args: baseArgs(),
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
Expected: FAIL — `result.head` is the merged SHA (not the fixed one), `result.finalFix` is
undefined, a null final review returns `halted: null`, and the source still has a bare
`await agent(finalFixPrompt(`.

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
        const acc = acceptVerification(verify, fix.headSha, cfg.testCmd);
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

In the returned object, add `finalFix` beside `finalReview` and `finalFixApplied` to `meta`:

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

`halted.wave` is now sometimes the string `"final"` rather than a wave number — intentional (a
halt in the Final phase is not a wave); the controller only prints it.

- [ ] **Step 5: Run the whole plugin's tests**

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
Observed live in wf_e69a9e74-22e, which returned head 6dfb959 while the fixer had already
committed 3949fdf on top of it. A null final review also passed as a clean run; it now halts.

The fix is checked once (rev-parse + suite), head advances to the SHA the verifier resolved, an
unconfirmable fix halts the run, and the result reports finalFix.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Task 5: Controller-level trusted verification + docs + version bump to 0.3.0

**Files:**
- Modify: `plugins/subagent-driven-development/skills/subagent-driven-development/SKILL.md`
  (section "### 7. On return: present, adjudicate, finish")
- Modify: `plugins/subagent-driven-development/README.md`
- Modify: `plugins/subagent-driven-development/.claude-plugin/plugin.json` (→ `0.3.0`)
- Modify: `.claude-plugin/marketplace.json` (`subagent-driven-development` entry → `0.3.0`)
- Test: `scripts/repo-consistency.test.mjs` and the plugin's `skill.test.mjs` must keep passing.

**Interfaces:** none.

**Background:** the in-workflow verifier is an agent checking an agent — a confidence check, not
proof (Codex review, round 1, P1). The layer that actually holds is the **controller**, which has
real Bash. It must re-run the checks itself before doing anything irreversible, and the skill must
say so, or the new `verified: true` flags will be read as guarantees they are not.

- [ ] **Step 1: Add the trusted-verification step to SKILL.md**

In "### 7. On return: present, adjudicate, finish", add this as the FIRST thing the controller does
on return, before presenting anything:

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
> Quote the real pass/fail line back to the user. If any of the three disagrees with the workflow's
> report, say so plainly and stop — a run that reports `halted: null` while the suite is red is
> exactly the failure this gate exists to catch.

Then add `finalFix` to the returned-keys list and note the new halt reasons:

- `**finalFix**` → `{ headSha, fixed, testSummary, verified }` — what the final fixer changed,
  re-checked against git and the suite. `head` points past it. `null` when the final review found
  nothing to fix.
- Under `halted`: a halt can now come from the **Final** phase (`wave: "final"`) — a missing final
  review, a missing final fixer result, or a final fix that could not be confirmed — and from a
  merge gate whose claimed green the verifier could not confirm (`merge gate unverified: …`).

- [ ] **Step 2: Same in the plugin README**

Add two or three sentences where the merge gate and final review are described: the workflow now
independently re-checks each merge and the final fix (SHA resolves, IS the branch head, contains
every merged task tip, suite green) and advances only to the SHA the verifier resolved; and the
controller re-runs git and the suite itself before finishing, because an agent checking an agent
is a confidence check, not proof. Do not restructure the README.

- [ ] **Step 3: Bump the version in both registries**

`plugins/subagent-driven-development/.claude-plugin/plugin.json`: `"version": "0.2.2"` → `"0.3.0"`.
`.claude-plugin/marketplace.json`, `subagent-driven-development` entry: same bump.

Minor, not patch: an unverifiable merge or final fix now **halts** a run that previously completed.

- [ ] **Step 4: Run the full suite**

Run: `bash scripts/run-node-tests.sh`
Expected: PASS, 0 fail — including `scripts/repo-consistency.test.mjs`'s
plugin.json↔marketplace.json version match (fails if only one bump landed).

- [ ] **Step 5: Commit**

```bash
git add plugins/subagent-driven-development/skills/subagent-driven-development/SKILL.md \
        plugins/subagent-driven-development/README.md \
        plugins/subagent-driven-development/.claude-plugin/plugin.json \
        .claude-plugin/marketplace.json
git commit -m "docs(sdd): controller-level trusted verification, evidence gates, bump to 0.3.0

The in-workflow verifier is an agent checking an agent — an independent check, not proof, because
the Workflow sandbox has no child_process. The controller has real Bash, so it now re-runs
rev-parse and the suite against the returned head before presenting or finishing, and the skill
says so rather than letting 'verified: true' read as a guarantee. Documents finalFix and the new
Final-phase halt reasons. Minor bump: runs that previously completed on an unverifiable claim now
halt.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Out of scope

- Batch C (`deep-dive`: schema-valid junk, silently dropped angles) — separate branch.
- Batch B2 (handoff statusline guard redesign) and B3 (handoff provenance/injection).
- The `adversarial-agents` README/SKILL contradiction (A3).
- Re-running the whole-branch review after a final fix. Deliberately excluded: it turns a bounded
  one-shot fix into an unbounded review→fix→review loop. One check is the contract.
