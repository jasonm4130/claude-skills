// @ts-check
// Tests for the workflow-model-guard PreToolUse hook. Spawns the hook as a child
// process with synthetic stdin and asserts on stdout/exit code — the same contract
// Claude Code uses at runtime.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOOK = fileURLToPath(
  new URL("../scripts/pretooluse-guard-workflow-model.mjs", import.meta.url),
);

/**
 * Run the hook with the given stdin payload.
 * @param {object | string} input
 * @returns {{ status: number | null, stdout: string }}
 */
function run(input) {
  const stdin = typeof input === "string" ? input : JSON.stringify(input);
  const res = spawnSync("node", [HOOK], { input: stdin, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout };
}

/** Wrap a workflow script string into a Workflow tool_input payload. */
function wf(script) {
  return { tool_name: "Workflow", tool_input: { script } };
}

/** Parse the deny envelope, asserting shape. */
function parseDecision(stdout) {
  const obj = JSON.parse(stdout);
  return obj.hookSpecificOutput;
}

/** Write content to a throwaway .mjs file; returns its path + a cleanup fn. */
function tmpScript(content) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wmg-"));
  const p = path.join(dir, "wf.mjs");
  writeFileSync(p, content);
  return { p, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("denies parallel fan-out with no model override", () => {
  const { status, stdout } = run(
    wf('phase("x"); await parallel(items.map(i => () => agent("do " + i)))'),
  );
  assert.equal(status, 0);
  const d = parseDecision(stdout);
  assert.equal(d.hookEventName, "PreToolUse");
  assert.equal(d.permissionDecision, "deny");
  assert.match(d.permissionDecisionReason, /workflow-model-guard/);
});

test("denies pipeline fan-out with no model override", () => {
  const { stdout } = run(
    wf('await pipeline(items, x => agent("a"), x => agent("b"))'),
  );
  assert.equal(parseDecision(stdout).permissionDecision, "deny");
});

test("denies >=4 plain agent() calls with no fan-out", () => {
  const { stdout } = run(
    wf('await agent("a"); await agent("b"); await agent("c"); await agent("d")'),
  );
  assert.equal(parseDecision(stdout).permissionDecision, "deny");
});

test("deny reason names the estimated agent count", () => {
  const { stdout } = run(
    wf('await parallel([() => agent("a"), () => agent("b")])'),
  );
  assert.match(parseDecision(stdout).permissionDecisionReason, /~2 agent\(\) calls/);
});

test("deny reason omits the count when no agent() calls are statically visible", () => {
  // parallel( fan-out with zero static agent() matches — must not read "~0 agent() calls".
  const reason = parseDecision(run(wf("await parallel([])")).stdout).permissionDecisionReason;
  assert.doesNotMatch(reason, /~0/);
  assert.match(reason, /parallel\/pipeline fan-out/);
});

test("allows when a model: override is present", () => {
  const { status, stdout } = run(
    wf('await parallel(items.map(i => () => agent("do", {model: "sonnet"})))'),
  );
  assert.equal(status, 0);
  assert.equal(stdout.trim(), "");
});

test("allows when the ack marker is present", () => {
  const { stdout } = run(
    wf('// model-guard:ack\nawait parallel(items.map(i => () => agent("do " + i)))'),
  );
  assert.equal(stdout.trim(), "");
});

test("allows a tiny single-agent workflow", () => {
  const { stdout } = run(wf('const r = await agent("summarize this")'));
  assert.equal(stdout.trim(), "");
});

test("allows a 3-agent workflow with no fan-out or loop", () => {
  const { stdout } = run(
    wf('await agent("a"); await agent("b"); await agent("c")'),
  );
  assert.equal(stdout.trim(), "");
});

test("allows when script is absent (scriptPath/name re-run)", () => {
  const { stdout } = run({ tool_name: "Workflow", tool_input: { scriptPath: "/x.js" } });
  assert.equal(stdout.trim(), "");
});

test("ignores non-Workflow tools", () => {
  const { stdout } = run({ tool_name: "Bash", tool_input: { command: "agent(" } });
  assert.equal(stdout.trim(), "");
});

test("exits gracefully on malformed stdin", () => {
  const { status, stdout } = run("not json at all");
  assert.equal(status, 0);
  assert.equal(stdout.trim(), "");
});

test("treats phase meta model field as consideration (bypass)", () => {
  // meta.phases entries can carry a model — that's still evidence tiers were weighed.
  const { stdout } = run(
    wf('export const meta = { phases: [{ title: "x", model: "haiku" }] }; await parallel([() => agent("a"), () => agent("b")])'),
  );
  assert.equal(stdout.trim(), "");
});

// ---- scriptPath inspection (read the file, apply the same heuristic) ----

test("denies a scriptPath workflow that fans out with no model override", () => {
  const { p, cleanup } = tmpScript('await parallel(items.map(i => () => agent("do " + i)))');
  try {
    const { stdout } = run({ tool_name: "Workflow", tool_input: { scriptPath: p } });
    assert.equal(parseDecision(stdout).permissionDecision, "deny");
  } finally {
    cleanup();
  }
});

test("allows a scriptPath workflow that sets a model override", () => {
  const { p, cleanup } = tmpScript('await parallel(items.map(i => () => agent("do", {model: "sonnet"})))');
  try {
    const { stdout } = run({ tool_name: "Workflow", tool_input: { scriptPath: p } });
    assert.equal(stdout.trim(), "");
  } finally {
    cleanup();
  }
});

test("allows the shipped deep-dive fanout.mjs by scriptPath (already tiered)", () => {
  const fanout = fileURLToPath(
    new URL("../../deep-dive/workflows/fanout.mjs", import.meta.url),
  );
  const { stdout } = run({ tool_name: "Workflow", tool_input: { scriptPath: fanout } });
  assert.equal(stdout.trim(), "");
});

test("allows when scriptPath points to a missing/unreadable file", () => {
  const { stdout } = run({
    tool_name: "Workflow",
    tool_input: { scriptPath: "/no/such/file-xyz-12345.mjs" },
  });
  assert.equal(stdout.trim(), "");
});

// ---- name: denylist (un-editable built-ins) → ask the user ----

test("asks the user before the all-Opus built-in name:deep-research", () => {
  const { status, stdout } = run({
    tool_name: "Workflow",
    tool_input: { name: "deep-research", args: "some question" },
  });
  assert.equal(status, 0);
  const d = parseDecision(stdout);
  assert.equal(d.permissionDecision, "ask");
  assert.match(d.permissionDecisionReason, /workflow-model-guard/);
  assert.match(d.permissionDecisionReason, /Opus|session model/i);
});

test("ignores named workflows not on the denylist", () => {
  const { stdout } = run({
    tool_name: "Workflow",
    tool_input: { name: "some-other-saved-workflow" },
  });
  assert.equal(stdout.trim(), "");
});
