// Run: node --test .claude/hooks
// Two kinds of test: the pure judge() functions on strings, and the hooks as
// processes against a throwaway git repo, so the stdin/stdout contract and the
// git calls are exercised, not just the regexes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { judge as routeJudge } from "./no-route-around-ci.mjs";
import { judge as testsJudge } from "./tests-are-readonly.mjs";

const here = dirname(fileURLToPath(import.meta.url));

test("no-route-around-ci: the merge itself and every bypass of it are denied", () => {
  assert.ok(routeJudge("gh pr merge 12 --merge", []).length);
  assert.ok(routeJudge("gh pr merge --admin 12", []).length);
  assert.ok(routeJudge("gh pr checks 12 --watch && gh pr merge 12", []).length);
  assert.ok(routeJudge("gh workflow disable land.yml", []).length);
  assert.ok(routeJudge("gh variable set LANDING_STATE --body run", []).length);
  assert.ok(routeJudge("git push --force origin land/x-t1", []).length);
  assert.ok(routeJudge("git push -f origin land/x-t1", []).length);
  assert.ok(routeJudge("git push origin +land/x-t1", []).length);
  assert.ok(routeJudge("git push origin main", []).length);
  assert.ok(routeJudge("git push origin HEAD:main", []).length);
  assert.ok(routeJudge("git push origin land/x:refs/heads/main", []).length);
  assert.ok(routeJudge("git -C . push origin HEAD:main", []).length);
  assert.ok(routeJudge("command git push origin HEAD:main", []).length);
  assert.ok(routeJudge("exec git push origin main", []).length);
  assert.ok(routeJudge("env GIT_DIR=.git git push origin HEAD:main", []).length);
  assert.ok(routeJudge("\\git push origin HEAD:main", []).length);
  assert.ok(routeJudge("/usr/bin/git push origin main", []).length);
  assert.ok(routeJudge("cd x && 'git' push origin HEAD:main", []).length);
  assert.ok(routeJudge("command git commit --no-verify -m x", []).length);
  assert.ok(routeJudge("git -C /tmp/wt --no-pager push --force origin land/x-t1", []).length);
  assert.ok(routeJudge("git --git-dir=.git commit --no-verify -m x", []).length);
  assert.ok(routeJudge("git -c user.name=x commit -m x", [".github/workflows/ci.yml"]).length);
  assert.ok(routeJudge("git commit --no-verify -m x", []).length);
  assert.ok(routeJudge("git commit -m x", [".github/workflows/ci.yml"]).length);
  assert.ok(routeJudge("git commit -m x", [".claude/hooks/no-route-around-ci.mjs"]).length);
  assert.ok(routeJudge("git commit -m x", [".claude/settings.json"]).length);
  assert.ok(routeJudge("gh api -X PUT repos/o/r/pulls/12/merge", []).length);
  assert.ok(routeJudge("gh api --method PATCH repos/o/r/actions/variables/LANDING_STATE -f value=run", []).length);
  assert.ok(routeJudge("gh api repos/o/r/git/refs -f ref=refs/heads/main -f sha=abc", []).length);
  assert.ok(routeJudge("gh api repos/o/r/pulls/12/merge --input body.json", []).length);
});

test("no-route-around-ci: the loop's own commands pass", () => {
  assert.deepEqual(routeJudge("git push -u origin land/x-t1", []), []);
  assert.deepEqual(routeJudge("git push", []), []);
  assert.deepEqual(routeJudge("git -C /tmp/wt push -u origin land/x-t1", []), []);
  assert.deepEqual(routeJudge("command git push -u origin land/x-t1", []), []);
  assert.deepEqual(routeJudge("gh pr create --title '[task 1] x' --label land", []), []);
  assert.deepEqual(routeJudge("gh pr view 12 --json state", []), []);
  assert.deepEqual(routeJudge("gh variable get LANDING_STATE", []), []);
  assert.deepEqual(routeJudge("git commit -F - <<'EOF'\nx\nEOF", ["src/a.rs", "README.md"]), []);
  assert.deepEqual(routeJudge("./loop/merge-pr.sh 12", []), []);
  assert.deepEqual(routeJudge("gh api repos/o/r/pulls/12/checks", []), []);
  assert.deepEqual(routeJudge("gh api -X GET repos/o/r/branches/main/protection", []), []);
  assert.deepEqual(routeJudge("gh api repos/o/r/commits/abc/check-runs --jq '.check_runs[].name'", []), []);
  assert.deepEqual(routeJudge("git switch main && git pull --ff-only", []), []);
});

test("tests-are-readonly: removing markers or deleting test files is denied, adding passes", () => {
  const removed = "--- a/src/x.rs\n+++ b/src/x.rs\n-    #[test]\n-    fn old() {}\n+    fn helper() {}\n";
  assert.ok(testsJudge(removed, []).length);
  const moved = "-    #[test]\n-    fn a() {}\n+    #[test]\n+    fn a() {}\n";
  assert.deepEqual(testsJudge(moved, []), []);
  const added = "+    #[test]\n+    fn b() {}\n";
  assert.deepEqual(testsJudge(added, []), []);
  assert.ok(testsJudge("", ["tests/it.rs"]).length);
  assert.ok(testsJudge("", ["src/lib_test.go"]).length);
  assert.ok(testsJudge("", ["ui/src/a.test.ts"]).length);
  assert.deepEqual(testsJudge("", ["src/testament.rs"]), []);
  assert.ok(testsJudge("-def test_x():\n+def x():\n", []).length);
  assert.ok(testsJudge("-  it('works', () => {})\n", []).length);
});

function run(script, payload) {
  const r = spawnSync("node", [join(here, script)], { input: JSON.stringify(payload), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "hooks-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.rs"), "fn a() {}\n#[cfg(test)]\nmod t {\n    #[test]\n    fn x() {}\n}\n");
  writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "name: ci\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return { dir, git };
}

test("as a process: a commit staging a workflow file is denied, a source commit passes", () => {
  const { dir, git } = repo();
  try {
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "name: ci\non: push\n");
    git("add", ".github/workflows/ci.yml");
    const out = run("no-route-around-ci.mjs", { tool_name: "Bash", cwd: dir, tool_input: { command: "git commit -m x" } });
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /workflows/);
    git("reset", "-q");
    writeFileSync(join(dir, "src", "a.rs"), "fn a() {}\nfn b() {}\n#[cfg(test)]\nmod t {\n    #[test]\n    fn x() {}\n}\n");
    git("add", "src/a.rs");
    assert.equal(run("no-route-around-ci.mjs", { tool_name: "Bash", cwd: dir, tool_input: { command: "git commit -m x" } }), null);
    assert.equal(run("tests-are-readonly.mjs", { tool_name: "Bash", cwd: dir, tool_input: { command: "git commit -m x" } }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("as a process: a commit that deletes a test is denied", () => {
  const { dir, git } = repo();
  try {
    writeFileSync(join(dir, "src", "a.rs"), "fn a() {}\n");
    git("add", "src/a.rs");
    const out = run("tests-are-readonly.mjs", { tool_name: "Bash", cwd: dir, tool_input: { command: "git commit -m 'simplify'" } });
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /removes 2 test marker/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("as a process: non-Bash tools and non-commit commands are ignored", () => {
  assert.equal(run("tests-are-readonly.mjs", { tool_name: "Edit", tool_input: {} }), null);
  assert.equal(run("no-route-around-ci.mjs", { tool_name: "Bash", tool_input: { command: "ls" } }), null);
  assert.equal(run("no-route-around-ci.mjs", { tool_name: "Read", tool_input: {} }), null);
});
