// @ts-check
// GATES_DISABLE turns one guard off without touching its neighbours.
//
// The node side matters even though hooks.json reaches the binary first: the
// binary exits 0 when a guard is disabled, so the `|| node` fallback never
// fires on a machine that has it. It fires on every machine that does not —
// Linux, Intel Mac, a stripped install — and docs-sync and docs-consolidate
// have no binary path at all.
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
function run(name, input, extraEnv = {}) {
  const stdin = typeof input === "string" ? input : JSON.stringify(input);
  const res = spawnSync("node", [script(name)], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
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
  const on = (raw) => isGuardDisabled("lsp-first", { GATES_DISABLE: raw });
  assert.equal(isGuardDisabled("lsp-first", {}), false);
  assert.equal(on(""), false);
  assert.equal(on("lsp-first"), true);
  assert.equal(on("design-gate,lsp-first"), true);
  assert.equal(on(" design-gate , lsp-first "), true);
  assert.equal(on("design-gate,agent-model"), false);
  assert.equal(on("LSP-FIRST"), false);
  assert.equal(on("lsp_first"), false);
  assert.equal(on("lsp-first-extra"), false);
  assert.equal(on(",,"), false);
  assert.equal(on("lsp-first,"), true);
});

// ---- guards that write a decision to stdout ----

const STDOUT_GUARDS = [
  {
    guard: "design-gate",
    file: "pretooluse-guard-design-gate.mjs",
    payload: { tool_name: "Bash", tool_input: { command: "npm create vite@latest my-app" } },
  },
  {
    guard: "agent-model",
    file: "pretooluse-guard-agent-model.mjs",
    payload: { tool_name: "Agent", tool_input: { prompt: "x" } },
  },
  {
    guard: "workflow-model",
    file: "pretooluse-guard-workflow-model.mjs",
    payload: {
      tool_name: "Workflow",
      tool_input: { script: 'phase("x"); await parallel(items.map(i => () => agent("do " + i)))' },
    },
  },
];

for (const { guard, file, payload } of STDOUT_GUARDS) {
  test(`GATES_DISABLE silences ${guard}`, () => {
    const control = run(file, payload);
    assert.notEqual(control.stdout.trim(), "", "control run was silent — the case proves nothing");

    const off = run(file, payload, { GATES_DISABLE: guard });
    assert.equal(off.status, 0);
    assert.equal(off.stdout.trim(), "");
  });

  test(`disabling another guard leaves ${guard} alone`, () => {
    const other = run(file, payload, { GATES_DISABLE: "docs-sync,docs-consolidate" });
    assert.notEqual(other.stdout.trim(), "");
  });
}

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

// ---- json-config-guard: signals by exiting 2 with stderr ----

test("GATES_DISABLE silences json-config-guard", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gd-json-"));
  try {
    const bad = path.join(dir, "settings.json");
    writeFileSync(bad, '{"a":1,}');
    const payload = { tool_name: "Edit", tool_input: { file_path: bad } };

    const control = run("posttooluse-guard-json-config.mjs", payload);
    assert.equal(control.status, 2, "control run did not flag the broken file");

    const off = run("posttooluse-guard-json-config.mjs", payload, {
      GATES_DISABLE: "json-config-guard",
    });
    assert.equal(off.status, 0);
    assert.equal(off.stderr.trim(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
