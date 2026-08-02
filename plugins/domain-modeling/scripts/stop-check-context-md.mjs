#!/usr/bin/env node
// @ts-check
// Stop hook: for repos this session did source work in, flag the first one that
// has a CLAUDE.md but no CONTEXT.md. Consumed by check-context-md-flag.mjs on
// UserPromptSubmit.
//
// Noise budget is the whole design constraint here: a naive "no CONTEXT.md"
// check fires on nearly every repo, every session, forever — the failure mode
// that got a previous always-on automation deleted. Three gates keep it rare:
// source work happened here, the repo is already CLAUDE.md-configured (so the
// user opted into agent tooling for it), and the offer is made once per repo
// ever (the offered-list is written by the UserPromptSubmit consumer, so a
// nudge that never reached the user doesn't burn the one ask).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { readStdin, safeJsonParse, resolveSessionId, resolveDataDir } from "./lib.mjs";

/**
 * @typedef {object} StopInput
 * @property {string} [session_id]
 */

/**
 * Read a newline-delimited set file; missing or unreadable → empty.
 * @param {string} file
 * @returns {string[]}
 */
function readLines(file) {
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

const raw = await readStdin();
const payload = /** @type {StopInput | null} */ (safeJsonParse(raw));
const sessionId = resolveSessionId(payload);
const dataDir = resolveDataDir("domain-modeling-data");

const edited = readLines(path.join(dataDir, `source-edits-${sessionId}.txt`));
if (edited.length === 0) process.exit(0);

const offered = new Set(readLines(path.join(dataDir, "context-md-offered.txt")));

/** @type {string | null} */
let target = null;
for (const repo of edited) {
  if (offered.has(repo)) continue;
  if (!existsSync(path.join(repo, "CLAUDE.md"))) continue;
  if (existsSync(path.join(repo, "CONTEXT.md"))) continue;
  if (existsSync(path.join(repo, "CONTEXT-MAP.md"))) continue;
  target = repo;
  break;
}

if (target === null) process.exit(0);

try {
  writeFileSync(path.join(dataDir, `context-md-nudge-${sessionId}.flag`), target);
} catch {
  // best-effort
}
process.exit(0);
