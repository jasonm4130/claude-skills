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
