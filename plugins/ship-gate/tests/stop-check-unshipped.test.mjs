// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "scripts", "stop-check-unshipped.mjs");

/** Run the hook with a synthetic payload; returns the data dir used. */
function runHook(cwd, sid) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "shipgate-"));
  execSync(`echo '${JSON.stringify({ session_id: sid, cwd })}' | node "${script}"`, {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
  });
  return dataDir;
}

/** Fresh repo with one commit on the given branch. */
function mkRepo(branch) {
  const dir = mkdtempSync(path.join(tmpdir(), "repo-"));
  const g = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  g(["init", "-q", "-b", branch]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  g(["commit", "--allow-empty", "-q", "-m", "init"]);
  return dir;
}

/**
 * Repo on `branch` with a real upstream (a local bare "remote") tracked via
 * `push -u`, then `aheadCommits` additional local commits left unpushed —
 * exercises the headline `git rev-list --count @{upstream}..HEAD` path.
 */
function mkRepoWithUpstream(branch, aheadCommits) {
  const bare = mkdtempSync(path.join(tmpdir(), "bare-"));
  execFileSync("git", ["init", "-q", "--bare", bare]);

  const dir = mkdtempSync(path.join(tmpdir(), "repo-"));
  const g = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  g(["init", "-q", "-b", branch]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  g(["commit", "--allow-empty", "-q", "-m", "init"]);
  g(["remote", "add", "origin", bare]);
  g(["push", "-q", "-u", "origin", branch]);
  for (let i = 0; i < aheadCommits; i++) {
    g(["commit", "--allow-empty", "-q", "-m", `ahead-${i}`]);
  }
  return { dir, bare };
}

test("non-main branch with no upstream → nudge flag written", (t) => {
  const repo = mkRepo("feature-x");
  const dataDir = runHook(repo, "s1");
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const flag = path.join(dataDir, "shipgate-nudge-s1.flag");
  assert.ok(existsSync(flag));
  assert.match(readFileSync(flag, "utf8"), /feature-x/);
  rmSync(repo, { recursive: true, force: true });
});

test("main with no upstream → silent", (t) => {
  const repo = mkRepo("main");
  const dataDir = runHook(repo, "s2");
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  assert.ok(!existsSync(path.join(dataDir, "shipgate-nudge-s2.flag")));
  rmSync(repo, { recursive: true, force: true });
});

test("same HEAD nudges once; new commit re-arms", (t) => {
  const repo = mkRepo("feature-y");
  const dataDir = mkdtempSync(path.join(tmpdir(), "shipgate-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const run = () =>
    execSync(`echo '${JSON.stringify({ session_id: "s3", cwd: repo })}' | node "${script}"`, {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    });
  const flag = path.join(dataDir, "shipgate-nudge-s3.flag");
  run();
  assert.ok(existsSync(flag));
  rmSync(flag);
  run(); // same HEAD → throttled
  assert.ok(!existsSync(flag));
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "more"], { cwd: repo });
  run(); // new HEAD → re-armed
  assert.ok(existsSync(flag));
  rmSync(repo, { recursive: true, force: true });
});

test("commits ahead of upstream → nudge flag with ahead-count message", (t) => {
  const { dir, bare } = mkRepoWithUpstream("main", 2);
  const dataDir = runHook(dir, "s5");
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const flag = path.join(dataDir, "shipgate-nudge-s5.flag");
  assert.ok(existsSync(flag), "flag should be written for unpushed commits ahead of upstream");
  const content = readFileSync(flag, "utf8");
  assert.match(content, /2 commit\(s\) on 'main' not pushed to upstream/);
  rmSync(dir, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
});

test("in sync with upstream (0 ahead) → silent", (t) => {
  const { dir, bare } = mkRepoWithUpstream("main", 0);
  const dataDir = runHook(dir, "s6");
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  assert.ok(!existsSync(path.join(dataDir, "shipgate-nudge-s6.flag")));
  rmSync(dir, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
});

test("non-git cwd → silent exit 0", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "notgit-"));
  const dataDir = runHook(dir, "s4");
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });
  assert.ok(!existsSync(path.join(dataDir, "shipgate-nudge-s4.flag")));
});
