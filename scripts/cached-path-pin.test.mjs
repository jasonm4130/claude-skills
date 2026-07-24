// @ts-check
// scripts/cached-path-pin.test.mjs
//
// Guards every *cached-path resolution snippet* a skill hands to the agent —
// workflows AND versioned assets (visual-plan resolves assets/plan.css, not a
// workflow). `${CLAUDE_PLUGIN_ROOT}` is unavailable in model scope, so these
// snippets address the plugin cache by literal path. Two ways that goes wrong:
//
//   1. Selecting the highest *cached* version (`sort -V | tail -1`). Cache
//      presence is not activation state — superseded and rolled-back versions
//      stay on disk (marked `.orphaned_at`), so a rollback never takes effect
//      and a SKILL.md of version N can drive a script of version M. The args
//      contract moves across versions, so this degrades semantically instead
//      of crashing.
//   2. Hardcoding the marketplace id. A marketplace rename breaks every
//      resolver at once, silently, at run time.
//
// The pinned version must come from the **resolved** plugin's manifest, never
// the owning skill's: plugins/adr (0.1.0) resolves subagent-driven-development
// (0.5.0), and pinning adr's own version would produce a path that cannot exist.
//
// Bumping any plugin version invalidates the literal pins here by construction.
// That is deliberate — the version bump task re-pins and re-runs this file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const marketplace = JSON.parse(
  readFileSync(join(root, ".claude-plugin", "marketplace.json"), "utf8"),
);

/**
 * @param {string} name
 * @returns {string | null} the plugin's declared version, or null if absent
 */
function pluginVersion(name) {
  try {
    return JSON.parse(
      readFileSync(join(root, "plugins", name, ".claude-plugin", "plugin.json"), "utf8"),
    ).version;
  } catch {
    return null;
  }
}

/**
 * Every SKILL.md shipped by a plugin.
 * @returns {string[]} absolute paths
 */
function skillFiles() {
  /** @type {string[]} */
  const found = [];
  /** @param {string} dir */
  const walk = (dir) => {
    /** @type {import("node:fs").Dirent[]} */
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "SKILL.md") found.push(p);
    }
  };
  for (const d of readdirSync(join(root, "plugins"), { withFileTypes: true })) {
    if (d.isDirectory()) walk(join(root, "plugins", d.name, "skills"));
  }
  return found.sort();
}

// <marketplace-id>/<plugin>/<version>/ — the three segments after the cache root.
const CACHE_RE = /\.claude\/plugins\/cache\/([^/\s"'`)]+)\/([^/\s"'`)]+)\/([^/\s"'`)]+)\//g;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
// Fenced code blocks, so the loud-fail check below can anchor to the specific
// snippet that pins a cached path instead of scanning the whole file — prose
// elsewhere in the doc can contain "missing" without any guard existing.
const FENCE_RE = /```[a-zA-Z]*\n([\s\S]*?)```/g;

/**
 * The fenced code blocks in `content` that contain a cached-path reference.
 * @param {string} content
 * @returns {string[]}
 */
function cachePathSnippets(content) {
  /** @type {string[]} */
  const snippets = [];
  for (const [, body] of content.matchAll(FENCE_RE)) {
    if (new RegExp(CACHE_RE.source).test(body)) snippets.push(body);
  }
  return snippets;
}

/** @type {Array<{ file: string, marketplaceId: string, plugin: string, version: string }>} */
const refs = [];
/** @type {Array<{ file: string, content: string }>} */
const filesWithRefs = [];

for (const file of skillFiles()) {
  const content = readFileSync(file, "utf8");
  const rel = relative(root, file);
  const matches = [...content.matchAll(CACHE_RE)];
  if (matches.length === 0) continue;
  filesWithRefs.push({ file: rel, content });
  for (const [, marketplaceId, plugin, version] of matches) {
    refs.push({ file: rel, marketplaceId, plugin, version });
  }
}

test("the scan finds the known cached-path resolvers", () => {
  const files = filesWithRefs.map((f) => f.file);
  for (const expected of [
    "plugins/adr/skills/adr/SKILL.md",
    "plugins/deep-dive/skills/deep-dive/SKILL.md",
    "plugins/visual-plan/skills/visual-plan/SKILL.md",
    "plugins/subagent-driven-development/skills/subagent-driven-development/SKILL.md",
  ]) {
    assert.ok(
      files.includes(expected),
      `${expected} has no cached-path snippet — did the scan break, or was the resolver removed?`,
    );
  }
});

test("every cached-path snippet uses the marketplace id from marketplace.json", () => {
  for (const ref of refs) {
    assert.equal(
      ref.marketplaceId,
      marketplace.name,
      `${ref.file}: cached path uses marketplace id "${ref.marketplaceId}", ` +
        `expected "${marketplace.name}" (from .claude-plugin/marketplace.json)`,
    );
  }
});

test("every cached-path snippet pins the resolved plugin's exact version", () => {
  for (const ref of refs) {
    const expected = pluginVersion(ref.plugin);
    assert.ok(
      expected !== null,
      `${ref.file}: cached path resolves plugin "${ref.plugin}", which has no ` +
        `plugins/${ref.plugin}/.claude-plugin/plugin.json`,
    );
    assert.match(
      ref.version,
      SEMVER_RE,
      `${ref.file}: cached path for "${ref.plugin}" uses version segment ` +
        `"${ref.version}" — must be an exact semver, not a glob or range`,
    );
    assert.equal(
      ref.version,
      expected,
      `${ref.file}: cached path pins ${ref.plugin} ${ref.version}, but ` +
        `plugins/${ref.plugin}/.claude-plugin/plugin.json declares ${expected}. ` +
        `Pin the RESOLVED plugin's version, and re-pin whenever it is bumped.`,
    );
  }
});

test("no cached-path snippet selects a version by highest-cached", () => {
  for (const { file, content } of filesWithRefs) {
    const offender = content
      .split("\n")
      .find((line) => /sort\s+-V/.test(line) || /\bls\s+-d\b.*\*/.test(line));
    assert.equal(
      offender,
      undefined,
      `${file}: resolves a cached path by highest cached version:\n  ${offender}\n` +
        `Cache presence is not activation state — orphaned and rolled-back versions ` +
        `remain on disk. Pin the version and fail loudly when it is absent.`,
    );
  }
});

test("a missing pinned version fails loudly instead of falling back", () => {
  for (const { file, content } of filesWithRefs) {
    const snippets = cachePathSnippets(content);
    assert.ok(
      snippets.length > 0,
      `${file}: has a cached-path reference outside any fenced code block — ` +
        `cannot verify the loud-fail guard sits next to it.`,
    );
    for (const snippet of snippets) {
      assert.match(
        snippet,
        /\[\s*-f\s+"?\$\w+"?\s*\]/,
        `${file}: cached-path snippet never tests for the pinned path's existence ` +
          `(expected a \`[ -f "$P" ]\`-style guard in the same fenced block):\n${snippet}`,
      );
      assert.match(
        snippet,
        /MISSING:/,
        `${file}: cached-path snippet never emits a literal \`MISSING:\` message when ` +
          `the pinned version is absent. A silent fallback to another cached version is ` +
          `the bug this pin exists to prevent:\n${snippet}`,
      );
    }
  }
});

test("the handoff statusLine wrapper uses the marketplace id from marketplace.json", () => {
  // setup.mjs builds the cache path with path.join(), so it carries the id as a
  // bare string rather than a slash-joined literal the regex above can see.
  const setup = readFileSync(join(root, "plugins", "handoff", "scripts", "setup.mjs"), "utf8");
  assert.ok(
    setup.includes(marketplace.name),
    `plugins/handoff/scripts/setup.mjs does not reference the marketplace id ` +
      `"${marketplace.name}" — a rename would break the generated statusLine wrapper.`,
  );
});
