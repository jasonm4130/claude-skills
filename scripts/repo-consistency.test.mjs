// @ts-check
// scripts/repo-consistency.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const marketplace = JSON.parse(
  readFileSync(join(root, ".claude-plugin", "marketplace.json"), "utf8"),
);
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

  const offenders = [];
  for (const d of dirs) {
    let files = [];
    try {
      files = readdirSync(join(root, "plugins", d, "scripts"), { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".mjs") && !e.name.endsWith(".test.mjs"))
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const f of files) {
      // Only text the script actually EMITS counts. Comments routinely discuss
      // the bare name (including the ones explaining this very bug), and a
      // comment is never handed to the agent.
      const src = readFileSync(join(root, "plugins", d, "scripts", f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*)/.test(l))
        .join("\n");
      for (const [skill, owner] of skillOwner) {
        // "the <skill> skill" / "run <skill> skill" with no "<plugin>:" prefix.
        const bare = new RegExp(`(?<![\\w:-])${skill}\\s+skill\\b`, "i");
        if (bare.test(src)) offenders.push(`${d}/scripts/${f}: "${skill} skill" → "${owner}:${skill}"`);
      }
    }
  }
  assert.deepEqual(offenders, [], `unqualified skill names in hook output:\n${offenders.join("\n")}`);
});
