// @ts-check
// Orchestration tests: run the ACTUAL workflow body with a mocked agent() so we can assert the
// runtime behavior fanout.test.mjs's pure-helper tests cannot reach — a crashed worker becoming a
// failure record, a blocked angle being skipped, and meta agreeing with failedAngles. Copies the
// harness from plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs; do not
// invent a second one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "fanout.mjs"), "utf8");

// A Workflow script has a top-level `return` (the runtime wraps the body in a function), so it
// cannot be import()ed. Rebuild that wrapper.
const body = src.replace(/export const meta\s*=\s*\{[\s\S]*?\n\};/, "");

const runWorkflow = (agent, args) =>
  new Function(
    "agent", "phase", "log", "parallel", "pipeline", "args",
    `return (async () => { ${body} })();`,
  )(agent, () => {}, () => {}, (thunks) => Promise.all(thunks.map((t) => t().catch(() => null))), null, args);

const okResearch = (id) => ({
  angleId: id, kind: "core",
  summary: "A summary long enough to actually brief a dependent angle on what this one found.",
  findings: [{ claim: "A real, load-bearing claim about the topic under study.",
               sourceUrl: "https://example-real.dev/post", sourceTitle: "t", sourceDate: "2025-01-01" }],
});
const okVerify = (id) => ({ angleId: id, overallReliability: "high", flags: [] });

test("runtime: a crashed root angle becomes a FAILURE, and its dependent is SKIPPED — neither vanishes", async () => {
  const args = {
    topic: "t", mode: "deep",
    angles: [
      { id: "a", question: "qa", kind: "core", model: "sonnet", deps: [] },
      { id: "b", question: "qb", kind: "core", model: "sonnet", deps: ["a"] },
    ],
    verify: { escalateOn: "low" },
  };
  // Angle "a" crashes. Today filter(Boolean) erases it, and "b" runs anyway on a digest missing the
  // very thing it depended on — and the run reports as complete.
  const agent = async (_p, o) => {
    if (o.label.startsWith("research:a")) throw new Error("worker crashed");
    if (o.label.startsWith("research:")) return okResearch("b");
    return okVerify("b");
  };

  const r = await runWorkflow(agent, args);

  assert.equal(r.reports.length, 0, "b must NOT be reported: its dep failed");
  assert.equal(r.failedAngles.length, 2);
  assert.deepEqual(r.failedAngles.map((f) => f.angleId).sort(), ["a", "b"]);
  assert.match(r.failedAngles.find((f) => f.angleId === "b").reason, /dep-failed/);
  assert.equal(r.meta.anglesFailed, 2, "meta must AGREE with failedAngles");
  assert.equal(r.meta.anglesCompleted, 0);
  assert.equal(r.meta.failedCore, 2);
});

test("runtime: schema-valid JUNK is retried once, then failed — not reported as research", async () => {
  const args = {
    topic: "t", mode: "deep",
    angles: [{ id: "a", question: "qa", kind: "core", model: "sonnet", deps: [] }],
    verify: { escalateOn: "low" },
  };
  let researchCalls = 0;
  const agent = async (_p, o) => {
    if (o.label.startsWith("research:")) {
      researchCalls++;
      // Schema-valid, and entirely fabricated. Accepted as research today.
      return { angleId: "a", kind: "core", summary: "s",
               findings: [{ claim: "TODO", sourceUrl: "https://example.com", sourceTitle: "t", sourceDate: "d" }] };
    }
    return okVerify("a");
  };

  const r = await runWorkflow(agent, args);

  assert.equal(researchCalls, 2, "an unusable angle is retried exactly once");
  assert.equal(r.reports.length, 0, "placeholder junk must never reach the synthesis as research");
  assert.equal(r.failedAngles.length, 1);
  assert.match(r.failedAngles[0].reason, /unusable research/);
});

test("runtime: a root with an EMPTY SUMMARY cannot satisfy a dependent's dep", async () => {
  const args = {
    topic: "t", mode: "deep",
    angles: [
      { id: "a", question: "qa", kind: "core", model: "sonnet", deps: [] },
      { id: "b", question: "qb", kind: "core", model: "sonnet", deps: ["a"] },
    ],
    verify: { escalateOn: "low" },
  };
  // Real findings, blank summary. Without summary validation this angle is "successful", satisfies b's
  // dep, and b is dispatched with a digest that is a heading and nothing else — a blank premise it will
  // nonetheless answer.
  const agent = async (_p, o) => {
    if (o.label.startsWith("research:a")) return { ...okResearch("a"), summary: "" };
    if (o.label.startsWith("research:")) return okResearch("b");
    return okVerify("b");
  };

  const r = await runWorkflow(agent, args);

  assert.equal(r.reports.length, 0);
  assert.match(r.failedAngles.find((f) => f.angleId === "a").reason, /summary/i);
  assert.match(r.failedAngles.find((f) => f.angleId === "b").reason, /dep-failed/);
});

test("runtime: a healthy run still reports normally", async () => {
  const args = {
    topic: "t", mode: "deep",
    angles: [{ id: "a", question: "qa", kind: "core", model: "sonnet", deps: [] }],
    verify: { escalateOn: "low" },
  };
  const agent = async (_p, o) => (o.label.startsWith("research:") ? okResearch("a") : okVerify("a"));

  const r = await runWorkflow(agent, args);
  assert.equal(r.reports.length, 1);
  assert.equal(r.failedAngles.length, 0);
  assert.equal(r.meta.anglesCompleted, 1);
  assert.equal(r.meta.anglesFailed, 0);
});
