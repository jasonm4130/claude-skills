// @ts-check
// GATES_DISABLE turns json-config-guard off.
//
// The hook runs the binary only, and go/config_test.go covers its side. This
// checks the .mjs reference implementation.
//
// The disabled run is paired with a control run on identical input, so a payload
// that quietly stops triggering fails the test instead of passing it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
