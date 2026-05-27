// @ts-check
// Integration: status-and-flag writes a flag that check-handoff-flag then
// consumes and surfaces via additionalContext. Mirrors the v0.1 cross-script
// contract that the bash tests only covered piecewise.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.join(here, "..", "scripts");
const statusScript = path.join(scriptsDir, "status-and-flag.mjs");
const checkScript = path.join(scriptsDir, "check-handoff-flag.mjs");

/**
 * @param {string} script
 * @param {string} stdinPayload
 * @param {Record<string, string>} extraEnv
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function run(script, stdinPayload, extraEnv) {
  return new Promise((resolve, reject) => {
    // Strip HANDOFF_EFFECTIVE_MAX_TOKENS so the developer's shell setting
    // doesn't bleed into tests that rely on the default (no effective max) path.
    const baseEnv = { ...process.env };
    delete baseEnv.HANDOFF_EFFECTIVE_MAX_TOKENS;
    const child = spawn(process.execPath, [script], {
      env: { ...baseEnv, ...extraEnv },
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

test("statusLine crossing -> check-handoff-flag emits and consumes", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-int-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "int-cross";
  // Seed below threshold so the new turn is the first crossing.
  writeFileSync(path.join(dir, `last-context-pct-${sid}.txt`), "60");

  // 1) statusLine: crossing
  const statusResult = await run(
    statusScript,
    JSON.stringify({
      session_id: sid,
      context_window: { used_percentage: 78 },
    }),
    { CLAUDE_PLUGIN_DATA: dir }
  );
  assert.equal(statusResult.code, 0);

  const flagFile = path.join(dir, `handoff-nudge-${sid}.flag`);
  assert.ok(existsSync(flagFile), "flag should exist after crossing");

  // 2) UserPromptSubmit: check-handoff-flag
  const checkResult = await run(
    checkScript,
    JSON.stringify({ session_id: sid }),
    { CLAUDE_PLUGIN_DATA: dir }
  );
  assert.equal(checkResult.code, 0);

  const out = JSON.parse(checkResult.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(out.hookSpecificOutput.additionalContext, /\[handoff\]/);
  assert.match(out.hookSpecificOutput.additionalContext, /78/);

  // Flag should have been consumed.
  assert.ok(!existsSync(flagFile), "flag should be deleted after consumption");

  // 3) A second UserPromptSubmit with no new crossing should be silent.
  const checkAgain = await run(
    checkScript,
    JSON.stringify({ session_id: sid }),
    { CLAUDE_PLUGIN_DATA: dir }
  );
  assert.equal(checkAgain.code, 0);
  assert.equal(checkAgain.stdout, "");
});

test("setup.mjs wires statusLine in a fresh ~/.claude/settings.json", async (t) => {
  // Run setup with HOME pointed at a tmpdir so we don't touch real settings.
  const home = mkdtempSync(path.join(os.tmpdir(), "handoff-setup-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const setupScript = path.join(scriptsDir, "setup.mjs");
  const result = await run(setupScript, "", { HOME: home, USERPROFILE: home });
  assert.equal(result.code, 0, `setup failed: ${result.stderr}`);

  const settingsPath = path.join(home, ".claude", "settings.json");
  assert.ok(existsSync(settingsPath), "settings.json not written");

  const { readFileSync } = await import("node:fs");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.ok(settings.statusLine, "statusLine not set");
  assert.equal(settings.statusLine.type, "command");
  // setup.mjs now writes a stable wrapper (handoff-statusline.mjs) rather than
  // pointing directly at the versioned plugin path.
  assert.match(settings.statusLine.command, /handoff-statusline\.mjs/);
});
