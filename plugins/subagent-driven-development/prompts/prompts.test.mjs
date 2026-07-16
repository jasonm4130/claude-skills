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

test("reviewer prompts grant a respected clean pass and scrutinize weakened test assertions (over-rejection calibration)", () => {
  // Ported from the codex-review side (codex-review.mjs:99): AI reviewers over-reject correct code, and
  // these reviewers run on EVERY task/branch, so each inflated finding costs a paid fixer round. A clean
  // pass must be a legitimate result — and because the implementer's job is to make the planned tests
  // pass, a test weakened to pass trivially is the one thing that must be CAUGHT, not softened.
  for (const f of ["reviewer.md", "final-reviewer.md"]) {
    const s = read(f);
    assert.match(s, /zero findings/i, `${f}: a clean pass must be legitimized`);
    assert.match(s, /do not manufacture or inflate/i, `${f}: must forbid manufacturing findings`);
    assert.match(s, /test-file changes[\s\S]{0,30}more carefully/i, `${f}: must prioritize test-diff scrutiny`);
    // Bind Critical to the weakened-assertion language — a bare /Critical/ would match the severity
    // enum and still pass if this line were softened to "Minor" (the exact gaming this rule forbids).
    assert.match(s, /asserts nothing or cannot\s+fail[\s\S]{0,120}Critical/i,
      `${f}: a test that asserts nothing or cannot fail must be classified Critical, not just mentioned`);
  }
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

test("implementer halts on new load-bearing decisions instead of deciding them", () => {
  const s = read("implementer.md");
  assert.match(s, /load-bearing/i);
  assert.match(s, /new dependency/i);
  assert.match(s, /schema|data-model/i);
  assert.match(s, /BLOCKED/);
});

test("merger prompt merges in task order, bounds repair, cleans up, reports suite verdict", () => {
  const s = read("merger.md");
  assert.match(s, /ascending|numeric task order/i);
  assert.match(s, /ONE repair attempt/i);
  assert.match(s, /worktree remove/);
  assert.match(s, /branch -d/);
  assert.match(s, /conflictsResolved/);
  assert.match(s, /"green" \| "red"/);
  assert.match(s, /full suite/i);
});

test("implementer prompt covers task-worktree entry and the setup command", () => {
  const s = read("implementer.md");
  assert.match(s, /sdd-worktree/);
  assert.match(s, /setup command/i);
});

test("implementer halts loudly on a wrong dispatch base instead of rebuilding files", () => {
  const s = read("implementer.md");
  assert.match(s, /BLOCKED: wrong-dispatch-base/);
  assert.match(s, /does not exist/i);
});
