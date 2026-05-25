#!/usr/bin/env node
// @ts-check
// One-time wiring helper: patches ~/.claude/settings.json so the handoff
// status-and-flag.mjs script renders as Claude Code's statusLine.
//
// Usage:
//   node /path/to/plugins/handoff/scripts/setup.mjs [--force]
//
// --force overwrites an existing statusLine without prompting.

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const statusLineScript = path.join(here, "status-and-flag.mjs");

const homedir = os.homedir();
const claudeDir = path.join(homedir, ".claude");
const settingsPath = path.join(claudeDir, "settings.json");
const backupPath = path.join(claudeDir, "settings.json.pre-handoff.bak");

const args = new Set(process.argv.slice(2));
const force = args.has("--force");

try {
  mkdirSync(claudeDir, { recursive: true });
} catch (err) {
  console.error(`Could not create ${claudeDir}: ${/** @type {any} */ (err).message}`);
  process.exit(1);
}

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

const desiredCommand = `node "${statusLineScript}"`;
const existing = settings.statusLine;

if (existing && typeof existing === "object" && !force) {
  const existingCmd = typeof existing.command === "string" ? existing.command : "";
  if (existingCmd === desiredCommand) {
    console.log(`statusLine already wired to handoff. Nothing to do.`);
    console.log(`  ${settingsPath}`);
    process.exit(0);
  }
  console.error(
    `A statusLine is already configured in ${settingsPath}:\n` +
      `  ${JSON.stringify(existing)}\n\n` +
      `Re-run with --force to overwrite, or merge manually:\n` +
      `  ${desiredCommand}`
  );
  process.exit(1);
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
