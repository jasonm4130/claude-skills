// @ts-check
// UserPromptSubmit hook consumes retro-nudge flag and emits additionalContext.

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  existsSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "scripts", "check-retro-flag.mjs");

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

// Parity with test_check_retro_flag_consumes.sh
test("flag present: emits additionalContext envelope, deletes flag", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-chk-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const sid = "test-check-consume";
  const reasons = "3 edits across 2 files + 25 minutes of work";
  const flag = path.join(tmp, `retro-nudge-${sid}.flag`);
  writeFileSync(flag, reasons);

  const { code, stdout } = await run(JSON.stringify({ session_id: sid }), {
    CLAUDE_PLUGIN_DATA: tmp,
  });
  assert.equal(code, 0);
  assert.ok(stdout.length > 0, "expected non-empty stdout");

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const ac = parsed.hookSpecificOutput.additionalContext;
  assert.match(ac, /3 edits across 2 files/);
  assert.match(ac, /\/retro/);

  assert.ok(!existsSync(flag), "flag should be deleted after consumption");
});

// Parity with test_check_retro_flag_no_flag.sh
test("no flag: silent exit (no stdout)", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-chk-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const sid = "test-check-no-flag";
  const { code, stdout } = await run(JSON.stringify({ session_id: sid }), {
    CLAUDE_PLUGIN_DATA: tmp,
  });
  assert.equal(code, 0);
  assert.equal(stdout, "");
});
