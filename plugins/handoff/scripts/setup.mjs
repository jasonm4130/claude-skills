#!/usr/bin/env node
// @ts-check
// One-time wiring helper: patches ~/.claude/settings.json so the handoff
// status-and-flag.mjs script renders as Claude Code's statusLine.
//
// This script also writes a stable wrapper (~/.claude/handoff-statusline.mjs)
// that resolves the installed plugin version at run time, so upgrading the
// plugin never breaks the statusLine. See WRAPPER_CONTENT for the exact
// upgrade/rollback contract.
//
// Usage:
//   node /path/to/plugins/handoff/scripts/setup.mjs [--force]
//
// --force overwrites an existing statusLine without prompting.
//
// Test seam: set CLAUDE_HOME_OVERRIDE to an absolute path to redirect all
// reads/writes away from the real ~/.claude directory.

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";

const homedir = os.homedir();
// Allow tests (and dry-run usage) to redirect writes to a temp dir
const claudeDir =
  typeof process.env.CLAUDE_HOME_OVERRIDE === "string" &&
  process.env.CLAUDE_HOME_OVERRIDE.length > 0
    ? process.env.CLAUDE_HOME_OVERRIDE
    : path.join(homedir, ".claude");

const settingsPath = path.join(claudeDir, "settings.json");
const backupPath = path.join(claudeDir, "settings.json.pre-handoff.bak");
const wrapperPath = path.join(claudeDir, "handoff-statusline.mjs");

const args = new Set(process.argv.slice(2));
const force = args.has("--force");

// ---------------------------------------------------------------------------
// Stable wrapper content — this script is written to ~/.claude/handoff-statusline.mjs
// and pointed to by the statusLine command.
//
// Upgrade/rollback contract: run the highest cached version that Claude Code has
// NOT marked `.orphaned_at`. Resolution has to stay dynamic — ~/.claude/settings.json
// points at this wrapper by absolute path, so pinning a literal version here would
// break the statusLine on every upgrade. But "highest cached" alone is wrong: cache
// presence is not activation state. Superseded and rolled-back versions stay on disk
// carrying an `.orphaned_at` marker, so an unfiltered max would silently undo a
// rollback. Filtering on the marker keeps upgrades working and makes rollbacks stick.
// ---------------------------------------------------------------------------
const WRAPPER_CONTENT = `#!/usr/bin/env node
// @ts-check
// Stable statusLine wrapper for the handoff plugin.
// Resolves the highest NON-ORPHANED cached semver of jasonm4130-claude-skills/handoff,
// so upgrading the plugin never breaks the statusLine and a rollback actually takes
// effect. Written by: plugins/handoff/scripts/setup.mjs
// Do not edit by hand — re-run setup.mjs to regenerate.

import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { spawn } from "node:child_process";

/** @param {string} v @returns {[number, number, number] | null} */
function parseSemver(v) {
  const m = /^(\\d+)\\.(\\d+)\\.(\\d+)(?:[\\.-].*)?$/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 * @returns {number}
 */
function cmpSemver(a, b) {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

// Allow CLAUDE_HOME_OVERRIDE for testing (same seam used by setup.mjs)
const claudeDir =
  typeof process.env.CLAUDE_HOME_OVERRIDE === "string" &&
  process.env.CLAUDE_HOME_OVERRIDE.length > 0
    ? process.env.CLAUDE_HOME_OVERRIDE
    : path.join(os.homedir(), ".claude");

const cacheDir = path.join(
  claudeDir,
  "plugins",
  "cache",
  "jasonm4130-claude-skills",
  "handoff",
);

/** @type {string | null} */
let resolvedScript = null;

if (existsSync(cacheDir)) {
  /** @type {Array<{ version: [number, number, number], scriptPath: string }>} */
  const candidates = [];
  let entries;
  try {
    entries = readdirSync(cacheDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const parsed = parseSemver(entry.name);
    if (!parsed) continue;
    // Claude Code marks every superseded / rolled-back / uninstalled cache dir
    // with .orphaned_at and leaves it on disk. Skipping them is what makes this
    // "the installed version" rather than "whatever version is newest on disk".
    // ponytail: infers activation state from an undocumented marker file; if the
    // convention changes, read ~/.claude/plugins/installed_plugins.json instead.
    if (existsSync(path.join(cacheDir, entry.name, ".orphaned_at"))) continue;
    const candidate = path.join(cacheDir, entry.name, "scripts", "status-and-flag.mjs");
    if (existsSync(candidate)) {
      candidates.push({ version: parsed, scriptPath: candidate });
    }
  }
  if (candidates.length > 0) {
    candidates.sort((a, b) => cmpSemver(a.version, b.version));
    resolvedScript = candidates[candidates.length - 1].scriptPath;
  }
}

if (!resolvedScript) {
  process.stdout.write("?\\n");
  process.exit(0);
}

const child = spawn(process.execPath, [resolvedScript], { stdio: "inherit" });
child.on("error", () => {
  process.stdout.write("?\\n");
  process.exit(0);
});
child.on("close", (code) => {
  process.exit(code ?? 0);
});
`;

// ---------------------------------------------------------------------------
// Ensure ~/.claude exists
// ---------------------------------------------------------------------------
try {
  mkdirSync(claudeDir, { recursive: true });
} catch (err) {
  console.error(`Could not create ${claudeDir}: ${/** @type {any} */ (err).message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Write wrapper (idempotent: skip if identical)
// ---------------------------------------------------------------------------
let wrapperNeedsWrite = true;
if (existsSync(wrapperPath)) {
  try {
    const existing = readFileSync(wrapperPath, "utf8");
    if (existing === WRAPPER_CONTENT) wrapperNeedsWrite = false;
  } catch {
    // Unreadable — overwrite
  }
}
if (wrapperNeedsWrite) {
  try {
    writeFileSync(wrapperPath, WRAPPER_CONTENT);
  } catch (err) {
    console.error(`Could not write wrapper ${wrapperPath}: ${/** @type {any} */ (err).message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Patch settings.json
// ---------------------------------------------------------------------------
const desiredCommand = `node "${wrapperPath}"`;

// Pattern that identifies an old versioned statusLine written by a previous
// version of this script — safe to replace without --force.
const oldVersionedPattern = /plugins\/cache\/jasonm4130-claude-skills\/handoff\/[^/]+\/scripts\/status-and-flag\.mjs/;

const hadSettings = existsSync(settingsPath);

/** @type {Record<string, any>} */
let settings = {};
if (hadSettings) {
  let raw = "";
  try {
    raw = readFileSync(settingsPath, "utf8");
  } catch (err) {
    console.error(`Could not read ${settingsPath}: ${/** @type {any} */ (err).message}`);
    process.exit(1);
  }
  if (raw.trim().length > 0) {
    try {
      settings = JSON.parse(raw);
      if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
        console.error(`${settingsPath} is not a JSON object. Aborting.`);
        process.exit(1);
      }
    } catch (err) {
      console.error(
        `${settingsPath} is not valid JSON: ${/** @type {any} */ (err).message}\n` +
          `Fix the file and re-run. No changes made.`
      );
      process.exit(1);
    }
  }
}

const existing = settings.statusLine;

if (existing && typeof existing === "object" && !force) {
  const existingCmd = typeof existing.command === "string" ? existing.command : "";

  // Already wired to the new wrapper — nothing to do
  if (existingCmd === desiredCommand) {
    console.log(`statusLine already wired to handoff. Nothing to do.`);
    console.log(`  ${settingsPath}`);
    process.exit(0);
  }

  // Old versioned form written by a previous setup.mjs — replace silently
  const isOldVersionedForm = oldVersionedPattern.test(existingCmd);
  if (!isOldVersionedForm) {
    console.error(
      `A statusLine is already configured in ${settingsPath}:\n` +
        `  ${JSON.stringify(existing)}\n\n` +
        `Re-run with --force to overwrite, or merge manually:\n` +
        `  ${desiredCommand}`
    );
    process.exit(1);
  }
  // Fall through — old versioned form, replace it
}

if (hadSettings) {
  try {
    copyFileSync(settingsPath, backupPath);
  } catch (err) {
    console.error(`Could not write backup ${backupPath}: ${/** @type {any} */ (err).message}`);
    process.exit(1);
  }
}

settings.statusLine = {
  type: "command",
  command: desiredCommand,
};

try {
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
} catch (err) {
  console.error(`Could not write ${settingsPath}: ${/** @type {any} */ (err).message}`);
  process.exit(1);
}

console.log(`Wired statusLine in ${settingsPath}:`);
console.log(`  command: ${desiredCommand}`);
if (hadSettings) {
  console.log(`Backup saved to ${backupPath}`);
}
console.log(`Restart Claude Code for the change to take effect.`);
process.exit(0);
