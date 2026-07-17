// @ts-check
// UserPromptSubmit hook: consumes a per-session retro-nudge flag.
//   - PreCompact ("compact imminent") emits an immediate agent-directed nudge.
//   - Stop-origin flags are absorbed silently into retro-worthy.jsonl.
// Then evaluates the batch condition and fires an agent-directed nudge once
// enough worthy sessions have accrued since the last retro.

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
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

/** @returns {string} */
function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * @param {number} days
 * @returns {string}
 */
function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86_400_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
}

/**
 * @param {number} hours
 * @returns {string}
 */
function isoHoursAgo(hours) {
  return new Date(Date.now() - hours * 3_600_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
}

/**
 * @param {string} dir
 * @param {Array<{ts: string, sid: string, reasons: string}>} entries
 */
function writeWorthy(dir, entries) {
  const body = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(path.join(dir, "retro-worthy.jsonl"), body);
}

/** @returns {string} */
function mkTmp() {
  return mkdtempSync(path.join(os.tmpdir(), "test-session-retro-chk-"));
}

// A Stop-origin flag (any content other than "compact imminent") is absorbed
// silently into the worthy log — no immediate nudge — and dedups per session.
test("Stop-origin flag: silent, appends one worthy line (dedup on repeat)", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const sid = "test-stop-origin";
  const flag = path.join(tmp, `retro-nudge-${sid}.flag`);
  writeFileSync(flag, "3 edits across 2 files + 25 minutes of work");

  const r1 = await run(JSON.stringify({ session_id: sid }), {
    CLAUDE_PLUGIN_DATA: tmp,
  });
  assert.equal(r1.code, 0);
  assert.equal(r1.stdout, "", "Stop-origin flag must produce no output");
  assert.ok(!existsSync(flag), "flag consumed");

  const worthy = path.join(tmp, "retro-worthy.jsonl");
  assert.ok(existsSync(worthy), "worthy log written");
  let lines = readFileSync(worthy, "utf8").split("\n").filter((l) => l);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.sid, sid);
  assert.match(parsed.reasons, /3 edits across 2 files/);

  // Second consume for the same sid must not append twice.
  writeFileSync(flag, "another trigger");
  const r2 = await run(JSON.stringify({ session_id: sid }), {
    CLAUDE_PLUGIN_DATA: tmp,
  });
  assert.equal(r2.stdout, "", "still silent");
  lines = readFileSync(worthy, "utf8").split("\n").filter((l) => l);
  assert.equal(lines.length, 1, "dedup: no second worthy line for same sid");
});

// PreCompact flag keeps its immediate emission — context loss is a hard event.
test("compact imminent flag: emits [session-retro] context immediately", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const sid = "test-compact";
  writeFileSync(path.join(tmp, `retro-nudge-${sid}.flag`), "compact imminent");

  const { code, stdout } = await run(JSON.stringify({ session_id: sid }), {
    CLAUDE_PLUGIN_DATA: tmp,
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const ac = parsed.hookSpecificOutput.additionalContext;
  assert.match(ac, /\[session-retro\]/);
  assert.match(ac, /compact imminent/);
  assert.match(ac, /Run the retro skill now/);
});

test("no flag, no worthy log: silent exit (no stdout)", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const { code, stdout } = await run(
    JSON.stringify({ session_id: "test-check-no-flag" }),
    { CLAUDE_PLUGIN_DATA: tmp },
  );
  assert.equal(code, 0);
  assert.equal(stdout, "");
});

// Batch: >=3 worthy sessions since last retro, no recent batch nudge → fires.
test("batch nudge fires: 3 worthy, no last-retro, no recent batch nudge", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeWorthy(tmp, [
    { ts: isoDaysAgo(2), sid: "s1", reasons: "a" },
    { ts: isoDaysAgo(1), sid: "s2", reasons: "b" },
    { ts: nowIso(), sid: "s3", reasons: "c" },
  ]);

  const { code, stdout } = await run(
    JSON.stringify({ session_id: "test-batch-fire" }),
    { CLAUDE_PLUGIN_DATA: tmp },
  );
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.match(
    parsed.hookSpecificOutput.additionalContext,
    /\[session-retro\] 3 retro-worthy sessions .* Run the retro skill now/,
  );
  assert.match(
    parsed.hookSpecificOutput.additionalContext,
    /no retro recorded yet/,
    "first-ever nudge explains there is no prior retro",
  );
  assert.doesNotMatch(
    parsed.hookSpecificOutput.additionalContext,
    /\d{3,}\+ days/,
    "no epoch-derived day count on first-ever nudge",
  );
  assert.ok(
    existsSync(path.join(tmp, "last-batch-nudge.txt")),
    "batch-nudge timestamp recorded",
  );
});

test("batch silent: last-batch-nudge fresh (<24h)", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeWorthy(tmp, [
    { ts: isoDaysAgo(2), sid: "s1", reasons: "a" },
    { ts: isoDaysAgo(1), sid: "s2", reasons: "b" },
    { ts: nowIso(), sid: "s3", reasons: "c" },
  ]);
  writeFileSync(path.join(tmp, "last-batch-nudge.txt"), isoHoursAgo(1));

  const { code, stdout } = await run(
    JSON.stringify({ session_id: "test-batch-recent" }),
    { CLAUDE_PLUGIN_DATA: tmp },
  );
  assert.equal(code, 0);
  assert.equal(stdout, "", "batch nudge already fired within 24h");
});

test("batch silent: only 2 worthy entries", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeWorthy(tmp, [
    { ts: isoDaysAgo(1), sid: "s1", reasons: "a" },
    { ts: nowIso(), sid: "s2", reasons: "b" },
  ]);

  const { code, stdout } = await run(
    JSON.stringify({ session_id: "test-batch-two" }),
    { CLAUDE_PLUGIN_DATA: tmp },
  );
  assert.equal(code, 0);
  assert.equal(stdout, "", "below min-sessions threshold");
});

test("batch silent: last retro 3 days ago (< 7-day gate)", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  // 3 worthy entries all newer than last-retro (dated now), but the 7-day
  // gate has not elapsed since the last retro.
  writeWorthy(tmp, [
    { ts: nowIso(), sid: "s1", reasons: "a" },
    { ts: nowIso(), sid: "s2", reasons: "b" },
    { ts: nowIso(), sid: "s3", reasons: "c" },
  ]);
  writeFileSync(path.join(tmp, "last-retro.txt"), isoDaysAgo(3));

  const { code, stdout } = await run(
    JSON.stringify({ session_id: "test-batch-days" }),
    { CLAUDE_PLUGIN_DATA: tmp },
  );
  assert.equal(code, 0);
  assert.equal(stdout, "", "day gate not met");
});

// Worthy entries older than the last retro do not count toward the batch.
test("batch silent: worthy entries predate last retro", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeWorthy(tmp, [
    { ts: isoDaysAgo(20), sid: "s1", reasons: "a" },
    { ts: isoDaysAgo(19), sid: "s2", reasons: "b" },
    { ts: isoDaysAgo(18), sid: "s3", reasons: "c" },
  ]);
  writeFileSync(path.join(tmp, "last-retro.txt"), isoDaysAgo(10));

  const { code, stdout } = await run(
    JSON.stringify({ session_id: "test-batch-stale" }),
    { CLAUDE_PLUGIN_DATA: tmp },
  );
  assert.equal(code, 0);
  assert.equal(stdout, "", "all worthy entries predate the last retro");
});

// Cleanup is now append-only + identity: processed sids are excluded from the
// count via retro-processed.jsonl, and retro-worthy.jsonl is NEVER rewritten
// (it's a concurrently-appended multi-writer log — a rewrite would clobber
// another session's append).
test("processed sids are excluded from the count and the worthy log is not rewritten", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeWorthy(tmp, [
    { ts: isoDaysAgo(3), sid: "done1", reasons: "a" },
    { ts: isoDaysAgo(2), sid: "done2", reasons: "b" },
    { ts: isoDaysAgo(1), sid: "todo1", reasons: "c" },
  ]);
  // done1/done2 already retro'd (identity ledger); a processed marker exists so
  // the migration seed is a no-op.
  writeFileSync(
    path.join(tmp, "retro-processed.jsonl"),
    [
      JSON.stringify({ ts: isoDaysAgo(2), sid: "done1" }),
      JSON.stringify({ ts: isoDaysAgo(1), sid: "done2" }),
    ].join("\n") + "\n",
  );
  const worthyPath = path.join(tmp, "retro-worthy.jsonl");
  const before = readFileSync(worthyPath, "utf8");

  const { code, stdout } = await run(
    JSON.stringify({ session_id: "test-identity-count" }),
    { CLAUDE_PLUGIN_DATA: tmp, RETRO_BATCH_MIN_SESSIONS: "1", RETRO_BATCH_MIN_DAYS: "0" },
  );
  assert.equal(code, 0);
  // Only todo1 is unprocessed → count 1.
  const parsed = JSON.parse(stdout);
  assert.match(parsed.hookSpecificOutput.additionalContext, /1 retro-worthy session/);
  // The worthy log is byte-for-byte unchanged (never rewritten).
  assert.equal(readFileSync(worthyPath, "utf8"), before, "worthy log must not be rewritten");
});

// One-time upgrade migration: an install with legacy worthy entries but no
// processed ledger must not resurface sessions the old timestamp watermark
// already treated as done.
test("migration: legacy worthy entries (ts <= last-retro) are seeded processed, not re-counted", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeWorthy(tmp, [
    { ts: isoDaysAgo(20), sid: "legacy1", reasons: "a" },
    { ts: isoDaysAgo(19), sid: "legacy2", reasons: "b" },
    { ts: isoDaysAgo(19), sid: "legacy3", reasons: "c" },
  ]);
  writeFileSync(path.join(tmp, "last-retro.txt"), isoDaysAgo(10));
  // no retro-processed.jsonl

  const { code, stdout } = await run(
    JSON.stringify({ session_id: "test-migration" }),
    { CLAUDE_PLUGIN_DATA: tmp, RETRO_BATCH_MIN_SESSIONS: "1", RETRO_BATCH_MIN_DAYS: "0" },
  );
  assert.equal(code, 0);
  assert.equal(stdout, "", "all legacy entries seeded as processed → 0 unprocessed → silent");
  const processed = readFileSync(path.join(tmp, "retro-processed.jsonl"), "utf8");
  for (const sid of ["legacy1", "legacy2", "legacy3"]) {
    assert.match(processed, new RegExp(`"sid":"${sid}"`));
  }
});

// Env override lowers the session threshold.
test("env override: RETRO_BATCH_MIN_SESSIONS=2 fires with 2 worthy", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeWorthy(tmp, [
    { ts: isoDaysAgo(1), sid: "s1", reasons: "a" },
    { ts: nowIso(), sid: "s2", reasons: "b" },
  ]);

  const { code, stdout } = await run(
    JSON.stringify({ session_id: "test-batch-env" }),
    { CLAUDE_PLUGIN_DATA: tmp, RETRO_BATCH_MIN_SESSIONS: "2" },
  );
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.match(
    parsed.hookSpecificOutput.additionalContext,
    /2 retro-worthy sessions/,
  );
});
