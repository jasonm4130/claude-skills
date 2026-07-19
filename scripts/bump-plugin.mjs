#!/usr/bin/env node
// @ts-check
// scripts/bump-plugin.mjs
//
// Bump a plugin's version in BOTH its plugin.json and the matching marketplace.json
// entry, in sync — so the two files never diverge (which repo-consistency.test.mjs
// would otherwise fail) and the CI version-bump-check is satisfied in one step.
//
//   node scripts/bump-plugin.mjs <plugin> <patch|minor|major>
//
// Edits are surgical string replacements of the version field only — the manifests
// are hand-formatted (inline objects), so a parse+reserialize would reformat them.

import process from "node:process";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LEVELS = new Set(["patch", "minor", "major"]);

/**
 * @param {string} v @param {string} level
 * @returns {string}
 */
function next(v, level) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`plugin version "${v}" is not a valid x.y.z`);
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (level === "major") (major += 1), (minor = 0), (patch = 0);
  else if (level === "minor") (minor += 1), (patch = 0);
  else patch += 1;
  return `${major}.${minor}.${patch}`;
}

/** @param {string} s */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace via `re` (which must capture the pre/post of the version literal) and
 * assert the substitution actually happened.
 * @param {string} raw @param {RegExp} re @param {string} version @param {string} label
 * @returns {string}
 */
function replaceVersion(raw, re, version, label) {
  const out = raw.replace(re, `$1${version}$2`);
  if (out === raw) throw new Error(`could not locate a version field to update in ${label}`);
  return out;
}

/**
 * @param {{ cwd: string, plugin: string, level: string }} opts
 * @returns {string} the new version
 */
export function bumpPlugin({ cwd, plugin, level }) {
  if (!LEVELS.has(level)) {
    throw new Error(`level must be patch|minor|major, got "${level}"`);
  }

  const pjPath = join(cwd, "plugins", plugin, ".claude-plugin", "plugin.json");
  let pjRaw;
  try {
    pjRaw = readFileSync(pjPath, "utf8");
  } catch {
    throw new Error(`unknown plugin "${plugin}": no ${pjPath}`);
  }
  const current = JSON.parse(pjRaw).version;
  const newVersion = next(current, level);

  // plugin.json has exactly one "version" field.
  writeFileSync(
    pjPath,
    replaceVersion(pjRaw, /("version"\s*:\s*")[^"]*(")/, newVersion, `plugin.json for ${plugin}`),
  );

  const mktPath = join(cwd, ".claude-plugin", "marketplace.json");
  const mktRaw = readFileSync(mktPath, "utf8");
  const registered = (JSON.parse(mktRaw).plugins || []).some(
    (/** @type {{ name: string }} */ p) => p.name === plugin,
  );
  if (!registered) throw new Error(`plugin "${plugin}" is not registered in marketplace.json`);
  // Target this plugin's entry: its "name" is unique, and its "version" is the first
  // version field after it (source/description carry no "version" key).
  const entryRe = new RegExp(
    `("name":\\s*"${escapeRe(plugin)}"[\\s\\S]*?"version":\\s*")[^"]*(")`,
  );
  writeFileSync(
    mktPath,
    replaceVersion(mktRaw, entryRe, newVersion, `marketplace entry for ${plugin}`),
  );

  return newVersion;
}

/** @returns {boolean} true when run as a script, not imported. */
function invokedDirectly() {
  try {
    return realpathSync(process.argv[1] || "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const [plugin, level] = process.argv.slice(2);
  if (!plugin || !level) {
    console.error("usage: node scripts/bump-plugin.mjs <plugin> <patch|minor|major>");
    process.exit(2);
  }
  try {
    const v = bumpPlugin({ cwd: process.cwd(), plugin, level });
    console.log(`${plugin} → ${v}  (plugin.json + marketplace.json)`);
  } catch (e) {
    console.error(`bump-plugin: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
