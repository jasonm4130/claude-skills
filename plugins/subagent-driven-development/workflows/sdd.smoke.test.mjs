import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "sdd.mjs"), "utf8");

test("body is guarded so import does not execute it", () => {
  assert.match(src, /if \(typeof phase === "function"\)/);
});

test("every agent() call sets an explicit model", () => {
  const calls = src.match(/agent\([\s\S]*?\{[\s\S]*?\}\s*\)/g) || [];
  assert.ok(calls.length >= 5, "expected at least 5 agent() calls");
  for (const c of calls) assert.match(c, /model:/, `agent() without model: ${c.slice(0, 60)}`);
});

test("finalPrompt threads ADR success criteria into the whole-branch review", () => {
  assert.match(src, /successCriteria/);
  assert.match(src, /holistic/);
});

// A Workflow script has a top-level `return` (the runtime wraps the body in a
// function), so it cannot be import()ed as a normal ES module — validate meta
// by source inspection instead.
test("meta is declared with four phases including Merge", () => {
  assert.match(src, /name:\s*"subagent-driven-development"/);
  const phaseTitles = [...src.matchAll(/title:\s*"(Implement|Review|Merge|Final)"/g)];
  assert.equal(phaseTitles.length, 4);
});

test("wave machinery is wired: schema, worktree script, pool, merge label", () => {
  assert.match(src, /MERGE_SCHEMA/);
  assert.match(src, /sdd-worktree/);
  assert.match(src, /runPool\(/);
  assert.match(src, /computeWaves\(/);
  assert.match(src, /label: `merge:w\$\{/);
  assert.match(src, /model: "sonnet", schema: MERGE_SCHEMA/);
});

test("halted carries wave and failures; return includes merges", () => {
  assert.match(src, /failures/);
  assert.match(src, /merges,/);
  assert.match(src, /suite === "red"/);
});
