// @ts-check
// PostToolUse hook appends one JSONL event per call, race-free.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "scripts", "posttooluse-append-event.mjs");

/**
 * @param {string} stdin
 * @param {Record<string, string>} env
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
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

// Parity with test_event_log_init.sh
test("event-log-init: first call creates events-{sid}.jsonl with one valid line", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-evlog-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const { code } = await run(
    JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: "/repo/src/foo.ts" },
    }),
    { CLAUDE_PLUGIN_DATA: tmp, CLAUDE_SESSION_ID: "test-event-log-init" },
  );
  assert.equal(code, 0);

  const events = path.join(tmp, "events-test-event-log-init.jsonl");
  assert.ok(existsSync(events), "events file should be created");

  const content = readFileSync(events, "utf8");
  const lines = content.split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, 1);

  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.tool, "Edit");
  assert.equal(parsed.input.file_path, "/repo/src/foo.ts");
  assert.match(parsed.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

// Parity with test_event_log_parallel.sh
test("event-log-parallel: 50 parallel writes yield 50 valid lines", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-evlog-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const N = 50;
  const runs = [];
  for (let i = 1; i <= N; i++) {
    runs.push(
      run(
        JSON.stringify({
          tool_name: "Edit",
          tool_input: { file_path: `/file_${i}.ts` },
        }),
        {
          CLAUDE_PLUGIN_DATA: tmp,
          CLAUDE_SESSION_ID: "test-event-log-parallel",
        },
      ),
    );
  }
  const results = await Promise.all(runs);
  for (const r of results) assert.equal(r.code, 0);

  const events = path.join(tmp, "events-test-event-log-parallel.jsonl");
  const content = readFileSync(events, "utf8");
  const lines = content.split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, N, `expected ${N} lines after parallel writes`);
  for (const line of lines) {
    // each line must be parsable on its own (no interleaving / partial writes)
    JSON.parse(line);
  }
});

// Parity with test_session_id_from_stdin.sh (first half: event lands in
// events-{stdin-sid}.jsonl, not events-unknown.jsonl)
test("session_id from stdin: event lands in events-{stdin-sid}.jsonl", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-evlog-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  // No CLAUDE_SESSION_ID env — must use the stdin session_id
  const child = spawn(process.execPath, [SCRIPT], {
    env: { CLAUDE_PLUGIN_DATA: tmp },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(
    JSON.stringify({
      session_id: "abc-123-real-session",
      tool_name: "Edit",
      tool_input: { file_path: "/foo.ts" },
    }),
  );
  /** @type {number} */
  const code = await new Promise((resolve) =>
    child.on("close", (c) => resolve(c ?? 0)),
  );
  assert.equal(code, 0);
  assert.ok(
    existsSync(path.join(tmp, "events-abc-123-real-session.jsonl")),
    "event file should use session_id from stdin",
  );
  assert.ok(
    !existsSync(path.join(tmp, "events-unknown.jsonl")),
    "event must NOT land in events-unknown.jsonl",
  );
});

/**
 * Read the single event written by one run.
 * @param {string} tmp
 * @param {string} sid
 * @returns {any}
 */
function readOne(tmp, sid) {
  const content = readFileSync(path.join(tmp, `events-${sid}.jsonl`), "utf8");
  const lines = content.split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, 1);
  return JSON.parse(lines[0]);
}

test("schema marker: every event carries v:2", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-evlog-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  await run(
    JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "/a.ts" } }),
    { CLAUDE_PLUGIN_DATA: tmp, CLAUDE_SESSION_ID: "v2" },
  );
  assert.equal(readOne(tmp, "v2").v, 2);
});

test("outcome ok:true when tool_response reports is_error false", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-evlog-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  await run(
    JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: "/a.ts" },
      tool_response: { is_error: false, filePath: "/a.ts" },
    }),
    { CLAUDE_PLUGIN_DATA: tmp, CLAUDE_SESSION_ID: "ok-true" },
  );
  const ev = readOne(tmp, "ok-true");
  assert.equal(ev.ok, true);
  assert.equal("err" in ev, false, "err must be absent on success");
});

test("outcome ok:false carries a bounded err string", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-evlog-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  await run(
    JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: "/a.ts" },
      tool_response: { is_error: true, error: "boom ".repeat(500) },
    }),
    { CLAUDE_PLUGIN_DATA: tmp, CLAUDE_SESSION_ID: "ok-false" },
  );
  const ev = readOne(tmp, "ok-false");
  assert.equal(ev.ok, false);
  assert.equal(typeof ev.err, "string");
  assert.ok(ev.err.length <= 200, `err was ${ev.err.length} chars`);
});

// The gate that matters: 43.6% of real tool_result blocks carry no is_error at
// all, and a Bash response has no exit code. Guessing false would invent
// failures; guessing true would hide them. Unknown must stay unknown.
test("outcome ok:null when the payload carries no outcome signal", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-evlog-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  await run(
    JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
      tool_response: {
        stdout: "hi\n",
        stderr: "",
        interrupted: false,
        isImage: false,
      },
    }),
    { CLAUDE_PLUGIN_DATA: tmp, CLAUDE_SESSION_ID: "ok-null" },
  );
  const ev = readOne(tmp, "ok-null");
  assert.equal(ev.ok, null, "no signal must record null, never false");
});

test("stderr on a Bash response is not treated as failure", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-evlog-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  await run(
    JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "cmd" },
      tool_response: { stdout: "", stderr: "warning: deprecated" },
    }),
    { CLAUDE_PLUGIN_DATA: tmp, CLAUDE_SESSION_ID: "stderr-ok" },
  );
  assert.equal(readOne(tmp, "stderr-ok").ok, null);
});

test("tool_use_id is captured when present", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-evlog-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  await run(
    JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: "/a.ts" },
      tool_use_id: "toolu_abc123",
    }),
    { CLAUDE_PLUGIN_DATA: tmp, CLAUDE_SESSION_ID: "tuid" },
  );
  assert.equal(readOne(tmp, "tuid").id, "toolu_abc123");
});

// 3108 events in the live store already exceed 4KB (max 118,989 bytes), which
// silently broke the O_APPEND atomicity the header comment claims.
test("byte budget: an oversized input is truncated below 4KB", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-evlog-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  await run(
    JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: "/big.ts", content: "x".repeat(120000) },
      tool_response: { is_error: true, error: "nope ".repeat(400) },
    }),
    { CLAUDE_PLUGIN_DATA: tmp, CLAUDE_SESSION_ID: "budget" },
  );
  const raw = readFileSync(path.join(tmp, "events-budget.jsonl"), "utf8");
  const line = raw.split("\n").filter((l) => l.length > 0)[0];
  assert.ok(
    Buffer.byteLength(line, "utf8") <= 4096,
    `line was ${Buffer.byteLength(line, "utf8")} bytes`,
  );
  const ev = JSON.parse(line);
  assert.ok(ev.input_truncated, "truncation must be marked");
  assert.equal(ev.tool, "Write");
  assert.equal(ev.ok, false, "outcome must survive truncation");
});

// The Stop aggregator reads ev.input.file_path / ev.input.command and falls
// back to {} when input is not an object. Truncating the whole payload into a
// string silently zeroed "files touched" and stopped Bash commands matching
// the tests/commit regexes — a large Write is exactly the case that truncates.
test("byte budget: truncation preserves structured input keys", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-evlog-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  await run(
    JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: "/repo/a.ts", content: "x".repeat(90000) },
    }),
    { CLAUDE_PLUGIN_DATA: tmp, CLAUDE_SESSION_ID: "keep-keys" },
  );
  const ev = readOne(tmp, "keep-keys");
  assert.equal(typeof ev.input, "object", "input must stay an object");
  assert.equal(ev.input.file_path, "/repo/a.ts", "file_path must survive");
  assert.ok(ev.input.content.length < 90000, "content must be clipped");
});

test("byte budget: a long Bash command keeps its head and tail", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-evlog-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const cmd = "npx vitest run " + "# pad ".repeat(2000) + "&& git commit -m x";
  await run(
    JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd } }),
    { CLAUDE_PLUGIN_DATA: tmp, CLAUDE_SESSION_ID: "bash-clip" },
  );
  const ev = readOne(tmp, "bash-clip");
  assert.equal(typeof ev.input, "object");
  assert.match(ev.input.command, /vitest/, "head must survive for test regex");
  assert.match(ev.input.command, /git commit/, "tail must survive too");
});

test("byte budget: parallel oversized writes stay race-free", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-evlog-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const N = 30;
  const runs = [];
  for (let i = 0; i < N; i++) {
    runs.push(
      run(
        JSON.stringify({
          tool_name: "Write",
          tool_input: { file_path: `/f${i}.ts`, content: "y".repeat(60000) },
        }),
        { CLAUDE_PLUGIN_DATA: tmp, CLAUDE_SESSION_ID: "budget-par" },
      ),
    );
  }
  await Promise.all(runs);
  const lines = readFileSync(path.join(tmp, "events-budget-par.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  assert.equal(lines.length, N);
  for (const line of lines) JSON.parse(line);
});

// A middle-of-command classifier survives when the bloat is in another field:
// `command` is clipped only after everything else has given what it can.
test("byte budget: a mid-command classifier survives other-field bloat", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-evlog-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  await run(
    JSON.stringify({
      tool_name: "Bash",
      tool_input: {
        command: "cd /repo && npm test && echo done",
        description: "z".repeat(90000),
      },
    }),
    { CLAUDE_PLUGIN_DATA: tmp, CLAUDE_SESSION_ID: "mid-clf" },
  );
  const ev = readOne(tmp, "mid-clf");
  assert.equal(
    ev.input.command,
    "cd /repo && npm test && echo done",
    "command must be untouched while another field can still be clipped",
  );
  assert.ok(ev.input.description.length < 90000);
});

// Classification runs on the full command before the budget clips it, so a
// classifier buried in the middle of an oversized command is not lost.
test("byte budget: an oversized command still records its classifiers", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-evlog-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const cmd = `: '${"x".repeat(2200)}'; npm test; : '${"y".repeat(2200)}'`;
  await run(
    JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd } }),
    { CLAUDE_PLUGIN_DATA: tmp, CLAUDE_SESSION_ID: "clf-clip" },
  );
  const ev = readOne(tmp, "clf-clip");
  assert.ok(
    !/npm test/.test(ev.input.command),
    "precondition: the command really was clipped past the classifier",
  );
  assert.equal(ev.clf.t, true, "classifier must survive the clip");
});

test("no classifier match adds no clf field", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-evlog-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  await run(
    JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls -la" } }),
    { CLAUDE_PLUGIN_DATA: tmp, CLAUDE_SESSION_ID: "no-clf" },
  );
  assert.equal("clf" in readOne(tmp, "no-clf"), false);
});

test("missing tool_name: silent exit, no file created", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-evlog-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const { code, stdout } = await run(
    JSON.stringify({ session_id: "no-tool" }),
    { CLAUDE_PLUGIN_DATA: tmp },
  );
  assert.equal(code, 0);
  assert.equal(stdout, "");
  assert.ok(!existsSync(path.join(tmp, "events-no-tool.jsonl")));
});
