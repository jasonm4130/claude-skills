// @ts-check
// Tests for the agent-model-guard PreToolUse hook (matcher: Agent). Spawns the hook
// as a child process with synthetic stdin and asserts on stdout/exit code — the same
// contract Claude Code uses at runtime. Custom-agent resolution is exercised through
// real temp dirs: `cwd` in the payload for project agents, $HOME override for user agents.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOOK = fileURLToPath(
  new URL("../scripts/pretooluse-guard-agent-model.mjs", import.meta.url),
);

/**
 * Run the hook with the given stdin payload.
 * @param {object | string} input
 * @param {Record<string, string>} [envOverride]
 * @returns {{ status: number | null, stdout: string }}
 */
function run(input, envOverride) {
  const stdin = typeof input === "string" ? input : JSON.stringify(input);
  const res = spawnSync("node", [HOOK], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, ...envOverride },
  });
  return { status: res.status, stdout: res.stdout };
}

/**
 * Wrap Agent tool_input fields into a PreToolUse payload.
 * @param {object} tool_input
 * @param {object} [extra]
 */
function agentCall(tool_input, extra = {}) {
  return { tool_name: "Agent", tool_input, ...extra };
}

/**
 * Parse the decision envelope, asserting shape.
 * @param {string} stdout
 */
function parseDecision(stdout) {
  const obj = JSON.parse(stdout);
  return obj.hookSpecificOutput;
}

/**
 * Create a throwaway dir containing .claude/agents/<file> with the given content.
 * @param {string} file
 * @param {string} content
 * @returns {{ root: string, cleanup: () => void }}
 */
function tmpAgentDir(file, content) {
  const root = mkdtempSync(path.join(os.tmpdir(), "amg-"));
  const agents = path.join(root, ".claude", "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(path.join(agents, file), content);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A $HOME with no ~/.claude/agents, so user-level resolution finds nothing. */
function emptyHome() {
  const root = mkdtempSync(path.join(os.tmpdir(), "amg-home-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const EXPLORE_PINNED = `---
name: Explore
description: Read-only search agent
model: sonnet
---
Search the codebase and report findings.
`;

const EXPLORE_INHERIT = `---
name: Explore
description: Read-only search agent
model: inherit
---
Search the codebase and report findings.
`;

const EXPLORE_NO_MODEL = `---
name: Explore
description: Read-only search agent
---
Search the codebase and report findings.
`;

// ---- core deny/allow behavior ----

test("denies a built-in Explore dispatch with no model", () => {
  const home = emptyHome();
  try {
    const { status, stdout } = run(
      agentCall({ description: "probe", prompt: "find x", subagent_type: "Explore" }),
      { HOME: home.root },
    );
    assert.equal(status, 0);
    const d = parseDecision(stdout);
    assert.equal(d.hookEventName, "PreToolUse");
    assert.equal(d.permissionDecision, "deny");
    assert.match(d.permissionDecisionReason, /agent-model-guard/);
  } finally {
    home.cleanup();
  }
});

test("denies a general-purpose dispatch with no model", () => {
  const home = emptyHome();
  try {
    const { stdout } = run(
      agentCall({ description: "d", prompt: "p", subagent_type: "general-purpose" }),
      { HOME: home.root },
    );
    assert.equal(parseDecision(stdout).permissionDecision, "deny");
  } finally {
    home.cleanup();
  }
});

test("denies when subagent_type is absent (defaults to an inheriting built-in)", () => {
  const home = emptyHome();
  try {
    const { stdout } = run(agentCall({ description: "d", prompt: "p" }), {
      HOME: home.root,
    });
    assert.equal(parseDecision(stdout).permissionDecision, "deny");
  } finally {
    home.cleanup();
  }
});

test("deny reason names the tier calculus and the explicit-model escape hatch", () => {
  const home = emptyHome();
  try {
    const { stdout } = run(
      agentCall({ description: "d", prompt: "p", subagent_type: "general-purpose" }),
      { HOME: home.root },
    );
    const reason = parseDecision(stdout).permissionDecisionReason;
    assert.match(reason, /model:\s*'sonnet'/);
    assert.match(reason, /haiku/);
    assert.match(reason, /explicit model always passes/i);
  } finally {
    home.cleanup();
  }
});

test("allows when model is set to sonnet", () => {
  const { status, stdout } = run(
    agentCall({ description: "d", prompt: "p", subagent_type: "Explore", model: "sonnet" }),
  );
  assert.equal(status, 0);
  assert.equal(stdout.trim(), "");
});

test("allows any explicit tier — setting model IS the ack, even fable", () => {
  const { stdout } = run(
    agentCall({ description: "d", prompt: "p", subagent_type: "general-purpose", model: "fable" }),
  );
  assert.equal(stdout.trim(), "");
});

test("allows fork dispatches (model param is ignored for forks — deny would dead-end)", () => {
  const home = emptyHome();
  try {
    const { stdout } = run(
      agentCall({ description: "d", prompt: "p", subagent_type: "fork" }),
      { HOME: home.root },
    );
    assert.equal(stdout.trim(), "");
  } finally {
    home.cleanup();
  }
});

// ---- custom agent definition resolution ----

test("allows when a project agent definition pins a model", () => {
  const proj = tmpAgentDir("Explore.md", EXPLORE_PINNED);
  const home = emptyHome();
  try {
    const { stdout } = run(
      agentCall(
        { description: "d", prompt: "p", subagent_type: "Explore" },
        { cwd: proj.root },
      ),
      { HOME: home.root },
    );
    assert.equal(stdout.trim(), "");
  } finally {
    proj.cleanup();
    home.cleanup();
  }
});

test("denies when the resolving project definition says model: inherit", () => {
  const proj = tmpAgentDir("Explore.md", EXPLORE_INHERIT);
  const home = emptyHome();
  try {
    const { stdout } = run(
      agentCall(
        { description: "d", prompt: "p", subagent_type: "Explore" },
        { cwd: proj.root },
      ),
      { HOME: home.root },
    );
    assert.equal(parseDecision(stdout).permissionDecision, "deny");
  } finally {
    proj.cleanup();
    home.cleanup();
  }
});

test("denies when the resolving project definition has no model field", () => {
  const proj = tmpAgentDir("Explore.md", EXPLORE_NO_MODEL);
  const home = emptyHome();
  try {
    const { stdout } = run(
      agentCall(
        { description: "d", prompt: "p", subagent_type: "Explore" },
        { cwd: proj.root },
      ),
      { HOME: home.root },
    );
    assert.equal(parseDecision(stdout).permissionDecision, "deny");
  } finally {
    proj.cleanup();
    home.cleanup();
  }
});

test("allows when a user-level (~/.claude/agents) definition pins a model", () => {
  const home = tmpAgentDir("Explore.md", EXPLORE_PINNED);
  try {
    const { stdout } = run(
      agentCall({ description: "d", prompt: "p", subagent_type: "Explore" }),
      { HOME: home.root },
    );
    assert.equal(stdout.trim(), "");
  } finally {
    home.cleanup();
  }
});

test("project definition takes precedence over user definition", () => {
  // Project says inherit; user pins sonnet. Project wins → the dispatch inherits → deny.
  const proj = tmpAgentDir("Explore.md", EXPLORE_INHERIT);
  const home = tmpAgentDir("Explore.md", EXPLORE_PINNED);
  try {
    const { stdout } = run(
      agentCall(
        { description: "d", prompt: "p", subagent_type: "Explore" },
        { cwd: proj.root },
      ),
      { HOME: home.root },
    );
    assert.equal(parseDecision(stdout).permissionDecision, "deny");
  } finally {
    proj.cleanup();
    home.cleanup();
  }
});

test("matches an agent by frontmatter name even when the filename differs", () => {
  const proj = tmpAgentDir("my-explorer.md", EXPLORE_PINNED);
  const home = emptyHome();
  try {
    const { stdout } = run(
      agentCall(
        { description: "d", prompt: "p", subagent_type: "Explore" },
        { cwd: proj.root },
      ),
      { HOME: home.root },
    );
    assert.equal(stdout.trim(), "");
  } finally {
    proj.cleanup();
    home.cleanup();
  }
});

// ---- pass-through and robustness ----

test("ignores non-Agent tools", () => {
  const { stdout } = run({ tool_name: "Workflow", tool_input: { script: "agent(" } });
  assert.equal(stdout.trim(), "");
});

test("exits gracefully on malformed stdin", () => {
  const { status, stdout } = run("not json at all");
  assert.equal(status, 0);
  assert.equal(stdout.trim(), "");
});

test("exits gracefully when tool_input is missing", () => {
  const home = emptyHome();
  try {
    const { status, stdout } = run({ tool_name: "Agent" }, { HOME: home.root });
    assert.equal(status, 0);
    // No input to inspect → still an untiered dispatch → deny is the safe default.
    assert.equal(parseDecision(stdout).permissionDecision, "deny");
  } finally {
    home.cleanup();
  }
});
