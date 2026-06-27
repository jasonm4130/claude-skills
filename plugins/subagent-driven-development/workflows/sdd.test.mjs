import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Extract the PURE block from sdd.mjs and evaluate it (mirrors fanout.test.mjs).
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "sdd.mjs"), "utf8");
const pure = src.split("// >>> PURE")[1].split("// <<< PURE")[0];
const H = new Function(
  `${pure}; return { TIERS, validateArgs, sequenceTasks, nextTier, reviewerModel, maxAttemptsAtTier, detectOscillation, ledgerLine };`,
)();

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
  assert.throws(
    () => H.validateArgs({ planPath: "p", workdir: "w", pluginDir: "d", mergeBase: "m", tasks: [] }),
    /non-empty array/,
  );
});

test("sequenceTasks sorts by n and rejects forward deps", () => {
  assert.deepEqual(
    H.sequenceTasks([{ n: 2, title: "b", deps: [1] }, { n: 1, title: "a", deps: [] }]).map((t) => t.n),
    [1, 2],
  );
  assert.throws(
    () => H.sequenceTasks([{ n: 1, title: "a", deps: [2] }, { n: 2, title: "b", deps: [] }]),
    /does not precede/,
  );
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
