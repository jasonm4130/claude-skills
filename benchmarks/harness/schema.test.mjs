import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TAXONOMY, SEVERITIES, validateItemMeta, validateTruth, newSideRanges, spanCovered,
} from "./schema.mjs";

const goodMeta = { id: "synthetic-0001", tranche: "synthetic", repo: "self", remote: null, language: "js" };
const goodTruth = {
  class: "wrong-constant", file: "src/parse-duration.mjs", span: [2, 2], severity: "Critical",
  mechanism: "The hours multiplier added to UNITS is 600000 instead of 3600000, so hour durations parse to one-sixth of their value.",
  knownIssues: [],
};

test("valid synthetic meta and truth pass", () => {
  assert.deepEqual(validateItemMeta(goodMeta), []);
  assert.deepEqual(validateTruth(goodTruth), []);
});

test("mined meta requires baseSha and remote (unless private)", () => {
  const m = { id: "x-1", tranche: "mined", repo: "~/Work/Git/x", language: "ts" };
  const errs = validateItemMeta(m);
  assert.ok(errs.some((e) => e.includes("baseSha")));
  assert.ok(errs.some((e) => e.includes("remote")));
  assert.deepEqual(
    validateItemMeta({ ...m, baseSha: "a".repeat(40), private: true }), []);
});

test("truth rejects unknown class, bad span, thin mechanism", () => {
  assert.ok(validateTruth({ ...goodTruth, class: "vibes" }).length === 1);
  assert.ok(validateTruth({ ...goodTruth, span: [5, 2] }).length === 1);
  assert.ok(validateTruth({ ...goodTruth, mechanism: "bad" }).length === 1);
});

test("knownIssues entries need a file and a valid span", () => {
  assert.equal(validateTruth({ ...goodTruth, knownIssues: [{}] }).length, 1);
  assert.deepEqual(validateTruth({ ...goodTruth, knownIssues: [{ file: "f.js", span: [1, 2] }] }), []);
});

test("taxonomy and severities are closed lists", () => {
  assert.ok(TAXONOMY.includes("weakened-test"));
  assert.deepEqual(SEVERITIES, ["Critical", "Important", "Minor"]);
});

const patch = [
  "diff --git a/src/parse-duration.mjs b/src/parse-duration.mjs",
  "index 111..222 100644",
  "--- a/src/parse-duration.mjs",
  "+++ b/src/parse-duration.mjs",
  "@@ -1,8 +1,8 @@",
  " line1",
  "-old",
  "+new",
  " line3",
  "",
].join("\n");

test("newSideRanges and spanCovered read the new side of the target file", () => {
  assert.deepEqual(newSideRanges(patch, "src/parse-duration.mjs"), [[1, 8]]);
  assert.equal(spanCovered(patch, "src/parse-duration.mjs", [2, 2]), true);
  assert.equal(spanCovered(patch, "src/parse-duration.mjs", [9, 12]), false);
  assert.equal(spanCovered(patch, "other.mjs", [2, 2]), false);
});
