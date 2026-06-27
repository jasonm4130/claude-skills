import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, f), "utf8");
const COUNTER = /security[\s\S]*validation[\s\S]*error handling[\s\S]*accessibility[\s\S]*observability/i;

test("implementer prompt has ladder, counter-boundary, ponytail marker, TDD, report contract", () => {
  const s = read("implementer.md");
  assert.match(s, /ladder/i);
  assert.match(s, /two concrete uses/i);
  assert.match(s, /ponytail: <ceiling>, <upgrade>/);
  assert.match(s, /RED[\s\S]*GREEN/);
  assert.match(s, COUNTER);
  assert.match(s, /DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT/);
});

test("reviewer prompt has three verdicts, the over-engineering tags, net score, and the boundary", () => {
  const s = read("reviewer.md");
  assert.match(s, /spec compliance/i);
  assert.match(s, /code quality/i);
  assert.match(s, /delete[\s\S]*stdlib[\s\S]*native[\s\S]*yagni[\s\S]*shrink/);
  assert.match(s, /net .?N/i);
  assert.match(s, /do not flag[\s\S]*ponytail:/i);
  assert.match(s, /planMandated/);
  assert.match(s, COUNTER);
});

test("fixer prompt forbids scope creep and requires test re-run evidence", () => {
  const s = read("fixer.md");
  assert.match(s, /only the listed findings|do not.*beyond/i);
  assert.match(s, /re-run|covering test/i);
});

test("final reviewer prompt is whole-branch and harvests ponytail debt", () => {
  const s = read("final-reviewer.md");
  assert.match(s, /whole-branch|entire branch/i);
  assert.match(s, /ponytail:/);
  assert.match(s, /approve|changes/);
});

test("final reviewer documents the ADR success-criteria done-oracle", () => {
  const s = read("final-reviewer.md");
  assert.match(s, /success criteria/i);
  assert.match(s, /done-oracle|done oracle/i);
  assert.match(s, /holistic/i);
  assert.match(s, /do not re-run|don't re-run|do not rerun/i);
});
