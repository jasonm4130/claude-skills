// @ts-check
// Tests for scripts/bump-plugin.mjs — bumps a plugin's version in BOTH its
// plugin.json and the matching marketplace.json entry, in sync.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bumpPlugin } from "./bump-plugin.mjs";

/** A repo root with plugins/foo at `version` and a marketplace entry to match.
 * @param {string} version */
function fixture(version) {
  const root = mkdtempSync(path.join(os.tmpdir(), "bump-"));
  mkdirSync(path.join(root, "plugins/foo/.claude-plugin"), { recursive: true });
  mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(
    path.join(root, "plugins/foo/.claude-plugin/plugin.json"),
    JSON.stringify({ name: "foo", description: "d", version }, null, 2) + "\n",
  );
  writeFileSync(
    path.join(root, ".claude-plugin/marketplace.json"),
    JSON.stringify(
      {
        name: "mkt",
        plugins: [
          { name: "aaa", source: "./plugins/aaa", version: "9.9.9" },
          { name: "foo", source: "./plugins/foo", version },
        ],
      },
      null,
      2,
    ) + "\n",
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** @param {string} root */
function versions(root) {
  const pj = JSON.parse(readFileSync(path.join(root, "plugins/foo/.claude-plugin/plugin.json"), "utf8"));
  const mkt = JSON.parse(readFileSync(path.join(root, ".claude-plugin/marketplace.json"), "utf8"));
  const entry = mkt.plugins.find((/** @type {{name:string}} */ p) => p.name === "foo");
  return { pj: pj.version, mkt: entry.version, other: mkt.plugins.find((/** @type {{name:string}} */ p) => p.name === "aaa").version };
}

test("patch bump updates both files in sync", () => {
  const f = fixture("0.1.0");
  try {
    const next = bumpPlugin({ cwd: f.root, plugin: "foo", level: "patch" });
    assert.equal(next, "0.1.1");
    assert.deepEqual(versions(f.root), { pj: "0.1.1", mkt: "0.1.1", other: "9.9.9" });
  } finally {
    f.cleanup();
  }
});

test("minor bump zeroes patch", () => {
  const f = fixture("0.1.3");
  try {
    assert.equal(bumpPlugin({ cwd: f.root, plugin: "foo", level: "minor" }), "0.2.0");
    assert.deepEqual(versions(f.root), { pj: "0.2.0", mkt: "0.2.0", other: "9.9.9" });
  } finally {
    f.cleanup();
  }
});

test("major bump zeroes minor and patch", () => {
  const f = fixture("1.4.2");
  try {
    assert.equal(bumpPlugin({ cwd: f.root, plugin: "foo", level: "major" }), "2.0.0");
  } finally {
    f.cleanup();
  }
});

test("unknown plugin throws", () => {
  const f = fixture("0.1.0");
  try {
    assert.throws(() => bumpPlugin({ cwd: f.root, plugin: "nope", level: "patch" }), /nope/);
  } finally {
    f.cleanup();
  }
});

test("invalid level throws", () => {
  const f = fixture("0.1.0");
  try {
    assert.throws(() => bumpPlugin({ cwd: f.root, plugin: "foo", level: "sideways" }));
  } finally {
    f.cleanup();
  }
});
