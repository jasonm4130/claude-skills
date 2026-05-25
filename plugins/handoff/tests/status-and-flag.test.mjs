// @ts-check
// Mirrors the v0.1 bash tests:
//   test_statusline_crossing.sh
//   test_statusline_already_above.sh
//   test_statusline_no_crossing.sh

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "scripts", "status-and-flag.mjs");

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
  return mkdtempSync(path.join(os.tmpdir(), "handoff-status-"));
}

test("test_statusline_crossing", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-crossing";
  writeFileSync(path.join(dir, `last-context-pct-${sid}.txt`), "60");

  const input = JSON.stringify({
    session_id: sid,
    context_window: { used_percentage: 76 },
  });
  const result = await run(input, { CLAUDE_PLUGIN_DATA: dir });

  assert.equal(result.code, 0);

  const flagFile = path.join(dir, `handoff-nudge-${sid}.flag`);
  assert.ok(existsSync(flagFile), "flag not written");

  const flagContent = readFileSync(flagFile, "utf8");
  assert.match(flagContent, /76/, `flag missing percentage: ${flagContent}`);
  assert.match(flagContent, /70/, `flag missing threshold: ${flagContent}`);

  const lastPct = readFileSync(path.join(dir, `last-context-pct-${sid}.txt`), "utf8");
  assert.equal(lastPct, "76", `last-pct not updated, got: ${lastPct}`);

  assert.ok(result.stdout.length > 0, "no output from status script");
});

test("test_statusline_already_above", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-already-above";
  writeFileSync(path.join(dir, `last-context-pct-${sid}.txt`), "76");

  const input = JSON.stringify({
    session_id: sid,
    context_window: { used_percentage: 78 },
  });
  const result = await run(input, { CLAUDE_PLUGIN_DATA: dir });

  assert.equal(result.code, 0);

  const flagFile = path.join(dir, `handoff-nudge-${sid}.flag`);
  assert.ok(!existsSync(flagFile), "flag should not be written when already above threshold");

  const lastPct = readFileSync(path.join(dir, `last-context-pct-${sid}.txt`), "utf8");
  assert.equal(lastPct, "78", `last-pct not updated, got: ${lastPct}`);
});

test("test_statusline_no_crossing", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-no-crossing";
  writeFileSync(path.join(dir, `last-context-pct-${sid}.txt`), "60");

  const input = JSON.stringify({
    session_id: sid,
    context_window: { used_percentage: 65 },
  });
  const result = await run(input, { CLAUDE_PLUGIN_DATA: dir });

  assert.equal(result.code, 0);

  const flagFile = path.join(dir, `handoff-nudge-${sid}.flag`);
  assert.ok(!existsSync(flagFile), "flag should not be written below threshold");

  const lastPct = readFileSync(path.join(dir, `last-context-pct-${sid}.txt`), "utf8");
  assert.equal(lastPct, "65", `last-pct not updated, got: ${lastPct}`);
});

test("statusline outputs '?' on invalid JSON", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = await run("not json at all", { CLAUDE_PLUGIN_DATA: dir });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^\?/);
});
