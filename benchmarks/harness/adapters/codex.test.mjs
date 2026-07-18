import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { ADAPTER_ID, MAX_DIFF_BYTES, buildPrompt, extractJson, version, review } from "./codex.mjs";

function fixtureRepo() {
  const scratch = mkdtempSync(join(tmpdir(), "bench-codex-"));
  const repo = join(scratch, "r");
  // Isolate from the developer machine's global hooksPath (e.g. a gitleaks
  // pre-commit hook) — fixture commits must be hermetic, per the repo pattern.
  const nohooks = join(scratch, "nohooks");
  mkdirSync(nohooks);
  execFileSync("git", ["init", "-q", repo]);
  const git = (args) => execFileSync("git",
    ["-C", repo, "-c", "user.email=b@l", "-c", "user.name=b", "-c", `core.hooksPath=${nohooks}`, ...args],
    { encoding: "utf8" }).trim();
  writeFileSync(join(repo, "f.txt"), "one\n");
  git(["add", "-A"]); git(["commit", "-q", "--no-verify", "-m", "c1"]);
  const base = git(["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "f.txt"), "two\n");
  git(["add", "-A"]); git(["commit", "-q", "--no-verify", "-m", "c2"]);
  const head = git(["rev-parse", "HEAD"]);
  return { scratch, repo, base, head, git };
}

const EVENTS = (text) => [
  JSON.stringify({ type: "thread.started", thread_id: "t1" }),
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4 } }),
].join("\n");

test("extractJson pulls the object out of prose or fences", () => {
  assert.deepEqual(extractJson('noise {"findings": []} trailing'), { findings: [] });
  assert.equal(extractJson("no json here"), null);
});

test("prompt embeds brief and diff, demands JSON-only response, mandates safe diff flags", () => {
  const p = buildPrompt({ brief: "B", diffText: "DIFFTEXT" });
  assert.ok(p.includes("B") && p.includes("DIFFTEXT"));
  assert.ok(p.includes("ONLY a JSON object"));
  assert.ok(p.includes("--no-textconv --no-ext-diff"));
});

test("schema-invalid findings (missing file/line) → error, not a scored result", async () => {
  const { scratch, repo, base, head } = fixtureRepo();
  const fake = async () => ({
    stdout: EVENTS('{"findings":[{"severity":"Critical"}]}'),
    stderr: "", timedOut: false, spawnError: false,
  });
  const r = await review({ worktree: repo, diffRange: `${base}..${head}`, brief: "B" }, { runCodex: fake });
  assert.equal(r.status, "error");
  assert.ok(r.error.includes("schema validation"));
  rmSync(scratch, { recursive: true, force: true });
});

test("review: happy path normalizes findings and records usage", async () => {
  const { scratch, repo, base, head } = fixtureRepo();
  const fake = async () => ({
    stdout: EVENTS('{"findings":[{"file":"f.txt","line":1,"severity":"high","summary":"s","mechanism":"m"}]}'),
    stderr: "", timedOut: false, spawnError: false,
  });
  const r = await review({ worktree: repo, diffRange: `${base}..${head}`, brief: "B" }, { runCodex: fake });
  assert.equal(r.status, "ok");
  assert.equal(r.findings[0].severity, "Critical");
  assert.equal(r.verdict, "reject");
  assert.deepEqual(r.tokens, { input: 10, output: 4 });
  rmSync(scratch, { recursive: true, force: true });
});

test("review: failed terminal or unparseable message → error", async () => {
  const { scratch, repo, base, head } = fixtureRepo();
  const failed = async () => ({ stdout: JSON.stringify({ type: "turn.failed" }), stderr: "", timedOut: false, spawnError: false });
  const r1 = await review({ worktree: repo, diffRange: `${base}..${head}`, brief: "B" }, { runCodex: failed });
  assert.equal(r1.status, "error");
  const noJson = async () => ({ stdout: EVENTS("I think it looks fine."), stderr: "", timedOut: false, spawnError: false });
  const r2 = await review({ worktree: repo, diffRange: `${base}..${head}`, brief: "B" }, { runCodex: noJson });
  assert.equal(r2.status, "error");
  rmSync(scratch, { recursive: true, force: true });
});

test("oversized diff is refused, not truncated", async () => {
  const { scratch, repo, base, git } = fixtureRepo();
  writeFileSync(join(repo, "big.txt"), "x".repeat(MAX_DIFF_BYTES + 1024) + "\n");
  git(["add", "-A"]); git(["commit", "-q", "--no-verify", "-m", "big"]);
  const bigHead = git(["rev-parse", "HEAD"]);
  const fake = async () => { throw new Error("must not be called"); };
  const r = await review({ worktree: repo, diffRange: `${base}..${bigHead}`, brief: "B" }, { runCodex: fake });
  assert.equal(r.status, "error");
  assert.ok(r.error.includes("refusing"));
  rmSync(scratch, { recursive: true, force: true });
});

test("adapter id and stable version", () => {
  assert.equal(ADAPTER_ID, "codex");
  assert.match(version(), /^[0-9a-f]{12}$/);
});
