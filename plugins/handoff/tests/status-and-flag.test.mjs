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

// --- HANDOFF_EFFECTIVE_MAX_TOKENS workaround tests (issue #4) ---

test("effective_max: computes pct against env var when current_usage present (issue #4 96% scenario)", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-effective-96";
  const input = JSON.stringify({
    session_id: sid,
    context_window: {
      used_percentage: 35,
      current_usage: {
        input_tokens: 380000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 4000,
      },
    },
  });
  const result = await run(input, {
    CLAUDE_PLUGIN_DATA: dir,
    HANDOFF_EFFECTIVE_MAX_TOKENS: "400000",
  });

  assert.equal(result.code, 0);
  // Bar should show 96%, not 35%
  assert.match(result.stdout, /96%/);
  assert.doesNotMatch(result.stdout, /35%/);

  // last-pct file should reflect the computed value
  const lastPct = readFileSync(path.join(dir, `last-context-pct-${sid}.txt`), "utf8");
  assert.equal(lastPct, "96");
});

test("effective_max: crossing triggers flag with computed pct in message", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-effective-crossing";
  writeFileSync(path.join(dir, `last-context-pct-${sid}.txt`), "60");

  const input = JSON.stringify({
    session_id: sid,
    context_window: {
      used_percentage: 35, // CC's raw value — should be ignored
      current_usage: {
        input_tokens: 380000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 4000,
      },
    },
  });
  const result = await run(input, {
    CLAUDE_PLUGIN_DATA: dir,
    HANDOFF_EFFECTIVE_MAX_TOKENS: "400000",
  });

  assert.equal(result.code, 0);

  const flagFile = path.join(dir, `handoff-nudge-${sid}.flag`);
  assert.ok(existsSync(flagFile), "flag should fire when computed pct crosses threshold");

  const flagContent = readFileSync(flagFile, "utf8");
  assert.match(flagContent, /96/, `flag should contain computed pct, got: ${flagContent}`);
  assert.match(flagContent, /70/, `flag should contain threshold, got: ${flagContent}`);
  assert.doesNotMatch(flagContent, /35/);
});

test("effective_max: falls back to used_percentage when current_usage is null", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-effective-null";
  const input = JSON.stringify({
    session_id: sid,
    context_window: {
      used_percentage: 42,
      current_usage: null,
    },
  });
  const result = await run(input, {
    CLAUDE_PLUGIN_DATA: dir,
    HANDOFF_EFFECTIVE_MAX_TOKENS: "400000",
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /42%/);

  const lastPct = readFileSync(path.join(dir, `last-context-pct-${sid}.txt`), "utf8");
  assert.equal(lastPct, "42");
});

test("effective_max: falls back to used_percentage when current_usage is missing", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-effective-missing";
  const input = JSON.stringify({
    session_id: sid,
    context_window: { used_percentage: 23 },
  });
  const result = await run(input, {
    CLAUDE_PLUGIN_DATA: dir,
    HANDOFF_EFFECTIVE_MAX_TOKENS: "400000",
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /23%/);
});

test("effective_max: falls back when env var is '0'", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-effective-zero";
  const input = JSON.stringify({
    session_id: sid,
    context_window: {
      used_percentage: 35,
      current_usage: { input_tokens: 380000, cache_creation_input_tokens: 0, cache_read_input_tokens: 4000 },
    },
  });
  const result = await run(input, {
    CLAUDE_PLUGIN_DATA: dir,
    HANDOFF_EFFECTIVE_MAX_TOKENS: "0",
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /35%/);
  assert.doesNotMatch(result.stdout, /96%/);
});

test("effective_max: falls back when env var is 'abc' (NaN)", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-effective-nan";
  const input = JSON.stringify({
    session_id: sid,
    context_window: {
      used_percentage: 35,
      current_usage: { input_tokens: 380000, cache_creation_input_tokens: 0, cache_read_input_tokens: 4000 },
    },
  });
  const result = await run(input, {
    CLAUDE_PLUGIN_DATA: dir,
    HANDOFF_EFFECTIVE_MAX_TOKENS: "abc",
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /35%/);
});

test("effective_max: falls back when env var is negative", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-effective-neg";
  const input = JSON.stringify({
    session_id: sid,
    context_window: {
      used_percentage: 35,
      current_usage: { input_tokens: 380000, cache_creation_input_tokens: 0, cache_read_input_tokens: 4000 },
    },
  });
  const result = await run(input, {
    CLAUDE_PLUGIN_DATA: dir,
    HANDOFF_EFFECTIVE_MAX_TOKENS: "-100",
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /35%/);
});

test("effective_max: renders 0% when input tokens are 0 (early session)", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-effective-zero-tokens";
  const input = JSON.stringify({
    session_id: sid,
    context_window: {
      used_percentage: 5,
      current_usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
  const result = await run(input, {
    CLAUDE_PLUGIN_DATA: dir,
    HANDOFF_EFFECTIVE_MAX_TOKENS: "400000",
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /0%/);
  // Should not have fallen back to 5%
  assert.doesNotMatch(result.stdout, /5%/);
});
