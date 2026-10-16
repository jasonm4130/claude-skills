// @ts-check
// GATES_DISABLE turns one guard off without touching its neighbours.
//
// docs-sync and docs-consolidate have no binary path, so the node scripts are
// the only implementation and the only thing to test. The other gates units
// carry their own copy of this test for their guards.
//
// Every case pairs the disabled run with a control run on identical input, so a
// payload that quietly stops triggering fails the test instead of passing it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { isGuardDisabled } from "../scripts/lib.mjs";

const script = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));

/**
 * @param {string} name  script filename under scripts/
 * @param {object | string} input
 * @param {Record<string, string>} [extraEnv]
 */
// The suite must not inherit GATES_DISABLE. A developer who has turned a guard off
// in their own settings.json would otherwise watch that guard's tests pass because
// it never ran, which is the one failure this whole feature can cause.
const BASE_ENV = (() => {
  const { GATES_DISABLE, ...rest } = process.env;
  return rest;
})();

function run(name, input, extraEnv = {}) {
  const stdin = typeof input === "string" ? input : JSON.stringify(input);
  const res = spawnSync("node", [script(name)], {
    input: stdin,
    encoding: "utf8",
    env: { ...BASE_ENV, ...extraEnv },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function tmpRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), "gd-"));
  execSync("git init -q -b main", { cwd: root });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: root });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("isGuardDisabled parses the list the same way the binary does", () => {
  const on = (raw) => isGuardDisabled("agent-model", { GATES_DISABLE: raw });
  assert.equal(isGuardDisabled("agent-model", {}), false);
  assert.equal(on(""), false);
  assert.equal(on("agent-model"), true);
  assert.equal(on("workflow-model,agent-model"), true);
  assert.equal(on(" workflow-model , agent-model "), true);
  assert.equal(on("workflow-model,docs-sync"), false);
  assert.equal(on("AGENT-MODEL"), false);
  assert.equal(on("agent_model"), false);
  assert.equal(on("agent-model-extra"), false);
  assert.equal(on(",,"), false);
  assert.equal(on("agent-model,"), true);
});

// ---- docs-sync: needs a real repo with staged code and no staged docs ----

test("GATES_DISABLE silences docs-sync", () => {
  const r = tmpRepo();
  try {
    for (const [p, content] of Object.entries({
      "plugins/foo/scripts/guard.mjs": "x",
      "plugins/foo/README.md": "docs",
    })) {
      mkdirSync(path.dirname(path.join(r.root, p)), { recursive: true });
      writeFileSync(path.join(r.root, p), content);
    }
    execSync("git add plugins/foo/scripts/guard.mjs", { cwd: r.root });

    const payload = {
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "change the guard"' },
      cwd: r.root,
    };
    const control = run("pretooluse-guard-docs-sync.mjs", payload);
    assert.notEqual(control.stdout.trim(), "", "control run was silent — the case proves nothing");

    const off = run("pretooluse-guard-docs-sync.mjs", payload, { GATES_DISABLE: "docs-sync" });
    assert.equal(off.status, 0);
    assert.equal(off.stdout.trim(), "");
  } finally {
    r.cleanup();
  }
});

// ---- docs-consolidate: the Stop hook arms a flag, the prompt hook reads it ----

test("GATES_DISABLE silences docs-consolidate", () => {
  const r = tmpRepo();
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "gd-data-"));
  try {
    writeFileSync(path.join(r.root, "seed.txt"), "0");
    execSync("git add seed.txt", { cwd: r.root });
    execSync('git commit -q -m "seed"', { cwd: r.root });
    const audited = execSync("git rev-parse HEAD", { cwd: r.root, encoding: "utf8" }).trim();
    writeFileSync(path.join(r.root, ".docs-sync"), `docs-sync: audited=${audited}\n`);
    execSync("git add .docs-sync", { cwd: r.root });
    execSync('git commit -q -m "docs: consolidate"', { cwd: r.root });
    for (let i = 0; i < 3; i++) {
      execSync(`git commit -q --allow-empty -m "c${i}"`, { cwd: r.root });
    }

    const env = {
      CLAUDE_PLUGIN_DATA: dataDir,
      DOCS_SYNC_CONSOLIDATE_THRESHOLD: "1",
      CLAUDE_SESSION_ID: "s1",
    };
    const stop = { session_id: "s1", cwd: r.root };
    const prompt = { session_id: "s1", cwd: r.root, prompt: "hi" };

    run("stop-check-consolidation-drift.mjs", stop, env);
    const control = run("check-consolidation-flag.mjs", prompt, env);
    assert.notEqual(control.stdout.trim(), "", "control run never armed the nudge");

    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    const offEnv = { ...env, GATES_DISABLE: "docs-consolidate" };
    run("stop-check-consolidation-drift.mjs", stop, offEnv);
    const off = run("check-consolidation-flag.mjs", prompt, offEnv);
    assert.equal(off.status, 0);
    assert.equal(off.stdout.trim(), "");
  } finally {
    r.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
