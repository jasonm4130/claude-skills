// The guards as init renders them: registered through $CLAUDE_PROJECT_DIR,
// runnable as processes from the rendered path, and the copied hooks.test.mjs
// passes in situ (so a repo can `node --test .claude/hooks` after init).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { nightshiftRepo } from "./fixtures.mjs";

function hook(repo, name, payload) {
  const settings = JSON.parse(readFileSync(join(repo.dir, ".claude", "settings.json"), "utf8"));
  const entry = settings.hooks.PreToolUse.flatMap((e) => e.hooks).find((h) => h.command.includes(name));
  assert.ok(entry, `${name} registered`);
  const cmd = entry.command.replace("$CLAUDE_PROJECT_DIR", repo.dir);
  const r = spawnSync("bash", ["-c", cmd], { cwd: repo.dir, input: JSON.stringify({ tool_name: "Bash", tool_input: { command: payload }, cwd: repo.dir }), encoding: "utf8" });
  return r.stdout ? JSON.parse(r.stdout) : null;
}

test("rendered guards deny the merge and pass the loop's push, via the registered command", () => {
  const repo = nightshiftRepo();
  try {
    const deny = hook(repo, "no-route-around-ci.mjs", "gh pr merge 12 --merge");
    assert.equal(deny.hookSpecificOutput.permissionDecision, "deny");
    assert.match(deny.hookSpecificOutput.permissionDecisionReason, /no-route-around-ci/);
    assert.equal(hook(repo, "no-route-around-ci.mjs", "git push -u origin land/smoke-t1"), null);
    assert.equal(hook(repo, "no-route-around-ci.mjs", "./loop/merge-pr.sh --stay 12"), null);
    assert.equal(hook(repo, "tests-are-readonly.mjs", "npm test"), null);
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

test("the copied hooks.test.mjs passes inside the rendered repo", () => {
  const repo = nightshiftRepo();
  try {
    // A nested `node --test` inherits NODE_TEST_CONTEXT and refuses to run; strip it.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS;
    const r = spawnSync("bash", ["-c", "node --test .claude/hooks/*.test.mjs"], { cwd: repo.dir, encoding: "utf8", env });
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 0, out);
    assert.match(out, /(#|ℹ) fail 0\b/, out);
    assert.match(out, /(#|ℹ) pass [1-9]/, out);
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});
