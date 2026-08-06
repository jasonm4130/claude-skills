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
  assert.match(s, /sdd-worktree/);
  assert.match(s, /BLOCKED/);
  assert.match(s, /never.*(work|commit).*(shared|integration) (tree|workdir)/i,
    "a failed worktree command must be a hard stop, never a fallback to the shared tree");
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
  assert.match(s, /finding class/i);
  // All eight, not a sample: the oscillation breaker in sdd.mjs compares these labels across
  // rounds, so a class the reviewer is never shown is a class it invents free text for — and a
  // rename in FINDING_CLASSES that never reaches reviewer.md fails silently, at run time.
  for (const c of [
    "correctness", "spec-gap", "test-gap", "error-handling",
    "security", "over-engineering", "duplication", "naming",
  ]) {
    assert.ok(s.includes(c), `reviewer.md must list the '${c}' finding class`);
  }
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
    // Bind the WHOLE rule: the Critical classification must be QUALIFIED by gaming ("trivial") and
    // pinned in polarity. Requiring trivial → tell → Critical → never → Minor rejects (a) a bare
    // /Critical/ that only matches the severity enum, (b) the inverted "Minor…never Critical", and
    // (c) an UNqualified blanket rule that would flag legitimate contract-change test deletions as
    // Critical — the over-rejection this whole change exists to reduce.
    assert.match(
      s,
      /trivial[\s\S]{0,120}asserts nothing or cannot\s+fail[\s\S]{0,80}Critical[\s\S]{0,25}never[\s\S]{0,15}Minor/i,
      `${f}: a test weakened to pass trivially (asserts nothing / cannot fail) must be Critical, never Minor`,
    );
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
  assert.match(s, /in the (order listed|listed task order)/i);
  assert.match(s, /do not re-sort/i);
  assert.match(s, /ONE repair attempt/i);
  assert.match(s, /worktree remove/);
  assert.match(s, /branch -d/);
  assert.match(s, /conflictsResolved/);
  assert.match(s, /"green" \| "red"/);
  assert.match(s, /full suite/i);
  // The verify gate deliberately ignores untracked files, so the integration tree can carry
  // suite output into the next wave — and `git merge` aborts outright when a task now tracks
  // a path that output occupies. Without an instruction the merger improvises there, and the
  // two obvious improvisations are deleting the file and forcing the merge.
  assert.match(s, /untracked working tree files would be\s+overwritten by merge/i,
    "merger.md must name the exact git refusal it has to handle");
  assert.match(s, /preexisting-untracked/,
    "the colliding output must be moved aside, not deleted");
  assert.match(s, /do not force the merge/i);
  // A fixed destination clobbers on the second collision at the same path — a later wave, or an
  // aborted earlier run — which would make "move aside, not delete" into silent data loss.
  assert.match(s, /never overwrite an existing destination/i);
  assert.match(s, /first\s+free/i);
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
