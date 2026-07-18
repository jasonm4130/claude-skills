import { test } from "node:test";
import assert from "node:assert/strict";
import {
  locationMatch, buildJudgePrompt, MATCHER_CONFIG, matchCell, JUDGE_SCHEMA,
} from "./matcher.mjs";

const truth = { file: "src/x.mjs", span: [10, 12], mechanism: "the retry counter resets on every failure so it loops forever" };

test("locationMatch: path normalization and span tolerance", () => {
  assert.equal(locationMatch({ file: "src/x.mjs", line: 10 }, truth), true);
  assert.equal(locationMatch({ file: "./src/x.mjs", line: 17 }, truth), true);  // 12+5
  assert.equal(locationMatch({ file: "b/src/x.mjs", line: 5 }, truth), true);   // 10-5
  assert.equal(locationMatch({ file: "src/x.mjs", line: 18 }, truth), false);
  assert.equal(locationMatch({ file: "src/y.mjs", line: 11 }, truth), false);
});

test("judge prompt is blind: both mechanisms present, no harness vocabulary", () => {
  const p = buildJudgePrompt({ summary: "S", mechanism: "FM" }, truth);
  assert.ok(p.includes("FM") && p.includes(truth.mechanism));
  for (const leak of ["seeded", "harness", "benchmark", "corpus"]) {
    assert.ok(!p.toLowerCase().includes(leak), `prompt leaks "${leak}"`);
  }
});

test("MATCHER_CONFIG is stable and versions the judge prompt", () => {
  assert.equal(MATCHER_CONFIG.tolerance, 5);
  assert.equal(MATCHER_CONFIG.judgeModel, "sonnet");
  assert.match(MATCHER_CONFIG.judgePromptVersion, /^[0-9a-f]{12}$/);
});

const rec = (findings) => ({ findings, status: "ok" });
const yes = async () => ({ ok: true, structured: { match: true, reason: "same defect" } });
const no = async () => ({ ok: true, structured: { match: false, reason: "different complaint" } });

test("matchCell: judge-confirmed location hit is a catch", async () => {
  const r = await matchCell(rec([{ file: "src/x.mjs", line: 11, summary: "s", mechanism: "m" }]), truth, { deps: { runClaude: yes } });
  assert.equal(r.catch, true);
  assert.equal(r.matchedFinding, 0);
});

test("matchCell: right location, judge-rejected → near miss, no catch", async () => {
  const r = await matchCell(rec([{ file: "src/x.mjs", line: 11, summary: "s", mechanism: "m" }]), truth, { deps: { runClaude: no } });
  assert.equal(r.catch, false);
  assert.deepEqual(r.nearMisses, [0]);
});

test("matchCell: wrong location is never judged", async () => {
  const boom = async () => { throw new Error("judge must not run"); };
  const r = await matchCell(rec([{ file: "other.mjs", line: 1, summary: "s", mechanism: "m" }]), truth, { deps: { runClaude: boom } });
  assert.deepEqual(r, { catch: false, matchedFinding: null, nearMisses: [], errors: [] });
});

test("matchCell: judge verdicts are cached", async () => {
  const store = new Map();
  const cache = { get: (k) => store.get(k) ?? null, put: (k, v) => store.set(k, v) };
  let calls = 0;
  const counting = async () => { calls++; return { ok: true, structured: { match: true, reason: "r" } }; };
  const f = [{ file: "src/x.mjs", line: 11, summary: "s", mechanism: "m" }];
  await matchCell(rec(f), truth, { cache, deps: { runClaude: counting } });
  await matchCell(rec(f), truth, { cache, deps: { runClaude: counting } });
  assert.equal(calls, 1);
});

test("matchCell: judge error is recorded, not thrown", async () => {
  const err = async () => ({ ok: false, error: "api down" });
  const r = await matchCell(rec([{ file: "src/x.mjs", line: 11, summary: "s", mechanism: "m" }]), truth, { deps: { runClaude: err } });
  assert.equal(r.catch, false);
  assert.deepEqual(r.errors, ["api down"]);
});

test("judge schema demands match + reason", () => {
  assert.deepEqual(JUDGE_SCHEMA.required, ["match", "reason"]);
});
