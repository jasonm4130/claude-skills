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
 * @returns {Promise<{result: any, calls: {label: string, model: string, phase: string}[], prompts: Record<string,string>}>}
 */
async function runWorkflow({ args, respond }) {
  /** @type {{label: string, model: string, phase: string}[]} */
  const calls = [];
  /** @type {Record<string,string>} */
  const prompts = {};
  const agent = async (prompt, opts = {}) => {
    const label = opts.label || "(unlabeled)";
    assert.ok(opts.model, `agent(${label}) must set an explicit model`);
    // phase is what the progress tree groups by; a mis-grouped agent is invisible to the human
    // watching the run, which is the whole point of the tree.
    calls.push({ label, model: opts.model, phase: opts.phase || "(none)" });
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
      return { headSha: MERGED, merged: ["1", "2"], conflictsResolved: [], testSummary: "2 pass", suite: "green" };
    }
    if (label === "preflight:workdir") {
      // Default: the integration tree is clean, so the run proceeds.
      return { porcelain: "", clean: true };
    }
    if (label.startsWith("verify:")) {
      // Default: the verifier confirms whatever was claimed. Tests override to inject disagreement.
      return { claimSha: MERGED, headSha: MERGED, baseContained: true, missingCommits: [], commitCount: 1, porcelain: "", suite: "green", evidence: "2 pass, 0 fail" };
    }
    if (label === "final-review" || label === "final-review-2") return { verdict: "approve", findings: [], ponytailDebt: [] };
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
      "verify:w0": { claimSha: MERGED, headSha: MERGED, baseContained: true, missingCommits: [], commitCount: 1, porcelain: "", suite: "red", evidence: "3 failing" },
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
      "verify:w0": { claimSha: MERGED, headSha: SHA("f"), missingCommits: [], commitCount: 1, porcelain: "", suite: "green", evidence: "ok" },
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
      "verify:t1": { claimSha: SHA("a"), headSha: SHA("a"), baseContained: true, missingCommits: [], commitCount: 1, porcelain: "", suite: "green", evidence: "1 pass" },
    }),
  });
  assert.equal(result.halted, null);
  assert.equal(result.head, SHA("a"));
  assert.ok(calls.some((c) => c.label === "verify:t1"), "a singleton task is verified too");
});

test("injection: a malformed claimed sha fails closed WITHOUT dispatching a verifier", async () => {
  // The verifier's prompt interpolates this string into git commands it will run.
  const { result, calls } = await runWorkflow({
    args: soloArgs(),
    respond: happyResponder({
      "impl:t1": { status: "DONE", headSha: "abc123; rm -rf ~ #", testSummary: "1 pass", concerns: "", reportPath: "/w/r.md" },
    }),
  });
  assert.ok(result.halted, "a non-sha head must halt");
  assert.ok(
    !calls.some((c) => c.label.startsWith("verify:")),
    "fail closed: no agent may be dispatched with an unvalidated sha in its prompt",
  );
});

test("singleton wave: an unverifiable task halts instead of advancing base", async () => {
  const { result } = await runWorkflow({
    args: soloArgs(),
    respond: happyResponder({
      "verify:t1": { claimSha: SHA("a"), headSha: SHA("a"), baseContained: true, missingCommits: [], commitCount: 1, porcelain: "", suite: "red", evidence: "1 failing" },
    }),
  });
  assert.ok(result.halted);
  assert.match(result.halted.reason, /unverified/i);
});

const FIXED = SHA("e");

test("final fix: head advances past the fixer's commit and finalFix is reported", async () => {
  // The live D1 bug: wf_e69a9e74-22e returned head 6dfb959 while the fixer had committed 3949fdf.
  const { result, calls } = await runWorkflow({
    args: waveArgs(),
    respond: happyResponder({
      "final-review": { verdict: "changes", findings: [{ severity: "Critical", file: "a.mjs", line: "1", what: "x", planMandated: false }], ponytailDebt: [] },
      "final-fix": { headSha: FIXED, testSummary: "294 pass", fixed: ["x"] },
      "verify:final-fix": { claimSha: FIXED, headSha: FIXED, baseContained: true, missingCommits: [], commitCount: 1, porcelain: "", suite: "green", evidence: "294 pass, 0 fail" },
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
      "final-review": { verdict: "changes", findings: [{ severity: "Critical", file: "a.mjs", line: "1", what: "x", planMandated: false }], ponytailDebt: [] },
      "final-fix": { headSha: FIXED, testSummary: "claims green", fixed: ["x"] },
      "verify:final-fix": { claimSha: FIXED, headSha: FIXED, baseContained: true, missingCommits: [], commitCount: 1, porcelain: "", suite: "red", evidence: "2 failing" },
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

// ---------------------------------------------------------------------------
// Dispatch failures. A dispatch can REJECT rather than resolve null (a withdrawn tier, a transient
// API failure). An uncaught rejection escapes the workflow body, so the run returns nothing at all —
// no halted state, no tasks, no merges — and SDD's resume state is session-memory-only.
// `happyResponder` returns its override by property access, so a getter is how a scripted label
// throws instead of resolving.
// ---------------------------------------------------------------------------

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
      "verify:final-fix": { claimSha: FIXED, headSha: FIXED, baseContained: true, missingCommits: [], commitCount: 1, porcelain: "", suite: "green", evidence: "3 pass" },
      get "final-review-2"() { return throwing(); },
    }),
  });
  assert.ok(result.halted, "a green fix whose re-review never ran is not a reviewed head");
  assert.match(result.halted.reason, /post-fix review/i);
});

// ---------------------------------------------------------------------------
// Phases. The progress tree groups agents by `phase`, and that grouping is the only view a human has
// of a long run. Fix agents used to be tagged "Review" — so repairs rendered inside the box that
// FOUND the problems, and the signal that matters most was invisible: fix rounds are a plan-quality
// smell. A task that needed two rounds is telling you the plan was underspecified, and you could not
// see that at a glance.
// ---------------------------------------------------------------------------

/** @param {{label:string,phase:string}[]} calls @param {string} label */
const phaseOf = (calls, label) => calls.find((c) => c.label === label)?.phase;

test("phases: a per-task fix runs in its OWN phase, not inside Review", async () => {
  // One review round finds something, the fixer fixes it, the second round passes.
  let reviewed = 0;
  const respond = happyResponder({});
  const { result, calls } = await runWorkflow({
    args: soloArgs(),
    respond: (label, prompt) => {
      if (label === "review:t1") {
        reviewed++;
        return reviewed === 1
          ? { spec: "fail", quality: "meh", cannotVerify: [], ponytail: { net: 0, items: [] },
              findings: [{ severity: "Important", class: "correctness", file: "a.ts", line: 1, what: "off-by-one", planMandated: false }] }
          : { spec: "pass", findings: [], cannotVerify: [], quality: "fine", ponytail: { net: 0, items: [] } };
      }
      if (label === "fix:t1.1") return { headSha: SHA("f"), testSummary: "1 pass", fixed: ["off-by-one"] };
      if (label.startsWith("verify:")) {
        return { claimSha: SHA("f"), headSha: SHA("f"), baseContained: true, missingCommits: [], commitCount: 1, porcelain: "", suite: "green", evidence: "1 pass, 0 fail" };
      }
      return respond(label, prompt);
    },
  });

  assert.equal(result.halted, null, JSON.stringify(result.halted));
  assert.equal(phaseOf(calls, "review:t1"), "Review", "the reviewer stays in Review");
  assert.equal(phaseOf(calls, "fix:t1.1"), "Fix",
    "a fixer is not a reviewer — burying repairs in the Review box hides the fix-round count");
  assert.equal(result.tasks[0].fixRounds, 1);
});

test("oscillation: a class surviving ONE fix gets the second attempt fixRounds:2 promises", async () => {
  // The pre-fix review is the baseline: a class in it has not survived anything yet. Counting it
  // made "the first repair didn't fully land" — the normal shape of a two-round fix — look like
  // oscillation and halt the task at rounds === 1.
  let reviewed = 0;
  const respond = happyResponder({});
  const finding = { severity: "Important", class: "correctness", file: "a.ts", line: "1", what: "off-by-one", planMandated: false };
  const { result, calls } = await runWorkflow({
    args: soloArgs(),
    respond: (label, prompt) => {
      if (label === "review:t1") {
        reviewed++;
        return reviewed <= 2
          ? { spec: "fail", quality: "meh", cannotVerify: [], ponytail: { net: 0, items: [] }, findings: [finding] }
          : { spec: "pass", findings: [], cannotVerify: [], quality: "fine", ponytail: { net: 0, items: [] } };
      }
      if (label.startsWith("fix:t1.")) return { headSha: SHA("f"), testSummary: "1 pass", fixed: ["off-by-one"] };
      if (label.startsWith("verify:")) {
        return { claimSha: SHA("f"), headSha: SHA("f"), baseContained: true, missingCommits: [], commitCount: 1, porcelain: "", suite: "green", evidence: "1 pass, 0 fail" };
      }
      return respond(label, prompt);
    },
  });

  assert.equal(result.halted, null, JSON.stringify(result.halted));
  assert.ok(calls.some((c) => c.label === "fix:t1.2"), "the second fix round must be dispatched");
  assert.equal(result.tasks[0].fixRounds, 2);
});

test("phases: every agent declares a phase, and the verifier's is passed in — not string-matched from its own label", async () => {
  // sdd.mjs used to derive the verifier's phase with `label === "verify:final-fix" ? "Final" : "Merge"`.
  // That is a string match on the agent's own label standing in for a fact the CALLER already knows,
  // and it silently mis-groups any verify: label added later (e.g. the singleton-wave verify:t1, which
  // is not a merge at all).
  const { result, calls } = await runWorkflow({ args: waveArgs(), respond: happyResponder() });
  assert.equal(result.halted, null);

  for (const c of calls) {
    assert.notEqual(c.phase, "(none)", `agent ${c.label} must declare a phase`);
  }
  assert.equal(phaseOf(calls, "merge:w0"), "Merge");
  assert.equal(phaseOf(calls, "verify:w0"), "Merge", "a merge's verifier belongs with the merge");
  assert.equal(phaseOf(calls, "final-review"), "Final");
});

test("phases: a SINGLETON wave's verifier is not mislabelled as a Merge — there is no merge", async () => {
  const { result, calls } = await runWorkflow({ args: soloArgs(), respond: happyResponder() });
  assert.equal(result.halted, null);
  assert.equal(phaseOf(calls, "verify:t1"), "Implement",
    "a singleton wave never merges; its verifier checks the implementer's claim, so it belongs with Implement");
});

test("return value: no path-shaped key points at a file the run never creates", async () => {
  // The workflow sandbox has no fs — it cannot create or append to a ledger file. Returning
  // `ledgerPath` claims a durable progress record that nothing ever writes.
  const { result } = await runWorkflow({ args: soloArgs(), respond: happyResponder() });
  assert.equal(result.halted, null);
  assert.ok(!("ledgerPath" in result), "result must not advertise an unwritten ledger file");
});

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

// ---------------------------------------------------------------------------
// Signal the loop collects and used to drop: the implementer's concerns, the reviewer's
// cannotVerify[], and the Minors filtered out of `actionable`. The final reviewer is TOLD to triage
// the deferred Minors, so it has to actually be given them.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Preflight. Wave worktrees are seeded from the committed branch tip, so uncommitted changes in the
// integration workdir are invisible to them — and the wave merger then merges into that dirty tree,
// which either aborts (orphaning worktrees) or integrates local edits nobody reviewed. sdd.mjs has
// no child_process, so the check is a dispatched observation the workflow gates on itself.
// ---------------------------------------------------------------------------

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

test("an implementer that escalated to fable is reviewed at fable, not dropped to sonnet", async () => {
  // "fable" is not in TIERS, so a reviewer lookup that only special-cases opus falls through to
  // sonnet — the run's hardest task, four escalations deep, checked by its weakest reviewer.
  let implCalls = 0;
  const { calls } = await runWorkflow({
    args: {
      ...soloArgs(),
      limits: { escalateAttempts: 1 },
      tasks: [{ n: 1, title: "a", tier: "opus", effort: "high", deps: [] }],
    },
    respond: happyResponder({
      get "impl:t1"() {
        implCalls++;
        return implCalls === 1
          ? { status: "BLOCKED", headSha: "", testSummary: "", concerns: "stuck", reportPath: "r.md" }
          : { status: "DONE", headSha: SHA("a"), testSummary: "1 pass", concerns: "", reportPath: "r.md" };
      },
    }),
  });
  const lastImpl = calls.filter((c) => c.label === "impl:t1").pop();
  const review = calls.find((c) => c.label === "review:t1");
  assert.equal(lastImpl.model, "fable", "an exhausted opus/high escalates to fable");
  assert.equal(review.model, "fable", "the reviewer must not sit below the implementer it checks");
});

test("a final 'changes' verdict with only Minor findings runs no fixer but is flagged in meta", async () => {
  const { result, calls } = await runWorkflow({
    args: soloArgs(),
    respond: happyResponder({
      "final-review": { verdict: "changes", findings: [{ severity: "Minor", what: "nit", where: "a.js", class: "style" }], ponytailDebt: [] },
    }),
  });
  assert.equal(result.halted, null, "a Minor nit is not a halt");
  assert.equal(calls.filter((c) => c.label === "final-fix").length, 0, "severity gating: no Opus fixer for a nit");
  assert.equal(result.meta.finalFixApplied, false);
  assert.equal(result.meta.finalVerdict, "changes");
  assert.equal(result.meta.finalChangesUnaddressed, true,
    "a 'do not merge yet' verdict must not report as a clean completed run");
});

test("an approved final review is not flagged as unaddressed changes", async () => {
  const { result } = await runWorkflow({ args: soloArgs(), respond: happyResponder() });
  assert.equal(result.meta.finalVerdict, "approve");
  assert.equal(result.meta.finalChangesUnaddressed, false);
});
