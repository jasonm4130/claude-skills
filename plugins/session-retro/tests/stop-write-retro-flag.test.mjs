// @ts-check
// Stop hook: aggregates events-{sid}.jsonl and writes retro-nudge-{sid}.flag
// when thresholds are met. Suppresses if retro-fired-{sid}.flag exists.

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
const SCRIPT = path.join(here, "..", "scripts", "stop-write-retro-flag.mjs");

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
    child.on("close", (code) =>
      resolve({ code: code ?? 0, stdout, stderr }),
    );
    child.stdin.end(stdin);
  });
}

/** @returns {string} */
function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * @param {number} minutesAgo
 * @returns {string}
 */
function isoMinutesAgo(minutesAgo) {
  const d = new Date(Date.now() - minutesAgo * 60_000);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Parity with test_stop_edits_threshold.sh
test("edits threshold: 3 edits across 2 files → flag with that reason", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-stop-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const sid = "test-stop-edits";
  const now = nowIso();
  const events = [
    { ts: now, tool: "Edit", input: { file_path: "/a.ts" } },
    { ts: now, tool: "Edit", input: { file_path: "/b.ts" } },
    { ts: now, tool: "Edit", input: { file_path: "/a.ts" } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n") + "\n";
  writeFileSync(path.join(tmp, `events-${sid}.jsonl`), events);

  const { code } = await run(JSON.stringify({ session_id: sid }), {
    CLAUDE_PLUGIN_DATA: tmp,
  });
  assert.equal(code, 0);

  const flag = path.join(tmp, `retro-nudge-${sid}.flag`);
  assert.ok(existsSync(flag), "expected nudge flag to exist");
  const content = readFileSync(flag, "utf8");
  assert.match(content, /3 edits across 2 files/);
});

// Parity with test_stop_no_trigger.sh
test("no trigger: below thresholds → no flag", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-stop-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const sid = "test-stop-quiet";
  const now = nowIso();
  const events = [
    { ts: now, tool: "Edit", input: { file_path: "/a.ts" } },
    { ts: now, tool: "Bash", input: { command: "ls" } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n") + "\n";
  writeFileSync(path.join(tmp, `events-${sid}.jsonl`), events);

  const { code } = await run(JSON.stringify({ session_id: sid }), {
    CLAUDE_PLUGIN_DATA: tmp,
  });
  assert.equal(code, 0);
  assert.ok(
    !existsSync(path.join(tmp, `retro-nudge-${sid}.flag`)),
    "expected no nudge flag",
  );
});

// Parity with test_stop_duration_threshold.sh
test("duration threshold: 25-min span → 'minutes of work' reason", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-stop-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const sid = "test-stop-dur";
  const past = isoMinutesAgo(25);
  const now = nowIso();
  const events = [
    { ts: past, tool: "Edit", input: { file_path: "/a.ts" } },
    { ts: now, tool: "Bash", input: { command: "echo done" } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n") + "\n";
  writeFileSync(path.join(tmp, `events-${sid}.jsonl`), events);

  const { code } = await run(JSON.stringify({ session_id: sid }), {
    CLAUDE_PLUGIN_DATA: tmp,
  });
  assert.equal(code, 0);
  const flag = path.join(tmp, `retro-nudge-${sid}.flag`);
  assert.ok(existsSync(flag));
  const content = readFileSync(flag, "utf8");
  assert.match(content, /minutes of work/);
});

// Parity with test_stop_commit_trigger.sh
test("commit trigger: git commit in Bash → 'committed during session'", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-stop-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const sid = "test-stop-commit";
  const now = nowIso();
  const events = [
    { ts: now, tool: "Bash", input: { command: "git status" } },
    { ts: now, tool: "Bash", input: { command: "git commit -m 'fix: thing'" } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n") + "\n";
  writeFileSync(path.join(tmp, `events-${sid}.jsonl`), events);

  const { code } = await run(JSON.stringify({ session_id: sid }), {
    CLAUDE_PLUGIN_DATA: tmp,
  });
  assert.equal(code, 0);
  const flag = path.join(tmp, `retro-nudge-${sid}.flag`);
  assert.ok(existsSync(flag));
  assert.match(readFileSync(flag, "utf8"), /committed during session/);
});

// Parity with test_stop_compound_reasons.sh
test("compound reasons: edits + duration + commit → joined by ' + '", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-stop-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const sid = "test-stop-compound";
  const past = isoMinutesAgo(25);
  const now = nowIso();
  const events = [
    { ts: past, tool: "Edit", input: { file_path: "/a.ts" } },
    { ts: past, tool: "Edit", input: { file_path: "/b.ts" } },
    { ts: past, tool: "Edit", input: { file_path: "/a.ts" } },
    { ts: now, tool: "Bash", input: { command: "git commit -m foo" } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n") + "\n";
  writeFileSync(path.join(tmp, `events-${sid}.jsonl`), events);

  const { code } = await run(JSON.stringify({ session_id: sid }), {
    CLAUDE_PLUGIN_DATA: tmp,
  });
  assert.equal(code, 0);
  const flag = path.join(tmp, `retro-nudge-${sid}.flag`);
  assert.ok(existsSync(flag));
  const content = readFileSync(flag, "utf8");
  assert.match(content, /3 edits across 2 files/);
  assert.match(content, /minutes of work/);
  assert.match(content, /committed during session/);
  assert.match(content, / \+ /);
});

// Parity with test_stop_retro_fired_suppresses.sh
test("retro-fired flag suppresses nudge flag", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-stop-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const sid = "test-stop-suppressed";
  const now = nowIso();
  const events = [
    { ts: now, tool: "Edit", input: { file_path: "/a.ts" } },
    { ts: now, tool: "Edit", input: { file_path: "/b.ts" } },
    { ts: now, tool: "Edit", input: { file_path: "/c.ts" } },
    { ts: now, tool: "Bash", input: { command: "git commit -m foo" } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n") + "\n";
  writeFileSync(path.join(tmp, `events-${sid}.jsonl`), events);
  writeFileSync(path.join(tmp, `retro-fired-${sid}.flag`), "");

  const { code } = await run(JSON.stringify({ session_id: sid }), {
    CLAUDE_PLUGIN_DATA: tmp,
  });
  assert.equal(code, 0);
  assert.ok(
    !existsSync(path.join(tmp, `retro-nudge-${sid}.flag`)),
    "expected no nudge flag when retro-fired exists",
  );
});

// Parity with test_stop_skips_malformed_lines.sh
test("malformed lines are skipped; valid edits still aggregate", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-stop-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const sid = "test-stop-malformed";
  const now = nowIso();
  const body =
    JSON.stringify({ ts: now, tool: "Edit", input: { file_path: "/a.ts" } }) +
    "\n" +
    "this is not json at all\n" +
    '{"ts":"' +
    now +
    '","tool":"Edit","input":{"file_pat' +
    "\n" +
    JSON.stringify({ ts: now, tool: "Edit", input: { file_path: "/b.ts" } }) +
    "\n" +
    "\n" +
    JSON.stringify({ ts: now, tool: "Edit", input: { file_path: "/c.ts" } }) +
    "\n";
  writeFileSync(path.join(tmp, `events-${sid}.jsonl`), body);

  const { code } = await run(JSON.stringify({ session_id: sid }), {
    CLAUDE_PLUGIN_DATA: tmp,
  });
  assert.equal(code, 0, "should not crash on malformed lines");
  const flag = path.join(tmp, `retro-nudge-${sid}.flag`);
  assert.ok(existsSync(flag));
  assert.match(readFileSync(flag, "utf8"), /3 edits across 3 files/);
});

// Parity with second half of test_session_id_from_stdin.sh: Stop hook picks
// session_id from stdin (no env var).
test("Stop hook reads session_id from stdin (env unset)", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-stop-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const sid = "stop-test-from-stdin";
  const now = nowIso();
  const events = [
    { ts: now, tool: "Edit", input: { file_path: "/a.ts" } },
    { ts: now, tool: "Edit", input: { file_path: "/b.ts" } },
    { ts: now, tool: "Edit", input: { file_path: "/a.ts" } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n") + "\n";
  writeFileSync(path.join(tmp, `events-${sid}.jsonl`), events);

  // Run with explicit env: no CLAUDE_SESSION_ID
  const child = spawn(process.execPath, [SCRIPT], {
    env: { CLAUDE_PLUGIN_DATA: tmp },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify({ session_id: sid }));
  /** @type {number} */
  const code = await new Promise((resolve) =>
    child.on("close", (c) => resolve(c ?? 0)),
  );
  assert.equal(code, 0);
  assert.ok(existsSync(path.join(tmp, `retro-nudge-${sid}.flag`)));
});

test("no events file: silent exit (no flag)", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-stop-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const sid = "no-events";
  const { code } = await run(JSON.stringify({ session_id: sid }), {
    CLAUDE_PLUGIN_DATA: tmp,
  });
  assert.equal(code, 0);
  assert.ok(!existsSync(path.join(tmp, `retro-nudge-${sid}.flag`)));
});

test("30 tool calls threshold → 'tool calls' reason", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-stop-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const sid = "test-tool-calls";
  const now = nowIso();
  const lines = [];
  // 30 unique Bash commands → totalTools=30, no edit triggers, no test/commit
  for (let i = 0; i < 30; i++) {
    lines.push(
      JSON.stringify({ ts: now, tool: "Bash", input: { command: `ls ${i}` } }),
    );
  }
  writeFileSync(path.join(tmp, `events-${sid}.jsonl`), lines.join("\n") + "\n");

  const { code } = await run(JSON.stringify({ session_id: sid }), {
    CLAUDE_PLUGIN_DATA: tmp,
  });
  assert.equal(code, 0);
  const flag = path.join(tmp, `retro-nudge-${sid}.flag`);
  assert.ok(existsSync(flag));
  assert.match(readFileSync(flag, "utf8"), /30 tool calls/);
});

test("ran tests + 2 edits (no edits+files trigger) → 'ran tests + 2 edits'", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-stop-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const sid = "test-tests-trigger";
  const now = nowIso();
  const events = [
    // 2 edits to the same file → editWrite=2, filesCount=1 (skips edits+files trigger)
    { ts: now, tool: "Edit", input: { file_path: "/a.ts" } },
    { ts: now, tool: "Edit", input: { file_path: "/a.ts" } },
    { ts: now, tool: "Bash", input: { command: "npm test" } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n") + "\n";
  writeFileSync(path.join(tmp, `events-${sid}.jsonl`), events);

  const { code } = await run(JSON.stringify({ session_id: sid }), {
    CLAUDE_PLUGIN_DATA: tmp,
  });
  assert.equal(code, 0);
  const flag = path.join(tmp, `retro-nudge-${sid}.flag`);
  assert.ok(existsSync(flag));
  assert.match(readFileSync(flag, "utf8"), /ran tests \+ 2 edits/);
});
