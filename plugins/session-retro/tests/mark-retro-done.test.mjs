// @ts-check
// mark-retro-done.mjs: invoked by /retro after a successful interview. Records
// the per-session fired flag plus the cross-session last-retro timestamp.
// Session id comes from the stdin payload or argv[2].

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
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
