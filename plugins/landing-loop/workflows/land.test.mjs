import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Extract the PURE block from land.mjs and evaluate it (mirrors sdd.test.mjs).
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "land.mjs"), "utf8");
const pure = src.split("// >>> PURE")[1].split("// <<< PURE")[0];
const H = new Function(
  `${pure}; return { validateArgs, sequenceTasks, branchName, reconcile, nextTask, shouldHalt, renderLedger, isShaish, UNATTENDED_CONSTRAINTS };`,
)();

const okArgs = () => ({
  planPath: "docs/superpowers/plans/2026-09-04-x.md", workdir: "/w", slug: "x",
  checkCmd: "scripts/check", mergeCmd: "./merge-pr.sh {pr}",
  sddPath: "/p/workflows/sdd.mjs", sddPluginDir: "/p",
  tasks: [{ n: 1, title: "a" }, { n: 2, title: "b", deps: [1] }, { n: 3, title: "c" }],
});

test("validateArgs defaults tiers, effort, limits and the ledger path", () => {
  const c = H.validateArgs(okArgs());
  assert.equal(c.tasks[0].tier, "opus");
  assert.equal(c.tasks[0].effort, "medium");
  assert.deepEqual(c.limits, { fixRounds: 1, skeptics: 0, maxTasks: 0, consecutiveBlocked: 2, sddFableEscalation: false });
  assert.equal(c.ledgerPath, "docs/superpowers/plans/2026-09-04-x.ledger.md");
});

test("validateArgs rejects a merge command without a {pr} slot", () => {
  assert.throws(() => H.validateArgs({ ...okArgs(), mergeCmd: "./merge-pr.sh" }), /\{pr\}/);
});

test("validateArgs rejects a slug that cannot be a branch segment", () => {
  assert.throws(() => H.validateArgs({ ...okArgs(), slug: "Bad Slug" }), /slug/);
});

test("validateArgs rejects missing fields and empty tasks", () => {
  assert.throws(() => H.validateArgs({}), /planPath is required/);
  assert.throws(() => H.validateArgs({ ...okArgs(), tasks: [] }), /non-empty array/);
  assert.throws(() => H.validateArgs({ ...okArgs(), tasks: [{ n: 1, title: "a" }, { n: 1, title: "b" }] }), /duplicate/);
});

test("sequenceTasks orders by deps and rejects unknown deps and cycles", () => {
  const c = H.validateArgs({ ...okArgs(), tasks: [{ n: 2, title: "b", deps: [1] }, { n: 1, title: "a" }] });
  assert.deepEqual(H.sequenceTasks(c.tasks).map((t) => t.n), ["1", "2"]);
  assert.throws(() => H.sequenceTasks(H.validateArgs({ ...okArgs(), tasks: [{ n: 1, title: "a", deps: [9] }] }).tasks), /unknown task 9/);
  assert.throws(() => H.sequenceTasks(H.validateArgs({ ...okArgs(), tasks: [{ n: 1, title: "a", deps: [2] }, { n: 2, title: "b", deps: [1] }] }).tasks), /cycle/);
});

test("branchName is named after the task, not the agent", () => {
  assert.equal(H.branchName("x", "1"), "land/x-t1");
});

test("reconcile derives status from pull requests, never from memory", () => {
  const order = H.sequenceTasks(H.validateArgs(okArgs()).tasks);
  const prs = [
    { number: 10, headRefName: "land/x-t1", state: "MERGED", isDraft: false, url: "u1" },
    { number: 11, headRefName: "land/x-t2", state: "OPEN", isDraft: true, url: "u2" },
    { number: 12, headRefName: "land/x-t3", state: "OPEN", isDraft: false, url: "u3" },
    { number: 13, headRefName: "land/other-t3", state: "OPEN", isDraft: false, url: "u4" },
  ];
  const s = H.reconcile(order, "x", prs);
  assert.equal(s.get("1").status, "landed");
  assert.equal(s.get("2").status, "blocked");
  assert.equal(s.get("3").status, "shipped");
  assert.equal(s.get("3").pr, 12);
});

test("reconcile treats a closed-unmerged PR as todo again", () => {
  const order = H.sequenceTasks(H.validateArgs(okArgs()).tasks);
  const s = H.reconcile(order, "x", [{ number: 10, headRefName: "land/x-t1", state: "CLOSED", isDraft: false, url: "" }]);
  assert.equal(s.get("1").status, "todo");
  assert.equal(s.get("1").pr, 10);
});

test("nextTask picks in plan order, waits on deps, and skips tasks behind a blocked dep", () => {
  const order = H.sequenceTasks(H.validateArgs(okArgs()).tasks);
  const s = H.reconcile(order, "x", []);
  assert.equal(H.nextTask(order, s).n, "1");
  s.set("1", { ...s.get("1"), status: "blocked" });
  const next = H.nextTask(order, s);
  assert.equal(next.n, "3");
  assert.equal(s.get("2").status, "skipped");
  assert.match(s.get("2").note, /depends on task 1/);
});

test("nextTask resumes a shipped task at the gate before starting new work", () => {
  const order = H.sequenceTasks(H.validateArgs(okArgs()).tasks);
  const s = H.reconcile(order, "x", [{ number: 5, headRefName: "land/x-t1", state: "OPEN", isDraft: false, url: "" }]);
  assert.equal(H.nextTask(order, s).n, "1");
  assert.equal(s.get("1").status, "shipped");
});

test("nextTask returns null when everything is landed, blocked or skipped", () => {
  const order = H.sequenceTasks(H.validateArgs(okArgs()).tasks);
  const s = H.reconcile(order, "x", []);
  for (const n of ["1", "3"]) s.set(n, { ...s.get(n), status: "landed" });
  s.set("2", { ...s.get("2"), status: "blocked" });
  assert.equal(H.nextTask(order, s), null);
});

test("shouldHalt fires only on N consecutive blocked outcomes", () => {
  const limits = { consecutiveBlocked: 2 };
  assert.equal(H.shouldHalt(["blocked"], limits), "");
  assert.equal(H.shouldHalt(["blocked", "landed", "blocked"], limits), "");
  assert.match(H.shouldHalt(["landed", "blocked", "blocked"], limits), /2 consecutive/);
});

test("renderLedger writes one row per task with PR and status", () => {
  const cfg = H.validateArgs(okArgs());
  const order = H.sequenceTasks(cfg.tasks);
  const s = H.reconcile(order, "x", [{ number: 7, headRefName: "land/x-t1", state: "MERGED", isDraft: false, url: "" }]);
  const out = H.renderLedger(cfg, order, s, "2026-09-04");
  assert.match(out, /Approved by the human who invoked \/landing-loop:land on 2026-09-04/);
  assert.match(out, /\| 1 \| land\/x-t1 \| #7 \| landed \|  \|/);
  assert.match(out, /\| 2 \|  \|  \| todo \| deps: 1 \|/);
});

test("the unattended constraints keep tests read-only and forbid --admin", () => {
  assert.match(H.UNATTENDED_CONSTRAINTS, /Tests are read-only/);
  assert.match(H.UNATTENDED_CONSTRAINTS, /never use --admin/);
});

test("isShaish accepts abbreviated and full shas only", () => {
  assert.ok(H.isShaish("abc1234"));
  assert.ok(H.isShaish("a".repeat(40)));
  assert.ok(!H.isShaish("main"));
  assert.ok(!H.isShaish("abc123; rm -rf /"));
});
