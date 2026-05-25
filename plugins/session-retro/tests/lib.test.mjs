// @ts-check
// Tests for the shared lib.mjs helpers.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  safeJsonParse,
  resolveSessionId,
  resolveDataDir,
  nowIso,
} from "../scripts/lib.mjs";

test("safeJsonParse: returns parsed object for valid JSON", () => {
  const r = safeJsonParse('{"a":1}');
  assert.deepEqual(r, { a: 1 });
});

test("safeJsonParse: returns null for invalid JSON", () => {
  assert.equal(safeJsonParse("not json"), null);
});

test("safeJsonParse: returns null for empty string", () => {
  assert.equal(safeJsonParse(""), null);
});

test("safeJsonParse: returns null for JSON null/primitives", () => {
  assert.equal(safeJsonParse("null"), null);
  assert.equal(safeJsonParse("42"), null);
  assert.equal(safeJsonParse('"hello"'), null);
});

test("resolveSessionId: extracts from payload", () => {
  assert.equal(resolveSessionId({ session_id: "abc" }), "abc");
});

test("resolveSessionId: falls back to env var", () => {
  const prev = process.env.CLAUDE_SESSION_ID;
  process.env.CLAUDE_SESSION_ID = "env-sid";
  try {
    assert.equal(resolveSessionId(null), "env-sid");
    assert.equal(resolveSessionId({}), "env-sid");
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_SESSION_ID;
    else process.env.CLAUDE_SESSION_ID = prev;
  }
});

test("resolveSessionId: returns 'unknown' when missing everywhere", () => {
  const prev = process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  try {
    assert.equal(resolveSessionId(null), "unknown");
    assert.equal(resolveSessionId({}), "unknown");
  } finally {
    if (prev !== undefined) process.env.CLAUDE_SESSION_ID = prev;
  }
});

test("resolveDataDir: uses CLAUDE_PLUGIN_DATA when set", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-lib-"));
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tmp;
  t.after(() => {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
    rmSync(tmp, { recursive: true, force: true });
  });
  assert.equal(resolveDataDir("session-retro-data"), tmp);
  assert.ok(existsSync(tmp));
});

test("resolveDataDir: falls back to tmpdir when env unset", (t) => {
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;
  t.after(() => {
    if (prev !== undefined) process.env.CLAUDE_PLUGIN_DATA = prev;
  });
  const dir = resolveDataDir("session-retro-data");
  assert.equal(dir, path.join(os.tmpdir(), "session-retro-data"));
  assert.ok(existsSync(dir));
});

test("nowIso: returns ISO-8601 UTC with no fractional seconds", () => {
  const ts = nowIso();
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});
