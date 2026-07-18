import { test } from "node:test";
import assert from "node:assert/strict";
import { SEVERITIES } from "./schema.mjs";
import { SEVERITY_WEIGHT, FINDINGS_SCHEMA, normalizeSeverity, applyVerdictPolicy, makeCellRecord } from "./model.mjs";

test("severity weights align with the corpus severity list", () => {
  assert.deepEqual(Object.keys(SEVERITY_WEIGHT), SEVERITIES);
  assert.deepEqual(Object.values(SEVERITY_WEIGHT), [3, 2, 1]);
});

test("normalizeSeverity maps common variants; unknown → Minor", () => {
  assert.equal(normalizeSeverity("critical"), "Critical");
  assert.equal(normalizeSeverity("P1"), "Critical");
  assert.equal(normalizeSeverity("importANT"), "Important");
  assert.equal(normalizeSeverity("medium"), "Important");
  assert.equal(normalizeSeverity("nit"), "Minor");
  assert.equal(normalizeSeverity(undefined), "Minor");
});

test("verdict policy: explicit reject OR any finding at/above threshold", () => {
  const minor = [{ severity: "Minor" }];
  const critical = [{ severity: "Critical" }];
  assert.equal(applyVerdictPolicy({ findings: minor }), "pass");
  assert.equal(applyVerdictPolicy({ findings: critical }), "reject");
  assert.equal(applyVerdictPolicy({ explicitReject: true, findings: [] }), "reject");
  assert.equal(applyVerdictPolicy({ findings: minor, threshold: "Minor" }), "reject");
});

test("FINDINGS_SCHEMA requires the five finding fields", () => {
  assert.deepEqual(FINDINGS_SCHEMA.properties.findings.items.required,
    ["file", "line", "severity", "summary", "mechanism"]);
});

test("makeCellRecord fills defaults", () => {
  const r = makeCellRecord({ item: "i", arm: "clean", adapter: "a", adapterVersion: "v", trial: 0, status: "ok" });
  assert.equal(r.verdict, null);
  assert.deepEqual(r.findings, []);
  assert.equal(r.cacheHit, false);
  assert.equal(r.error, null);
});
