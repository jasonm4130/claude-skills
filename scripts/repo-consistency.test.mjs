// @ts-check
// scripts/repo-consistency.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { isExempt } from "./check-version-bumps.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const marketplace = JSON.parse(
  readFileSync(join(root, ".claude-plugin", "marketplace.json"), "utf8"),
);
/** @type {{name: string, source: string, version: string}[]} */
const entries = marketplace.plugins;
const dirs = readdirSync(join(root, "plugins"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

test("every plugins/ dir is registered in marketplace.json and vice versa", () => {
  assert.deepEqual(entries.map((e) => e.name).sort(), [...dirs].sort());
});

test("every marketplace source points at ./plugins/<name>", () => {
  for (const e of entries) assert.equal(e.source, `./plugins/${e.name}`);
});

test("marketplace version matches each plugin.json version", () => {
  for (const e of entries) {
    const pj = JSON.parse(
      readFileSync(join(root, "plugins", e.name, ".claude-plugin", "plugin.json"), "utf8"),
    );
    assert.equal(
      e.version,
      pj.version,
      `${e.name}: marketplace ${e.version} != plugin.json ${pj.version}`,
    );
  }
});

test("README documents every plugin", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  for (const e of entries) {
    assert.ok(readme.includes("`" + e.name + "`"), `README missing ${e.name}`);
  }
});

test("plugin READMEs' install commands use the marketplace id", () => {
  const installRe = /\/plugin install ([\w-]+)@([\w.-]+)/g;
  for (const name of dirs) {
    const readmePath = join(root, "plugins", name, "README.md");
    let content;
    try {
      content = readFileSync(readmePath, "utf8");
    } catch {
      continue;
    }
    for (const [, pluginName, id] of content.matchAll(installRe)) {
      assert.equal(
        id,
        marketplace.name,
        `plugins/${name}/README.md: install command for ${pluginName} uses @${id}, expected @${marketplace.name}`,
      );
    }
  }
});

test("plugin READMEs' marketplace add commands point at the repo, not a plugin name", () => {
  const marketplaceAddRe = /\/plugin marketplace add ([\w.-]+\/[\w.-]+)/g;
  const expectedRepo = "jasonm4130/claude-skills";
  for (const name of dirs) {
    const readmePath = join(root, "plugins", name, "README.md");
    let content;
    try {
      content = readFileSync(readmePath, "utf8");
    } catch {
      continue;
    }
    for (const [, repo] of content.matchAll(marketplaceAddRe)) {
      assert.equal(
        repo,
        expectedRepo,
        `plugins/${name}/README.md: marketplace add command uses ${repo}, expected ${expectedRepo}`,
      );
    }
  }
});

// A hook fires correctly and then emits an instruction the agent cannot execute.
// This bug class has now shipped twice: session-retro's nudge said "Run the retro
// skill" and the agent called `Skill(retro)` → "Unknown skill: retro" four times,
// never once recovering; handoff's said "run the handoff skill". A bare name is a
// name the model has to guess, and across an audit of 8 used skills it guessed
// wrong in 4 of them. Every skill a hook names must be plugin-qualified.
test("hook-emitted skill references are plugin-qualified", () => {
  const skillOwner = new Map();
  for (const d of dirs) {
    let skills = [];
    try {
      skills = readdirSync(join(root, "plugins", d, "skills"), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue; // hooks-only plugin
    }
    for (const s of skills) skillOwner.set(s, d);
  }
  assert.ok(skillOwner.size > 0, "found no skills to check — the walk is broken");

  // Every source file that can EMIT hook text. Both the interpreted guards and
  // the compiled ones (rust/src/*.rs, shipped as plugins/*/bin/ccguard) build
  // their reason strings in source, so scanning only .mjs would leave the Rust
  // reasons unguarded — and those are the ones that actually run now.
  const sources = [];
  for (const d of dirs) {
    let files = [];
    try {
      files = readdirSync(join(root, "plugins", d, "scripts"), { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".mjs") && !e.name.endsWith(".test.mjs"))
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const f of files) sources.push({ label: `${d}/scripts/${f}`, path: join(root, "plugins", d, "scripts", f) });
  }
  try {
    for (const e of readdirSync(join(root, "rust", "src"), { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith(".rs")) {
        sources.push({ label: `rust/src/${e.name}`, path: join(root, "rust", "src", e.name) });
      }
    }
  } catch {
    // no rust crate — fine, the .mjs guards are the whole surface.
  }

  const offenders = [];
  for (const { label, path } of sources) {
    // Only text the source actually EMITS counts. Comments routinely discuss the
    // bare name (including the ones explaining this very bug), and a comment is
    // never handed to the agent. The line filter catches `//`, `///`, `//!` and
    // block-comment continuations, so it covers both languages.
    const src = readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join("\n");
    for (const [skill, owner] of skillOwner) {
      // "the <skill> skill" / "run <skill> skill" with no "<plugin>:" prefix.
      const bare = new RegExp(`(?<![\\w:-])${skill}\\s+skill\\b`, "i");
      if (bare.test(src)) offenders.push(`${label}: "${skill} skill" → "${owner}:${skill}"`);
    }
  }
  assert.deepEqual(offenders, [], `unqualified skill names in hook output:\n${offenders.join("\n")}`);
});

test("shipped plugin files cite no path outside their own payload", () => {
  // Only plugins/<name>/ is copied into the install cache. A shipped file that
  // points at docs/, RESEARCH_*.md at the repo root, or another repo entirely is
  // a dead end for everyone who installed the plugin rather than cloned the repo.
  // Provenance still belongs in the text — as a github.com URL, which resolves
  // for both audiences.
  const TEXT = /\.(md|mjs|js|cjs|sh|json|txt|rs)$/i;

  /** @param {string} dir @param {string} base @returns {{label:string,path:string}[]} */
  function walk(dir, base) {
    const out = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(abs, base));
      else if (e.isFile() && TEXT.test(e.name)) {
        const rel = relative(base, abs).split(sep).join("/");
        if (!isExempt(rel)) out.push({ label: `${relative(root, abs)}`, path: abs });
      }
    }
    return out;
  }

  const files = dirs.flatMap((d) => walk(join(root, "plugins", d), join(root, "plugins", d)));
  assert.ok(files.length > 0, "found no shipped files to check — the walk is broken");

  // A citation names one concrete existing file; an instruction names a template
  // ("save plans to docs/superpowers/plans/YYYY-MM-DD-<name>.md"). Requiring a
  // real ISO date in the filename separates them without an allowlist to maintain.
  /** @type {[RegExp, string][]} */
  const PATTERNS = [
    [/(?<![\w/-])(?:\.\.\/)*docs\/[\w/-]*\d{4}-\d{2}-\d{2}-[\w-]+\.md/g, "repo docs path"],
    [/(?<![\w/-])RESEARCH_[\w-]+\.md/g, "repo-root research doc"],
    [/(?<![\w/-])dotfiles\/[\w/-]+/g, "a different repo"],
  ];

  const offenders = [];
  for (const { label, path } of files) {
    let src = readFileSync(path, "utf8");
    // Anything inside a URL already resolves for installed users — that is the fix,
    // not the defect, so drop URLs before scanning.
    src = src.replace(/https?:\/\/\S+/g, "");
    // In code, only emitted text reaches the agent; comments are dev-facing.
    // Markdown is model-facing in full, so it is scanned whole. Same reasoning as
    // the skill-qualification test above.
    if (!label.endsWith(".md")) {
      src = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|#)/.test(l))
        .join("\n");
    }
    for (const [re, why] of PATTERNS) {
      for (const m of src.matchAll(re)) offenders.push(`${label}: ${m[0]} (${why})`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `shipped files cite paths absent from the install cache — link to github.com instead:\n${offenders.join("\n")}`,
  );
});
