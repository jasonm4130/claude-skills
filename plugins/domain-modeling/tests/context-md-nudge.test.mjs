// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, "..", "scripts");
const markScript = path.join(scripts, "posttooluse-mark-source-edit.mjs");
const stopScript = path.join(scripts, "stop-check-context-md.mjs");
const consumeScript = path.join(scripts, "check-context-md-flag.mjs");

/** Pipe a JSON payload into a hook script; returns stdout. */
function run(script, payload, dataDir) {
  return execSync(`node "${script}"`, {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
  });
}

/** Fresh git repo, optionally seeded with named root files. */
function mkRepo(files = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "dm-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const f of files) writeFileSync(path.join(dir, f), "x");
  return dir;
}

function mkDataDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "dm-data-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Record a source edit in `repo` for `sid`, then run the Stop hook. */
function editAndStop(repo, sid, dataDir, file = "src/app.ts") {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  run(markScript, { session_id: sid, tool_name: "Edit", tool_input: { file_path: path.join(repo, file) } }, dataDir);
  run(stopScript, { session_id: sid }, dataDir);
  return path.join(dataDir, `context-md-nudge-${sid}.flag`);
}

test("CLAUDE.md but no CONTEXT.md + source edit → nudge flag", (t) => {
  const repo = mkRepo(["CLAUDE.md"]);
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const dataDir = mkDataDir(t);
  const flag = editAndStop(repo, "s1", dataDir);
  assert.ok(existsSync(flag), "expected a nudge flag");
  assert.equal(readFileSync(flag, "utf8").trim(), repo);
});

test("existing CONTEXT.md → silent", (t) => {
  const repo = mkRepo(["CLAUDE.md", "CONTEXT.md"]);
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const dataDir = mkDataDir(t);
  assert.ok(!existsSync(editAndStop(repo, "s2", dataDir)));
});

test("multi-context repo (CONTEXT-MAP.md) → silent", (t) => {
  const repo = mkRepo(["CLAUDE.md", "CONTEXT-MAP.md"]);
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const dataDir = mkDataDir(t);
  assert.ok(!existsSync(editAndStop(repo, "s3", dataDir)));
});

test("no CLAUDE.md → silent (repo never opted into agent tooling)", (t) => {
  const repo = mkRepo([]);
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const dataDir = mkDataDir(t);
  assert.ok(!existsSync(editAndStop(repo, "s4", dataDir)));
});

test("prose-only edit does not arm the nudge", (t) => {
  const repo = mkRepo(["CLAUDE.md"]);
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const dataDir = mkDataDir(t);
  assert.ok(!existsSync(editAndStop(repo, "s5", dataDir, "README.md")));
});

test("no source edit at all → silent", (t) => {
  const repo = mkRepo(["CLAUDE.md"]);
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const dataDir = mkDataDir(t);
  run(stopScript, { session_id: "s6" }, dataDir);
  assert.ok(!existsSync(path.join(dataDir, "context-md-nudge-s6.flag")));
});

test("consumer emits context, records the repo as offered, and never re-asks", (t) => {
  const repo = mkRepo(["CLAUDE.md"]);
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const dataDir = mkDataDir(t);

  const flag = editAndStop(repo, "s7", dataDir);
  assert.ok(existsSync(flag));

  const out = run(consumeScript, { session_id: "s7" }, dataDir);
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(parsed.hookSpecificOutput.additionalContext, /has a CLAUDE\.md but no CONTEXT\.md/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /once per repo, ever/);
  assert.ok(!existsSync(flag), "flag should be consumed");

  const offered = readFileSync(path.join(dataDir, "context-md-offered.txt"), "utf8");
  assert.match(offered, new RegExp(repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  // A later session in the same repo must stay silent.
  assert.ok(!existsSync(editAndStop(repo, "s8", dataDir)), "offered repos are never re-asked");
});

test("a nudge that never reached the user does not burn the one ask", (t) => {
  const repo = mkRepo(["CLAUDE.md"]);
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const dataDir = mkDataDir(t);

  // Session ends without a following UserPromptSubmit — flag written, unconsumed.
  assert.ok(existsSync(editAndStop(repo, "s9", dataDir)));
  assert.ok(!existsSync(path.join(dataDir, "context-md-offered.txt")));

  // Next session still offers.
  assert.ok(existsSync(editAndStop(repo, "s10", dataDir)));
});

test("marker dedupes repeated edits to the same repo", (t) => {
  const repo = mkRepo(["CLAUDE.md"]);
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const dataDir = mkDataDir(t);
  for (const f of ["a.ts", "b.ts", "c.ts"]) {
    run(markScript, { session_id: "s11", tool_name: "Write", tool_input: { file_path: path.join(repo, f) } }, dataDir);
  }
  const lines = readFileSync(path.join(dataDir, "source-edits-s11.txt"), "utf8")
    .split("\n")
    .filter(Boolean);
  assert.deepEqual(lines, [repo]);
});

test("edit outside any git repo → silent", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "dm-nogit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dataDir = mkDataDir(t);
  run(markScript, { session_id: "s12", tool_name: "Edit", tool_input: { file_path: path.join(dir, "x.ts") } }, dataDir);
  assert.ok(!existsSync(path.join(dataDir, "source-edits-s12.txt")));
});
