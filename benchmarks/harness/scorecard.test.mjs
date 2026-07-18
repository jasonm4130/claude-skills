import { test } from "node:test";
import assert from "node:assert/strict";
import { median, populationId, computeScorecard, COVERAGE_FLOOR, ERROR_CEILING } from "./scorecard.mjs";

const TRUTHS = {
  "item-a": { class: "wrong-constant", file: "src/a.mjs", span: [2, 2], severity: "Critical", mechanism: "m", knownIssues: [] },
  "item-b": { class: "off-by-one", file: "src/b.mjs", span: [7, 7], severity: "Critical", mechanism: "m", knownIssues: [{ file: "src/b.mjs", span: [40, 44] }] },
};
const CONFIG = { arms: ["clean", "seeded"], trialsPolicy: { default: 3, codex: 1 }, adapters: { rev: { version: "v1", model: "sonnet" } }, matcher: { tolerance: 5, judgeModel: "sonnet", judgePromptVersion: "abc" } };

function cell(over = {}) {
  return { item: "item-a", arm: "seeded", adapter: "rev", adapterVersion: "v1", trial: 0,
    status: "ok", verdict: "pass", findings: [], tokens: { input: 1, output: 1 }, wallMs: 10,
    cacheHit: false, error: null, ...over };
}
const seededCatch = (item, trial) => cell({ item, trial, match: { catch: true, matchedFinding: 0, nearMisses: [], errors: [] }, verdict: "reject" });
const seededMiss = (item, trial) => cell({ item, trial, match: { catch: false, matchedFinding: null, nearMisses: [], errors: [] } });
const cleanCell = (item, trial, over = {}) => cell({ item, trial, arm: "clean", ...over });

function fullRun({ aCatches = 3 } = {}) {
  const records = [];
  for (let t = 0; t < 3; t++) {
    records.push(t < aCatches ? seededCatch("item-a", t) : seededMiss("item-a", t));
    records.push(seededCatch("item-b", t));
    records.push(cleanCell("item-a", t));
    records.push(cleanCell("item-b", t));
  }
  return records;
}

test("median", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

test("clean full run: OK, catch rate 1, over-rejection 0, exit 0", () => {
  const sc = computeScorecard({ records: fullRun(), truthsById: TRUTHS, manifestHash: "m1", config: CONFIG, baseline: null });
  assert.equal(sc.status, "OK");
  assert.equal(sc.exitCode, 0);
  assert.equal(sc.adapters.rev.catchRate, 1);
  assert.equal(sc.adapters.rev.overRejection, 0);
  assert.equal(sc.adapters.rev.flipRate, 0);
});

test("sampled → INFORMATIONAL, never OK, even with no baselines at all", () => {
  const sc = computeScorecard({ records: fullRun(), truthsById: TRUTHS, manifestHash: "m1", config: CONFIG, baseline: null, sampled: true });
  assert.equal(sc.status, "INFORMATIONAL");
  assert.equal(sc.exitCode, 0);
  assert.equal(sc.floors.evaluated, false);
});

test("majority catch + flip rate: 2-of-3 catches counts, and flips", () => {
  const sc = computeScorecard({ records: fullRun({ aCatches: 2 }), truthsById: TRUTHS, manifestHash: "m1", config: CONFIG, baseline: null });
  assert.equal(sc.adapters.rev.catchRate, 1);
  assert.equal(sc.adapters.rev.flipRate, 0.5); // item-a flipped, item-b did not
});

test("verdict-only clean rejection weighs 3; knownIssue findings excluded", () => {
  const records = fullRun();
  records.push(cleanCell("item-a", 3, { verdict: "reject", findings: [] }));
  records.push(cleanCell("item-b", 3, {
    findings: [{ file: "src/b.mjs", line: 42, severity: "Critical", summary: "s", mechanism: "m" }],
  }));
  const cfg = { ...CONFIG, trialsPolicy: { default: 4, codex: 1 } };
  const sc = computeScorecard({ records, truthsById: TRUTHS, manifestHash: "m1", config: cfg, baseline: null });
  // item-a: trials [0,0,0,3] → mean 3/4 = 0.75; item-b known-issue finding excluded → 0. Adapter mean = 0.375.
  assert.equal(sc.adapters.rev.overRejection, 0.375);
});

test("error cells: stratum under coverage floor is notScored; >20% errors → UNRELIABLE exit 2", () => {
  const records = fullRun();
  // fullRun is 12 cells; 4 errors → 4/16 = 25% > ERROR_CEILING (3 would be
  // exactly 20%, which the policy's strict > does NOT trip).
  for (let t = 0; t < 4; t++) {
    records.push(cell({ item: "item-a", trial: t + 10, status: "error", error: "boom", verdict: null }));
  }
  const sc = computeScorecard({ records, truthsById: TRUTHS, manifestHash: "m1", config: CONFIG, baseline: null });
  assert.equal(sc.status, "UNRELIABLE");
  assert.equal(sc.exitCode, 2);
});

test("population mismatch → INFORMATIONAL, floors skipped, exit 0", () => {
  const baseline = { populationId: "different", adapters: { rev: { catchRate: 1, overRejection: 0 } } };
  const sc = computeScorecard({ records: fullRun({ aCatches: 0 }), truthsById: TRUTHS, manifestHash: "m1", config: CONFIG, baseline });
  assert.equal(sc.status, "INFORMATIONAL");
  assert.equal(sc.exitCode, 0);
  assert.deepEqual(sc.floors.breaches, []);
});

test("baselines exist but none match → INFORMATIONAL, floors skipped", () => {
  const sc = computeScorecard({ records: fullRun(), truthsById: TRUTHS, manifestHash: "m1", config: CONFIG, baseline: null, baselinesExist: true });
  assert.equal(sc.status, "INFORMATIONAL");
  assert.equal(sc.exitCode, 0);
});

test("matching population with breached catch floor → exit 1", () => {
  const pid = populationId({ manifestHash: "m1", config: CONFIG });
  const baseline = { populationId: pid, adapters: { rev: { catchRate: 1, overRejection: 0 } } };
  const sc = computeScorecard({ records: fullRun({ aCatches: 0 }), truthsById: TRUTHS, manifestHash: "m1", config: CONFIG, baseline });
  assert.equal(sc.status, "OK");
  assert.equal(sc.exitCode, 1);
  assert.ok(sc.floors.breaches.some((b) => b.includes("catchRate")));
});

test("constants exported for the runner", () => {
  assert.equal(COVERAGE_FLOOR, 0.95);
  assert.equal(ERROR_CEILING, 0.20);
});
