// @ts-check
// Mirrors v0.1 bash tests:
//   test_check_handoff_flag_consumes.sh
//   test_check_handoff_flag_no_flag.sh

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "scripts", "check-handoff-flag.mjs");

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
  return mkdtempSync(path.join(os.tmpdir(), "handoff-check-"));
}

test("test_check_handoff_flag_consumes", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-flag-consumes";
  const flagFile = path.join(dir, `handoff-nudge-${sid}.flag`);
  writeFileSync(flagFile, "context at 76% (threshold 70%)");

  const result = await run(JSON.stringify({ session_id: sid }), {
    CLAUDE_PLUGIN_DATA: dir,
  });

  assert.equal(result.code, 0);

  // Output must be JSON with hookSpecificOutput envelope
  const out = JSON.parse(result.stdout);
  assert.ok(out.hookSpecificOutput, `no hookSpecificOutput in output: ${result.stdout}`);
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");

  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /\[handoff\]/, `missing [handoff] in context: ${ctx}`);
  assert.match(ctx, /76/, `missing percentage in context: ${ctx}`);

  // Flag should be deleted (consumed)
  assert.ok(!existsSync(flagFile), "flag not deleted after consumption");
});

// --- Severity-tiered wording (Task 7) ---

test("check-handoff-flag: below-85 tier defers to compaction and keeps working", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-tier-low";
  const flagFile = path.join(dir, `handoff-nudge-${sid}.flag`);
  writeFileSync(flagFile, "context at 72% (threshold 70%)");

  const result = await run(JSON.stringify({ session_id: sid }), {
    CLAUDE_PLUGIN_DATA: dir,
  });

  assert.equal(result.code, 0);
  const out = JSON.parse(result.stdout);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /\[handoff\].*handoff:handoff skill/i, `unexpected wording: ${ctx}`);
  assert.match(ctx, /keep working/i, `unexpected wording: ${ctx}`);
  // Same invariant as the >=85 tier: an offer, never an instruction to stop or
  // to finish up before continuing.
  assert.doesNotMatch(ctx, /before starting anything new/i, `stop-work order: ${ctx}`);
});

// Regression: a nudge must name the skill plugin-qualified. An unqualified name
// is one the model has to guess, and it guesses wrong — `Skill(handoff)` returns
// "Unknown skill: handoff". session-retro shipped this exact bug and lost 4
// nudges to it before anyone noticed.
test("check-handoff-flag: both tiers name the skill plugin-qualified", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  for (const [sid, pct] of [["qual-low", 72], ["qual-high", 91]]) {
    writeFileSync(
      path.join(dir, `handoff-nudge-${sid}.flag`),
      `context at ${pct}% (threshold 70%)`,
    );
    const result = await run(JSON.stringify({ session_id: sid }), {
      CLAUDE_PLUGIN_DATA: dir,
    });
    const ctx = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /handoff:handoff/, `${sid} lost the qualified name: ${ctx}`);
    assert.doesNotMatch(
      ctx,
      /(?<!:)\bthe handoff skill\b/,
      `${sid} still names the skill unqualified: ${ctx}`,
    );
  }
});

// Regression for the cross-process dir mismatch: the statusLine writer has no
// CLAUDE_PLUGIN_DATA and lands on the tmpdir fallback, while this hook does have
// it. The reader must still find the flag.
test("check-handoff-flag: reads a flag the writer left in the tmpdir fallback", async (t) => {
  const readerDir = mkTmp();
  const writerDir = path.join(os.tmpdir(), "handoff-data");
  mkdirSync(writerDir, { recursive: true });
  const sid = "cross-dir-flag";
  const writerFlag = path.join(writerDir, `handoff-nudge-${sid}.flag`);
  writeFileSync(writerFlag, "context at 88% (threshold 70%)");
  t.after(() => {
    rmSync(readerDir, { recursive: true, force: true });
    rmSync(writerFlag, { force: true });
  });

  const result = await run(JSON.stringify({ session_id: sid }), {
    CLAUDE_PLUGIN_DATA: readerDir,
  });

  assert.equal(result.code, 0);
  assert.notEqual(result.stdout.trim(), "", "hook stayed silent — flag not found");
  const ctx = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /88%/, `unexpected wording: ${ctx}`);
  assert.equal(existsSync(writerFlag), false, "flag was not consumed");
});

test("check-handoff-flag: >=85 tier offers the handoff without ordering a stop", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-tier-high";
  const flagFile = path.join(dir, `handoff-nudge-${sid}.flag`);
  writeFileSync(flagFile, "context at 91% (threshold 70%)");

  const result = await run(JSON.stringify({ session_id: sid }), {
    CLAUDE_PLUGIN_DATA: dir,
  });

  assert.equal(result.code, 0);
  const out = JSON.parse(result.stdout);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /handoff:handoff/, `unexpected wording: ${ctx}`);
  assert.match(ctx, /\/clear/, `unexpected wording: ${ctx}`);
  // The nudge must never tell the model to abandon the task it is mid-way
  // through: compaction carries the session, so a stop-work order here is both
  // wrong and the single most disruptive thing this hook can emit.
  assert.doesNotMatch(ctx, /Do not start new work/i, `stop-work order: ${ctx}`);
  assert.doesNotMatch(ctx, /\bNOW\b/, `urgency order: ${ctx}`);
});

test("test_check_handoff_flag_no_flag", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sid = "test-flag-no-flag";
  const result = await run(JSON.stringify({ session_id: sid }), {
    CLAUDE_PLUGIN_DATA: dir,
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "", `expected empty output, got: ${result.stdout}`);
});
