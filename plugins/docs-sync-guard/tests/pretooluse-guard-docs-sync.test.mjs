// @ts-check
// Tests for the docs-sync-guard PreToolUse hook (matcher: Bash, git-commit gate).
// Each test builds a real throwaway git repo with a plugins/ monorepo layout, stages
// files, and runs the hook as a child process with a synthetic payload — the same
// contract Claude Code uses at runtime.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOOK = fileURLToPath(
  new URL("../scripts/pretooluse-guard-docs-sync.mjs", import.meta.url),
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

/**
 * Wrap a Bash command into a PreToolUse payload rooted at `cwd`.
 * @param {string} command
 * @param {string} cwd
 */
function bash(command, cwd) {
  return { tool_name: "Bash", tool_input: { command }, cwd };
}

/**
 * Parse the decision envelope.
 * @param {string} stdout
 */
function parseDecision(stdout) {
  return JSON.parse(stdout).hookSpecificOutput;
}

/**
 * Create a throwaway git repo. `files` maps repo-relative path → content; every
 * file is written; paths in `staged` are git-added.
 * @param {Record<string, string>} files
 * @param {string[]} staged
 * @returns {{ root: string, cleanup: () => void }}
 */
function repo(files, staged) {
  const root = mkdtempSync(path.join(os.tmpdir(), "dsg-"));
  execSync("git init -q", { cwd: root });
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    writeFileSync(path.join(root, p), content);
  }
  if (staged.length) execSync(`git add ${staged.join(" ")}`, { cwd: root });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const COMMIT = 'git commit -m "change the guard"';

// ---- core deny/allow ----

test("denies a commit staging plugin code with no staged docs", () => {
  const r = repo(
    { "plugins/foo/scripts/guard.mjs": "x", "plugins/foo/README.md": "docs" },
    ["plugins/foo/scripts/guard.mjs"],
  );
  try {
    const { status, stdout } = run(bash(COMMIT, r.root));
    assert.equal(status, 0);
    const d = parseDecision(stdout);
    assert.equal(d.permissionDecision, "deny");
    assert.match(d.permissionDecisionReason, /docs-sync-guard/);
    assert.match(d.permissionDecisionReason, /foo/); // names the plugin
  } finally {
    r.cleanup();
  }
});

test("allows when the plugin's README is staged alongside the code", () => {
  const r = repo(
    { "plugins/foo/scripts/guard.mjs": "x", "plugins/foo/README.md": "docs" },
    ["plugins/foo/scripts/guard.mjs", "plugins/foo/README.md"],
  );
  try {
    const { stdout } = run(bash(COMMIT, r.root));
    assert.equal(stdout.trim(), "");
  } finally {
    r.cleanup();
  }
});

test("allows when the plugin's CLAUDE.md is staged alongside the code", () => {
  const r = repo(
    { "plugins/foo/hooks/hooks.json": "{}", "plugins/foo/CLAUDE.md": "docs" },
    ["plugins/foo/hooks/hooks.json", "plugins/foo/CLAUDE.md"],
  );
  try {
    const { stdout } = run(bash(COMMIT, r.root));
    assert.equal(stdout.trim(), "");
  } finally {
    r.cleanup();
  }
});

test("docs must belong to the SAME plugin as the code change", () => {
  const r = repo(
    {
      "plugins/foo/scripts/guard.mjs": "x",
      "plugins/bar/README.md": "unrelated docs",
    },
    ["plugins/foo/scripts/guard.mjs", "plugins/bar/README.md"],
  );
  try {
    assert.equal(parseDecision(run(bash(COMMIT, r.root)).stdout).permissionDecision, "deny");
  } finally {
    r.cleanup();
  }
});

// ---- suppression list (what NOT to flag) ----

test("allows a tests-only change", () => {
  const r = repo(
    { "plugins/foo/tests/guard.test.mjs": "t" },
    ["plugins/foo/tests/guard.test.mjs"],
  );
  try {
    assert.equal(run(bash(COMMIT, r.root)).stdout.trim(), "");
  } finally {
    r.cleanup();
  }
});

test("allows a version-bump-only change (plugin.json + marketplace.json)", () => {
  const r = repo(
    {
      "plugins/foo/.claude-plugin/plugin.json": "{}",
      ".claude-plugin/marketplace.json": "{}",
    },
    ["plugins/foo/.claude-plugin/plugin.json", ".claude-plugin/marketplace.json"],
  );
  try {
    assert.equal(run(bash(COMMIT, r.root)).stdout.trim(), "");
  } finally {
    r.cleanup();
  }
});

test("allows skills/commands markdown changes (self-documenting prompt files)", () => {
  const r = repo(
    { "plugins/foo/skills/thing/SKILL.md": "s" },
    ["plugins/foo/skills/thing/SKILL.md"],
  );
  try {
    assert.equal(run(bash(COMMIT, r.root)).stdout.trim(), "");
  } finally {
    r.cleanup();
  }
});

// ---- escape hatch ----

test("allows when the ack marker is in the commit command", () => {
  const r = repo(
    { "plugins/foo/scripts/guard.mjs": "x" },
    ["plugins/foo/scripts/guard.mjs"],
  );
  try {
    const { stdout } = run(
      bash('git commit -m "refactor, no doc impact docs-sync:ack"', r.root),
    );
    assert.equal(stdout.trim(), "");
  } finally {
    r.cleanup();
  }
});

// ---- compound commands: `git add X && git commit` where X isn't staged yet ----

test("catches code added in the same compound command as the commit", () => {
  const r = repo({ "plugins/foo/scripts/guard.mjs": "x" }, []);
  try {
    const { stdout } = run(
      bash('git add plugins/foo/scripts/guard.mjs && git commit -m "x"', r.root),
    );
    assert.equal(parseDecision(stdout).permissionDecision, "deny");
  } finally {
    r.cleanup();
  }
});

test("compound add of code AND its docs passes", () => {
  const r = repo(
    { "plugins/foo/scripts/guard.mjs": "x", "plugins/foo/README.md": "d" },
    [],
  );
  try {
    const { stdout } = run(
      bash(
        'git add plugins/foo/scripts/guard.mjs plugins/foo/README.md && git commit -m "x"',
        r.root,
      ),
    );
    assert.equal(stdout.trim(), "");
  } finally {
    r.cleanup();
  }
});

// ---- pass-through and robustness ----

test("silent outside a plugins/ monorepo layout", () => {
  const r = repo({ "src/main.js": "x" }, ["src/main.js"]);
  try {
    assert.equal(run(bash(COMMIT, r.root)).stdout.trim(), "");
  } finally {
    r.cleanup();
  }
});

test("ignores non-commit git commands", () => {
  const r = repo(
    { "plugins/foo/scripts/guard.mjs": "x" },
    ["plugins/foo/scripts/guard.mjs"],
  );
  try {
    assert.equal(run(bash("git status", r.root)).stdout.trim(), "");
  } finally {
    r.cleanup();
  }
});

test("ignores non-Bash tools", () => {
  const { stdout } = run({ tool_name: "Write", tool_input: { file_path: "/x" } });
  assert.equal(stdout.trim(), "");
});

test("exits gracefully on malformed stdin", () => {
  const { status, stdout } = run("not json");
  assert.equal(status, 0);
  assert.equal(stdout.trim(), "");
});

test("fails open when cwd is not a git repo", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsg-nogit-"));
  try {
    assert.equal(run(bash(COMMIT, dir)).stdout.trim(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
