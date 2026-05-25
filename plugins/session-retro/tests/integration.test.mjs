// @ts-check
// Integration test: end-to-end pipeline.
//   SessionStart → PostToolUse (×N) → Stop → UserPromptSubmit
// Verifies that the events written by posttooluse are picked up by stop,
// the resulting flag is consumed by check-retro-flag, and the additionalContext
// emission contains the aggregated reasons.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(here, "..", "scripts");

/**
 * @param {string} script  absolute path to .mjs
 * @param {string} stdin
 * @param {Record<string, string>} env
 */
function run(script, stdin, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
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

test("end-to-end: edits → flag → consumed → additionalContext", async (t) => {
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

  // 4. UserPromptSubmit → consumes flag, emits additionalContext
  const chk = await run(
    path.join(SCRIPTS, "check-retro-flag.mjs"),
    JSON.stringify({ session_id: sid }),
    env,
  );
  assert.equal(chk.code, 0);
  const parsed = JSON.parse(chk.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(
    parsed.hookSpecificOutput.additionalContext,
    /3 edits across 2 files/,
  );
  assert.match(parsed.hookSpecificOutput.additionalContext, /\/retro/);
  assert.ok(!existsSync(flagPath), "flag should be deleted after consume");
});

test("end-to-end: PreCompact path bypasses thresholds", async (t) => {
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

  // Check-retro-flag should pick it up and surface "compact imminent"
  const chk = await run(
    path.join(SCRIPTS, "check-retro-flag.mjs"),
    JSON.stringify({ session_id: sid }),
    env,
  );
  assert.equal(chk.code, 0);
  const parsed = JSON.parse(chk.stdout);
  assert.match(parsed.hookSpecificOutput.additionalContext, /compact imminent/);
});
