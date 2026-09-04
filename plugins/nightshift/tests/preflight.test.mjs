// preflight.mjs against a rendered repo and a fake gh: the plan-on-origin
// rule, the protection/MERGE_MODE agreement, and the wait-mode check names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { nightshiftRepo, shims } from "./fixtures.mjs";
import { readConfig, originSlug } from "../scripts/preflight.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const preflight = join(here, "..", "scripts", "preflight.mjs");

function run(repo, env) {
  const r = spawnSync("node", [preflight, "--repo", repo.dir, "--skip-check"], {
    encoding: "utf8", env: { ...process.env, PATH: shims(repo.root), ...env },
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

function setConfig(repo, key, value) {
  const p = join(repo.dir, "loop", "config");
  writeFileSync(p, readFileSync(p, "utf8").replace(new RegExp(`\\$\\{${key}:=[^}]*\\}`), `\${${key}:=${value}}`));
}

test("clean in wait mode: gate registered, switch set; warns that main is unprotected", () => {
  const repo = nightshiftRepo();
  try {
    setConfig(repo, "EXPECTED_CHECKS", "gate");
    const r = run(repo, { FAKE_GH_STATE: "frozen", FAKE_GH_CHECK_RUNS: "gate\nnode-tests (ubuntu-latest)" });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /ok   config .*on origin\/main/);
    assert.match(r.out, /ok   protection .*MERGE_MODE=wait/);
    assert.match(r.out, /warn protection .*accepts direct pushes/);
    assert.match(r.out, /ok   checks .*waiting on: gate/);
    assert.match(r.out, /ok   switch .*LANDING_STATE=frozen/);
    assert.match(r.out, /preflight clean/);
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

test("a plan that is committed but not on origin/main fails, naming the fix", () => {
  const repo = nightshiftRepo();
  try {
    setConfig(repo, "EXPECTED_CHECKS", "gate");
    repo.git("checkout", "-q", "-b", "scaffold");
    writeFileSync(join(repo.dir, "docs", "plans", "smoke.md"), "# p\n\n### Task 1: x\n- [ ] y\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "plan v2");
    // origin/main still has the old plan file, so cat-file finds it; move the plan instead.
    writeFileSync(join(repo.dir, "docs", "plans", "other.md"), "# o\n\n### Task 1: x\n- [ ] y\n");
    setConfig(repo, "PLAN", "docs/plans/other.md");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "other plan");
    const r = run(repo, { FAKE_GH_STATE: "frozen", FAKE_GH_CHECK_RUNS: "gate" });
    assert.equal(r.status, 1);
    assert.match(r.out, /FAIL config .*NOT on origin\/main .*merge the PR that carries it/);
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

test("protection and MERGE_MODE must agree; wait mode needs real check names; an unset switch fails", () => {
  const repo = nightshiftRepo();
  try {
    // protected base, config says wait
    let r = run(repo, { FAKE_GH_STATE: "run", FAKE_GH_PROTECTED: "3" });
    assert.equal(r.status, 1);
    assert.match(r.out, /FAIL protection .*3 required check\(s\) but MERGE_MODE=wait; set MERGE_MODE=protected/);
    // unprotected, wait mode, empty EXPECTED_CHECKS: lists what GitHub has seen
    r = run(repo, { FAKE_GH_STATE: "run", FAKE_GH_CHECK_RUNS: "build (macos)\nbuild (ubuntu)" });
    assert.match(r.out, /FAIL checks .*EXPECTED_CHECKS is empty — names seen on origin\/main: build \(macos\), build \(ubuntu\)/);
    // a job id that GitHub never reported
    setConfig(repo, "EXPECTED_CHECKS", "build");
    r = run(repo, { FAKE_GH_STATE: "run", FAKE_GH_CHECK_RUNS: "build (macos)" });
    assert.match(r.out, /FAIL checks .*never reported on origin\/main and not a job id: build/);
    // switch unset
    r = run(repo, { FAKE_GH_CHECK_RUNS: "build" });
    assert.match(r.out, /FAIL switch .*LANDING_STATE is unset — gh variable set LANDING_STATE --body frozen/);
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

test("readConfig: config defaults, environment wins; originSlug parses ssh and https", () => {
  const repo = nightshiftRepo();
  try {
    assert.equal(readConfig(repo.dir, {}).PLAN, "docs/plans/smoke.md");
    assert.equal(readConfig(repo.dir, { PLAN: "x.md" }).PLAN, "x.md");
    assert.equal(originSlug(repo.dir), "o/r");
    repo.git("remote", "set-url", "origin", "git@github.com:o/r.git");
    assert.equal(originSlug(repo.dir), "o/r");
    repo.git("remote", "set-url", "origin", "https://github.com/o/r");
    assert.equal(originSlug(repo.dir), "o/r");
    repo.git("remote", "set-url", "origin", "/srv/git/r.git");
    assert.equal(originSlug(repo.dir), null, "a plain local origin is not github");
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});
