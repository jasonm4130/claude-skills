// @ts-check
// Mirrors v0.1 bash tests:
//   test_check_handoff_flag_consumes.sh
//   test_check_handoff_flag_no_flag.sh

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "scripts", "check-handoff-flag.mjs");

/**
 * @param {string} stdinPayload
 * @param {Record<string, string>} extraEnv
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function run(stdinPayload, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => {
      stdout += b.toString("utf8");
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    child.stdin.write(stdinPayload);
    child.stdin.end();
  });
}

function mkTmp() {
  return mkdtempSync(path.join(os.tmpdir(), "handoff-check-"));
}

test("test_check_handoff_flag_consumes", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-flag-consumes";
  const flagFile = path.join(dir, `handoff-nudge-${sid}.flag`);
  writeFileSync(flagFile, "context at 76% (threshold 70%)");

  const result = await run(JSON.stringify({ session_id: sid }), {
    CLAUDE_PLUGIN_DATA: dir,
  });

  assert.equal(result.code, 0);

  // Output must be JSON with hookSpecificOutput envelope
  const out = JSON.parse(result.stdout);
  assert.ok(out.hookSpecificOutput, `no hookSpecificOutput in output: ${result.stdout}`);
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");

  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /\[handoff\]/, `missing [handoff] in context: ${ctx}`);
  assert.match(ctx, /76/, `missing percentage in context: ${ctx}`);

  // Flag should be deleted (consumed)
  assert.ok(!existsSync(flagFile), "flag not deleted after consumption");
});

// --- Severity-tiered wording (Task 7) ---

test("check-handoff-flag: below-85 tier uses 'wrap the current step' wording", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-tier-low";
  const flagFile = path.join(dir, `handoff-nudge-${sid}.flag`);
  writeFileSync(flagFile, "context at 72% (threshold 70%)");

  const result = await run(JSON.stringify({ session_id: sid }), {
    CLAUDE_PLUGIN_DATA: dir,
  });

  assert.equal(result.code, 0);
  const out = JSON.parse(result.stdout);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /\[handoff\].*run the handoff skill/i, `unexpected wording: ${ctx}`);
  assert.match(ctx, /wrap the current step/i, `unexpected wording: ${ctx}`);
});

test("check-handoff-flag: >=85 tier uses urgent NOW/clear wording", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-tier-high";
  const flagFile = path.join(dir, `handoff-nudge-${sid}.flag`);
  writeFileSync(flagFile, "context at 91% (threshold 70%)");

  const result = await run(JSON.stringify({ session_id: sid }), {
    CLAUDE_PLUGIN_DATA: dir,
  });

  assert.equal(result.code, 0);
  const out = JSON.parse(result.stdout);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /NOW/, `unexpected wording: ${ctx}`);
  assert.match(ctx, /\/clear/, `unexpected wording: ${ctx}`);
});

test("test_check_handoff_flag_no_flag", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-flag-no-flag";
  const result = await run(JSON.stringify({ session_id: sid }), {
    CLAUDE_PLUGIN_DATA: dir,
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "", `expected empty output, got: ${result.stdout}`);
});
