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
      return { claimSha: MERGED, headSha: MERGED, baseContained: true, missingCommits: [], suite: "green", evidence: "2 pass, 0 fail" };
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
      "verify:w0": { claimSha: MERGED, headSha: MERGED, baseContained: true, missingCommits: [], suite: "red", evidence: "3 failing" },
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
      "verify:t1": { claimSha: SHA("a"), headSha: SHA("a"), baseContained: true, missingCommits: [], suite: "green", evidence: "1 pass" },
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
      "verify:t1": { claimSha: SHA("a"), headSha: SHA("a"), baseContained: true, missingCommits: [], suite: "red", evidence: "1 failing" },
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
      "final-review": { verdict: "approve", findings: [{ severity: "Minor", file: "a.mjs", line: "1", what: "x" }], ponytailDebt: [] },
      "final-fix": { headSha: FIXED, testSummary: "294 pass", fixed: ["x"] },
      "verify:final-fix": { claimSha: FIXED, headSha: FIXED, baseContained: true, missingCommits: [], suite: "green", evidence: "294 pass, 0 fail" },
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
      "verify:final-fix": { claimSha: FIXED, headSha: FIXED, baseContained: true, missingCommits: [], suite: "red", evidence: "2 failing" },
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
