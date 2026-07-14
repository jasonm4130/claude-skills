// @ts-check
// Mirrors v0.1 bash tests:
//   test_load_pending_loads.sh
//   test_load_pending_missing_file.sh
//   test_load_pending_stale.sh

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  utimesSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "scripts", "load-pending-handoff.mjs");

/**
 * @param {string} stdinPayload
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function run(stdinPayload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env },
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

function mkProject() {
  const root = mkdtempSync(path.join(os.tmpdir(), "handoff-load-"));
  const project = path.join(root, "project");
  mkdirSync(path.join(project, ".claude", "handoffs"), { recursive: true });
  return { root, project };
}

test("test_load_pending_loads", async (t) => {
  const { root, project } = mkProject();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const handoffName = "2026-05-25T14-00-00-auto.md";
  const handoffPath = path.join(project, ".claude", "handoffs", handoffName);
  writeFileSync(
    handoffPath,
    "## Current state\nHalf done.\n\n## Next concrete step\nRun: npm test"
  );

  const pendingFile = path.join(project, ".claude", "handoffs", ".pending");
  writeFileSync(pendingFile, handoffName);

  const result = await run(JSON.stringify({ cwd: project }));
  assert.equal(result.code, 0);

  const out = JSON.parse(result.stdout);
  assert.ok(out.hookSpecificOutput, `no hookSpecificOutput in output: ${result.stdout}`);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");

  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /\[handoff\]/, `missing [handoff] in context: ${ctx}`);
  assert.match(ctx, /Half done/, `handoff content not in context: ${ctx}`);

  assert.ok(!existsSync(pendingFile), ".pending not deleted");
});

test("test_load_pending_missing_file", async (t) => {
  const { root, project } = mkProject();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const pendingFile = path.join(project, ".claude", "handoffs", ".pending");
  writeFileSync(pendingFile, "nonexistent-handoff.md");

  const result = await run(JSON.stringify({ cwd: project }));
  assert.equal(result.code, 0);

  assert.ok(!existsSync(pendingFile), ".pending not deleted when file missing");
  assert.equal(
    result.stdout,
    "",
    `expected empty output for missing file, got: ${result.stdout}`
  );
});

test("test_load_pending_stale", async (t) => {
  const { root, project } = mkProject();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const pendingFile = path.join(project, ".claude", "handoffs", ".pending");
  writeFileSync(pendingFile, "2026-05-24T10-00-00-auto.md");

  // Backdate mtime to 2 days ago
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  utimesSync(pendingFile, twoDaysAgo, twoDaysAgo);

  const result = await run(JSON.stringify({ cwd: project }));
  assert.equal(result.code, 0);

  assert.ok(!existsSync(pendingFile), "stale .pending not deleted");
  assert.equal(
    result.stdout,
    "",
    `expected empty output for stale .pending, got: ${result.stdout}`
  );
});

test("traversal: a .pending pointing outside handoffs/ is refused and consumed", async (t) => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "handoff-trav-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const handoffsDir = path.join(cwd, ".claude", "handoffs");
  mkdirSync(handoffsDir, { recursive: true });
  writeFileSync(path.join(cwd, "secret.env"), "API_KEY=super-secret-value");
  const pending = path.join(handoffsDir, ".pending");
  writeFileSync(pending, "../../secret.env");

  const { code, stdout } = await run(JSON.stringify({ cwd }));

  assert.equal(code, 0, "a refusal is not an error");
  assert.doesNotMatch(stdout, /super-secret-value/, "traversal target must never reach context");
  assert.equal(stdout.trim(), "", "no additionalContext is emitted for a refused marker");
  assert.equal(existsSync(pending), false, "the poisoned marker is consumed, not left to retry");
});

test("traversal: a symlinked handoff target is refused and consumed", { skip: process.platform === "win32" }, async (t) => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "handoff-symtrav-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const handoffsDir = path.join(cwd, ".claude", "handoffs");
  mkdirSync(handoffsDir, { recursive: true });
  writeFileSync(path.join(cwd, "secret.env"), "API_KEY=super-secret-value");
  symlinkSync(path.join(cwd, "secret.env"), path.join(handoffsDir, "innocent.md"));
  const pending = path.join(handoffsDir, ".pending");
  writeFileSync(pending, "innocent.md");

  const { code, stdout } = await run(JSON.stringify({ cwd }));

  assert.equal(code, 0);
  assert.doesNotMatch(stdout, /super-secret-value/, "a symlink out of handoffs/ must not be followed");
  assert.equal(existsSync(pending), false);
});
