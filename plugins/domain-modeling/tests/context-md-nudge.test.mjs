// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Mirrors lib.mjs repoClaimPath — asserted independently, not imported. */
function claimPath(dataDir, repo) {
  const digest = createHash("sha256").update(repo).digest("hex").slice(0, 16);
  return path.join(dataDir, `offered-${digest}.claim`);
}

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

/**
 * Fresh git repo, optionally seeded with named root files.
 *
 * The path is canonicalized to match what `findRepoRoot` records: on macOS
 * `os.tmpdir()` sits behind the `/var` -> `/private/var` symlink, so the
 * lexical path a test holds and the real path production stores are different
 * strings for the same directory.
 */
function mkRepo(files = []) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "dm-repo-")));
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

  assert.equal(readFileSync(claimPath(dataDir, repo), "utf8").trim(), repo);

  // A later session in the same repo must stay silent.
  assert.ok(!existsSync(editAndStop(repo, "s8", dataDir)), "offered repos are never re-asked");
});

test("concurrent sessions in one repo: only one offer wins", (t) => {
  const repo = mkRepo(["CLAUDE.md"]);
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const dataDir = mkDataDir(t);

  // Both Stop hooks run before either prompt is submitted, so both see no claim
  // and both raise a flag — the race the atomic claim exists to settle.
  const flagA = editAndStop(repo, "cA", dataDir);
  const flagB = editAndStop(repo, "cB", dataDir);
  assert.ok(existsSync(flagA) && existsSync(flagB), "both sessions flag the repo");

  const outA = run(consumeScript, { session_id: "cA" }, dataDir);
  const outB = run(consumeScript, { session_id: "cB" }, dataDir);

  const spoke = [outA, outB].filter((o) => o.trim().length > 0);
  assert.equal(spoke.length, 1, "exactly one session may make the offer");
  assert.match(JSON.parse(spoke[0]).hookSpecificOutput.additionalContext, /no CONTEXT\.md/);
});

test("a nudge that never reached the user does not burn the one ask", (t) => {
  const repo = mkRepo(["CLAUDE.md"]);
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const dataDir = mkDataDir(t);

  // Session ends without a following UserPromptSubmit — flag written, unconsumed.
  assert.ok(existsSync(editAndStop(repo, "s9", dataDir)));
  assert.ok(!existsSync(claimPath(dataDir, repo)));

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

// --- regressions found by cross-provider diff review, 2026-08-03 ---

test("extension-less config does not arm the nudge", (t) => {
  // `path.extname` is "" for all of these, so a deny-list keyed on extension
  // alone lets config-only work spend the repo's single offer.
  const repo = mkRepo(["CLAUDE.md"]);
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const dataDir = mkDataDir(t);
  for (const f of [".env", ".gitignore", "Dockerfile", "Makefile", "LICENSE"]) {
    run(markScript, { session_id: "s13", tool_name: "Write", tool_input: { file_path: path.join(repo, f) } }, dataDir);
  }
  assert.ok(
    !existsSync(path.join(dataDir, "source-edits-s13.txt")),
    "config-only work must not count as source work",
  );
});

test("the same repo reached through a symlink takes the same claim", (t) => {
  const repo = mkRepo(["CLAUDE.md"]);
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const linkDir = realpathSync(mkdtempSync(path.join(tmpdir(), "dm-link-")));
  t.after(() => rmSync(linkDir, { recursive: true, force: true }));
  const link = path.join(linkDir, "alias");
  symlinkSync(repo, link);
  const dataDir = mkDataDir(t);

  mkdirSync(path.join(repo, "src"), { recursive: true });
  run(markScript, { session_id: "s14", tool_name: "Edit", tool_input: { file_path: path.join(repo, "src/a.ts") } }, dataDir);
  run(markScript, { session_id: "s14", tool_name: "Edit", tool_input: { file_path: path.join(link, "src/b.ts") } }, dataDir);

  const lines = readFileSync(path.join(dataDir, "source-edits-s14.txt"), "utf8")
    .split("\n")
    .filter(Boolean);
  assert.deepEqual(lines, [repo], "the alias must resolve to one repo, not two");
});

test("a CONTEXT.md written after Stop silences the offer and keeps the claim unspent", (t) => {
  const repo = mkRepo(["CLAUDE.md"]);
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const dataDir = mkDataDir(t);
  const flag = editAndStop(repo, "s15", dataDir);
  assert.ok(existsSync(flag), "precondition: the Stop hook flagged this repo");

  // The user creates it themselves during the turn boundary.
  writeFileSync(path.join(repo, "CONTEXT.md"), "# Glossary\n");

  const out = run(consumeScript, { session_id: "s15" }, dataDir);
  assert.equal(out.trim(), "", "must not claim a file it can see exists");
  assert.ok(
    !existsSync(claimPath(dataDir, repo)),
    "an offer never made must not spend the one-per-repo claim",
  );
});

test("a deeply nested edit still finds the repo root", (t) => {
  // A fixed 64-iteration bound spent its final pass on the leaf and returned
  // null without ever testing the root.
  const repo = mkRepo(["CLAUDE.md"]);
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const dataDir = mkDataDir(t);
  const deep = path.join(repo, ...Array.from({ length: 70 }, (_, i) => `d${i}`));
  mkdirSync(deep, { recursive: true });
  run(markScript, { session_id: "s16", tool_name: "Edit", tool_input: { file_path: path.join(deep, "app.ts") } }, dataDir);
  const lines = readFileSync(path.join(dataDir, "source-edits-s16.txt"), "utf8")
    .split("\n")
    .filter(Boolean);
  assert.deepEqual(lines, [repo]);
});
