// @ts-check
// GATES_DISABLE turns one guard off without touching its neighbours.
//
// The node side matters even though hooks.json reaches the binary first: the
// binary exits 0 when a guard is disabled, so the `|| node` fallback never
// fires on a machine that has it. It fires on every machine that does not —
// Linux, Intel Mac, a stripped install.
//
// Every case pairs the disabled run with a control run on identical input, so a
// payload that quietly stops triggering fails the test instead of passing it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

// ---- guards that write a decision to stdout ----

const STDOUT_GUARDS = [
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
