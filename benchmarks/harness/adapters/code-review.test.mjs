import { test } from "node:test";
import assert from "node:assert/strict";
import { ADAPTER_ID, buildPrompt, version, claudeCliVersion, review } from "./code-review.mjs";

test("prompt carries range, brief, introduced-only scope, and clean-pass license", () => {
  const p = buildPrompt({ brief: "Add hours support.", diffRange: "abc..def" });
  assert.ok(p.includes("abc..def"));
  assert.ok(p.includes("Add hours support."));
  assert.ok(p.includes("only defects introduced by this change"));
  assert.ok(p.includes("Zero findings is a valid"));
});

test("version is stable and 12 hex chars", () => {
  assert.match(version(), /^[0-9a-f]{12}$/);
  assert.equal(version(), version());
  // The built-in /code-review skill ships with the CLI, so the CLI version
  // must feed the hash (fallback string when the CLI is absent keeps this
  // hermetic — cells can't run in that environment anyway).
  assert.ok(claudeCliVersion().length > 0);
});

test("review normalizes severities and applies the verdict policy", async () => {
  const fake = async () => ({
    ok: true,
    structured: { findings: [{ file: "f.js", line: 3, severity: "p1", summary: "s", mechanism: "m" }] },
    tokens: { input: 1, output: 2 }, wallMs: 5,
  });
  const r = await review({ worktree: "/tmp", diffRange: "a..b", brief: "B" }, { runClaude: fake });
  assert.equal(r.status, "ok");
  assert.equal(r.findings[0].severity, "Critical");
  assert.equal(r.verdict, "reject");
});

test("review passes through wrapper errors as status error", async () => {
  const fake = async () => ({ ok: false, error: "boom" });
  const r = await review({ worktree: "/tmp", diffRange: "a..b", brief: "B" }, { runClaude: fake });
  assert.deepEqual(r, { status: "error", error: "boom" });
});

test("adapter id reflects the probed path", () =>
  assert.ok(["code-review", "claude-review"].includes(ADAPTER_ID)));
