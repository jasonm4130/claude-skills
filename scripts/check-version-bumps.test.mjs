// @ts-check
// Tests for scripts/check-version-bumps.mjs — the CI gate that fails a branch whose
// shipped plugin content changed without a strict semver version increase.
// Each test builds a real throwaway git repo: a base commit, then a branch commit,
// and calls checkVersionBumps({ cwd, baseRef }) directly (no child process).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkVersionBumps } from "./check-version-bumps.mjs";

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** Create a repo with an empty root commit; returns its path. */
function initRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), "cvb-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@t.test"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["commit", "-q", "--allow-empty", "-m", "root"]);
  return root;
}

/** @param {string} root @param {Record<string,string>} files */
function write(root, files) {
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    writeFileSync(path.join(root, p), content);
  }
}

/** Stage everything and commit; returns the new HEAD sha.
 * @param {string} root @param {string} msg */
function commit(root, msg) {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", msg]);
  return git(root, ["rev-parse", "HEAD"]);
}

/** @param {string} version */
const pj = (version) => JSON.stringify({ name: "foo", version }, null, 2) + "\n";

/**
 * Build base state, capture base sha, apply branch state, return { root, base }.
 * @param {Record<string,string>} baseFiles
 * @param {Record<string,string>} branchFiles
 */
function scenario(baseFiles, branchFiles) {
  const root = initRepo();
  write(root, baseFiles);
  const base = commit(root, "base");
  write(root, branchFiles);
  commit(root, "branch");
  return { root, base, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Names of plugins flagged as violating.
 * @param {string} root @param {string} base */
function violated(root, base) {
  return checkVersionBumps({ cwd: root, baseRef: base }).violations.map((v) => v.plugin);
}

// ---- the core failure this whole change exists to stop ----

test("content changed + version bumped → pass", () => {
  const s = scenario(
    { "plugins/foo/.claude-plugin/plugin.json": pj("0.1.0"), "plugins/foo/skills/s/SKILL.md": "v1" },
    { "plugins/foo/.claude-plugin/plugin.json": pj("0.2.0"), "plugins/foo/skills/s/SKILL.md": "v2" },
  );
  try {
    assert.deepEqual(violated(s.root, s.base), []);
  } finally {
    s.cleanup();
  }
});

test("content changed + version UNCHANGED → fail (the PR #51 bug)", () => {
  const s = scenario(
    { "plugins/foo/.claude-plugin/plugin.json": pj("0.1.0"), "plugins/foo/skills/s/SKILL.md": "v1" },
    { "plugins/foo/skills/s/SKILL.md": "v2" },
  );
  try {
    assert.deepEqual(violated(s.root, s.base), ["foo"]);
  } finally {
    s.cleanup();
  }
});

test("content changed + version DOWNGRADED → fail", () => {
  const s = scenario(
    { "plugins/foo/.claude-plugin/plugin.json": pj("0.2.0"), "plugins/foo/skills/s/SKILL.md": "v1" },
    { "plugins/foo/.claude-plugin/plugin.json": pj("0.1.9"), "plugins/foo/skills/s/SKILL.md": "v2" },
  );
  try {
    assert.deepEqual(violated(s.root, s.base), ["foo"]);
  } finally {
    s.cleanup();
  }
});

// ---- deny-list surface: non-standard shipped dirs must count ----

test("change in a non-standard shipped dir (prompts/) without a bump → fail", () => {
  const s = scenario(
    { "plugins/foo/.claude-plugin/plugin.json": pj("0.1.0"), "plugins/foo/prompts/x.md": "v1" },
    { "plugins/foo/prompts/x.md": "v2" },
  );
  try {
    assert.deepEqual(violated(s.root, s.base), ["foo"]);
  } finally {
    s.cleanup();
  }
});

test("change in assets/ or references/ without a bump → fail", () => {
  const s = scenario(
    { "plugins/foo/.claude-plugin/plugin.json": pj("0.1.0"), "plugins/foo/assets/a.css": "a{}" },
    { "plugins/foo/assets/a.css": "a{color:red}" },
  );
  try {
    assert.deepEqual(violated(s.root, s.base), ["foo"]);
  } finally {
    s.cleanup();
  }
});

// ---- exemptions ----

test("brand-new plugin (no base plugin.json) → exempt", () => {
  const s = scenario(
    { "README.md": "root" },
    {
      "plugins/new/.claude-plugin/plugin.json": pj("0.1.0"),
      "plugins/new/skills/s/SKILL.md": "hello",
    },
  );
  try {
    assert.deepEqual(violated(s.root, s.base), []);
  } finally {
    s.cleanup();
  }
});

test("tests-only change → exempt", () => {
  const s = scenario(
    { "plugins/foo/.claude-plugin/plugin.json": pj("0.1.0"), "plugins/foo/tests/x.test.mjs": "t1" },
    { "plugins/foo/tests/x.test.mjs": "t2" },
  );
  try {
    assert.deepEqual(violated(s.root, s.base), []);
  } finally {
    s.cleanup();
  }
});

test("a *.test.mjs beside a skill → exempt", () => {
  const s = scenario(
    { "plugins/foo/.claude-plugin/plugin.json": pj("0.1.0"), "plugins/foo/skills/s/skill.test.mjs": "t1" },
    { "plugins/foo/skills/s/skill.test.mjs": "t2" },
  );
  try {
    assert.deepEqual(violated(s.root, s.base), []);
  } finally {
    s.cleanup();
  }
});

test("plugin-root README/CLAUDE only → exempt", () => {
  const s = scenario(
    { "plugins/foo/.claude-plugin/plugin.json": pj("0.1.0"), "plugins/foo/README.md": "d1" },
    { "plugins/foo/README.md": "d2" },
  );
  try {
    assert.deepEqual(violated(s.root, s.base), []);
  } finally {
    s.cleanup();
  }
});

test("plugin metadata (.claude-plugin) only → exempt", () => {
  const s = scenario(
    { "plugins/foo/.claude-plugin/plugin.json": pj("0.1.0") },
    { "plugins/foo/.claude-plugin/plugin.json": JSON.stringify({ name: "foo", version: "0.1.0", keywords: ["x"] }, null, 2) + "\n" },
  );
  try {
    assert.deepEqual(violated(s.root, s.base), []);
  } finally {
    s.cleanup();
  }
});

// ---- multi-plugin + no-op ----

test("two plugins, one bumped one not → fails naming only the unbumped", () => {
  const s = scenario(
    {
      "plugins/foo/.claude-plugin/plugin.json": pj("0.1.0"), "plugins/foo/skills/s/SKILL.md": "v1",
      "plugins/bar/.claude-plugin/plugin.json": pj("0.1.0"), "plugins/bar/skills/s/SKILL.md": "v1",
    },
    {
      "plugins/foo/.claude-plugin/plugin.json": pj("0.2.0"), "plugins/foo/skills/s/SKILL.md": "v2",
      "plugins/bar/skills/s/SKILL.md": "v2",
    },
  );
  try {
    assert.deepEqual(violated(s.root, s.base), ["bar"]);
  } finally {
    s.cleanup();
  }
});

test("no plugin changes at all → pass", () => {
  const s = scenario(
    { "README.md": "a", "scripts/tool.mjs": "x" },
    { "README.md": "b", "scripts/tool.mjs": "y" },
  );
  try {
    assert.deepEqual(violated(s.root, s.base), []);
  } finally {
    s.cleanup();
  }
});

test("unparseable version at HEAD → fail", () => {
  const s = scenario(
    { "plugins/foo/.claude-plugin/plugin.json": pj("0.1.0"), "plugins/foo/skills/s/SKILL.md": "v1" },
    { "plugins/foo/.claude-plugin/plugin.json": pj("latest"), "plugins/foo/skills/s/SKILL.md": "v2" },
  );
  try {
    assert.deepEqual(violated(s.root, s.base), ["foo"]);
  } finally {
    s.cleanup();
  }
});
