// loop/land.sh --dry-run in a rendered repo, with a fake gh: the kill switch,
// task selection from what origin/<base> says, and the resume/blocked paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { nightshiftRepo, shims } from "./fixtures.mjs";

function dryRun(repo, env) {
  const state = join(repo.root, "state");
  const r = spawnSync("bash", ["loop/land.sh", "--dry-run"], {
    cwd: repo.dir, encoding: "utf8",
    env: { ...process.env, PATH: shims(repo.root), STATE_DIR: state, WORKTREE: join(repo.root, "wt"), ...env },
  });
  return { status: r.status, err: r.stderr, journal: readFileSync(join(state, "journal.md"), "utf8") };
}

test("kill switch: unset and frozen both stop before any work; run picks task 1", () => {
  const repo = nightshiftRepo();
  try {
    let r = dryRun(repo, {});
    assert.equal(r.status, 0, r.err);
    assert.match(r.journal, /kill switch: LANDING_STATE=unset\n.*STOP: frozen/);
    r = dryRun(repo, { FAKE_GH_STATE: "frozen" });
    assert.match(r.journal, /STOP: frozen/);
    r = dryRun(repo, { FAKE_GH_STATE: "run" });
    assert.match(r.journal, /STOP: would run task 1: first/);
    assert.doesNotMatch(r.journal, /task 2/);
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

test("a merge commit on origin/main naming the task branch marks it done; all done says so", () => {
  const repo = nightshiftRepo();
  try {
    // land.sh's done test: a merge commit on origin/<base> whose subject or body names land/<plan>-t<N>.
    repo.git("checkout", "-q", "-b", "land/smoke-t1");
    repo.git("commit", "-q", "--allow-empty", "-m", "t1 work");
    repo.git("checkout", "-q", "main");
    repo.git("merge", "-q", "--no-ff", "-m", "Merge pull request #1 from o/land/smoke-t1", "land/smoke-t1");
    repo.git("push", "-q", "origin", "main");
    let r = dryRun(repo, { FAKE_GH_STATE: "run" });
    assert.match(r.journal, /STOP: would run task 2: second/, r.journal);
    repo.git("checkout", "-q", "-b", "land/smoke-t2");
    repo.git("commit", "-q", "--allow-empty", "-m", "t2 work");
    repo.git("checkout", "-q", "main");
    repo.git("merge", "-q", "--no-ff", "-m", "Merge pull request #2 from o/land/smoke-t2", "land/smoke-t2");
    repo.git("push", "-q", "origin", "main");
    r = dryRun(repo, { FAKE_GH_STATE: "run" });
    assert.match(r.journal, /STOP: nothing to do: every task of smoke is landed/, r.journal);
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

test("an open PR is resumed, a blocked or human-closed PR stops the night", () => {
  const repo = nightshiftRepo();
  try {
    let r = dryRun(repo, { FAKE_GH_STATE: "run", FAKE_GH_OPEN_PR: "7\tfalse\tland" });
    assert.match(r.journal, /STOP: would wait on open PR #7 for task 1/, r.journal);
    r = dryRun(repo, { FAKE_GH_STATE: "run", FAKE_GH_OPEN_PR: "7\ttrue\tland,land:blocked" });
    assert.match(r.journal, /STOP: task 1: PR #7 is blocked, waiting for a human/, r.journal);
    r = dryRun(repo, { FAKE_GH_STATE: "run", FAKE_GH_CLOSED_PR: "5" });
    assert.match(r.journal, /STOP: task 1: PR #5 was closed without merging; a human decided/, r.journal);
    r = dryRun(repo, { FAKE_GH_STATE: "run", FAKE_GH_CLOSED_PR: "5", FAKE_GH_CLOSED_RETRY: "1" });
    assert.match(r.journal, /STOP: would run task 1: first/, "a land:retry label on the closed PR means run it again");
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});
