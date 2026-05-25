// @ts-check
// PreCompact hook always writes a nudge flag — even when retro-fired exists.

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(
  here,
  "..",
  "scripts",
  "precompact-write-retro-flag.mjs",
);

/**
 * @param {string} stdin
 * @param {Record<string, string>} env
 */
function run(stdin, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

// Parity with test_precompact_always_fires.sh
test("PreCompact always writes nudge flag, even when retro-fired exists", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-pc-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const sid = "test-precompact";
  writeFileSync(path.join(tmp, `retro-fired-${sid}.flag`), "");

  const { code } = await run("{}", {
    CLAUDE_PLUGIN_DATA: tmp,
    CLAUDE_SESSION_ID: sid,
  });
  assert.equal(code, 0);

  const flag = path.join(tmp, `retro-nudge-${sid}.flag`);
  assert.ok(existsSync(flag), "expected nudge flag after PreCompact");
  assert.match(readFileSync(flag, "utf8"), /compact/);
});

test("PreCompact reads session_id from stdin", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-pc-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  // Explicit env without CLAUDE_SESSION_ID
  const child = spawn(process.execPath, [SCRIPT], {
    env: { CLAUDE_PLUGIN_DATA: tmp },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify({ session_id: "from-stdin" }));
  /** @type {number} */
  const code = await new Promise((resolve) =>
    child.on("close", (c) => resolve(c ?? 0)),
  );
  assert.equal(code, 0);
  assert.ok(existsSync(path.join(tmp, "retro-nudge-from-stdin.flag")));
});
