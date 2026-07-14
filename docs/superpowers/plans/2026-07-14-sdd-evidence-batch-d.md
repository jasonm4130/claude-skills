# SDD Evidence-Based Gates (Batch D) — Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `sdd.mjs` from trusting agent claims as execution evidence. Three
defects from the Codex/Terra audit, all in `plugins/subagent-driven-development/workflows/sdd.mjs`:

- **D1 (P1):** the final fixer runs, and its result is **thrown away** — `head` is not
  updated, the suite is not rerun. **Confirmed live** on 2026-07-14: run `wf_e69a9e74-22e`
  returned `head: 6dfb959` while the fixer had already committed `3949fdf` on top of it.
  A final fix that breaks the branch is reported as a clean, approved run.
- **D2 (P2):** the wave merge agent returns `headSha` and `suite: "green"` as *strings*
  and the workflow believes them — nothing resolves the SHA or runs the suite before
  advancing `base` for the next wave. One hallucinated "green" corrupts every wave after it.
- **D3 (P2):** `validateArgs` accepts duplicate and non-integer task numbers. Two tasks
  with `n: 1` race on the same `sdd/t1` branch, `<workdir>-t1` worktree, and report path.

**Architecture:** The fix for D1 and D2 is the same primitive: **an agent's claim is a
hypothesis; a verifier's observation is evidence.** A cheap `sonnet` verifier re-resolves
the claimed SHA with `git rev-parse` and re-runs `testCmd`, and the workflow advances its
state to *the SHA the verifier actually observed*, not the one the claimant reported.

The verifier must be an `agent()` call: `sdd.mjs` runs in the sealed Workflow sandbox
(no `imports`, no `fs`, no `child_process`), so the script cannot shell out itself.

The accept/reject *decision* is a pure function (`acceptVerification`) living inside the
`// >>> PURE` block, so `sdd.test.mjs` can unit-test it by extraction — that is the
repo's established pattern for this file, and the workflow body itself is only testable
by source inspection (`sdd.smoke.test.mjs`), because a Workflow script has a top-level
`return` and cannot be `import()`ed.

**Tech Stack:** Node 18+ ESM, stdlib only, `// @ts-check`. Tests: `node --test`.

## Global Constraints

- Plugin version becomes `0.3.0` (behavior change: runs now halt on an unverifiable
  merge or final fix) in BOTH `plugins/subagent-driven-development/.claude-plugin/plugin.json`
  AND the `subagent-driven-development` entry in `.claude-plugin/marketplace.json`
  (`scripts/repo-consistency.test.mjs` asserts they match).
- **`sdd.mjs` runs in a sealed sandbox:** no `import`, no `fs`, no `child_process`, no
  `Date.now()`, no `Math.random()`. Everything the script needs must come from `args`,
  `agent()` results, or pure computation. Do not add an import to this file.
- **Every `agent()` call must set an explicit `model:`.** `sdd.smoke.test.mjs` asserts
  this by source inspection, and the `workflow-model-guard` plugin enforces it at runtime.
- New pure helpers go **inside the `// >>> PURE` … `// <<< PURE` markers** and must be
  added to the `return { … }` list at the end of that block, or `sdd.test.mjs` cannot
  extract them.
- Run the suite with `bash scripts/run-node-tests.sh`, never `node --test <dir>` (Node 24
  regressed bare-directory invocation — that is why the script exists). Single files are fine.
- All commits on branch `fix/sdd-evidence`. Every commit message ends with:
  `Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw`

---

## Task 1: Reject duplicate and non-integer task numbers (D3)

**Files:**
- Modify: `plugins/subagent-driven-development/workflows/sdd.mjs:37` (inside `validateArgs`)
- Test: `plugins/subagent-driven-development/workflows/sdd.test.mjs`

**Interfaces:** none new. `validateArgs` keeps its signature and throw-on-invalid contract.

**Background:** `validateArgs` checks `typeof t.n !== "number"`, which admits `1.5`, `-1`,
`0`, `NaN`, and — critically — two tasks both numbered `1`. Task numbers are used to build
the branch (`sdd/t{n}`), the worktree (`<workdir>-t{n}`), and the report path, so duplicates
mean two concurrent implementers writing to the same three places.

- [ ] **Step 1: Write the failing test**

In `plugins/subagent-driven-development/workflows/sdd.test.mjs`, append:

```js
test("validateArgs rejects non-integer, non-positive, and duplicate task numbers", () => {
  const withTasks = (tasks) => ({ planPath: "p.md", workdir: "/w", pluginDir: "/p", mergeBase: "abc", tasks });
  // A duplicate n means two implementers racing on sdd/t1, <workdir>-t1, and one report path.
  assert.throws(
    () => H.validateArgs(withTasks([{ n: 1, title: "a" }, { n: 1, title: "b" }])),
    /duplicate/i,
  );
  assert.throws(() => H.validateArgs(withTasks([{ n: 1.5, title: "a" }])), /integer/i);
  assert.throws(() => H.validateArgs(withTasks([{ n: 0, title: "a" }])), /integer|positive/i);
  assert.throws(() => H.validateArgs(withTasks([{ n: -1, title: "a" }])), /integer|positive/i);
  assert.throws(() => H.validateArgs(withTasks([{ n: NaN, title: "a" }])), /integer/i);
  // The valid case still passes.
  assert.equal(H.validateArgs(withTasks([{ n: 1, title: "a" }, { n: 2, title: "b" }])).tasks.length, 2);
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.test.mjs`
Expected: FAIL — no throw for the duplicate or the fractional/zero/negative cases.

- [ ] **Step 3: Tighten `validateArgs`**

In `sdd.mjs`, replace the `n` check inside the `input.tasks.map(...)` callback:

```js
    if (!Number.isInteger(t.n) || t.n <= 0) {
      throw new Error(`tasks[${i}].n must be a positive integer (got ${JSON.stringify(t.n)})`);
    }
```

Then, immediately after the `const tasks = input.tasks.map(...)` block closes, add the
uniqueness check:

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
Expected: PASS, including the pre-existing `validateArgs` tests (a valid two-task plan
still validates, tiers and limits still default).

- [ ] **Step 5: Commit**

```bash
git add plugins/subagent-driven-development/workflows/sdd.mjs \
        plugins/subagent-driven-development/workflows/sdd.test.mjs
git commit -m "fix(sdd): reject duplicate and non-integer task numbers (D3)

Task numbers name the branch (sdd/t{n}), the worktree (<workdir>-t{n}) and the report
path, so two tasks numbered 1 raced on all three. validateArgs now requires a positive
integer and enforces uniqueness.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Task 2: Verify the merge gate's claim before advancing `base` (D2)

**Files:**
- Modify: `plugins/subagent-driven-development/workflows/sdd.mjs` (add `VERIFY_SCHEMA` beside
  `MERGE_SCHEMA` ~line 215; add `acceptVerification` inside the PURE block; add a
  `verifyPrompt` builder beside `mergePrompt` ~line 303; rewire the merge gate ~lines 399-411)
- Test: `plugins/subagent-driven-development/workflows/sdd.test.mjs`
- Test: `plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs`

**Interfaces:**
- Produces (Task 3 consumes both):
  - `acceptVerification(v, claimedSha, testCmd)` → `{ ok: boolean, reason: string, headSha: string }`.
    Pure. `headSha` is the SHA the **verifier observed**, which is what callers must advance to.
  - `verifyPrompt(claimedSha, claim)` → prompt string for a read-only verifier agent.
  - `VERIFY_SCHEMA` — `{ shaExists, headSha, suite: "green"|"red"|"unknown", evidence }`.

**Background:** at `sdd.mjs:405-409` the workflow pushes the merge agent's self-reported
`headSha` into `merges` and sets `base = merge.headSha` whenever `merge.suite !== "red"`.
Both values are just strings the agent emitted under a schema — nothing resolves the SHA
against git, and nothing runs `testCmd`. A merger that hallucinates `suite: "green"` (or an
honest one that mistypes a SHA) silently poisons the base of every subsequent wave.

`suite: "unknown"` is a legitimate outcome when the controller passed no `testCmd` — in that
case only the SHA is verifiable, and `acceptVerification` must not fail the run for a suite
it never asked anyone to run.

- [ ] **Step 1: Write the failing tests**

In `sdd.test.mjs`, add `acceptVerification` to the destructured `H` extraction list at the
top of the file (the `return { … }` in the `new Function(...)` call), then append:

```js
test("acceptVerification: an unresolvable SHA is rejected", () => {
  const r = H.acceptVerification({ shaExists: false, headSha: "", suite: "unknown", evidence: "bad object" }, "deadbeef", "npm test");
  assert.equal(r.ok, false);
  assert.match(r.reason, /deadbeef/);
});

test("acceptVerification: a red suite is rejected when a testCmd was configured", () => {
  const r = H.acceptVerification({ shaExists: true, headSha: "abc123", suite: "red", evidence: "2 failing" }, "abc123", "npm test");
  assert.equal(r.ok, false);
  assert.match(r.reason, /red/);
});

test("acceptVerification: a claimed-green suite the verifier could not confirm is rejected", () => {
  // The D2 bug: the merger says green, the verifier could not actually run the suite.
  const r = H.acceptVerification({ shaExists: true, headSha: "abc123", suite: "unknown", evidence: "" }, "abc123", "npm test");
  assert.equal(r.ok, false, "with a testCmd configured, 'unknown' is not evidence of green");
});

test("acceptVerification: suite 'unknown' is accepted when no testCmd was configured", () => {
  const r = H.acceptVerification({ shaExists: true, headSha: "abc123", suite: "unknown", evidence: "rev-parse ok" }, "abc123", "");
  assert.equal(r.ok, true, "we cannot require a suite result we never asked for");
  assert.equal(r.headSha, "abc123");
});

test("acceptVerification: returns the OBSERVED head, not the claimed one", () => {
  // Evidence beats claim: the caller must advance to what git actually resolved.
  const r = H.acceptVerification({ shaExists: true, headSha: "real999", suite: "green", evidence: "294 pass" }, "claimed1", "npm test");
  assert.equal(r.ok, true);
  assert.equal(r.headSha, "real999");
});

test("acceptVerification: a missing verifier result is rejected", () => {
  assert.equal(H.acceptVerification(null, "abc123", "npm test").ok, false);
});
```

In `sdd.smoke.test.mjs`, append (this file asserts wiring by source inspection — the body
cannot be imported):

```js
test("the merge gate advances base only on verified evidence", () => {
  assert.match(src, /VERIFY_SCHEMA/, "a verification schema exists");
  assert.match(src, /label: `verify:w\$\{/, "each wave merge is verified");
  assert.match(src, /acceptVerification\(/, "the accept decision is the pure helper");
  // base must never be set straight from the merge agent's self-reported SHA.
  assert.doesNotMatch(src, /base\s*=\s*merge\.headSha/, "base must come from the verifier, not the merger's claim");
});
```

- [ ] **Step 2: Run them and verify they fail**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.test.mjs plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs`
Expected: FAIL — `acceptVerification` is not exported from the PURE block (undefined), and
the smoke test still finds `base = merge.headSha`.

- [ ] **Step 3: Add `acceptVerification` to the PURE block**

In `sdd.mjs`, inside the `// >>> PURE` block (put it after `partitionWaveResults`), add:

```js
/**
 * Decide whether a verifier's observation supports an agent's claim.
 *
 * An agent's `headSha` / `suite` are a hypothesis: they are strings it emitted under a
 * schema, not evidence. This gates on what the verifier actually observed, and hands back
 * the SHA git really resolved — callers advance to THAT, never to the claim.
 *
 * `suite: "unknown"` is legitimate only when no testCmd was configured; with one, an
 * unconfirmable suite is not evidence of green.
 */
function acceptVerification(v, claimedSha, testCmd) {
  if (!v) return { ok: false, reason: "verifier returned no result", headSha: "" };
  if (!v.shaExists) {
    return { ok: false, reason: `claimed head ${claimedSha} does not resolve to a commit`, headSha: "" };
  }
  if (testCmd && v.suite !== "green") {
    return { ok: false, reason: `suite is ${v.suite} at ${v.headSha || claimedSha}`, headSha: "" };
  }
  return { ok: true, reason: "", headSha: v.headSha || claimedSha };
}
```

Add `acceptVerification` to the `return { … }` list at the end of the PURE block — without
that, `sdd.test.mjs` cannot extract it.

- [ ] **Step 4: Add `VERIFY_SCHEMA` and the `verifyPrompt` builder**

Beside `MERGE_SCHEMA` (~line 215), add:

```js
const VERIFY_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["shaExists", "headSha", "suite", "evidence"],
  properties: {
    shaExists: { type: "boolean" },
    headSha: { type: "string" },
    suite: { type: "string", enum: ["green", "red", "unknown"] },
    evidence: { type: "string" },
  },
};
```

Beside `mergePrompt` (~line 303, inside the same scope that closes over `cfg`), add:

```js
  const verifyPrompt = (claimedSha, claim) => `You are a VERIFIER. Do not fix anything, do
not commit, do not write or edit any file. Observe and report.

Working directory: ${cfg.workdir}

Another agent claims: ${claim}
Claimed head SHA: ${claimedSha}

Do exactly this and report only what you observe:

1. Resolve the claimed SHA:
   \`git -C ${cfg.workdir} rev-parse --verify ${claimedSha}^{commit}\`
   If it fails, set shaExists=false, put the error text in evidence, and stop.
2. Read the branch's real current head:
   \`git -C ${cfg.workdir} rev-parse HEAD\`
   Report it as headSha — the full SHA git printed, not the claimed one.
${cfg.testCmd
  ? `3. Run the suite VERBATIM from ${cfg.workdir}:
   \`${cfg.testCmd}\`
   Read its actual output. suite="green" ONLY if it ran to completion with zero failures.
   Anything else — failures, a crash, a command that would not run — is "red".
   Quote the real pass/fail summary line in evidence.`
  : `3. No test command was configured for this run, so you cannot run a suite:
   set suite="unknown" and put the rev-parse output in evidence.`}

Never report a result you did not observe. If a command fails, say what it printed. A claim
you cannot confirm is not confirmed.`;
```

- [ ] **Step 5: Rewire the merge gate**

Replace the merge-result handling (the `else { merges.push(...) … }` branch at ~lines 405-411):

```js
      } else {
        const verify = await agent(
          verifyPrompt(merge.headSha, `wave ${w} merged task(s) ${merge.merged.join(", ")} and left the suite ${merge.suite}`),
          { label: `verify:w${w}`, phase: "Merge", model: "sonnet", schema: VERIFY_SCHEMA },
        );
        const acc = acceptVerification(verify, merge.headSha, cfg.testCmd);
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
          // The merger claimed green; the verifier could not confirm it. Do not let an
          // unverified base poison every wave after this one.
          halted = { wave: w, reason: `merge gate unverified: ${acc.reason}`, failures };
        } else {
          base = acc.headSha;
          succeeded.forEach((t) => results.push(t));
        }
      }
```

- [ ] **Step 6: Run the tests and verify they pass**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.test.mjs plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs`
Expected: PASS — including the pre-existing smoke assertions (`every agent() call sets an
explicit model` must still pass: the new `verify:w${w}` call sets `model: "sonnet"`).

- [ ] **Step 7: Commit**

```bash
git add plugins/subagent-driven-development/workflows/sdd.mjs \
        plugins/subagent-driven-development/workflows/sdd.test.mjs \
        plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs
git commit -m "fix(sdd): verify the merge gate's claim before advancing base (D2)

The wave merger returned headSha and suite:'green' as strings and the workflow believed
them — nothing resolved the SHA against git, nothing ran testCmd. One hallucinated 'green'
poisoned the base of every subsequent wave. A sonnet verifier now re-resolves the SHA and
re-runs the suite, and base advances to the SHA the VERIFIER observed, not the one the
merger claimed. An unconfirmable claim halts the run.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Task 3: Capture and verify the final fixer's work (D1)

**Files:**
- Modify: `plugins/subagent-driven-development/workflows/sdd.mjs:420-430` (the `Final` phase)
  and the returned result object (~line 434)
- Test: `plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs`

**Interfaces:**
- Consumes: `acceptVerification`, `verifyPrompt`, `VERIFY_SCHEMA` from Task 2.
- Produces: a new `finalFix` key on the workflow's return value:
  `{ headSha, fixed: string[], testSummary, verified: true } | null`.

**Background:** at `sdd.mjs:425-428` the workflow dispatches the final fixer and **discards
its return value**. `head` therefore still points at the pre-fix commit, the final review is
not re-run, and the suite is not re-run — so a final fix that breaks the branch is reported
as an approved, green run. This is not hypothetical: on 2026-07-14 the codex-review build
(`wf_e69a9e74-22e`) returned `head: 6dfb959` while the fixer had already committed `3949fdf`
on top of it.

The fix is bounded on purpose: **verify once, do not re-review.** Re-running the whole-branch
Opus review after every fix invites an unbounded review→fix→review loop; the plan's contract
is one fix pass, then evidence.

- [ ] **Step 1: Write the failing test**

In `sdd.smoke.test.mjs`, append:

```js
test("the final fixer's result is captured, verified, and reflected in head", () => {
  // The D1 bug: `await agent(finalFixPrompt(...), {...})` with the result thrown away.
  assert.doesNotMatch(
    src,
    /\n\s*await agent\(finalFixPrompt\(/,
    "the final fixer's result must be captured, not discarded",
  );
  assert.match(src, /label: "verify:final-fix"/, "the final fix is verified");
  assert.match(src, /finalFix/, "the run reports what the final fixer did");
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs`
Expected: FAIL — the source still contains a bare `await agent(finalFixPrompt(`.

- [ ] **Step 3: Capture, verify, and advance**

Replace the `Final` phase block (~lines 420-430):

```js
  let finalReview = null;
  let finalFix = null;
  if (!halted && results.length) {
    phase("Final");
    finalReview = await agent(finalPrompt(cfg.mergeBase, base), {
      label: "final-review", phase: "Final", model: "opus", schema: FINAL_SCHEMA,
    });
    if (finalReview && (finalReview.findings || []).length) {
      const fix = await agent(finalFixPrompt(finalReview.findings), {
        label: "final-fix", phase: "Final", model: "sonnet", schema: FIX_SCHEMA,
      });
      if (!fix) {
        halted = { wave: "final", reason: "final fixer returned no result", failures: [] };
      } else {
        // Bounded on purpose: verify once, do not re-run the whole-branch review — that
        // invites an unbounded review -> fix -> review loop.
        const verify = await agent(
          verifyPrompt(fix.headSha, `the final fixer addressed ${finalReview.findings.length} finding(s) and left the suite: ${fix.testSummary}`),
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

In the returned object (~line 434), add `finalFix` beside `finalReview`, and add it to
`meta`:

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

Note `halted.wave` is now sometimes the string `"final"` rather than a wave number. That is
intentional — a halt in the Final phase is not a wave — and the controller only prints it.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `node --test plugins/subagent-driven-development/workflows/sdd.test.mjs plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs`
Expected: PASS, including `every agent() call sets an explicit model` (the new
`verify:final-fix` call sets `model: "sonnet"`).

- [ ] **Step 6: Commit**

```bash
git add plugins/subagent-driven-development/workflows/sdd.mjs \
        plugins/subagent-driven-development/workflows/sdd.smoke.test.mjs
git commit -m "fix(sdd): capture and verify the final fixer's work (D1)

The final fixer ran and its result was discarded: head stayed at the pre-fix commit and
the suite was never re-run, so a final fix that broke the branch was reported as an
approved, green run. Observed live in wf_e69a9e74-22e, which returned head 6dfb959 while
the fixer had already committed 3949fdf on top of it.

The fix is now verified once (rev-parse + suite), head advances to the SHA the verifier
observed, an unverifiable fix halts the run, and the result reports finalFix.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Task 4: Document the evidence gates + version bump to 0.3.0

**Files:**
- Modify: `plugins/subagent-driven-development/skills/subagent-driven-development/SKILL.md`
  (the "On return" section, ~line 130)
- Modify: `plugins/subagent-driven-development/README.md`
- Modify: `plugins/subagent-driven-development/.claude-plugin/plugin.json` (→ `0.3.0`)
- Modify: `.claude-plugin/marketplace.json` (`subagent-driven-development` entry → `0.3.0`)
- Test: `scripts/repo-consistency.test.mjs` (existing), and the plugin's `skill.test.mjs`
  / `manifest.test.mjs` must keep passing.

**Interfaces:** none.

- [ ] **Step 1: Bump the version in both registries**

`plugins/subagent-driven-development/.claude-plugin/plugin.json`: `"version": "0.2.2"` → `"0.3.0"`.
`.claude-plugin/marketplace.json`, `subagent-driven-development` entry: same bump.

Minor, not patch: an unverifiable merge or final fix now **halts** a run that previously
completed.

- [ ] **Step 2: Document the return shape and the gates in SKILL.md**

In the "### 7. On return: present, adjudicate, finish" section, add `finalFix` to the
returned-keys list and describe the two new halt reasons. Keep it to the existing bullet
style:

- `**finalFix**` → `{ headSha, fixed, testSummary, verified }` — what the final fixer
  changed, verified against git and the suite. `head` points past it. `null` when the final
  review found nothing to fix.
- Note under `halted`: a halt can now come from the **Final** phase (`wave: "final"`) when a
  final fix cannot be verified, and from a merge gate whose claimed green the verifier could
  not confirm (`merge gate unverified: …`).

Add one sentence to the section that explains the principle, because it is the reason a run
can now halt where it previously passed: *an agent's `headSha`/`suite` is a claim; the
workflow advances only on a verifier's observation, and to the SHA the verifier actually
resolved.*

- [ ] **Step 3: Same in the plugin README**

Add the same two or three sentences to `plugins/subagent-driven-development/README.md` where
the merge gate and final review are described. Do not restructure it.

- [ ] **Step 4: Run the full suite**

Run: `bash scripts/run-node-tests.sh`
Expected: PASS, 0 fail — including `scripts/repo-consistency.test.mjs`'s
plugin.json↔marketplace.json version match (fails if only one bump landed) and the plugin's
own `skill.test.mjs` / `manifest.test.mjs`.

- [ ] **Step 5: Commit**

```bash
git add plugins/subagent-driven-development/skills/subagent-driven-development/SKILL.md \
        plugins/subagent-driven-development/README.md \
        plugins/subagent-driven-development/.claude-plugin/plugin.json \
        .claude-plugin/marketplace.json
git commit -m "docs(sdd): document the evidence gates, bump to 0.3.0

An agent's headSha/suite is a claim, not evidence: the workflow now advances only on a
verifier's observation, and to the SHA the verifier actually resolved. Documents the new
finalFix return key and the two new halt reasons (unverified merge gate, unverified final
fix). Minor bump: runs that previously completed on an unverifiable claim now halt.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Out of scope

- Batch C (`deep-dive`: schema-valid junk, silently dropped angles) — separate branch.
- Batch B2 (the handoff statusline guard redesign) and B3 (handoff provenance/injection).
- The `adversarial-agents` README/SKILL contradiction (A3).
- Re-running the whole-branch review after a final fix. Deliberately excluded: it turns a
  bounded one-shot fix into an unbounded review→fix→review loop. One verification is the
  contract.
