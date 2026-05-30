// @ts-check
// Tests the PURE helper block extracted from fanout.mjs. fanout.mjs cannot be
// imported (top-level return → SyntaxError in node:test), so we read it as text,
// slice the // >>> PURE ... // <<< PURE block, and eval it with new Function to get
// the actual shipped helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "fanout.mjs"), "utf8");
const block = src.split("// >>> PURE")[1]?.split("// <<< PURE")[0];
assert.ok(block, "fanout.mjs must contain a // >>> PURE ... // <<< PURE block");
const PURE = new Function(
  block +
    "\nreturn { partitionWaves, validateArgs, shouldEscalate, tallyMeta, researchPrompt, verifyPrompt };"
)();

test("partitionWaves: empty deps -> wave 1, non-empty deps -> wave 2", () => {
  const angles = [
    { id: "a", deps: [] },
    { id: "b", deps: [] },
    { id: "c", deps: ["a"] },
  ];
  const { wave1, wave2 } = PURE.partitionWaves(angles);
  assert.deepEqual(wave1.map((x) => x.id), ["a", "b"]);
  assert.deepEqual(wave2.map((x) => x.id), ["c"]);
});

test("partitionWaves: missing deps treated as wave 1", () => {
  const { wave1, wave2 } = PURE.partitionWaves([{ id: "a" }]);
  assert.deepEqual(wave1.map((x) => x.id), ["a"]);
  assert.equal(wave2.length, 0);
});

test("validateArgs: rejects missing topic", () => {
  assert.throws(() => PURE.validateArgs({ angles: [{ id: "a", question: "q" }] }), /topic/);
});

test("validateArgs: rejects empty angles", () => {
  assert.throws(() => PURE.validateArgs({ topic: "t", angles: [] }), /angles/);
});

test("validateArgs: defaults mode=deep and angle.model=sonnet", () => {
  const out = PURE.validateArgs({ topic: "t", angles: [{ id: "a", question: "q" }] });
  assert.equal(out.mode, "deep");
  assert.equal(out.angles[0].model, "sonnet");
  assert.equal(out.angles[0].kind, "core");
  assert.deepEqual(out.angles[0].deps, []);
});

test("shouldEscalate: true only when reliability is low", () => {
  assert.equal(PURE.shouldEscalate({ reliability: "low" }, "low"), true);
  assert.equal(PURE.shouldEscalate({ reliability: "medium" }, "low"), false);
  assert.equal(PURE.shouldEscalate({ reliability: "high" }, "low"), false);
  assert.equal(PURE.shouldEscalate(null, "low"), false);
});

test("tallyMeta: counts completed, failed, escalated", () => {
  const results = [
    { angleId: "a", escalated: false },
    { angleId: "b", escalated: true },
    null,
  ];
  const m = PURE.tallyMeta("deep", 2, results);
  assert.equal(m.mode, "deep");
  assert.equal(m.wavesRun, 2);
  assert.equal(m.anglesCompleted, 2);
  assert.equal(m.anglesFailed, 1);
  assert.equal(m.escalations, 1);
});

test("researchPrompt: deep vs scout wording, and wave context", () => {
  const deep = PURE.researchPrompt("T", { id: "a", question: "Q", kind: "core" }, "deep", null);
  assert.match(deep, /DEPTH MODE/);
  const scout = PURE.researchPrompt("T", { id: "a", question: "Q", kind: "core" }, "scout", null);
  assert.match(scout, /BREADTH MODE/);
  const withCtx = PURE.researchPrompt("T", { id: "a", question: "Q", kind: "core" }, "deep", "PRIOR");
  assert.match(withCtx, /WAVE-1 FINDINGS/);
  assert.match(withCtx, /PRIOR/);
});
