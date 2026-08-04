// @ts-check
// mark-retro-done.mjs: invoked by /retro after a successful interview. Records
// the per-session fired flag plus the cross-session last-retro timestamp.
// Session id comes from the stdin payload or argv[2].

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
const SCRIPT = path.join(here, "..", "scripts", "mark-retro-done.mjs");

/**
 * @param {string} stdin
 * @param {Record<string, string>} env
 * @param {string[]} args
 */
function run(stdin, env, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
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

test("stdin session_id: writes fired flag + parseable last-retro timestamp", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-mrd-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const { code } = await run(JSON.stringify({ session_id: "dev" }), {
    CLAUDE_PLUGIN_DATA: tmp,
  });
  assert.equal(code, 0);

  assert.ok(
    existsSync(path.join(tmp, "retro-fired-dev.flag")),
    "per-session fired flag written",
  );

  const lastRetro = path.join(tmp, "last-retro.txt");
  assert.ok(existsSync(lastRetro), "last-retro.txt written");
  const ts = readFileSync(lastRetro, "utf8").trim();
  assert.ok(
    Number.isFinite(Date.parse(ts)),
    `last-retro.txt should be a parseable ISO timestamp, got: ${ts}`,
  );
});

test("argv[2] session_id used when stdin payload is empty", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-mrd-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const { code } = await run("", { CLAUDE_PLUGIN_DATA: tmp }, ["from-argv"]);
  assert.equal(code, 0);

  assert.ok(
    existsSync(path.join(tmp, "retro-fired-from-argv.flag")),
    "fired flag uses the argv session id",
  );
  assert.ok(existsSync(path.join(tmp, "last-retro.txt")));
});

test("argv[2] overrides stdin session_id", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-mrd-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const { code } = await run(JSON.stringify({ session_id: "stdin-sid" }), {
    CLAUDE_PLUGIN_DATA: tmp,
  }, ["argv-sid"]);
  assert.equal(code, 0);

  assert.ok(existsSync(path.join(tmp, "retro-fired-argv-sid.flag")));
  assert.ok(!existsSync(path.join(tmp, "retro-fired-stdin-sid.flag")));
});

test("batch snapshot present: appends processedSids to the ledger, leaves worthy log untouched", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-mrd-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  // A concurrent worthy-log line that is NOT in this batch must survive.
  const worthyBody =
    [
      JSON.stringify({ ts: "2026-07-10T00:00:00Z", sid: "w1", reasons: "a" }),
      JSON.stringify({ ts: "2026-07-11T00:00:00Z", sid: "w2", reasons: "b" }),
      JSON.stringify({ ts: "2026-07-12T00:00:00Z", sid: "concurrent", reasons: "c" }),
    ].join("\n") + "\n";
  writeFileSync(path.join(tmp, "retro-worthy.jsonl"), worthyBody);
  writeFileSync(
    path.join(tmp, "retro-batch-cur.json"),
    JSON.stringify({
      boundaryTs: "2026-07-15T09:00:00Z",
      processedSids: ["w1", "w2"],
      totalSessions: 3,
      batch: [],
    }) + "\n",
  );

  const { code } = await run("", { CLAUDE_PLUGIN_DATA: tmp }, ["cur"]);
  assert.equal(code, 0);

  // processedSids appended to the ledger.
  const processed = readFileSync(path.join(tmp, "retro-processed.jsonl"), "utf8");
  assert.match(processed, /"sid":"w1"/);
  assert.match(processed, /"sid":"w2"/);
  assert.doesNotMatch(processed, /"sid":"concurrent"/, "unprocessed session not marked");

  // Worthy log byte-for-byte unchanged (never rewritten).
  assert.equal(readFileSync(path.join(tmp, "retro-worthy.jsonl"), "utf8"), worthyBody);

  // last-retro.txt uses the snapshot's boundaryTs, not now().
  assert.equal(readFileSync(path.join(tmp, "last-retro.txt"), "utf8"), "2026-07-15T09:00:00Z");

  // Snapshot consumed.
  assert.ok(!existsSync(path.join(tmp, "retro-batch-cur.json")), "batch json deleted");
});

test("no batch snapshot: fallback writes now() cadence, appends nothing", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-mrd-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const { code } = await run("", { CLAUDE_PLUGIN_DATA: tmp }, ["cur"]);
  assert.equal(code, 0);

  const ts = readFileSync(path.join(tmp, "last-retro.txt"), "utf8").trim();
  assert.ok(Number.isFinite(Date.parse(ts)), "cadence hint is a valid timestamp");
  assert.ok(
    !existsSync(path.join(tmp, "retro-processed.jsonl")),
    "no ledger created when there is nothing to append",
  );
});

test("argv[2] session_id: exits without waiting for stdin to close", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "test-session-retro-mrd-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  // The skill invokes this from a session shell, where stdin is an inherited
  // pipe or TTY that never reaches EOF. Reading it there blocks forever, so a
  // run carrying its session id in argv must not touch stdin at all.
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, "no-eof"], {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: tmp },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out waiting for stdin EOF"));
    }, 5000);
    child.on("error", reject);
    child.on("close", (c) => {
      clearTimeout(timer);
      resolve(c ?? 0);
    });
    // Deliberately never call child.stdin.end() — the pipe stays open.
  });

  assert.equal(code, 0);
  assert.ok(
    existsSync(path.join(tmp, "retro-fired-no-eof.flag")),
    "fired flag written without stdin ever closing",
  );
});

test("SKILL.md Step 6 sets CLAUDE_PLUGIN_DATA on the invocation", () => {
  const skill = readFileSync(
    path.join(here, "..", "skills", "retro", "SKILL.md"),
    "utf8",
  );
  // Session shells do NOT inherit CLAUDE_PLUGIN_DATA (hooks do), so a bare
  // invocation writes to the os.tmpdir() fallback and the batch clock never
  // resets. The skill must pass the data dir explicitly.
  assert.match(
    skill,
    /CLAUDE_PLUGIN_DATA="\$\{CLAUDE_PLUGIN_DATA\}" node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/mark-retro-done\.mjs"/,
    "Step 6 must prefix CLAUDE_PLUGIN_DATA so the flag lands in the hook data dir",
  );
});
