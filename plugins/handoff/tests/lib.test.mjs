// @ts-check
// Unit tests for shared lib.mjs helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

import {
  safeJsonParse,
  resolveSessionId,
  resolveDataDir,
  nowIso,
  lastAssistantUsageFromTranscript,
} from "../scripts/lib.mjs";

test("safeJsonParse returns object for valid JSON", () => {
  assert.deepEqual(safeJsonParse('{"a":1}'), { a: 1 });
});

test("safeJsonParse returns null for invalid JSON", () => {
  assert.equal(safeJsonParse("not json"), null);
});

test("safeJsonParse returns null for empty input", () => {
  assert.equal(safeJsonParse(""), null);
});

test("safeJsonParse returns null for non-object JSON", () => {
  assert.equal(safeJsonParse("42"), null);
  assert.equal(safeJsonParse('"str"'), null);
  assert.equal(safeJsonParse("null"), null);
});

test("resolveSessionId prefers payload.session_id", () => {
  assert.equal(resolveSessionId({ session_id: "abc" }), "abc");
});

test("resolveSessionId falls back to env, then 'unknown'", () => {
  const prev = process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  assert.equal(resolveSessionId(null), "unknown");
  process.env.CLAUDE_SESSION_ID = "envsid";
  assert.equal(resolveSessionId(null), "envsid");
  assert.equal(resolveSessionId({}), "envsid");
  if (prev === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = prev;
});

test("resolveDataDir uses CLAUDE_PLUGIN_DATA when set", (t) => {
  const dir = path.join(os.tmpdir(), `handoff-lib-test-${randomUUID()}`);
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
    rmSync(dir, { recursive: true, force: true });
  });
  const resolved = resolveDataDir("handoff-data");
  assert.equal(resolved, dir);
  assert.ok(existsSync(dir), "data dir should be created");
});

test("resolveDataDir falls back to tmpdir/<fallbackName>", (t) => {
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;
  const fallback = `handoff-fallback-${randomUUID()}`;
  t.after(() => {
    if (prev !== undefined) process.env.CLAUDE_PLUGIN_DATA = prev;
    rmSync(path.join(os.tmpdir(), fallback), { recursive: true, force: true });
  });
  const resolved = resolveDataDir(fallback);
  assert.equal(resolved, path.join(os.tmpdir(), fallback));
  assert.ok(existsSync(resolved));
});

test("nowIso returns YYYY-MM-DDTHH:MM:SSZ", () => {
  const ts = nowIso();
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

// --- lastAssistantUsageFromTranscript tests ---

function mkTmpDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-lib-transcript-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeTranscript(dir, lines) {
  const filePath = path.join(dir, `${randomUUID()}.jsonl`);
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n"));
  return filePath;
}

test("lastAssistantUsageFromTranscript: returns null for nonexistent path", () => {
  const result = lastAssistantUsageFromTranscript("/nonexistent/path/to/file.jsonl");
  assert.equal(result, null);
});

test("lastAssistantUsageFromTranscript: returns null for empty file", (t) => {
  const dir = mkTmpDir(t);
  const filePath = path.join(dir, "empty.jsonl");
  writeFileSync(filePath, "");
  const result = lastAssistantUsageFromTranscript(filePath);
  assert.equal(result, null);
});

test("lastAssistantUsageFromTranscript: returns null when no assistant entries exist", (t) => {
  const dir = mkTmpDir(t);
  const filePath = writeTranscript(dir, [
    { type: "user", message: { content: "hello" } },
    { type: "system", message: { content: "system msg" } },
  ]);
  const result = lastAssistantUsageFromTranscript(filePath);
  assert.equal(result, null);
});

test("lastAssistantUsageFromTranscript: returns usage from last main-chain assistant entry", (t) => {
  const dir = mkTmpDir(t);
  const filePath = writeTranscript(dir, [
    {
      type: "assistant",
      isSidechain: false,
      message: { usage: { input_tokens: 100, cache_creation_input_tokens: 500, cache_read_input_tokens: 1000 } },
    },
    {
      type: "assistant",
      isSidechain: false,
      message: { usage: { input_tokens: 200, cache_creation_input_tokens: 600, cache_read_input_tokens: 2000 } },
    },
  ]);
  const result = lastAssistantUsageFromTranscript(filePath);
  assert.deepEqual(result, { inputTokens: 200, cacheCreationTokens: 600, cacheReadTokens: 2000 });
});

test("lastAssistantUsageFromTranscript: skips sidechain entries (isSidechain: true)", (t) => {
  const dir = mkTmpDir(t);
  const filePath = writeTranscript(dir, [
    {
      type: "assistant",
      isSidechain: false,
      message: { usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    },
    {
      type: "assistant",
      isSidechain: true,
      message: { usage: { input_tokens: 9999, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    },
  ]);
  const result = lastAssistantUsageFromTranscript(filePath);
  assert.deepEqual(result, { inputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0 });
});

test("lastAssistantUsageFromTranscript: handles missing usage fields as 0", (t) => {
  const dir = mkTmpDir(t);
  const filePath = writeTranscript(dir, [
    {
      type: "assistant",
      message: { usage: { input_tokens: 50 } },
    },
  ]);
  const result = lastAssistantUsageFromTranscript(filePath);
  assert.deepEqual(result, { inputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 });
});

test("lastAssistantUsageFromTranscript: handles entry with no usage object", (t) => {
  const dir = mkTmpDir(t);
  const filePath = writeTranscript(dir, [
    {
      type: "assistant",
      message: {},
    },
  ]);
  const result = lastAssistantUsageFromTranscript(filePath);
  assert.deepEqual(result, { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 });
});

test("lastAssistantUsageFromTranscript: tolerates malformed JSON lines mixed with valid ones", (t) => {
  const dir = mkTmpDir(t);
  const filePath = path.join(dir, "mixed.jsonl");
  writeFileSync(
    filePath,
    [
      JSON.stringify({ type: "assistant", isSidechain: false, message: { usage: { input_tokens: 77 } } }),
      "this is not valid json {{{",
      "",
      JSON.stringify({ type: "user", message: {} }),
    ].join("\n"),
  );
  // The last valid assistant entry is the first line (scanning backwards, user line is skipped, bad line is skipped)
  const result = lastAssistantUsageFromTranscript(filePath);
  assert.deepEqual(result, { inputTokens: 77, cacheCreationTokens: 0, cacheReadTokens: 0 });
});

test("lastAssistantUsageFromTranscript: isSidechain undefined is treated as main-chain", (t) => {
  const dir = mkTmpDir(t);
  const filePath = writeTranscript(dir, [
    {
      type: "assistant",
      // isSidechain not present
      message: { usage: { input_tokens: 42, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 } },
    },
  ]);
  const result = lastAssistantUsageFromTranscript(filePath);
  assert.deepEqual(result, { inputTokens: 42, cacheCreationTokens: 10, cacheReadTokens: 5 });
});
