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
