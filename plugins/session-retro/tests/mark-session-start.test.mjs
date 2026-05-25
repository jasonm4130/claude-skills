// @ts-check
// SessionStart hook writes an ISO-8601 timestamp to session-start-{sid}.txt.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "scripts", "mark-session-start.mjs");

/**
 * @param {string} script
 * @param {string} stdin
 * @param {Record<string, string>} env
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runScript(script, stdin, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
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

test("mark-session-start: writes session-start-{sid}.txt with ISO timestamp", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-mss-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const { code } = await runScript(
    SCRIPT,
    JSON.stringify({ session_id: "sid-mss-1" }),
    { CLAUDE_PLUGIN_DATA: tmp },
  );
  assert.equal(code, 0);

  const outPath = path.join(tmp, "session-start-sid-mss-1.txt");
  assert.ok(existsSync(outPath), "expected session-start file to be created");
  const ts = readFileSync(outPath, "utf8");
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test("mark-session-start: falls back to env CLAUDE_SESSION_ID", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-mss-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const { code } = await runScript(SCRIPT, "{}", {
    CLAUDE_PLUGIN_DATA: tmp,
    CLAUDE_SESSION_ID: "env-sid",
  });
  assert.equal(code, 0);
  assert.ok(existsSync(path.join(tmp, "session-start-env-sid.txt")));
});

test("mark-session-start: writes session-start-unknown.txt when sid missing", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-mss-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  // Strip CLAUDE_SESSION_ID from inherited env
  const env = { CLAUDE_PLUGIN_DATA: tmp };
  const child = spawn(process.execPath, [SCRIPT], {
    env, // explicit env: no PATH/CLAUDE_SESSION_ID inherited
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end("{}");
  /** @type {number} */
  const code = await new Promise((resolve) => {
    child.on("close", (c) => resolve(c ?? 0));
  });
  assert.equal(code, 0);
  assert.ok(existsSync(path.join(tmp, "session-start-unknown.txt")));
});
