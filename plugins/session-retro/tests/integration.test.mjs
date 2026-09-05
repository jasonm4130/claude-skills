// @ts-check
// Integration test: end-to-end pipeline.
//   SessionStart → PostToolUse (×N) → Stop → UserPromptSubmit
// Verifies that the events written by posttooluse are picked up by stop,
// the resulting flag is consumed by check-retro-flag, and the additionalContext
// emission contains the aggregated reasons.

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(here, "..", "scripts");

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

// The end-of-day offer is gated on local time, so any run that expects it to
// fire injects the clock rather than hoping the suite runs after 16:00. The
// date is far-future on purpose: the other scripts in these pipelines stamp
// files with the real clock, and the injected "now" must be after those.
const EVENING = { TZ: "UTC", RETRO_NOW: "2099-06-15T18:00:00Z" };

/**
 * @param {string} script  absolute path to .mjs
 * @param {string} stdin
 * @param {Record<string, string>} env
 */
function run(script, stdin, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...baseEnv(), ...env },
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

test("end-to-end: edits → flag → consumed silently into worthy log", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-int-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const sid = "int-e2e-1";
  const env = { CLAUDE_PLUGIN_DATA: tmp };

  // 1. SessionStart
  const ss = await run(
    path.join(SCRIPTS, "mark-session-start.mjs"),
    JSON.stringify({ session_id: sid }),
    env,
  );
  assert.equal(ss.code, 0);
  assert.ok(existsSync(path.join(tmp, `session-start-${sid}.txt`)));

  // 2. PostToolUse: 3 edits across 2 files
  for (const fp of ["/a.ts", "/b.ts", "/a.ts"]) {
    const r = await run(
      path.join(SCRIPTS, "posttooluse-append-event.mjs"),
      JSON.stringify({
        session_id: sid,
        tool_name: "Edit",
        tool_input: { file_path: fp },
      }),
      env,
    );
    assert.equal(r.code, 0);
  }
  const events = readFileSync(
    path.join(tmp, `events-${sid}.jsonl`),
    "utf8",
  );
  assert.equal(events.split("\n").filter((l) => l).length, 3);

  // 3. Stop → writes flag
  const stop = await run(
    path.join(SCRIPTS, "stop-write-retro-flag.mjs"),
    JSON.stringify({ session_id: sid }),
    env,
  );
  assert.equal(stop.code, 0);
  const flagPath = path.join(tmp, `retro-nudge-${sid}.flag`);
  assert.ok(existsSync(flagPath));
  assert.match(readFileSync(flagPath, "utf8"), /3 edits across 2 files/);

  // 4. UserPromptSubmit → Stop-origin flag is absorbed silently into the
  //    worthy log (no immediate nudge; one worthy session is below threshold).
  const chk = await run(
    path.join(SCRIPTS, "check-retro-flag.mjs"),
    JSON.stringify({ session_id: sid }),
    env,
  );
  assert.equal(chk.code, 0);
  assert.equal(chk.stdout, "", "Stop-origin flag surfaces no nudge");
  assert.ok(!existsSync(flagPath), "flag should be deleted after consume");

  const worthy = path.join(tmp, "retro-worthy.jsonl");
  assert.ok(existsSync(worthy), "worthy log written");
  const worthyLines = readFileSync(worthy, "utf8")
    .split("\n")
    .filter((l) => l);
  assert.equal(worthyLines.length, 1);
  assert.match(worthyLines[0], /3 edits across 2 files/);
});

test("interleaving: a worthy session appended during the interview survives cleanup", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-int-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const env = { CLAUDE_PLUGIN_DATA: tmp };

  // Two accrued worthy sessions the retro is about to interview.
  writeFileSync(
    path.join(tmp, "retro-worthy.jsonl"),
    [
      JSON.stringify({ ts: "2026-07-10T00:00:00Z", sid: "w1", reasons: "a" }),
      JSON.stringify({ ts: "2026-07-11T00:00:00Z", sid: "w2", reasons: "b" }),
    ].join("\n") + "\n",
  );

  // Step 1: collector snapshots the batch (processedSids = [w1, w2]).
  const collect = await run(
    path.join(SCRIPTS, "collect-batch-sessions.mjs"),
    JSON.stringify({ session_id: "cur" }),
    env,
  );
  assert.equal(collect.code, 0);
  assert.deepEqual(JSON.parse(collect.stdout).processedSids, ["w1", "w2"]);

  // Meanwhile, a concurrent session becomes worthy and appends — AFTER the
  // snapshot, DURING the interview.
  appendFileSync(
    path.join(tmp, "retro-worthy.jsonl"),
    JSON.stringify({ ts: "2026-07-12T00:00:00Z", sid: "concurrent", reasons: "c" }) + "\n",
  );

  // Step 6: cleanup appends only the interviewed sids to the processed ledger.
  const done = await run(
    path.join(SCRIPTS, "mark-retro-done.mjs"),
    JSON.stringify({ session_id: "cur" }),
    env,
  );
  assert.equal(done.code, 0);

  // The concurrent session is still unprocessed → it still counts.
  const chk = await run(
    path.join(SCRIPTS, "check-retro-flag.mjs"),
    JSON.stringify({ session_id: "cur" }),
    { ...env, ...EVENING, RETRO_BATCH_MIN_SESSIONS: "1", RETRO_BATCH_MIN_DAYS: "0" },
  );
  assert.equal(chk.code, 0);
  {
    const { systemMessage, hookSpecificOutput: { additionalContext } } =
      JSON.parse(chk.stdout);
    assert.match(
      systemMessage,
      /1 retro-worthy session/,
      "the concurrent session survived cleanup and still counts",
    );
    assert.match(additionalContext, /Do not start it unprompted/);
  }
});

test("end-to-end: PreCompact marks the session worthy without interrupting", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-int-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const sid = "int-pc-1";
  const env = { CLAUDE_PLUGIN_DATA: tmp };

  // No events at all. PreCompact must still set the flag.
  const pc = await run(
    path.join(SCRIPTS, "precompact-write-retro-flag.mjs"),
    JSON.stringify({ session_id: sid }),
    env,
  );
  assert.equal(pc.code, 0);
  assert.ok(existsSync(path.join(tmp, `retro-nudge-${sid}.flag`)));

  // Check-retro-flag absorbs it silently: one worthy line, no nudge. A single
  // session is below the batch threshold even at the end of the day.
  const chk = await run(
    path.join(SCRIPTS, "check-retro-flag.mjs"),
    JSON.stringify({ session_id: sid }),
    { ...env, ...EVENING },
  );
  assert.equal(chk.code, 0);
  assert.equal(chk.stdout, "", "compaction must not interrupt the session");
  const worthyLines = readFileSync(path.join(tmp, "retro-worthy.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l);
  assert.equal(worthyLines.length, 1);
  assert.match(worthyLines[0], /compact imminent/);
});
