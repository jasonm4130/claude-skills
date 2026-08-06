# SDD Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close fifteen verified defects in the `subagent-driven-development` plugin, concentrated in its verification layer — the part whose entire premise is that the loop cannot drift, skip a review, or rubber-stamp.

**Architecture:** Every change is to the deterministic layer, not to agent judgment. Where a gate today rests on a model noticing something, this plan replaces it with a fact the workflow computes itself: a commit count, a caught rejection, an enumerated label, a schema field. Two changes go the other way and *remove* information — the implementer's self-assessment from the reviewer's prompt — because independence is the property being protected. `sdd.mjs` is one file and every task in Tranche A touches it, so Tranche A is a linear dependency chain; Tranche B is file-disjoint and runs alongside it.

**Tech Stack:** Node 18+ stdlib only, ESM, `node --test`. Bash for `scripts/*`. No third-party packages, no `package.json`.

## Global Constraints

- **`sdd.mjs` runs in a sealed Workflow sandbox:** no `import`, no `require`, no `fs`, no `child_process`, no `Date.now()`, no `Math.random()`. Any helper must be defined inline in the file.
- **Pure helpers live between the `// >>> PURE` and `// <<< PURE` markers.** `sdd.test.mjs` extracts that block with `new Function` and returns a fixed list of names — a new pure helper must be added to that return list in `sdd.test.mjs` or it is untestable.
- **`// @ts-check` at the top of every `.mjs` file.** New `const` arrays that get `.push`ed need a `/** @type {...} */` annotation or checkJS reports `not assignable to parameter of type 'never'`.
- **Every `agent()` call must set an explicit `model:`.** `sdd.orchestration.test.mjs` asserts this on every dispatch.
- **Never hand-roll a `respond` function.** Always start from `happyResponder(overrides)` and override only the labels a test needs to differ — a bare `(label) => …` responder returning `null` for anything it does not recognise silently halts the run the moment a later task adds a dispatch (Task 6B adds `preflight:workdir` to every run).
- **The orchestration harness's real names,** which every test in this plan uses: fixtures are `soloArgs()` (one task, singleton wave) and `waveArgs()` (two independent tasks, a real merge gate); the scripted happy path is `happyResponder(overrides)`, which takes an object keyed by agent label and **throws on any unscripted label**. The workflow returns completed tasks under **`result.tasks`**, not `result.results`.
- **Test runner:** `node --test <file>` for `.mjs`; `bash plugins/subagent-driven-development/scripts/scripts.test.sh` for the shell helpers. The whole repo suite is `bash scripts/run-node-tests.sh`.
- **Version bump gate:** shipped plugin content cannot change without a version increase. Run `node scripts/bump-plugin.mjs subagent-driven-development minor` **once, in the final task** — bumping per task would fight the marketplace sync. CI (`version-bump-check`) fails the PR otherwise.
- **Docs gate:** a commit that changes executable code in a plugin must stage that plugin's `README.md` or `CLAUDE.md`, or carry `docs-sync:ack` in the message when the change genuinely has no doc impact.

---

### Task 1: Reject a task that committed nothing

A task whose implementer runs `git rev-parse HEAD` without ever committing reports `headSha === base`. Every check then passes: the sha resolves, it equals HEAD, `merge-base --is-ancestor base HEAD` exits 0 because a commit is its own ancestor, `missingCommits` is empty, and the suite is green because nothing changed. The task is recorded complete. The only thing standing between that and a green run is a reviewer noticing an empty diff — a model judgment, on reviewers deliberately calibrated toward "a clean pass is the expected result".

**Files:**
- Modify: `plugins/subagent-driven-development/workflows/sdd.mjs` (`VERIFY_SCHEMA` ~line 366, `acceptVerification` ~line 304, `verifyPrompt` ~line 511)
- Test: `plugins/subagent-driven-development/workflows/sdd.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `VERIFY_SCHEMA` gains a required `commitCount: { type: "number" }`. `acceptVerification(v, testCmd)` keeps its two-argument signature and its `{ ok, reason, headSha }` return shape; later tasks call it unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `sdd.test.mjs`, immediately after the existing `acceptVerification` tests:

```js
test("acceptVerification rejects a claim whose range contains no commits", () => {
  // The whole no-op-task class: rev-parse HEAD without committing reports the base
  // sha, which is its own ancestor, contains every expected commit, and leaves a
  // green suite because nothing changed.
  const r = H.acceptVerification(ok({ commitCount: 0 }), "npm test");
  assert.equal(r.ok, false);
  assert.match(r.reason, /no commits/i);
});

test("acceptVerification rejects a commitCount that is not a non-negative integer", () => {
  for (const bad of [undefined, null, "2", -1, 1.5, NaN]) {
    const r = H.acceptVerification(ok({ commitCount: bad }), "npm test");
    assert.equal(r.ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
    assert.match(r.reason, /commit count/i);
  }
});

test("acceptVerification accepts a verified claim that contains at least one commit", () => {
  assert.deepEqual(H.acceptVerification(ok({ commitCount: 1 }), "npm test"), {
    ok: true, reason: "", headSha: SHA_A,
  });
});
```

The existing `ok()` fixture must supply the new field so the pre-existing tests keep passing. Find it (it currently reads `const ok = (over = {}) => ({ claimSha: SHA_A, headSha: SHA_A, baseContained: true, missingCommits: [], suite: "green", ... })`) and add `commitCount: 1` to its defaults.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.test.mjs`
Expected: FAIL — the three new tests report `ok` where `false` was expected, because nothing reads `commitCount` yet.

- [ ] **Step 3: Add the schema field**

In `sdd.mjs`, `VERIFY_SCHEMA`: add `"commitCount"` to the `required` array, and this property beside `missingCommits`:

```js
    // How many commits the claimed range actually contains. A task that reported HEAD
    // without committing produces 0 here and passes every other check in this schema:
    // its sha resolves, it is its own ancestor, and the suite is green because nothing
    // changed. This is the only field that can tell that apart from real work.
    commitCount: { type: "number" },
```

- [ ] **Step 4: Enforce it in `acceptVerification`**

In `sdd.mjs`, insert immediately before the `if (testCmd && v.suite !== "green")` line. `acceptVerification` does not receive the base sha and must not grow a third parameter for a message string — four call sites would change for nothing:

```js
  if (!Number.isInteger(v.commitCount) || v.commitCount < 0) {
    return no(`verifier reported no usable commit count (got ${JSON.stringify(v.commitCount)})`);
  }
  if (v.commitCount === 0) {
    return no(`head ${v.headSha} contains no commits from this step — the claimed work was never committed`);
  }
```

- [ ] **Step 5: Have the verifier actually count**

In `sdd.mjs`, `verifyPrompt`, insert a numbered instruction between the current step 3 (ancestry) and step 4 (task commits), and renumber the two that follow:

```js
4. \`git -C ${cfg.workdir} rev-list --count ${baseSha}..${claimedSha}\`
   Report the integer it prints as commitCount. Report the number you saw — if the command
   fails or prints nothing, say so in evidence and report commitCount=0.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.test.mjs`
Expected: PASS, all tests.

- [ ] **Step 7: Close the same hole in a parallel wave**

`commitCount` is checked by `runVerify`, and a parallel wave's tasks are never verified individually — `runPool` hands straight to `partitionWaveResults` and then to the merge gate. There, a task that never committed reports the wave base as its `headSha`, which is trivially an ancestor of the merge head, and the merge range is non-zero because its *sibling* committed. So the oracle above closes the singleton path and leaves the parallel one open. No dispatch is needed to close it: the workflow already knows the base each task was dispatched from.

Add to `sdd.test.mjs`:

```js
test("partitionWaveResults fails a task whose head is still the wave base", () => {
  const wave = [{ n: "1" }, { n: "2" }];
  const { succeeded, failures } = H.partitionWaveResults(wave, [
    { task: { n: "1", status: "DONE", headSha: SHA_A } },
    { task: { n: "2", status: "DONE", headSha: SHA_B } }, // never committed
  ], SHA_B);
  assert.deepEqual(succeeded.map((t) => t.n), ["1"]);
  assert.equal(failures.length, 1);
  assert.match(failures[0].reason, /never committed|no commits/i);
});

test("partitionWaveResults without a base keeps its old behaviour", () => {
  const wave = [{ n: "1" }];
  const { succeeded } = H.partitionWaveResults(wave, [{ task: { n: "1", headSha: SHA_A } }]);
  assert.equal(succeeded.length, 1);
});
```

Then give `partitionWaveResults` an optional third parameter and the check:

```js
function partitionWaveResults(wave, results, waveBase = "") {
  const succeeded = [];
  const failures = [];
  wave.forEach((task, i) => {
    const r = results[i];
    if (r && r.task && waveBase && r.task.headSha === waveBase) {
      // A parallel task is only ever verified via the merge gate, where its sha being an
      // ancestor of the merge head is trivially true when it IS the base. This is the one
      // place the no-op is visible without another dispatch.
      failures.push({ taskN: task.n, reason: "task head is still the wave base — the claimed work was never committed", reportPath: r.task.reportPath || "" });
    } else if (r && r.task) succeeded.push(r.task);
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

and pass the base at the call site: `partitionWaveResults(wave, poolOut, waveBase)`.

- [ ] **Step 8: Update the orchestration fixtures**

`sdd.orchestration.test.mjs` has eight `verify:*` mock responses that will now fail `acceptVerification` — including the default inside `happyResponder`. Add `commitCount: 1` to every mock verify response whose test expects the run to succeed. While in that file, fix one stale fixture: `happyResponder`'s merge response returns `merged: [1, 2]`, but `MERGE_SCHEMA.merged` is `items: { type: "string" }` since task ids became strings — make it `merged: ["1", "2"]`. Run:

Run: `node --test plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add plugins/subagent-driven-development/workflows/sdd.mjs plugins/subagent-driven-development/workflows/sdd.test.mjs plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs
git commit -m "fix(sdd): reject a claim whose range contains no commits, in both wave shapes

docs-sync:ack"
```

---

### Task 2: Guard every agent dispatch, not just the implementer's

`dispatchImpl` normalises both failure shapes — a resolved `null` and a thrown rejection — for exactly one call site. Every other dispatch is a bare `await agent(...)`: the reviewer, the fixer, `runVerify`'s verifier, the merge agent, and all three final-phase calls. `runPool` catches throws for *parallel*-wave tasks, but the singleton-wave call is bare too. A linear plan is all singleton waves, so one transient dispatch rejection there propagates out of the workflow body and the run returns nothing — no `halted`, no `results`, no `merges`. Resume state is session-memory-only, so an eight-task run is simply gone.

**Files:**
- Modify: `plugins/subagent-driven-development/workflows/sdd.mjs` (`dispatchImpl` ~line 207; the dispatch sites listed below)
- Test: `plugins/subagent-driven-development/workflows/sdd.test.mjs`, `plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs`

**Interfaces:**
- Consumes: `acceptVerification` from Task 1, unchanged.
- Produces: `dispatchImpl` is renamed `dispatchAgent(agentFn, prompt, opts)` — same behaviour, same `null`-on-either-failure contract, name no longer implying one call site. Task 3 onward calls `dispatchAgent`.

- [ ] **Step 1: Write the failing tests**

In `sdd.test.mjs`, rename the existing `dispatchImpl` test to use the new name and add:

```js
test("dispatchAgent normalizes a rejecting dispatch to null, not a throw", async () => {
  const reject = async () => { throw new Error("model fable is unavailable"); };
  assert.equal(await H.dispatchAgent(reject, "prompt", {}), null);
});

test("dispatchAgent passes a resolved value straight through", async () => {
  const resolve = async () => ({ status: "DONE" });
  assert.deepEqual(await H.dispatchAgent(resolve, "prompt", {}), { status: "DONE" });
});
```

In `sdd.orchestration.test.mjs`, add:

```js
const throwing = () => { throw new Error("transient dispatch failure"); };

test("a rejecting dispatch in a singleton wave halts cleanly instead of crashing the run", async () => {
  const { result } = await runWorkflow({
    args: soloArgs(),
    respond: happyResponder({ get "review:t1"() { return throwing(); } }),
  });
  assert.ok(result.halted, "the run must return a halted state, not reject");
  assert.match(result.halted.reason, /reviewer returned no result|task failure/i);
  assert.ok(Array.isArray(result.tasks), "tasks must still be returned");
});

test("a rejecting merge dispatch halts cleanly", async () => {
  const { result } = await runWorkflow({
    args: waveArgs(),
    respond: happyResponder({ get "merge:w0"() { return throwing(); } }),
  });
  assert.ok(result.halted, "the run must return a halted state, not reject");
  assert.match(result.halted.reason, /merge agent returned no result/i);
});

test("a post-fix review that fails to dispatch halts — the returned head is not reviewed", async () => {
  const { result } = await runWorkflow({
    args: soloArgs(),
    respond: happyResponder({
      "final-review": { verdict: "changes", findings: [{ severity: "Critical", file: "a.js", line: "1", what: "real bug", planMandated: false }], ponytailDebt: [] },
      "final-fix": { headSha: FIXED, testSummary: "3 pass", fixed: ["real bug"] },
      "verify:final-fix": { claimSha: FIXED, headSha: FIXED, baseContained: true, missingCommits: [], commitCount: 1, suite: "green", evidence: "3 pass" },
      get "final-review-2"() { return throwing(); },
    }),
  });
  assert.ok(result.halted, "a green fix whose re-review never ran is not a reviewed head");
  assert.match(result.halted.reason, /post-fix review/i);
});
```

`happyResponder` returns its override by property access, so a getter is how a scripted label throws instead of resolving. `FIXED` is already defined in that file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.test.mjs plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs`
Expected: FAIL — `H.dispatchAgent is not a function`, and the orchestration tests reject with `transient dispatch failure` instead of returning a halted result.

- [ ] **Step 3: Rename the helper and widen its comment**

In `sdd.mjs`, rename `dispatchImpl` to `dispatchAgent` and replace its comment:

```js
// Dispatch an agent, normalizing BOTH failure shapes to null so every caller's clean-halt guard
// fires either way: a resolved null (the runtime's terminal-error return) AND a thrown rejection.
// A tier that cannot be dispatched at all — a withdrawn or repriced model, a transient API failure
// — can reject rather than resolve; an uncaught rejection escapes the `if (!x)` guard and takes the
// whole run with it, returning no halted state, no results and no merges for a run that cannot be
// resumed. `agentFn` is injected so this is unit-testable.
async function dispatchAgent(agentFn, prompt, opts) {
  try {
    return await agentFn(prompt, opts);
  } catch {
    return null;
  }
}
```

Update the name in `sdd.test.mjs`'s exported-names list (line 12) from `dispatchImpl` to `dispatchAgent`.

- [ ] **Step 4: Route every dispatch through it**

In `sdd.mjs`, replace each bare `await agent(...)` with `await dispatchAgent(agent, ...)`, keeping the existing `if (!x)` guard that follows each one:

- `runTask`'s implementer call (already `dispatchImpl` — just the rename)
- `runTask`'s reviewer call (`label: review:t${task.n}`)
- `runTask`'s fixer call (`label: fix:t${task.n}.${rounds}`)
- `runVerify`'s verifier call (`label` passed in)
- the merge dispatch (`label: merge:w${w}`)
- `final-review`, `final-fix`, and `final-review-2`

Each becomes, e.g.:

```js
      review = await dispatchAgent(agent, reviewPrompt(task, base, head, wd), {
        label: `review:t${task.n}`, phase: "Review", model: reviewerModel(task.tier), effort: reviewerEffort(task.effort), schema: REVIEW_SCHEMA,
      });
```

- [ ] **Step 5: Halt when the post-fix review does not run**

Routing `final-review-2` through `dispatchAgent` converts a rejection into `null`, and today `null` is silently accepted as `postFixReview: null` — so a run whose fix verified green but whose re-review never happened returns unhalted while claiming the returned head is reviewed. That is the exact failure the existing "`changes` with no findings is a broken report, not an approval" guard exists to prevent, one level up. In `sdd.mjs`, replace **the whole block from the existing `const postFix = await agent(...)` through the closing `};` of the `finalFix = { ... }` assignment** — the replacement re-declares `postFix`, so leaving the original in place is a duplicate `const` and the file will not load:

```js
          const postFix = await dispatchAgent(agent, finalPrompt(cfg.mergeBase, base), {
            label: "final-review-2", phase: "Final", model: "opus", effort: "high", schema: FINAL_SCHEMA,
          });
          if (!postFix) {
            // The fix is committed and verified green, but nothing has reviewed the head we are
            // about to return. "The re-review did not run" is not "the branch is fine".
            halted = { wave: "final", reason: "post-fix review returned no result — the returned head is unreviewed", failures: [] };
          }
          finalFix = {
            headSha: acc.headSha, fixed: fix.fixed, testSummary: fix.testSummary, verified: true,
            postFixReview: postFix || null,
            postFixFindings: postFix ? (postFix.findings || []) : [],
          };
```

`finalFix` is still assigned on the halt path: the fix really did land and its sha must reach the human.

- [ ] **Step 6: Guard the singleton-wave task call**

`runTask` returns `{ task }` or `{ halt }` and can still reject from code outside a dispatch. In `sdd.mjs`, replace the singleton-wave line:

```js
      const r = await runTask(wave[0], base, cfg.workdir).catch((e) => ({
        halt: { taskN: wave[0].n, reason: `task dispatch failed: ${e && e.message ? e.message : e}`, reportPath: "" },
      }));
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test plugins/subagent-driven-development/workflows/`
Expected: PASS, all tests.

- [ ] **Step 8: Commit**

```bash
git add plugins/subagent-driven-development/workflows/
git commit -m "fix(sdd): normalize a rejecting dispatch at every call site, not just the implementer's

docs-sync:ack"
```

---

### Task 3: Make the oscillation breaker measure oscillation

`roundClasses` is pushed the *pre-fix* review's classes before any fix has run, and `detectOscillation(cap = 2)` fires as soon as a class appears in the last two entries. So a defect class that survives one fix attempt halts the task at `rounds === 1`, before `rounds >= limits.fixRounds` (2) is ever reached — `fixRounds: 2` never grants a second attempt. That is not oscillation (A→B→A); it is "the first repair didn't fully land", which is the normal shape of a two-round fix. Compounding it, `class` is an unconstrained `{ type: "string" }` produced by a fresh agent each round, so the comparison is free-text equality between models that never saw each other's labels: `missing-validation` and `input-validation` defeat detection entirely, while two unrelated defects both labelled `test-quality` halt sound work.

**Files:**
- Modify: `plugins/subagent-driven-development/workflows/sdd.mjs` (`detectOscillation` ~line 217, `REVIEW_SCHEMA.findings[].class` ~line 343, `runTask`'s review loop ~line 585, `reviewPrompt` ~line 459)
- Modify: `plugins/subagent-driven-development/prompts/reviewer.md`
- Test: `plugins/subagent-driven-development/workflows/sdd.test.mjs`, `plugins/subagent-driven-development/prompts/prompts.test.mjs`

**Interfaces:**
- Consumes: `dispatchAgent` from Task 2.
- Produces: a new pure const `FINDING_CLASSES` (array of strings) exported from the PURE block; `detectOscillation(postFixRoundClasses, cap)` keeps its signature but is now fed only post-fix rounds.

- [ ] **Step 1: Write the failing tests**

In `sdd.test.mjs`:

```js
test("FINDING_CLASSES is a closed vocabulary the reviewer schema can enumerate", () => {
  assert.ok(Array.isArray(H.FINDING_CLASSES));
  assert.ok(H.FINDING_CLASSES.length >= 5 && H.FINDING_CLASSES.length <= 12,
    "few enough that two reviewers pick the same label, many enough to be meaningful");
  assert.equal(new Set(H.FINDING_CLASSES).size, H.FINDING_CLASSES.length, "no duplicates");
  for (const c of H.FINDING_CLASSES) assert.match(c, /^[a-z][a-z-]*[a-z]$/, "kebab-case");
});

test("detectOscillation needs a class to survive two FIX attempts, not one", () => {
  // One post-fix round is never oscillation, however bad it looks.
  assert.equal(H.detectOscillation([["correctness"]]), false);
  // Two post-fix rounds naming the same class is the real signal.
  assert.equal(H.detectOscillation([["correctness"], ["correctness"]]), true);
  // Different classes each round is progress, not oscillation.
  assert.equal(H.detectOscillation([["correctness"], ["test-gap"]]), false);
});
```

In `prompts.test.mjs`, extend the reviewer-prompt test:

```js
  assert.match(s, /finding class/i);
  for (const c of ["correctness", "spec-gap", "test-gap"]) {
    assert.ok(s.includes(c), `reviewer.md must list the '${c}' finding class`);
  }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.test.mjs plugins/subagent-driven-development/prompts/prompts.test.mjs`
Expected: FAIL — `H.FINDING_CLASSES` is undefined; `detectOscillation([["correctness"]])` returns `false` already but `[["correctness"], ["correctness"]]` also returns `true` today, so only the first and third assertions in that test currently hold. The `FINDING_CLASSES` test and the prompts test fail outright.

- [ ] **Step 3: Add the closed vocabulary**

In `sdd.mjs`, inside the PURE block beside `TIERS` and `EFFORTS`:

```js
// A closed vocabulary for finding classes. The oscillation breaker compares these labels across
// review rounds run by SEPARATE agents with no shared history — free text made that comparison
// unreliable in both directions: "missing-validation" vs "input-validation" hid a real loop, and two
// unrelated defects both called "test-quality" halted sound work.
const FINDING_CLASSES = [
  "correctness", "spec-gap", "test-gap", "error-handling",
  "security", "over-engineering", "duplication", "naming",
];
```

Add `FINDING_CLASSES` to the returned-names list in `sdd.test.mjs` line 12.

- [ ] **Step 4: Enumerate it in the schema and the prompt**

In `sdd.mjs`, `REVIEW_SCHEMA.findings[].properties`:

```js
          class: { type: "string", enum: FINDING_CLASSES },
```

In `reviewPrompt`, replace the trailing sentence about `class` with:

```js
"class" must be exactly one of: ${FINDING_CLASSES.join(", ")}. Pick the closest; it is compared across review rounds to detect a defect the fixer cannot land.
```

In `prompts/reviewer.md`, replace the free-text guidance about `class` with the same list and one line per class explaining what belongs in it.

- [ ] **Step 5: Feed the breaker only post-fix rounds**

In `sdd.mjs`, `runTask`: rename `roundClasses` to `postFixClasses`, declare it `/** @type {string[][]} */`, and move the push so the pre-fix round is excluded:

```js
    let head = impl.headSha, rounds = 0, review = null;
    /** @type {string[][]} */
    const postFixClasses = [];
    while (true) {
      review = await dispatchAgent(agent, reviewPrompt(task, base, head, wd), { /* … */ });
      if (!review) return { halt: { taskN: task.n, reason: "reviewer returned no result", reportPath: impl.reportPath } };
      (review.findings || []).filter((f) => f.planMandated).forEach((c) => planConflicts.push({ taskN: task.n, ...c }));
      const actionable = (review.findings || []).filter((f) => !f.planMandated && (f.severity === "Critical" || f.severity === "Important"));
      // Only rounds that follow a fix attempt count: the first review is the baseline, and a class
      // present in it has not yet survived anything.
      if (rounds > 0) postFixClasses.push(actionable.map((f) => f.class));
      if (review.spec === "pass" && actionable.length === 0) break;
      if (rounds >= cfg.limits.fixRounds || detectOscillation(postFixClasses)) {
        return { halt: { taskN: task.n, reason: "review did not converge (cap or oscillation)", reportPath: impl.reportPath } };
      }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test plugins/subagent-driven-development/workflows/ plugins/subagent-driven-development/prompts/prompts.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/subagent-driven-development/workflows/ plugins/subagent-driven-development/prompts/
git commit -m "fix(sdd): oscillation halts on two failed fixes, over a closed class vocabulary

docs-sync:ack"
```

---

### Task 4: Restore reviewer independence

Two defects, one property. First, `reviewPrompt` hands the reviewer the path to `task-N-report.md`, which `prompts/implementer.md` requires to contain "self-review notes and concerns" — so the reviewer reads the implementer's own assessment before forming its own. The prompt says "treat as unverified claims", which is the right instruction and still only a prose counterweight to an anchoring effect. Every agent in this loop is same-family Claude, which is the most correlated pairing there is. Second, `reviewerModel(task.tier)` and `reviewerEffort(task.effort)` read the *controller-assigned* tier, not the escalated one the implementer actually ran at — so an implementer that climbed to `opus`/`high` after a BLOCKED can be checked by a reviewer picked for its original assignment, inverting the stated "reviewers sit a notch above the implementer they check" invariant.

**Files:**
- Modify: `plugins/subagent-driven-development/workflows/sdd.mjs` (`reviewPrompt` ~line 455, `runTask`'s review dispatch ~line 588)
- Test: `plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs`

**Interfaces:**
- Consumes: `dispatchAgent` (Task 2), `postFixClasses` loop shape (Task 3).
- Produces: `reviewPrompt(task, base, head, wd)` keeps its signature; its output no longer names the report path.

- [ ] **Step 1: Write the failing tests**

In `sdd.orchestration.test.mjs`:

```js
test("the reviewer is never given the implementer's report path", async () => {
  const { prompts } = await runWorkflow({
    args: soloArgs(),
    respond: happyResponder({
      "impl:t1": { status: "DONE", headSha: SHA("a"), testSummary: "1 pass", concerns: "worried about X", reportPath: "/w/.sdd/task-1-report.md" },
    }),
  });
  assert.doesNotMatch(prompts["review:t1"], /task-1-report\.md/,
    "the reviewer must judge the diff and the brief, never the implementer's self-assessment");
});

test("the merger still gets the reports — it needs them to read conflict intent", async () => {
  const { prompts } = await runWorkflow({ args: waveArgs(), respond: happyResponder() });
  assert.match(prompts["merge:w0"], /report/i);
});

test("an escalated implementer is reviewed at the tier it escalated to", async () => {
  // Start the task at sonnet and BLOCK once, so the ladder escalates it to opus before it
  // succeeds. Today the reviewer would be picked from the ORIGINAL sonnet assignment.
  let implCalls = 0;
  const { calls } = await runWorkflow({
    args: { ...soloArgs(), tasks: [{ n: 1, title: "a", tier: "sonnet", effort: "medium", deps: [] }] },
    respond: happyResponder({
      get "impl:t1"() {
        implCalls++;
        return implCalls === 1
          ? { status: "BLOCKED", headSha: "", testSummary: "", concerns: "need more context", reportPath: "r.md" }
          : { status: "DONE", headSha: SHA("a"), testSummary: "1 pass", concerns: "", reportPath: "r.md" };
      },
    }),
  });
  const lastImpl = calls.filter((c) => c.label === "impl:t1").pop();
  const review = calls.find((c) => c.label === "review:t1");
  assert.equal(lastImpl.model, "opus", "the ladder must have escalated sonnet -> opus");
  assert.equal(review.model, "opus",
    "reviewerModel('opus') is 'opus'; a reviewer picked from the original sonnet would be 'sonnet'");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs`
Expected: FAIL — the first test finds `task-1-report.md` in the reviewer prompt.

- [ ] **Step 3: Remove the report path from the reviewer's prompt**

In `sdd.mjs`, `reviewPrompt`, delete the line:

```js
Read the package file it prints. The implementer's report is at ${wd}/.sdd/task-${task.n}-report.md (treat as unverified claims).
```

and replace it with:

```js
Read the package file it prints. You are NOT given the implementer's report: the diff and the brief
are the evidence, and a stated rationale is not one. Judge what the code does.
```

Leave `mergePrompt` untouched — the merger needs the reports to read both sides' intent on a conflict.

- [ ] **Step 4: Thread the escalated tier to the reviewer**

In `sdd.mjs`, `runTask`: the implement loop already mutates the local `tier` and `effort`. Change the review dispatch to read those locals instead of `task.tier`/`task.effort`:

```js
      review = await dispatchAgent(agent, reviewPrompt(task, base, head, wd), {
        label: `review:t${task.n}`, phase: "Review",
        // The tier the implementer FINISHED at, not the one the controller guessed: a task that
        // escalated to opus/high must not be checked by a reviewer picked for its original sonnet.
        model: reviewerModel(tier), effort: reviewerEffort(effort), schema: REVIEW_SCHEMA,
      });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test plugins/subagent-driven-development/workflows/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/subagent-driven-development/workflows/
git commit -m "fix(sdd): reviewers judge the diff, at the tier the implementer finished at

docs-sync:ack"
```

---

### Task 5: Gate the final fix on severity, and hoist plan conflicts to the human

`FINAL_SCHEMA.findings[]` has no `planMandated` field, so the deliberate HITL hoist that exists at the task level — plan-mandated findings route to `planConflicts` and are never auto-fixed — is absent at the whole-branch gate. A final-review finding that contradicts what the plan mandated goes straight to the fixer and gets committed. Separately the fix trigger is `else if (findings.length)`: verdict and severity play no part, so a single `Minor` nit on an `approve` verdict fires an Opus fixer plus an Opus re-review, the most expensive tail in the run.

**Files:**
- Modify: `plugins/subagent-driven-development/workflows/sdd.mjs` (`FINAL_SCHEMA` ~line 395, `finalPrompt` ~line 545, the final phase ~line 686)
- Modify: `plugins/subagent-driven-development/prompts/final-reviewer.md`
- Test: `plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs`

**Interfaces:**
- Consumes: `dispatchAgent` (Task 2).
- Produces: the workflow's return value gains nothing new here; `planConflicts` now also receives entries with `taskN: "final"`.

- [ ] **Step 1: Write the failing tests**

In `sdd.orchestration.test.mjs`:

```js
test("a lone Minor finding on an approve verdict does not trigger the final fixer", async () => {
  const { calls, result } = await runWorkflow({
    args: soloArgs(),
    respond: happyResponder({
      "final-review": { verdict: "approve", findings: [{ severity: "Minor", file: "a.js", line: "1", what: "nit", planMandated: false }], ponytailDebt: [] },
    }),
  });
  assert.equal(calls.filter((c) => c.label === "final-fix").length, 0,
    "an approve verdict with only Minors is an approval");
  assert.ok(!result.halted);
});

test("a plan-mandated final finding is hoisted to planConflicts, never auto-fixed", async () => {
  const { calls, result } = await runWorkflow({
    args: soloArgs(),
    respond: happyResponder({
      "final-review": { verdict: "changes", findings: [{ severity: "Critical", file: "a.js", line: "1", what: "the plan mandates this duplication", planMandated: true }], ponytailDebt: [] },
    }),
  });
  assert.equal(calls.filter((c) => c.label === "final-fix").length, 0);
  assert.ok(result.planConflicts.some((c) => c.taskN === "final"),
    "the human adjudicates a plan conflict; the fixer must not overwrite the plan");
});

test("a Critical final finding still triggers the fixer", async () => {
  const { calls } = await runWorkflow({
    args: soloArgs(),
    respond: happyResponder({
      "final-review": { verdict: "changes", findings: [{ severity: "Critical", file: "a.js", line: "1", what: "real bug", planMandated: false }], ponytailDebt: [] },
    }),
  });
  assert.equal(calls.filter((c) => c.label === "final-fix").length, 1);
});
```

`happyResponder` already scripts the DONE implementer, the passing reviewer and the confirming verifier; pass only the labels this test needs to differ.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs`
Expected: FAIL — the fixer runs in the first two tests.

- [ ] **Step 3: Add `planMandated` to the final schema and prompt**

In `sdd.mjs`, `FINAL_SCHEMA.findings[].items`: add `"planMandated"` to `required` and:

```js
          planMandated: { type: "boolean" },
```

In `finalPrompt`, change the return line to `findings[{severity,file,line,what,planMandated}]` and add:

```js
Set planMandated=true for any finding the plan or an ADR explicitly mandates — those go to a human to
adjudicate and are NEVER auto-fixed.
```

Mirror the same sentence in `prompts/final-reviewer.md`.

- [ ] **Step 4: Split and gate in the final phase**

In `sdd.mjs`, replace the `const findings = ...` line and the branch that follows:

```js
    const allFindings = finalReview ? (finalReview.findings || []) : [];
    allFindings.filter((f) => f.planMandated).forEach((c) => planConflicts.push({ taskN: "final", ...c }));
    // Severity, not count: an "approve" carrying one Minor nit used to fire an Opus fixer plus an
    // Opus re-review — the most expensive tail in the run, spent on a nit.
    const findings = allFindings.filter((f) => !f.planMandated && (f.severity === "Critical" || f.severity === "Important"));
    if (!finalReview) {
      halted = { wave: "final", reason: "final review returned no result", failures: [] };
    } else if (finalReview.verdict === "changes" && !allFindings.length) {
      halted = { wave: "final", reason: "final review returned verdict 'changes' with no findings to act on", failures: [] };
    } else if (findings.length) {
```

Note the `changes`-with-nothing-to-act-on guard deliberately tests `allFindings`, not the filtered list: a `changes` verdict whose only findings are Minor or plan-mandated is still a report that said something.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test plugins/subagent-driven-development/workflows/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/subagent-driven-development/workflows/ plugins/subagent-driven-development/prompts/
git commit -m "fix(sdd): final fix gates on severity, and plan-mandated findings reach the human

docs-sync:ack"
```

---

### Task 6: Stop discarding the signal the loop already collects

`cannotVerify[]` and `quality` are required by `REVIEW_SCHEMA` and read nowhere — `cannotVerify` is the single most useful thing a reviewer produces ("here is what I could not check") and it is collected and dropped. Minor findings are filtered out of `actionable` and never returned or forwarded, yet `prompts/final-reviewer.md` instructs the final reviewer to "triage the Minor findings the per-task reviews deferred" — findings it is never given, so the instruction can only be satisfied by appearing to satisfy it. And `runTask`'s success return drops `impl.concerns` and `impl.reportPath`, so a `DONE_WITH_CONCERNS` status arrives at the human with the concerns stripped off.

**Files:**
- Modify: `plugins/subagent-driven-development/workflows/sdd.mjs` (`runTask` return ~line 606, the final phase ~line 686, `finalPrompt` ~line 545, the workflow return ~line 745)
- Modify: `plugins/subagent-driven-development/prompts/final-reviewer.md`
- Test: `plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: the workflow's return value gains `deferred: { minors: [...], cannotVerify: [...] }`; each entry carries `taskN`. `results[]` entries gain `concerns` and `reportPath`.

- [ ] **Step 1: Write the failing tests**

```js
test("a successful task carries its concerns and report path to the human", async () => {
  const { result } = await runWorkflow({
    args: soloArgs(),
    respond: happyResponder({
      "impl:t1": { status: "DONE_WITH_CONCERNS", headSha: SHA("a"), testSummary: "1 pass", concerns: "the retry budget is a guess", reportPath: "/w/.sdd/task-1-report.md" },
    }),
  });
  assert.equal(result.tasks[0].concerns, "the retry budget is a guess",
    "DONE_WITH_CONCERNS with the concerns stripped is just DONE");
  assert.equal(result.tasks[0].reportPath, "/w/.sdd/task-1-report.md");
});

test("deferred Minors and cannotVerify reach the return value and the final reviewer", async () => {
  const { result, prompts } = await runWorkflow({
    args: soloArgs(),
    respond: happyResponder({
      "review:t1": {
        spec: "pass",
        findings: [{ severity: "Minor", class: "naming", file: "a.js", line: "2", what: "shadowed name", planMandated: false }],
        cannotVerify: ["could not exercise the timeout path"],
        quality: "ok", ponytail: { net: 0, items: [] },
      },
    }),
  });
  assert.equal(result.deferred.minors.length, 1);
  assert.equal(result.deferred.minors[0].taskN, "1");
  assert.equal(result.deferred.cannotVerify.length, 1);
  assert.match(prompts["final-review"], /shadowed name/);
  assert.match(prompts["final-review"], /could not exercise the timeout path/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs`
Expected: FAIL — `result.deferred` is undefined; `result.tasks[0].concerns` is undefined.

- [ ] **Step 3: Accumulate the deferred signal**

In `sdd.mjs`, beside the existing `const planConflicts = [];` declaration:

```js
  /** @type {any[]} */
  const deferredMinors = [];
  /** @type {any[]} */
  const deferredCannotVerify = [];
```

The review loop can run several rounds, and pushing on each one double-counts: a Minor that is still present after a fix round would be recorded twice for one task, and the final reviewer — told to treat a Minor recurring across tasks as not minor — would misread one task's duplicate as a cross-task signal. Only the **terminal** review describes the state of the code that is actually being returned, so collect from that one. In `runTask`, keep a reference to the last review's deferred items and push once, immediately before the success return:

```js
    // The loop's LAST review is the one that describes the code being returned; earlier rounds
    // describe code that has since been fixed. Recording every round would double-count a Minor
    // that survived a fix and make one task look like a cross-task pattern.
    (review.findings || []).filter((f) => !f.planMandated && f.severity === "Minor")
      .forEach((f) => deferredMinors.push({ taskN: task.n, ...f }));
    (review.cannotVerify || []).forEach((w) => deferredCannotVerify.push({ taskN: task.n, what: w }));
    return { task: { /* … see Step 4 … */ } };
```

Add a test alongside the others in this task pinning that:

```js
test("only the terminal review's deferred items are forwarded, not one per round", async () => {
  let reviews = 0;
  const minor = { severity: "Minor", class: "naming", file: "a.js", line: "2", what: "shadowed name", planMandated: false };
  const { result } = await runWorkflow({
    args: soloArgs(),
    respond: happyResponder({
      get "review:t1"() {
        reviews++;
        return reviews === 1
          ? { spec: "fail", findings: [minor, { severity: "Critical", class: "correctness", file: "a.js", line: "3", what: "bug", planMandated: false }], cannotVerify: [], quality: "ok", ponytail: { net: 0, items: [] } }
          : { spec: "pass", findings: [minor], cannotVerify: [], quality: "ok", ponytail: { net: 0, items: [] } };
      },
      "fix:t1.1": { headSha: SHA("a"), testSummary: "1 pass", fixed: ["bug"] },
    }),
  });
  assert.equal(result.deferred.minors.length, 1, "one surviving Minor is one entry, not one per round");
});
```

- [ ] **Step 4: Carry the implementer's signal on success**

In `sdd.mjs`, `runTask`'s success return:

```js
    return { task: {
      n: task.n, status: impl.status, headSha: head,
      reviewVerdict: review.spec, fixRounds: rounds,
      concerns: impl.concerns || "", reportPath: impl.reportPath || "",
    } };
```

- [ ] **Step 5: Give the final reviewer what it is told to triage**

In `sdd.mjs`, change `finalPrompt`'s signature to `(mergeBase, head, deferred)` and append, before the return-per-schema line:

```js
${deferred.minors.length || deferred.cannotVerify.length
  ? `\nDEFERRED FROM PER-TASK REVIEW — triage these against the whole branch. A Minor that recurs across tasks is not minor; a "could not verify" that is still unverified at branch level is a finding.\nMinors:\n${JSON.stringify(deferred.minors, null, 2)}\nCould not verify:\n${JSON.stringify(deferred.cannotVerify, null, 2)}`
  : "\nNo per-task reviews deferred anything: there are no rolled-up Minors and nothing was reported unverifiable."}
```

Update both `finalPrompt` call sites (`final-review` and `final-review-2`) to pass `{ minors: deferredMinors, cannotVerify: deferredCannotVerify }`.

In `prompts/final-reviewer.md`, change the "Rolled-up Minors" instruction to say these are supplied in the prompt, and that "nothing was deferred" is a valid and common state.

- [ ] **Step 6: Return it**

In `sdd.mjs`, add to the workflow's return object:

```js
    deferred: { minors: deferredMinors, cannotVerify: deferredCannotVerify },
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test plugins/subagent-driven-development/workflows/`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add plugins/subagent-driven-development/workflows/ plugins/subagent-driven-development/prompts/
git commit -m "fix(sdd): surface deferred Minors, cannotVerify and per-task concerns

docs-sync:ack"
```

---

### Task 6B: Refuse to dispatch into a dirty integration tree

Uncommitted changes in `workdir` are invisible to wave worktrees, which are seeded from the committed `branchTip` — and then the wave-0 merger runs `git merge --no-ff` into that dirty tree, which either aborts (halting the run and orphaning worktrees) or integrates against uncommitted local edits nobody reviewed. A line of prose in SKILL.md telling the controller to check first is not a precondition: a direct, otherwise-valid `Workflow(...)` invocation bypasses the controller entirely and is still a supported way to start a run. `sdd.mjs` is sealed — no `child_process` — so it cannot run `git status` itself; the enforcement has to be a dispatched observation the workflow then gates on deterministically, exactly as `runVerify` already does for SHAs.

(The task id is `6B` rather than `7` deliberately: ids are identity, and renumbering the tranche that follows would invalidate every reference to it. This is the behaviour PR #77 shipped.)

**Files:**
- Modify: `plugins/subagent-driven-development/workflows/sdd.mjs` (add `PREFLIGHT_SCHEMA` beside the other schemas; add the preflight before the wave loop's first iteration)
- Test: `plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs`

**Interfaces:**
- Consumes: `dispatchAgent` (Task 2).
- Produces: a `preflight:workdir` agent label in the `Implement` phase, and a `halted.wave === "preflight"` state.

- [ ] **Step 1: Write the failing tests**

```js
test("a dirty integration tree halts before any implementer is dispatched", async () => {
  const { result, calls } = await runWorkflow({
    args: soloArgs(),
    respond: happyResponder({
      "preflight:workdir": { porcelain: " M src/app.js\n?? scratch.txt", clean: false },
    }),
  });
  assert.ok(result.halted);
  assert.equal(result.halted.wave, "preflight");
  assert.match(result.halted.reason, /uncommitted|dirty/i);
  assert.equal(calls.filter((c) => c.label.startsWith("impl:")).length, 0,
    "nothing may be dispatched into a tree whose state the wave worktrees cannot see");
});

test("the preflight trusts the porcelain output, not the agent's clean flag", async () => {
  const { result } = await runWorkflow({
    args: soloArgs(),
    // The same shape acceptVerification defends against: never gate on a boolean the
    // agent could simply set — gate on the output it reported seeing.
    respond: happyResponder({ "preflight:workdir": { porcelain: " M src/app.js", clean: true } }),
  });
  assert.ok(result.halted, "non-empty porcelain is dirty however the flag is set");
});

test("a clean tree runs normally and dispatches the preflight exactly once", async () => {
  const { result, calls } = await runWorkflow({
    args: waveArgs(),
    respond: happyResponder({ "preflight:workdir": { porcelain: "", clean: true } }),
  });
  assert.ok(!result.halted);
  assert.equal(calls.filter((c) => c.label === "preflight:workdir").length, 1);
});
```

Add `"preflight:workdir": { porcelain: "", clean: true }` to `happyResponder`'s defaults so every pre-existing orchestration test keeps passing.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs`
Expected: FAIL — `unscripted agent label: preflight:workdir` is never thrown because the preflight is never dispatched; the runs complete unhalted.

- [ ] **Step 3: Add the schema**

In `sdd.mjs`, beside `VERIFY_SCHEMA`:

```js
const PREFLIGHT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["porcelain", "clean"],
  properties: {
    // The raw output of `git status --porcelain`. The workflow decides from THIS, not from
    // `clean` — same reasoning as VERIFY_SCHEMA's two SHAs: a boolean is a value the agent
    // can simply set, and the whole point of the gate is not to take its word for it.
    porcelain: { type: "string" },
    clean: { type: "boolean" },
  },
};
```

- [ ] **Step 4: Add the pure decision helper**

Inside the PURE block, so it is unit-testable:

```js
// Decide from a reported `git status --porcelain` whether dispatch may proceed. Empty output
// (modulo whitespace) is the only clean state; a missing/unreported field is NOT clean, because
// "I could not tell" must never read as "fine".
function acceptPreflight(p) {
  if (!p || typeof p.porcelain !== "string") {
    return { ok: false, reason: "preflight did not report git status output" };
  }
  const dirty = p.porcelain.split("\n").map((l) => l.trim()).filter(Boolean);
  if (dirty.length) {
    return { ok: false, reason: `workdir has ${dirty.length} uncommitted change(s) — wave worktrees are seeded from the committed tip and cannot see them: ${dirty.slice(0, 5).join("; ")}` };
  }
  return { ok: true, reason: "" };
}
```

Add `acceptPreflight` to the returned-names list in `sdd.test.mjs` line 12, and add a direct unit test for the three cases above.

- [ ] **Step 5: Dispatch and gate before the wave loop**

In `sdd.mjs`, immediately after `let base = dispatchBase(cfg);` and before the `for (let w = 0; ...)` loop:

```js
  phase("Implement");
  const pre = await dispatchAgent(agent, `You are a PREFLIGHT checker. Do not fix anything, do not commit, do not write or edit any file.
Run exactly this and report what it actually prints:
  \`git -C ${cfg.workdir} status --porcelain\`
Report the output verbatim as porcelain ("" if it printed nothing), and set clean accordingly.
Never report a result you did not observe.`, {
    label: "preflight:workdir", phase: "Implement", model: "sonnet", effort: "low", schema: PREFLIGHT_SCHEMA,
  });
  const preOk = acceptPreflight(pre);
  if (!preOk.ok) {
    halted = { wave: "preflight", reason: preOk.reason, failures: [] };
  }
```

and change the wave loop's guard so it does not run when the preflight halted (it already reads `!halted`, so this needs no change — confirm it does).

- [ ] **Step 6: Re-check cleanliness at every merge, for free**

One preflight guards the tree's state at wave 0 and nothing after. A singleton task that commits its intended change but leaves a stray uncommitted file dirties the integration tree for every later wave, and that wave's merger then merges into it — the exact failure this task exists to prevent, arriving one wave later. Re-dispatching the preflight per wave would cost an agent call each time; the merge-gate verifier already runs `git` in the integration tree, so add the field there instead and it costs nothing.

In `VERIFY_SCHEMA`, add `"porcelain"` to `required` and:

```js
    // `git status --porcelain` in the integration tree. A merge into a dirty tree either
    // aborts or silently integrates uncommitted edits nobody reviewed, and the tree can
    // become dirty at any point after the wave-0 preflight.
    porcelain: { type: "string" },
```

In `verifyPrompt`, add a numbered instruction (renumbering those after it):

```js
2. \`git -C ${cfg.workdir} status --porcelain\`
   Report its output verbatim as porcelain — "" if it printed nothing.
```

In `acceptVerification`, reuse the Task 6B helper rather than restating the rule:

```js
  const pre = acceptPreflight(v);
  if (!pre.ok) return no(pre.reason);
```

Add an orchestration test:

```js
test("a merge verified against a dirty integration tree is refused", async () => {
  const { result } = await runWorkflow({
    args: waveArgs(),
    respond: happyResponder({
      "verify:w0": { claimSha: MERGED, headSha: MERGED, baseContained: true, missingCommits: [], commitCount: 2, porcelain: " M src/leftover.js", suite: "green", evidence: "2 pass" },
    }),
  });
  assert.ok(result.halted, "a green suite in a dirty tree is not a verified merge");
  assert.match(result.halted.reason, /uncommitted/i);
});
```

Every other mock verify response in the file needs `porcelain: ""` added, including `happyResponder`'s default.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test plugins/subagent-driven-development/workflows/`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add plugins/subagent-driven-development/workflows/
git commit -m "fix(sdd): refuse to dispatch into a dirty tree, and re-check at every merge

docs-sync:ack"
```

---

### Task 7: Make `sdd-worktree` survive a pruned worktree, and make its failure a hard stop

`git worktree list --porcelain` still lists a worktree whose directory has been deleted but whose `.git/worktrees/` metadata survives (the `prunable` state). `sdd-worktree` matches that line, then runs `git -C "$path" rev-parse HEAD` against a directory that does not exist, and `set -euo pipefail` exits non-zero. The implementer's first action fails. Nothing in the prompts *instructs* a fallback to the shared integration tree — but `prompts/implementer.md` does say that a prompt naming no worktree means "work directly in the given workdir", which is one inference away, and in a parallel wave that means several implementers committing to one branch in one tree. Nothing downstream detects it: the merge verifier checks each task's sha is *contained* in HEAD, which is trivially true if they all committed there.

**Files:**
- Modify: `plugins/subagent-driven-development/scripts/sdd-worktree`
- Modify: `plugins/subagent-driven-development/prompts/implementer.md`
- Test: `plugins/subagent-driven-development/scripts/scripts.test.sh`, `plugins/subagent-driven-development/prompts/prompts.test.mjs`

**Interfaces:**
- Consumes: nothing from Tasks 1–6B (file-disjoint; runs in parallel with them).
- Produces: `sdd-worktree` keeps its `WORKDIR BASE N` argument order and prints the worktree path on success.

- [ ] **Step 1: Write the failing tests**

Append to `scripts.test.sh`, after the existing `sdd-worktree` cases:

```bash
# sdd-worktree: a registered-but-deleted (prunable) worktree is reclaimed, not fatal
wt5=$("$dir/sdd-worktree" "$repo" "$nb" 8)
rm -rf "$wt5"                     # directory gone, .git/worktrees metadata survives
wt6=$("$dir/sdd-worktree" "$repo" "$nb" 8) || { echo "FAIL: prunable worktree was fatal"; exit 1; }
[ -d "$wt6" ] || { echo "FAIL: prunable worktree not recreated"; exit 1; }
[ "$(git -C "$wt6" rev-parse HEAD)" = "$nb" ] || { echo "FAIL: recreated worktree not at base"; exit 1; }
```

In `prompts.test.mjs`, extend the implementer test:

```js
  assert.match(s, /sdd-worktree/);
  assert.match(s, /BLOCKED/);
  assert.match(s, /never.*(work|commit).*(shared|integration) (tree|workdir)/i,
    "a failed worktree command must be a hard stop, never a fallback to the shared tree");
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bash plugins/subagent-driven-development/scripts/scripts.test.sh`
Expected: FAIL with `FAIL: prunable worktree was fatal` (the `rev-parse` against the deleted directory exits non-zero under `set -e`).

Run: `node --test plugins/subagent-driven-development/prompts/prompts.test.mjs`
Expected: FAIL on the new implementer assertion.

- [ ] **Step 3: Prune before the registration check**

In `sdd-worktree`, immediately before the `git worktree list --porcelain` line:

```bash
# A worktree whose directory was deleted stays registered as "prunable". It still matches the
# list below, and the rev-parse that follows then runs against a path that does not exist —
# which under `set -e` kills the script on the implementer's very first action.
git -C "$repo" worktree prune >/dev/null 2>&1 || true
```

Use whatever variable the script already holds the repo path in; do not introduce a new one.

- [ ] **Step 4: Make the failure a hard stop in the prompt**

In `prompts/implementer.md`, in the worktree section, add:

```markdown
If your prompt gives you an `sdd-worktree` command and that command FAILS, stop and report
`BLOCKED` with its exact error. Never fall back to working in the shared workdir: in a parallel
wave that puts several implementers on one branch in one tree, and nothing downstream detects it —
the merge verifier only checks that each task's commit is *contained* in HEAD, which is trivially
true when everyone committed there. "No worktree named in the prompt" and "the worktree command
failed" are different situations with different correct responses.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bash plugins/subagent-driven-development/scripts/scripts.test.sh`
Expected: `OK`

Run: `node --test plugins/subagent-driven-development/prompts/prompts.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/subagent-driven-development/scripts/ plugins/subagent-driven-development/prompts/
git commit -m "fix(sdd): prune stale worktree metadata; a failed worktree is BLOCKED, not a fallback

docs-sync:ack"
```

---

### Task 8: An `sdd-gc` script that reports orphaned worktrees and branches

The only cleanup in the system is in `prompts/merger.md`, and it runs per merged task inside the merge loop — reached only for tasks in `succeeded`. Every halt path (merge agent returned nothing, merge unverified, task failure, wave halt) leaves `<workdir>-t<N>` worktrees and `sdd/t<N>` branches behind, and nothing sweeps them. `sdd-worktree` only reclaims a path when the *same* task id is dispatched again from a compatible base. The script must **report, not delete**: after a halt those worktrees are the evidence.

**Files:**
- Create: `plugins/subagent-driven-development/scripts/sdd-gc`
- Test: `plugins/subagent-driven-development/scripts/scripts.test.sh`

**Interfaces:**
- Consumes: Task 7's `sdd-worktree` (same file family; sequenced after it to avoid two tasks editing `scripts.test.sh`).
- Produces: `sdd-gc WORKDIR` prints one line per SDD artefact — `<merged|unmerged|prunable> worktree <path>` and `<merged|unmerged> branch sdd/t<N>` — then a `# to remove:` block of shell-quoted commands. Exit 0 whether or not anything was found.

**This tool must never mutate anything, including git metadata.** Task 7 adds `git worktree prune` to `sdd-worktree`, where reclaiming a path is the job. Here it would be a bug: pruning before enumerating silently deletes the registration for a worktree whose directory is gone — the `prunable` state — so the one artefact most likely to confuse a human is the one never reported. Report it as its own state instead.

- [ ] **Step 1: Write the failing test**

Append to `scripts.test.sh`:

```bash
# sdd-gc reports leftover SDD worktrees and branches without deleting them
gcwt=$("$dir/sdd-worktree" "$repo" "$nb" 9)
echo z > "$gcwt/z" && git -C "$gcwt" add z && git -C "$gcwt" commit -qm z
out=$("$dir/sdd-gc" "$repo")
echo "$out" | grep -q "unmerged worktree ${repo}-t9" || { echo "FAIL: sdd-gc missed the worktree"; exit 1; }
echo "$out" | grep -q "unmerged branch sdd/t9" || { echo "FAIL: sdd-gc missed the branch"; exit 1; }
echo "$out" | grep -q "# to remove:" || { echo "FAIL: sdd-gc printed no removal commands"; exit 1; }
[ -d "$gcwt" ] || { echo "FAIL: sdd-gc deleted a worktree — it must only report"; exit 1; }

# a registered-but-deleted worktree is REPORTED as prunable, never silently pruned away
rm -rf "$gcwt"
out=$("$dir/sdd-gc" "$repo")
echo "$out" | grep -q "prunable worktree ${repo}-t9" || { echo "FAIL: sdd-gc hid the prunable worktree"; exit 1; }
git -C "$repo" worktree list --porcelain | grep -qF "worktree ${repo}-t9" || { echo "FAIL: sdd-gc pruned metadata — it must only report"; exit 1; }
git -C "$repo" worktree prune
git -C "$repo" branch -D sdd/t9 >/dev/null

# the printed removal commands survive a path containing a space
spacerepo="$tmp/sdd run"
git init -q "$spacerepo" && git -C "$spacerepo" config user.email t@t && git -C "$spacerepo" config user.name t
echo a > "$spacerepo/f" && git -C "$spacerepo" add f && git -C "$spacerepo" commit -qm a
sb=$(git -C "$spacerepo" rev-parse HEAD)
"$dir/sdd-worktree" "$spacerepo" "$sb" 1 >/dev/null
eval "$("$dir/sdd-gc" "$spacerepo" | sed -n "/# to remove:/,\$p" | tail -n +2)"
[ -d "$spacerepo-t1" ] && { echo "FAIL: sdd-gc removal commands broke on a path with a space"; exit 1; }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash plugins/subagent-driven-development/scripts/scripts.test.sh`
Expected: FAIL — `sdd-gc: No such file or directory`.

- [ ] **Step 3: Write the script**

Create `plugins/subagent-driven-development/scripts/sdd-gc`, mode `755`:

```bash
#!/usr/bin/env bash
# Report SDD worktrees and branches left behind by a run. REPORTS ONLY — after a halt these
# are the evidence for the human, so removal is always the human's call.
# Usage: sdd-gc [WORKDIR]
set -euo pipefail
repo=${1:-$(pwd -P)}
repo=$(cd "$repo" && pwd -P)
git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || { echo "not a git repo: $repo" >&2; exit 2; }

# Every path and ref below is interpolated into commands a human will paste, so quote
# them: a workdir like "/tmp/sdd run" otherwise prints a command that splits the path and
# cannot remove the worktree it just reported.
q() { printf '%s' "'$(printf '%s' "$1" | sed "s/'/'\\\\''/g")'"; }

removals=""
found=0

while IFS= read -r path; do
  case "$path" in "${repo}-t"*) ;; *) continue ;; esac
  found=1
  if [ ! -d "$path" ]; then
    # Registered, directory gone. Reported, never pruned — this is the state a human is most
    # likely to be confused by, and pruning it here would delete the only evidence it existed.
    state=prunable
  elif git -C "$repo" merge-base --is-ancestor "$(git -C "$path" rev-parse HEAD)" HEAD 2>/dev/null; then
    state=merged
  else
    state=unmerged
  fi
  echo "$state worktree $path"
  removals="${removals}git -C $(q "$repo") worktree remove --force $(q "$path")"$'\n'
done < <(git -C "$repo" worktree list --porcelain | awk '/^worktree /{print substr($0, 10)}')

while IFS= read -r branch; do
  found=1
  if git -C "$repo" merge-base --is-ancestor "$branch" HEAD 2>/dev/null; then
    state=merged
  else
    state=unmerged
  fi
  echo "$state branch $branch"
  removals="${removals}git -C $(q "$repo") branch -D $(q "$branch")"$'\n'
done < <(git -C "$repo" for-each-ref --format='%(refname:short)' 'refs/heads/sdd/*')

if [ "$found" -eq 0 ]; then
  echo "no SDD worktrees or branches left behind"
  exit 0
fi
echo ""
echo "# to remove:"
printf '%s' "$removals"
```

- [ ] **Step 4: Make it executable and run the test**

```bash
chmod +x plugins/subagent-driven-development/scripts/sdd-gc
bash plugins/subagent-driven-development/scripts/scripts.test.sh
```
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add plugins/subagent-driven-development/scripts/
git commit -m "feat(sdd): add sdd-gc to report worktrees and branches a halt left behind

docs-sync:ack"
```

---

### Task 9: Reconcile the docs with the code, and bump the version

Three tiering claims disagree across README, SKILL.md and the code, in two directions at once — in the plugin whose premise is that the loop cannot drift. Plus three claims the earlier tasks have now made false or incomplete.

**Files:**
- Modify: `plugins/subagent-driven-development/README.md`
- Modify: `plugins/subagent-driven-development/skills/subagent-driven-development/SKILL.md`
- Modify: `plugins/subagent-driven-development/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` (via the bump script)

**Interfaces:**
- Consumes: the final behaviour of Tasks 1–6B, 7 and 8.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Fix the three tiering disagreements**

Delete the tiering table from `README.md` entirely and replace it with a one-line pointer to SKILL.md's table — one table, one home. Then correct SKILL.md's table so it matches the code:

- fixer is `opus`/`medium` (`sdd.mjs`'s fix dispatch), not sonnet as README claimed.
- the implementer floor is `opus`, not the sonnet floor README still described; the ladder is `opus`(low→medium→high) then optional `fable`, not `haiku → sonnet → opus → fable`.
- the reviewer is **conditional** — `opus` for an opus-tier task, `sonnet` otherwise (`reviewerModel`) — not unconditionally opus as SKILL.md's table states. After Task 4 it is derived from the tier the implementer *finished* at; say so.

- [ ] **Step 2: Fix the three now-false claims**

- SKILL.md's "Failed tasks keep their worktree and branch for inspection" is false for singleton waves, which run in the shared workdir on the integration branch. State the split, and state the recovery: a halt on a singleton task can leave unapproved commits on the branch, so check `git log` against `result.head` and `git reset` if needed.
- SKILL.md's "On return" section documents `finalFix` as `{ headSha, fixed, testSummary, verified }`. Add `postFixReview` / `postFixFindings`, with an explicit instruction to surface any Critical or Important from the post-fix review before offering to merge — that is the one place the design defers to a human and the human was never told to look. Add the new `deferred` field from Task 6.
- SKILL.md step 3 checks the branch is not `main` but never checks the tree is clean. Add `git status --porcelain` to that block. This is now belt *and* braces — Task 6B makes it an enforced precondition inside the workflow — but the controller should still fail fast rather than spend a dispatch to learn it.

- [ ] **Step 3: Document `sdd-gc`**

Add it to README's script list and to SKILL.md step 7, as the thing to run after a halted run to see what was left behind.

- [ ] **Step 4: Bump the version**

```bash
node scripts/bump-plugin.mjs subagent-driven-development minor
```
Expected: `subagent-driven-development → 0.10.0  (plugin.json + marketplace.json)`

Then re-pin every cached-path snippet that names this plugin's version — `plugins/adr/skills/adr/SKILL.md` and this plugin's own SKILL.md — and bump `adr` with `node scripts/bump-plugin.mjs adr patch`, because its pinned path is shipped content.

- [ ] **Step 5: Run the whole suite**

```bash
bash scripts/run-node-tests.sh
bash plugins/subagent-driven-development/scripts/scripts.test.sh
```
Expected: `# fail 0` and `OK`. `scripts/cached-path-pin.test.mjs` is the guard that catches a missed re-pin.

- [ ] **Step 6: Commit**

```bash
git add plugins/subagent-driven-development/ plugins/adr/ .claude-plugin/marketplace.json
git commit -m "docs(sdd): one tiering table, honest halt semantics, sdd-gc; bump to 0.10.0"
```

---

## Open Questions / Unresolved Assumptions

- **Task 1's `commitCount` at the merge gate is weaker than at a task.** `rev-list --count <waveBase>..<mergeHead>` is non-zero whenever the merger produced any merge commit, so it catches "the merger merged nothing" but not "the merger merged less than it claimed" — `missingCommits` covers that, and Step 7's wave-base check covers the no-op task underneath it. The three together are the oracle; none is sufficient alone.
- **Task 3's `FINDING_CLASSES` list is a first guess.** Eight labels chosen for coverage, not from data — no run has been sampled to see which labels reviewers actually reach for. If a real run shows reviewers straining against the enum, widen it; do not let a reviewer suppress a finding because nothing fits.
- **Task 4 removes the report from the reviewer but leaves the reviewer with no BLOCKED context.** A task that escalated three times may have context in its report that the diff does not show. The judgement here is that reviewer independence is worth more than that context; if reviews start missing things an escalated implementer knew, reconsider passing a *fixed*, factual subset (the blocker text) rather than the whole self-assessment.
- **Task 5 hoists plan-mandated final findings to `planConflicts` with `taskN: "final"`.** The controller's post-run adjudication step in SKILL.md is written for per-task conflicts; whether "final" reads naturally there is untested until a real run produces one.
- **Task 8's merged/unmerged classification uses `merge-base --is-ancestor` against the workdir's current HEAD.** If the controller has already switched branches, "merged" is answered against the wrong branch. Acceptable for a report-only tool; it would not be for one that deletes.
- **Task 6B's preflight and the merge-gate `porcelain` check overlap by design.** The preflight catches a tree that was dirty before anything ran (the common case, and it fails before spending a single implementer); the merge check catches a tree that a task dirtied mid-run. A future simplification could drop the preflight and rely on the merge check alone — but that only fires at a merge, so a linear plan would never check at all.
- **Task 6B costs one extra agent dispatch per run** — a sonnet/low preflight before wave 0. That is the price of making cleanliness a precondition rather than controller prose, given the sandbox cannot shell out. If it proves noisy in practice, the cheaper fallback is to fold the `status --porcelain` check into the first task's verifier rather than dispatch its own agent.
- **Task 6B trusts a reported string over a reported boolean,** the same defence `acceptVerification` uses for SHAs. It is still an agent's report of what git printed, not git's output — the workflow cannot do better from inside the sandbox, and it should not pretend otherwise.
- **Task 6's "collect from the terminal review only"** loses a Minor that was reported in round 1 and genuinely fixed in round 2 — correct — but also loses one that round 2's reviewer simply failed to re-report. Terminal-state is the right default; if deferred Minors start looking thin, revisit.
- **Tasks 7, 8 and 9 are cheap and mechanical** (a two-line shell fix, a new self-contained script, a doc pass). They are written as SDD tasks for uniformity, but any of them could be done inline for less ceremony than a full implement → review → fix cycle costs.
