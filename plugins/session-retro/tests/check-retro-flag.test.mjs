// @ts-check
// UserPromptSubmit hook: consumes a per-session retro-nudge flag (Stop- or
// PreCompact-origin) silently into retro-worthy.jsonl, then evaluates the
// end-of-day offer: past RETRO_EOD_HOUR local time, at most once per calendar
// day, and only once the RETRO_BATCH_* thresholds are met.
//
// Time is injected via RETRO_NOW (never the wall clock) and TZ is pinned to UTC,
// so "past 16:00 local" is a fact about the test, not about when it runs.

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

// Injected "now". Everything else in the file is derived from it, so no
// assertion depends on the real clock.
const EVENING = "2026-08-26T18:00:00Z"; // 18:00 local under TZ=UTC
const MORNING = "2026-08-26T09:00:00Z";
const TODAY = "2026-08-26";
const NOW_MS = Date.parse(EVENING);

/**
 * Threshold env vars are read from the ambient environment, so a developer with
 * RETRO_BATCH_* / RETRO_EOD_HOUR / RETRO_NOW set in their Claude settings would
 * otherwise flip tests that assert the documented defaults. Strip them; a test
 * that cares sets its own.
 * @returns {Record<string, string | undefined>}
 */
function baseEnv() {
  const e = { ...process.env };
  delete e.RETRO_BATCH_MIN_SESSIONS;
  delete e.RETRO_BATCH_MIN_DAYS;
  delete e.RETRO_BATCH_MAX_SESSIONS;
  delete e.RETRO_EOD_HOUR;
  delete e.RETRO_NOW;
  return e;
}

/**
 * Default env for a run: data dir, pinned zone, injected evening clock.
 * @param {string} tmp
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string>}
 */
function env(tmp, extra) {
  return { CLAUDE_PLUGIN_DATA: tmp, TZ: "UTC", RETRO_NOW: EVENING, ...extra };
}

/**
 * @param {string} stdin
 * @param {Record<string, string>} runEnv
 */
function run(stdin, runEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...baseEnv(), ...runEnv },
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

/**
 * @param {number} days
 * @returns {string}
 */
function isoDaysAgo(days) {
  return new Date(NOW_MS - days * 86_400_000)
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

/**
 * Three unprocessed worthy sessions — enough for the default threshold.
 * @param {string} dir
 */
function writeThreeWorthy(dir) {
  writeWorthy(dir, [
    { ts: isoDaysAgo(2), sid: "s1", reasons: "a" },
    { ts: isoDaysAgo(1), sid: "s2", reasons: "b" },
    { ts: isoDaysAgo(0), sid: "s3", reasons: "c" },
  ]);
}

/** @returns {string} */
function mkTmp() {
  return mkdtempSync(path.join(os.tmpdir(), "test-session-retro-chk-"));
}

// A Stop-origin flag is absorbed silently into the worthy log — no immediate
// nudge — and dedups per session.
test("Stop-origin flag: silent, appends one worthy line (dedup on repeat)", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const sid = "test-stop-origin";
  const flag = path.join(tmp, `retro-nudge-${sid}.flag`);
  writeFileSync(flag, "3 edits across 2 files + 25 minutes of work");

  const r1 = await run(JSON.stringify({ session_id: sid }), env(tmp));
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
  const r2 = await run(JSON.stringify({ session_id: sid }), env(tmp));
  assert.equal(r2.stdout, "", "still silent");
  lines = readFileSync(worthy, "utf8").split("\n").filter((l) => l);
  assert.equal(lines.length, 1, "dedup: no second worthy line for same sid");
});

// A compaction no longer interrupts: it marks the session worthy and waits for
// the end-of-day offer like every other trigger.
test("compact imminent flag: absorbed silently, no immediate nudge", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const sid = "test-compact";
  writeFileSync(path.join(tmp, `retro-nudge-${sid}.flag`), "compact imminent");

  const { code, stdout } = await run(JSON.stringify({ session_id: sid }), env(tmp));
  assert.equal(code, 0);
  assert.equal(stdout, "", "compaction must not emit a per-session nudge");

  const lines = readFileSync(path.join(tmp, "retro-worthy.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.sid, sid);
  assert.match(parsed.reasons, /compact imminent/);
});

test("no flag, no worthy log: silent exit (no stdout)", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const { code, stdout } = await run(
    JSON.stringify({ session_id: "test-check-no-flag" }),
    env(tmp),
  );
  assert.equal(code, 0);
  assert.equal(stdout, "");
});

// End of day: past the hour, 3 worthy sessions, no offer made today → fires.
test("EOD offer fires: past RETRO_EOD_HOUR, 3 worthy, no offer today", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeThreeWorthy(tmp);

  const { code, stdout } = await run(
    JSON.stringify({ session_id: "test-eod-fire" }),
    env(tmp),
  );
  assert.equal(code, 0);
  const { systemMessage, hookSpecificOutput: { additionalContext } } =
    JSON.parse(stdout);
  assert.match(
    systemMessage,
    /\[session-retro\].*3 retro-worthy sessions have accrued/,
  );
  assert.match(
    systemMessage,
    /no retro recorded yet/,
    "first-ever offer explains there is no prior retro",
  );
  assert.doesNotMatch(
    systemMessage,
    /\d{3,}\+ days/,
    "no epoch-derived day count on the first-ever offer",
  );
  assert.match(
    additionalContext,
    /Do not start it unprompted/,
    "model-facing half tells the model not to act unprompted",
  );
  assert.ok(
    existsSync(path.join(tmp, `eod-offer-${TODAY}.txt`)),
    "the offer claims today's per-day marker",
  );
});

// The hour gate is what makes this end-of-day rather than any-time.
test("EOD silent: before RETRO_EOD_HOUR", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeThreeWorthy(tmp);

  const { code, stdout } = await run(
    JSON.stringify({ session_id: "test-eod-morning" }),
    env(tmp, { RETRO_NOW: MORNING }),
  );
  assert.equal(code, 0);
  assert.equal(stdout, "", "09:00 is before the default 16:00 gate");
  assert.ok(
    !existsSync(path.join(tmp, `eod-offer-${TODAY}.txt`)),
    "a suppressed offer must not burn the day",
  );
});

test("EOD env override: RETRO_EOD_HOUR=8 fires at 09:00", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeThreeWorthy(tmp);

  const { code, stdout } = await run(
    JSON.stringify({ session_id: "test-eod-hour-env" }),
    env(tmp, { RETRO_NOW: MORNING, RETRO_EOD_HOUR: "8" }),
  );
  assert.equal(code, 0);
  const { systemMessage, hookSpecificOutput: { additionalContext } } =
    JSON.parse(stdout);
  assert.match(systemMessage, /3 retro-worthy sessions/);
  assert.match(additionalContext, /Do not start it unprompted/);
});

test("EOD silent: an offer was already claimed today", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeThreeWorthy(tmp);
  writeFileSync(path.join(tmp, `eod-offer-${TODAY}.txt`), "");

  const { code, stdout } = await run(
    JSON.stringify({ session_id: "test-eod-once" }),
    env(tmp),
  );
  assert.equal(code, 0);
  assert.equal(stdout, "", "at most one offer per calendar day");
});

// Upgrade day: a pre-0.8.1 last-eod-offer.txt holding today's date still
// suppresses, so upgrading mid-day cannot re-offer.
test("EOD silent: legacy last-eod-offer.txt from today suppresses", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeThreeWorthy(tmp);
  writeFileSync(path.join(tmp, "last-eod-offer.txt"), TODAY + "\n");

  const { code, stdout } = await run(
    JSON.stringify({ session_id: "test-eod-legacy" }),
    env(tmp),
  );
  assert.equal(code, 0);
  assert.equal(stdout, "", "legacy same-day marker honored across upgrade");
});

// Calendar day, not a rolling 24h window: yesterday's 18:00 offer does not
// suppress today's 17:00 one, 23 hours later.
test("EOD fires: yesterday's offer does not suppress today's (calendar day, not 24h)", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeThreeWorthy(tmp);
  writeFileSync(path.join(tmp, "eod-offer-2026-08-25.txt"), "");

  const { code, stdout } = await run(
    JSON.stringify({ session_id: "test-eod-newday" }),
    env(tmp, { RETRO_NOW: "2026-08-26T17:00:00Z" }),
  );
  assert.equal(code, 0);
  {
    const { systemMessage, hookSpecificOutput: { additionalContext } } =
      JSON.parse(stdout);
    assert.match(systemMessage, /3 retro-worthy sessions/);
    assert.match(additionalContext, /Do not start it unprompted/);
  }
  assert.ok(
    existsSync(path.join(tmp, `eod-offer-${TODAY}.txt`)),
    "today's marker claimed",
  );
  assert.ok(
    !existsSync(path.join(tmp, "eod-offer-2026-08-25.txt")),
    "the winner sweeps stale day markers",
  );
});

// The sweep is older-only: a cross-midnight straggler (RETRO_EOD_HOUR=0) that
// claimed yesterday must not delete the new day's freshly-claimed marker.
test("EOD sweep never deletes a newer day's marker", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeThreeWorthy(tmp);
  writeFileSync(path.join(tmp, "eod-offer-2026-08-27.txt"), "");

  const { code, stdout } = await run(
    JSON.stringify({ session_id: "test-eod-newer" }),
    env(tmp),
  );
  assert.equal(code, 0);
  {
    const { systemMessage, hookSpecificOutput: { additionalContext } } =
      JSON.parse(stdout);
    assert.match(systemMessage, /3 retro-worthy sessions/, "tomorrow's marker does not suppress today");
    assert.match(additionalContext, /Do not start it unprompted/);
  }
  assert.ok(
    existsSync(path.join(tmp, "eod-offer-2026-08-27.txt")),
    "a newer day's claim survives the sweep",
  );
});

test("EOD silent: only 2 worthy entries", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeWorthy(tmp, [
    { ts: isoDaysAgo(1), sid: "s1", reasons: "a" },
    { ts: isoDaysAgo(0), sid: "s2", reasons: "b" },
  ]);

  const { code, stdout } = await run(
    JSON.stringify({ session_id: "test-batch-two" }),
    env(tmp),
  );
  assert.equal(code, 0);
  assert.equal(stdout, "", "below min-sessions threshold");
});

test("EOD silent: last retro earlier today (< 1-day gate)", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  // 3 worthy entries all newer than last-retro, but the default 1-day cadence
  // gate has not elapsed since the last retro (which ran earlier today).
  writeThreeWorthy(tmp);
  writeFileSync(path.join(tmp, "last-retro.txt"), isoDaysAgo(0));

  const { code, stdout } = await run(
    JSON.stringify({ session_id: "test-batch-days" }),
    env(tmp),
  );
  assert.equal(code, 0);
  assert.equal(stdout, "", "day gate not met");
});

// Worthy entries older than the last retro do not count toward the batch.
test("EOD silent: worthy entries predate last retro", async (t) => {
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
    env(tmp),
  );
  assert.equal(code, 0);
  assert.equal(stdout, "", "all worthy entries predate the last retro");
});

// Cleanup is append-only + identity: processed sids are excluded from the
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
    env(tmp, { RETRO_BATCH_MIN_SESSIONS: "1", RETRO_BATCH_MIN_DAYS: "0" }),
  );
  assert.equal(code, 0);
  // Only todo1 is unprocessed → count 1.
  const parsed = JSON.parse(stdout);
  assert.match(parsed.systemMessage, /1 retro-worthy session/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /Do not start it unprompted/);
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
    env(tmp, { RETRO_BATCH_MIN_SESSIONS: "1", RETRO_BATCH_MIN_DAYS: "0" }),
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
    { ts: isoDaysAgo(0), sid: "s2", reasons: "b" },
  ]);

  const { code, stdout } = await run(
    JSON.stringify({ session_id: "test-batch-env" }),
    env(tmp, { RETRO_BATCH_MIN_SESSIONS: "2" }),
  );
  assert.equal(code, 0);
  {
    const { systemMessage, hookSpecificOutput: { additionalContext } } =
      JSON.parse(stdout);
    assert.match(systemMessage, /2 retro-worthy sessions/);
    assert.match(additionalContext, /Do not start it unprompted/);
  }
});

// A garbage hour must not silence the offer forever (NaN >= n is false).
test("RETRO_EOD_HOUR garbage falls back to the 16:00 default", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeThreeWorthy(tmp);

  const { code, stdout } = await run(
    JSON.stringify({ session_id: "test-eod-garbage" }),
    env(tmp, { RETRO_EOD_HOUR: "not-an-hour" }),
  );
  assert.equal(code, 0);
  {
    const { systemMessage, hookSpecificOutput: { additionalContext } } =
      JSON.parse(stdout);
    assert.match(systemMessage, /3 retro-worthy sessions/);
    assert.match(additionalContext, /Do not start it unprompted/);
  }
});

// An out-of-range hour is finite but can never be < getHours(), so it too
// must fall back rather than silence the offer permanently.
test("RETRO_EOD_HOUR=24 (out of range) falls back to the 16:00 default", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeThreeWorthy(tmp);

  const { code, stdout } = await run(
    JSON.stringify({ session_id: "test-eod-range" }),
    env(tmp, { RETRO_EOD_HOUR: "24" }),
  );
  assert.equal(code, 0);
  {
    const { systemMessage, hookSpecificOutput: { additionalContext } } =
      JSON.parse(stdout);
    assert.match(systemMessage, /3 retro-worthy sessions/);
    assert.match(additionalContext, /Do not start it unprompted/);
  }
});

// The offer only reaches a human if `systemMessage` sits at the payload root;
// nested under hookSpecificOutput, Claude Code drops it silently.
test("the EOD offer's systemMessage is at the payload root", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeThreeWorthy(tmp);

  const { code, stdout } = await run(
    JSON.stringify({ session_id: "test-eod-root" }),
    env(tmp),
  );
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.match(parsed.systemMessage, /retro-worthy sessions have accrued/);
  assert.equal(parsed.hookSpecificOutput.systemMessage, undefined);
});
