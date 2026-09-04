// @ts-check
// scripts/repo-consistency.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

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
  // the compiled ones (go/*.go, shipped as plugins/*/bin/ccguard) build their
  // reason strings in source, so scanning only .mjs would leave the compiled
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
  // Deliberately NOT wrapped in a try/catch that shrugs off a missing directory.
  // The previous version did, so when the crate moved the scan would simply have
  // stopped covering the compiled guards — passing green while checking less. If
  // plugins/gates/go/ is gone or renamed, this must fail and be fixed, not quietly narrow.
  const goSources = readdirSync(join(root, "plugins", "gates", "go"), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".go") && !e.name.endsWith("_test.go"))
    .map((e) => e.name);
  assert.ok(
    goSources.length > 0,
    "found no plugins/gates/go/*.go sources to scan — the compiled guards emit hook text too, so this " +
      "check must cover them; if the module moved, update this path rather than deleting it",
  );
  for (const name of goSources) {
    sources.push({ label: `go/${name}`, path: join(root, "plugins", "gates", "go", name) });
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
  // The WHOLE plugins/<name>/ tree is copied into the install cache — README.md,
  // CLAUDE.md and tests/ included (verified against a real cache directory). So a
  // shipped file pointing at docs/, a repo-root RESEARCH_*.md, or another repo is
  // a dead end for everyone who installed the plugin rather than cloning it.
  //
  // Deliberately NOT check-version-bumps.mjs's isExempt(): that answers a
  // different question — "does changing this file require a version bump?" — and
  // its exemptions (README/CLAUDE/tests) are all things that ship. Reusing it here
  // silently skipped the files carrying most of the repo's provenance citations.
  const TEXT = /\.(md|mjs|js|cjs|sh|json|txt|rs)$/i;

  /** @param {string} dir @returns {{label:string,path:string}[]} */
  function walk(dir) {
    const out = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(abs));
      else if (e.isFile() && TEXT.test(e.name)) out.push({ label: relative(root, abs), path: abs });
    }
    return out;
  }

  const files = dirs.flatMap((d) => walk(join(root, "plugins", d)));
  assert.ok(files.length > 0, "found no shipped files to check — the walk is broken");

  // A citation names one concrete existing file; an instruction names a template
  // ("save plans to docs/superpowers/plans/YYYY-MM-DD-<name>.md"). Requiring a
  // real ISO date in the filename separates them without an allowlist to maintain.
  // The optional prefix catches ./docs/…, ../../docs/… and plugins/<name>/docs/…,
  // which are the same defect wearing a different path.
  const PREFIX = String.raw`(?:(?:\.{1,2}\/)+|plugins\/[\w-]+\/)?`;
  // `mustExist` distinguishes a citation from test data. A citation names a file
  // that exists HERE and won't in the cache; a synthetic fixture path
  // (sdd.test.mjs's "docs/adr/2026-06-27-x.md") resolves nowhere and is not a
  // reference anyone can follow. Paths into another repo can't be resolved from
  // here at all, so that pattern skips the check.
  /** @type {{re: RegExp, why: string, mustExist: boolean}[]} */
  const PATTERNS = [
    { re: new RegExp(`(?<![\\w-])${PREFIX}docs\\/[\\w/-]*\\d{4}-\\d{2}-\\d{2}-[\\w-]+\\.md`, "g"), why: "repo docs path", mustExist: true },
    { re: /(?<![\w/-])RESEARCH_[\w-]+\.md/g, why: "repo-root research doc", mustExist: true },
    { re: /(?<![\w/-])dotfiles\/[\w/-]+/g, why: "a different repo", mustExist: false },
  ];
  const stripRelative = (/** @type {string} */ p) => p.replace(/^(?:\.{1,2}\/)+/, "");

  // A github.com link to this repo is the sanctioned fix, so it must stay checkable
  // — blanket-stripping URLs would turn every fix into a reference nothing verifies
  // again, and the docs/plans → docs/research rename would have silently 404'd them.
  const REPO_BLOB = /https:\/\/github\.com\/jasonm4130\/claude-skills\/blob\/[^/\s]+\/([^\s)`"']+)/g;

  const offenders = [];
  for (const { label, path } of files) {
    let src = readFileSync(path, "utf8");

    for (const m of src.matchAll(REPO_BLOB)) {
      if (!existsSync(join(root, m[1]))) offenders.push(`${label}: ${m[1]} (github link to a path that no longer exists)`);
    }
    // Drop each whole `[label](url)` construct, not just the url — the label of a
    // correctly-linked citation names the file it points at, so stripping only the
    // url leaves the label behind to be re-flagged as a bare path.
    src = src.replace(/\[[^\]]*\]\(\s*https?:\/\/[^)]*\)/g, "");
    // Then any remaining bare URLs, so the patterns below don't match path
    // components inside them.
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
    for (const { re, why, mustExist } of PATTERNS) {
      for (const m of src.matchAll(re)) {
        if (mustExist && !existsSync(join(root, stripRelative(m[0])))) continue;
        offenders.push(`${label}: ${m[0]} (${why})`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `shipped files cite paths absent from the install cache — link to github.com instead:\n${offenders.join("\n")}`,
  );
});
