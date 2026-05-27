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
import { randomUUID } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "scripts", "status-and-flag.mjs");

/**
 * @param {string} stdinPayload
 * @param {Record<string, string>} extraEnv
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function run(stdinPayload, extraEnv) {
  return new Promise((resolve, reject) => {
    // Strip HANDOFF_EFFECTIVE_MAX_TOKENS from the inherited env so that a
    // developer's shell setting doesn't bleed into tests that don't set it.
    // Tests that need the env var pass it explicitly via extraEnv.
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

/**
 * Write a JSONL transcript file with the given entries.
 * @param {string} dir
 * @param {object[]} entries
 * @returns {string} absolute path to the written file
 */
function writeTranscript(dir, entries) {
  const filePath = path.join(dir, `${randomUUID()}.jsonl`);
  writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join("\n"));
  return filePath;
}

// --- Updated tests: current_usage null/missing with HANDOFF_EFFECTIVE_MAX_TOKENS set ---
// Per issue #6: when effective max is set but current_usage is absent, we now attempt
// JSONL fallback rather than silently falling back to raw used_percentage.

test("effective_max: bails to '?' when current_usage is null and no transcript_path", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-effective-null-no-transcript";
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
  assert.match(result.stdout, /^\?/);
  // Must NOT fall back to raw 42%
  assert.doesNotMatch(result.stdout, /42%/);
});

test("effective_max: bails to '?' when current_usage is missing and no transcript_path", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-effective-missing-no-transcript";
  const input = JSON.stringify({
    session_id: sid,
    context_window: { used_percentage: 23 },
  });
  const result = await run(input, {
    CLAUDE_PLUGIN_DATA: dir,
    HANDOFF_EFFECTIVE_MAX_TOKENS: "400000",
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /^\?/);
  assert.doesNotMatch(result.stdout, /23%/);
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

test("effective_max: bails to '?' when current_usage is all-zero and no transcript_path (issue #6)", async (t) => {
  // Per issue #6: all-zero current_usage means the new turn hasn't been recorded yet.
  // Without a transcript to fall back to, we bail rather than show a stale/wrong 0%.
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
  assert.match(result.stdout, /^\?/);
  // Must not show 0% or 5% — both are wrong without transcript fallback
  assert.doesNotMatch(result.stdout, /5%/);
});

// --- JSONL fallback tests (issue #6) ---

test("effective_max + JSONL fallback: uses transcript when current_usage is missing", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-jsonl-fallback-missing";
  // 200000 / 400000 = 50%
  const transcriptPath = writeTranscript(dir, [
    {
      type: "assistant",
      isSidechain: false,
      message: { usage: { input_tokens: 200000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    },
  ]);

  const input = JSON.stringify({
    session_id: sid,
    transcript_path: transcriptPath,
    context_window: { used_percentage: 20 },
  });
  const result = await run(input, {
    CLAUDE_PLUGIN_DATA: dir,
    HANDOFF_EFFECTIVE_MAX_TOKENS: "400000",
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /50%/);
  assert.doesNotMatch(result.stdout, /20%/);
});

test("effective_max + JSONL fallback: uses transcript when current_usage is null", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-jsonl-fallback-null";
  // 320000 + 80000 = 400000 / 400000 = 100%
  const transcriptPath = writeTranscript(dir, [
    {
      type: "assistant",
      isSidechain: false,
      message: {
        usage: {
          input_tokens: 320000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 80000,
        },
      },
    },
  ]);

  const input = JSON.stringify({
    session_id: sid,
    transcript_path: transcriptPath,
    context_window: {
      used_percentage: 40,
      current_usage: null,
    },
  });
  const result = await run(input, {
    CLAUDE_PLUGIN_DATA: dir,
    HANDOFF_EFFECTIVE_MAX_TOKENS: "400000",
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /100%/);
  assert.doesNotMatch(result.stdout, /40%/);
});

test("effective_max + JSONL fallback: uses LAST main-chain assistant turn", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-jsonl-last-turn";
  // Last turn: 300000 / 400000 = 75%
  const transcriptPath = writeTranscript(dir, [
    {
      type: "assistant",
      isSidechain: false,
      message: { usage: { input_tokens: 100000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    },
    {
      type: "assistant",
      isSidechain: true, // sidechain — should be skipped
      message: { usage: { input_tokens: 999999, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    },
    {
      type: "assistant",
      isSidechain: false,
      message: { usage: { input_tokens: 300000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    },
  ]);

  const input = JSON.stringify({
    session_id: sid,
    transcript_path: transcriptPath,
    context_window: { used_percentage: 25 },
  });
  const result = await run(input, {
    CLAUDE_PLUGIN_DATA: dir,
    HANDOFF_EFFECTIVE_MAX_TOKENS: "400000",
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /75%/);
  assert.doesNotMatch(result.stdout, /25%/);
});

test("effective_max + JSONL fallback: bails to '?' when transcript_path doesn't exist", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-jsonl-missing-file";
  const input = JSON.stringify({
    session_id: sid,
    transcript_path: "/nonexistent/no-such-file.jsonl",
    context_window: { used_percentage: 33 },
  });
  const result = await run(input, {
    CLAUDE_PLUGIN_DATA: dir,
    HANDOFF_EFFECTIVE_MAX_TOKENS: "400000",
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /^\?/);
  assert.doesNotMatch(result.stdout, /33%/);
});

test("effective_max + JSONL fallback: bails to '?' when transcript exists but is empty", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-jsonl-empty-file";
  const transcriptPath = path.join(dir, "empty.jsonl");
  writeFileSync(transcriptPath, "");

  const input = JSON.stringify({
    session_id: sid,
    transcript_path: transcriptPath,
    context_window: { used_percentage: 33 },
  });
  const result = await run(input, {
    CLAUDE_PLUGIN_DATA: dir,
    HANDOFF_EFFECTIVE_MAX_TOKENS: "400000",
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /^\?/);
  assert.doesNotMatch(result.stdout, /33%/);
});

test("effective_max + JSONL fallback: current_usage all-zero uses JSONL when transcript has data", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-jsonl-zero-current-usage";
  // current_usage is all zeros (new turn hasn't been recorded yet) → fall through to JSONL
  // Transcript has 200k tokens → 50%
  const transcriptPath = writeTranscript(dir, [
    {
      type: "assistant",
      isSidechain: false,
      message: { usage: { input_tokens: 200000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    },
  ]);

  const input = JSON.stringify({
    session_id: sid,
    transcript_path: transcriptPath,
    context_window: {
      used_percentage: 10,
      current_usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
  const result = await run(input, {
    CLAUDE_PLUGIN_DATA: dir,
    HANDOFF_EFFECTIVE_MAX_TOKENS: "400000",
  });

  assert.equal(result.code, 0);
  // The all-zero current_usage is "present and non-zero"=false → JSONL fallback → 50%
  assert.match(result.stdout, /50%/);
  assert.doesNotMatch(result.stdout, /10%/);
});

test("effective_max + JSONL fallback: last assistant turn with all-zero usage renders 0%", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-jsonl-zero-tokens";
  // current_usage missing, transcript exists, last assistant turn has all-zero usage.
  // Documented behavior: still uses it (0%); not bailing to '?'.
  const transcriptPath = writeTranscript(dir, [
    {
      type: "assistant",
      isSidechain: false,
      message: { usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    },
  ]);

  const input = JSON.stringify({
    session_id: sid,
    transcript_path: transcriptPath,
    context_window: { used_percentage: 50 },
  });
  const result = await run(input, {
    CLAUDE_PLUGIN_DATA: dir,
    HANDOFF_EFFECTIVE_MAX_TOKENS: "400000",
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /\] 0%/);
  assert.doesNotMatch(result.stdout, /50%/);
});

test("effective_max NOT set + current_usage missing: preserves existing behavior using raw used_percentage", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-no-effective-max";
  const input = JSON.stringify({
    session_id: sid,
    context_window: { used_percentage: 47 },
  });
  const result = await run(input, {
    CLAUDE_PLUGIN_DATA: dir,
    // HANDOFF_EFFECTIVE_MAX_TOKENS deliberately not set
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /47%/);
});
