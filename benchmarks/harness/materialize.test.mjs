import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { materializeArm, FIXED_GIT_ENV } from "./materialize.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ITEM = join(HERE, "..", "corpus", "reviewer", "synthetic-0001");
const meta = { id: "synthetic-0001", tranche: "synthetic", repo: "self", language: "js" };

test("self mode: deterministic shas, committed arm, non-empty range", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bench-test-"));
  const a = materializeArm({ itemDir: ITEM, meta, arm: "seeded", scratchRoot: scratch });
  const b = materializeArm({ itemDir: ITEM, meta, arm: "seeded", scratchRoot: scratch });
  assert.equal(a.baseSha, b.baseSha);
  assert.equal(a.armSha, b.armSha);
  assert.notEqual(a.baseSha, a.armSha);
  const diff = execFileSync("git", ["-C", a.worktree, "diff", "--no-textconv", "--no-ext-diff", `${a.baseSha}..${a.armSha}`, "--"], { encoding: "utf8" });
  assert.ok(diff.includes("h: 600_000"));
  a.cleanup(); b.cleanup();
  assert.ok(!existsSync(a.worktree));
  rmSync(scratch, { recursive: true, force: true });
});

test("repo mode: clone at baseSha, arm committed, source repo untouched", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bench-test-"));
  const repo = join(scratch, "mined");
  mkdirSync(repo);
  const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, ...FIXED_GIT_ENV } }).trim();
  git(["init", "-q"]);
  writeFileSync(join(repo, "f.txt"), "one\n");
  git(["add", "-A"]); git(["commit", "-q", "--no-verify", "-m", "c1"]);
  const baseSha = git(["rev-parse", "HEAD"]);
  const itemDir = join(scratch, "item");
  mkdirSync(itemDir);
  cpSync(join(ITEM, "clean.patch"), join(itemDir, "clean.patch")); // any valid patch target? no — write our own
  writeFileSync(join(itemDir, "clean.patch"), [
    "diff --git a/f.txt b/f.txt", "index 43dd47e..2bdf67a 100644",
    "--- a/f.txt", "+++ b/f.txt", "@@ -1 +1 @@", "-one", "+two", "",
  ].join("\n"));
  const minedMeta = { id: "mined-x", tranche: "mined", repo, baseSha, language: "txt", private: true };
  const m = materializeArm({ itemDir, meta: minedMeta, arm: "clean", scratchRoot: scratch });
  assert.equal(m.baseSha, baseSha);
  assert.notEqual(m.armSha, baseSha);
  m.cleanup();
  assert.equal(git(["worktree", "list"]).split("\n").length, 1); // nothing registered in source
  // failure path: a non-applying patch throws and still leaves the source repo untouched
  writeFileSync(join(itemDir, "seeded.patch"), [
    "diff --git a/f.txt b/f.txt", "index 0000000..1111111 100644",
    "--- a/f.txt", "+++ b/f.txt", "@@ -1 +1 @@", "-NOT-THE-CONTENT", "+nope", "",
  ].join("\n"));
  assert.throws(() => materializeArm({ itemDir, meta: minedMeta, arm: "seeded", scratchRoot: scratch }));
  assert.equal(git(["worktree", "list"]).split("\n").length, 1);
  assert.equal(git(["status", "--porcelain"]), "");
  rmSync(scratch, { recursive: true, force: true });
});

test("hooks AND clean/smudge filters in the source repo never fire during materialization", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bench-test-"));
  const repo = join(scratch, "hooked");
  mkdirSync(repo);
  const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, ...FIXED_GIT_ENV } }).trim();
  git(["init", "-q"]);
  const marker = join(scratch, "evil-ran");
  // In-tree .gitattributes wires f.txt to a filter defined in the SOURCE
  // repo's config — checkout would smudge, `git add` would clean. The clone
  // has fresh config, so the filter name resolves to nothing (pass-through).
  writeFileSync(join(scratch, "evil.sh"), `#!/bin/sh\ntouch ${marker}\ncat\n`, { mode: 0o755 });
  writeFileSync(join(repo, ".gitattributes"), "f.txt filter=evil\n");
  git(["config", "filter.evil.clean", join(scratch, "evil.sh")]);
  git(["config", "filter.evil.smudge", join(scratch, "evil.sh")]);
  const hookDir = join(repo, "hooks");
  mkdirSync(hookDir);
  for (const hook of ["pre-commit", "post-checkout"]) {
    writeFileSync(join(hookDir, hook), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  }
  git(["config", "core.hooksPath", hookDir]);
  writeFileSync(join(repo, "f.txt"), "one\n");
  git(["add", "-A"]); git(["commit", "-q", "--no-verify", "-m", "c1"]);
  rmSync(marker, { force: true }); // source-repo staging may have run it; the harness must not
  const baseSha = git(["rev-parse", "HEAD"]);
  const itemDir = join(scratch, "item");
  mkdirSync(itemDir);
  writeFileSync(join(itemDir, "seeded.patch"), [
    "diff --git a/f.txt b/f.txt", "index 43dd47e..2bdf67a 100644",
    "--- a/f.txt", "+++ b/f.txt", "@@ -1 +1 @@", "-one", "+two", "",
  ].join("\n"));
  const minedMeta = { id: "mined-h", tranche: "mined", repo, baseSha, language: "txt", private: true };
  const m = materializeArm({ itemDir, meta: minedMeta, arm: "seeded", scratchRoot: scratch });
  assert.ok(!existsSync(marker), "source-repo hooks and filters must not run in the clone");
  m.cleanup();
  rmSync(scratch, { recursive: true, force: true });
});
