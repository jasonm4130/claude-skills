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
  `${pure}; return { TIERS, validateArgs, sequenceTasks, nextTier, reviewerModel, maxAttemptsAtTier, detectOscillation, ledgerLine, computeWaves, taskWorkdir, runPool, partitionWaveResults, dispatchBase };`,
)();

const okArgs = () => ({
  planPath: "p.md", workdir: "/w", pluginDir: "/p", mergeBase: "abc",
  tasks: [{ n: 1, title: "a" }, { n: 2, title: "b", tier: "opus", deps: [1] }],
});

test("validateArgs accepts a valid object and defaults tiers/limits", () => {
  const c = H.validateArgs(okArgs());
  assert.equal(c.tasks[0].tier, "sonnet");
  assert.equal(c.tasks[1].tier, "opus");
  assert.deepEqual(c.limits, { fixRounds: 2, escalateAttempts: 2, maxParallel: 4 });
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

test("validateArgs accepts adrPath as an alias for planPath", () => {
  const { planPath: _drop, ...rest } = okArgs();
  const c = H.validateArgs({ ...rest, adrPath: "docs/adr/2026-06-27-x.md" });
  assert.equal(c.planPath, "docs/adr/2026-06-27-x.md");
});

test("validateArgs still requires a path when neither planPath nor adrPath is given", () => {
  assert.throws(() => H.validateArgs({}), /planPath is required/);
  const { planPath: _drop, ...rest } = okArgs();
  assert.throws(() => H.validateArgs(rest), /planPath is required/);
});

test("validateArgs threads successCriteria, defaulting to empty string", () => {
  assert.equal(H.validateArgs(okArgs()).successCriteria, "");
  const c = H.validateArgs({ ...okArgs(), successCriteria: "GET /x returns 200 with shape Y" });
  assert.equal(c.successCriteria, "GET /x returns 200 with shape Y");
});

test("validateArgs threads branchTip, defaulting to empty string", () => {
  assert.equal(H.validateArgs(okArgs()).branchTip, "");
  const c = H.validateArgs({ ...okArgs(), branchTip: "def456" });
  assert.equal(c.branchTip, "def456");
});

test("dispatchBase seeds wave 0 from branchTip, falling back to mergeBase", () => {
  assert.equal(H.dispatchBase({ branchTip: "tip", mergeBase: "mb" }), "tip");
  assert.equal(H.dispatchBase({ branchTip: "", mergeBase: "mb" }), "mb");
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
