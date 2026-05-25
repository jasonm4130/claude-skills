// @ts-check
// Unit tests for shared lib.mjs helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

import {
  safeJsonParse,
  resolveSessionId,
  resolveDataDir,
  nowIso,
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
