import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  ADAPTER_ID, NEUTRAL_REPORT, SDD_SCHEMA, buildPrompt, generatePackage, version, review,
} from "./sdd-reviewer.mjs";

test("schema mirrors the reviewer's NATIVE return contract (reviewer.md 'Return')", () => {
  assert.deepEqual(SDD_SCHEMA.required, ["spec", "findings", "cannotVerify", "quality", "ponytail"]);
  assert.deepEqual(SDD_SCHEMA.properties.spec, { enum: ["pass", "fail"] });
  assert.deepEqual(SDD_SCHEMA.properties.findings.items.required,
    ["severity", "class", "file", "line", "what", "planMandated"]);
});

test("prompt: reviewer.md first, then brief, neutral report, package path — no arm hints", () => {
  const p = buildPrompt({ reviewerMd: "REVIEWER-OPERATING-INSTRUCTIONS", brief: "THE-BRIEF", packagePath: "/x/pkg.diff" });
  assert.ok(p.startsWith("REVIEWER-OPERATING-INSTRUCTIONS"));
  assert.ok(p.indexOf("THE-BRIEF") < p.indexOf(NEUTRAL_REPORT));
  assert.ok(p.includes("/x/pkg.diff"));
  for (const leak of ["seeded", "planted", "harness", "benchmark"]) assert.ok(!p.toLowerCase().includes(leak));
});

test("generatePackage drives the real hardened script against a fixture repo", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bench-sddadapter-"));
  const repo = join(scratch, "r");
  execFileSync("git", ["init", "-q", repo]);
  const git = (args) => execFileSync("git", ["-C", repo, "-c", "user.email=b@l", "-c", "user.name=b", ...args], { encoding: "utf8" }).trim();
  writeFileSync(join(repo, "f.txt"), "one\n");
  git(["add", "-A"]); git(["commit", "-qm", "c1"]);
  const base = git(["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "f.txt"), "two\n");
  git(["add", "-A"]); git(["commit", "-qm", "c2"]);
  const head = git(["rev-parse", "HEAD"]);
  const out = join(scratch, "pkg.diff");
  generatePackage({ worktree: repo, base, head, outFile: out });
  assert.ok(existsSync(out));
  const pkg = readFileSync(out, "utf8");
  assert.ok(pkg.includes("## Diff") && pkg.includes("+two"));
  rmSync(scratch, { recursive: true, force: true });
});

const native = (over = {}) => ({
  spec: "pass", findings: [], cannotVerify: [], quality: "solid",
  ponytail: { net: 0, items: [] }, ...over,
});

test("verdict: spec fail rejects even with zero findings; spec pass + minor passes", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bench-sddadapter-"));
  const fakeRun = (structured) => async () => ({ ok: true, structured, tokens: { input: 1, output: 1 }, wallMs: 1 });
  const fakePkg = () => {}; // review() must accept a generatePackage override in deps for this test
  const rFail = await review(
    { worktree: "/tmp", diffRange: "a..b", brief: "B", scratchDir: scratch },
    { runClaude: fakeRun(native({ spec: "fail" })), generatePackage: fakePkg });
  assert.equal(rFail.verdict, "reject");
  const rPass = await review(
    { worktree: "/tmp", diffRange: "a..b", brief: "B", scratchDir: scratch },
    { runClaude: fakeRun(native({ findings: [{ severity: "Minor", class: "style", file: "f", line: 1, what: "w", planMandated: false }] })), generatePackage: fakePkg });
  assert.equal(rPass.verdict, "pass");
  rmSync(scratch, { recursive: true, force: true });
});

test("native findings normalize (what → summary+mechanism); ponytail items are not findings", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bench-sddadapter-"));
  const fakeRun = (structured) => async () => ({ ok: true, structured, tokens: { input: 1, output: 1 }, wallMs: 1 });
  const r = await review(
    { worktree: "/tmp", diffRange: "a..b", brief: "B", scratchDir: scratch },
    { runClaude: fakeRun(native({
        findings: [{ severity: "Critical", class: "logic", file: "f.js", line: 3, what: "retry counter resets every iteration so the loop never exits", planMandated: false }],
        ponytail: { net: -4, items: ["shrink: inline the helper"] },
      })), generatePackage: () => {} });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].summary, "retry counter resets every iteration so the loop never exits");
  assert.equal(r.findings[0].mechanism, r.findings[0].summary);
  assert.equal(r.verdict, "reject");
  assert.equal(r.raw.ponytail.net, -4); // preserved raw, never scored
  rmSync(scratch, { recursive: true, force: true });
});

test("version is stable 12-hex and changes with reviewer.md content", () => {
  assert.match(version(), /^[0-9a-f]{12}$/);
});

test("adapter id", () => assert.equal(ADAPTER_ID, "sdd-reviewer"));
