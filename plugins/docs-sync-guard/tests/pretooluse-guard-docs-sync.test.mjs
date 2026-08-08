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

// ---- generic mode: any repo with agent-facing docs (v0.2.0) ----

test("generic: denies code change when covering root README+CLAUDE.md untouched", () => {
  const r = repo(
    { "src/main.js": "x", "README.md": "d", "CLAUDE.md": "d" },
    ["src/main.js"],
  );
  try {
    const d = parseDecision(run(bash(COMMIT, r.root)).stdout);
    assert.equal(d.permissionDecision, "deny");
    assert.match(d.permissionDecisionReason, /source of truth|stale/i);
  } finally {
    r.cleanup();
  }
});

test("generic: allows when a covering doc is staged with the code", () => {
  const r = repo(
    { "src/main.js": "x", "README.md": "d" },
    ["src/main.js", "README.md"],
  );
  try {
    assert.equal(run(bash(COMMIT, r.root)).stdout.trim(), "");
  } finally {
    r.cleanup();
  }
});

test("generic: nearest covering doc satisfies — subdir README staged", () => {
  const r = repo(
    { "svc/api/server.js": "x", "svc/README.md": "d", "README.md": "root" },
    ["svc/api/server.js", "svc/README.md"],
  );
  try {
    assert.equal(run(bash(COMMIT, r.root)).stdout.trim(), "");
  } finally {
    r.cleanup();
  }
});

test("generic: AGENTS.md counts as a covering doc", () => {
  const r = repo(
    { "src/main.js": "x", "AGENTS.md": "d" },
    ["src/main.js", "AGENTS.md"],
  );
  try {
    assert.equal(run(bash(COMMIT, r.root)).stdout.trim(), "");
  } finally {
    r.cleanup();
  }
});

test("generic: silent when the repo has no agent-facing docs at all", () => {
  const r = repo({ "src/main.js": "x" }, ["src/main.js"]);
  try {
    assert.equal(run(bash(COMMIT, r.root)).stdout.trim(), "");
  } finally {
    r.cleanup();
  }
});

test("generic: docs-only commits never trigger", () => {
  const r = repo(
    { "README.md": "d", "notes/design.md": "n" },
    ["README.md", "notes/design.md"],
  );
  try {
    assert.equal(run(bash(COMMIT, r.root)).stdout.trim(), "");
  } finally {
    r.cleanup();
  }
});

test("generic: tests-only and lockfile-only commits never trigger", () => {
  const r = repo(
    { "tests/a.test.js": "t", "package-lock.json": "{}", "README.md": "d" },
    ["tests/a.test.js", "package-lock.json"],
  );
  try {
    assert.equal(run(bash(COMMIT, r.root)).stdout.trim(), "");
  } finally {
    r.cleanup();
  }
});

// ---- .docs-sync: this plugin's own consolidation record (v0.3.0) ----
//
// The record is not Markdown, so without an explicit exemption rule 2 treats it as
// code, walks up for its covering doc, finds the root README.md unstaged, and denies.
// Every repo this ships to has a root README, so `/docs-consolidate --init` and every
// routine re-stamp would be refused — the feature could not be adopted at all.
//
// The exemption must not become a bypass: it exempts the record, not the commit.

test("docs-sync: a record-only commit is allowed even with an unstaged root README", () => {
  const r = repo({ ".docs-sync": "docs-sync: audited=abc123", "README.md": "d" }, [
    ".docs-sync",
  ]);
  try {
    assert.equal(run(bash(COMMIT, r.root)).stdout.trim(), "");
  } finally {
    r.cleanup();
  }
});

test("docs-sync: the record alongside markdown edits is allowed", () => {
  const r = repo(
    { ".docs-sync": "docs-sync: audited=abc123", "README.md": "d", "docs/STATUS.md": "s" },
    [".docs-sync", "README.md", "docs/STATUS.md"],
  );
  try {
    assert.equal(run(bash(COMMIT, r.root)).stdout.trim(), "");
  } finally {
    r.cleanup();
  }
});

test("docs-sync: the exemption is not a bypass — real code in the same commit still denies", () => {
  const r = repo(
    { ".docs-sync": "docs-sync: audited=abc123", "src/main.js": "x", "README.md": "d" },
    [".docs-sync", "src/main.js"],
  );
  try {
    const d = parseDecision(run(bash(COMMIT, r.root)).stdout);
    assert.equal(d.permissionDecision, "deny");
    assert.match(d.permissionDecisionReason, /src\/main\.js/);
    assert.doesNotMatch(d.permissionDecisionReason, /\.docs-sync/);
  } finally {
    r.cleanup();
  }
});

// ---- quoted paths containing spaces (2026-08-03) ----
//
// `pathsFromGitAdd` split the add segment on bare whitespace, so a quoted path
// containing a space fragmented. `git add "Daily/2026-08-03 - Daily.md"` became
// `Daily/2026-08-03` + `-` + `Daily.md"`: the `-` was dropped as a flag,
// `Daily.md` passed the markdown skip, and the extensionless `Daily/2026-08-03`
// was treated as CODE — denying an ordinary markdown-only commit. Found for real
// on an Obsidian vault, where every daily note has a space in its name.

test("docs-sync: a quoted markdown path containing spaces is still markdown", () => {
  const r = repo({ "Daily/2026-08-03 - Daily.md": "note", "README.md": "d" }, []);
  try {
    const cmd = 'git add "Daily/2026-08-03 - Daily.md" && git commit -m "note"';
    assert.equal(run(bash(cmd, r.root)).stdout.trim(), "", "markdown-only commit must pass");
  } finally {
    r.cleanup();
  }
});

test("docs-sync: single-quoted and backslash-escaped spaces are handled too", () => {
  const r = repo({ "My Docs/a b.md": "x", "README.md": "d" }, []);
  try {
    for (const cmd of [
      `git add 'My Docs/a b.md' && git commit -m "x"`,
      `git add My\\ Docs/a\\ b.md && git commit -m "x"`,
    ]) {
      assert.equal(run(bash(cmd, r.root)).stdout.trim(), "", `should pass: ${cmd}`);
    }
  } finally {
    r.cleanup();
  }
});

test("docs-sync: a commit mentioned inside a heredoc body is not a commit", () => {
  // Text being written to a file is not a command. Without stripping, writing a
  // README that documents `git add x && git commit` denies the write itself.
  const r = repo({ "src/main.js": "x", "README.md": "d" }, ["src/main.js"]);
  try {
    const cmd = "cat >> notes.md <<'EOF'\ngit add src/main.js && git commit -m x\nEOF";
    assert.equal(run(bash(cmd, r.root)).stdout.trim(), "", "heredoc body must not trigger the gate");
  } finally {
    r.cleanup();
  }
});

// The guard promises the ack "lands in the commit message, so the judgment is
// auditable later". With `git commit -F -` the heredoc IS the message, so
// stripping it before the ack check made that promise unachievable: you could
// have the ack work, or have it in the message, never both.
test("docs-sync: ack inside a `commit -F -` heredoc is honoured", () => {
  const r = repo({ "plugins/p/scripts/a.mjs": "x", "plugins/p/README.md": "d" }, [
    "plugins/p/scripts/a.mjs",
  ]);
  try {
    const cmd =
      "git commit -F - <<'EOF'\nfix(p): tweak a comment\n\nNo behavioural change: docs-sync:ack\nEOF";
    assert.equal(
      run(bash(cmd, r.root)).stdout.trim(),
      "",
      "ack in the commit message must allow the commit",
    );
  } finally {
    r.cleanup();
  }
});

test("docs-sync: `--file=-` and `--file -` heredoc acks are honoured too", () => {
  const r = repo({ "plugins/p/scripts/a.mjs": "x", "plugins/p/README.md": "d" }, [
    "plugins/p/scripts/a.mjs",
  ]);
  try {
    for (const flag of ["--file=-", "--file -"]) {
      const cmd = `git commit ${flag} <<'EOF'\nfix: x\n\ndocs-sync:ack\nEOF`;
      assert.equal(run(bash(cmd, r.root)).stdout.trim(), "", `should pass: ${flag}`);
    }
  } finally {
    r.cleanup();
  }
});

// The bypass this must NOT open: a heredoc that merely documents the marker.
// The docs-sync-guard's own README necessarily contains the literal token.
test("docs-sync: ack in a non-message heredoc does NOT bypass the gate", () => {
  const r = repo({ "plugins/p/scripts/a.mjs": "x", "plugins/p/README.md": "d" }, [
    "plugins/p/scripts/a.mjs",
  ]);
  try {
    const cmd =
      "cat >> notes.md <<'EOF'\nTo skip the gate write docs-sync:ack in the message.\nEOF\ngit commit -m x";
    const d = parseDecision(run(bash(cmd, r.root)).stdout);
    assert.equal(d.permissionDecision, "deny", "documenting the token must not bypass");
  } finally {
    r.cleanup();
  }
});

// A `commit -F -` with no ack anywhere must still deny — the new scan widens
// where the marker is looked for, not whether one is required.
test("docs-sync: `commit -F -` without an ack still denies", () => {
  const r = repo({ "plugins/p/scripts/a.mjs": "x", "plugins/p/README.md": "d" }, [
    "plugins/p/scripts/a.mjs",
  ]);
  try {
    const cmd = "git commit -F - <<'EOF'\nfeat(p): real behaviour change\nEOF";
    const d = parseDecision(run(bash(cmd, r.root)).stdout);
    assert.equal(d.permissionDecision, "deny");
  } finally {
    r.cleanup();
  }
});

test("docs-sync: the deny reason says where the marker must go", () => {
  const r = repo({ "plugins/p/scripts/a.mjs": "x", "plugins/p/README.md": "d" }, [
    "plugins/p/scripts/a.mjs",
  ]);
  try {
    const d = parseDecision(run(bash("git commit -m x", r.root)).stdout);
    assert.match(d.permissionDecisionReason, /heredoc/i, "must explain heredoc placement");
  } finally {
    r.cleanup();
  }
});

test("docs-sync: a real commit AFTER a heredoc terminator still denies", () => {
  // Guard against over-correction: stripping the body must not swallow the
  // commands that follow it.
  const r = repo({ "src/main.js": "x", "README.md": "d" }, ["src/main.js"]);
  try {
    const cmd = "cat <<EOF\nhello\nEOF\ngit commit -m x";
    const d = parseDecision(run(bash(cmd, r.root)).stdout);
    assert.equal(d.permissionDecision, "deny");
    assert.match(d.permissionDecisionReason, /src\/main\.js/);
  } finally {
    r.cleanup();
  }
});

test("docs-sync: a quoted CODE path with spaces is still caught", () => {
  // Guard against over-correction: fixing the split must not make the gate blind
  // to real code whose path happens to contain a space.
  const r = repo({ "My Code/app.js": "x", "README.md": "d" }, []);
  try {
    const cmd = 'git add "My Code/app.js" && git commit -m "x"';
    const d = parseDecision(run(bash(cmd, r.root)).stdout);
    assert.equal(d.permissionDecision, "deny");
    assert.match(d.permissionDecisionReason, /My Code\/app\.js/);
  } finally {
    r.cleanup();
  }
});
