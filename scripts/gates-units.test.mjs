// @ts-check
// Repo invariant: `gates` is a bundle of independently installable units.
//
// Each guard family installs on its own, so a user who wants the Agent model
// guard is not also handed the docs commit gate and the consolidation trigger.
// `gates` itself ships nothing but a `dependencies` list, which keeps
// `gates@jasonm4130-claude-skills` installing the whole set for anyone who had
// it before the split.
//
// The table below is the contract: every hook the pre-split plugin registered
// lands in exactly one unit, and no unit registers anything the table does not
// name. Moving a hook between units, or adding one, is an edit here first.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** unit → "Event matcher" keys its hooks.json must register, and nothing else. */
const UNITS = {
  "gates-docs": ["PreToolUse Bash", "Stop *", "UserPromptSubmit *"],
  "gates-models": ["PreToolUse Workflow", "PreToolUse Agent"],
  "gates-config": ["PostToolUse Edit|Write|MultiEdit|Bash"],
  "gates-signing": ["PostToolUseFailure Bash"],
};

/** @param {string} rel */
const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), "utf8"));

/** @param {string} plugin @returns {string[]} */
function hookKeys(plugin) {
  const rel = `plugins/${plugin}/hooks/hooks.json`;
  if (!existsSync(join(root, rel))) return [];
  const { hooks } = readJson(rel);
  return Object.entries(hooks).flatMap(([event, groups]) =>
    /** @type {{ matcher?: string }[]} */ (groups).map((g) => `${event} ${g.matcher ?? "*"}`),
  );
}

test("the gates bundle ships only dependencies on the units", () => {
  const manifest = readJson("plugins/gates/.claude-plugin/plugin.json");
  assert.deepEqual([...manifest.dependencies].sort(), Object.keys(UNITS).sort());
  const shipped = readdirSync(join(root, "plugins/gates")).filter(
    (f) => ![".claude-plugin", "README.md", "CLAUDE.md"].includes(f),
  );
  assert.deepEqual(shipped, [], "the bundle carries components; move them into a unit");
});

test("every unit is registered in the marketplace", () => {
  const names = readJson(".claude-plugin/marketplace.json").plugins.map((/** @type {any} */ p) => p.name);
  for (const unit of Object.keys(UNITS)) assert.ok(names.includes(unit), `${unit} is not in marketplace.json`);
});

for (const [unit, keys] of Object.entries(UNITS)) {
  test(`${unit} registers exactly its own hooks`, () => {
    assert.deepEqual(hookKeys(unit).sort(), [...keys].sort());
  });
}

test("both units that run ccguard ship the same binary", () => {
  const models = readFileSync(join(root, "plugins/gates-models/bin/ccguard"));
  const config = readFileSync(join(root, "plugins/gates-config/bin/ccguard"));
  assert.ok(models.equals(config), "rebuild with plugins/gates-config/go/build.sh, which writes both copies");
});
