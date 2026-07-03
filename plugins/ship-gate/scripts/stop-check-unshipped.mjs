#!/usr/bin/env node
// @ts-check
// Stop hook: detect unshipped work (commits ahead of upstream, or a non-main
// branch with no upstream) and write a nudge flag keyed to HEAD. Consumed by
// check-shipgate-flag.mjs on UserPromptSubmit. Working-tree dirtiness is
// deliberately ignored — mid-feature dirt is normal; unpushed commits are the
// trail-off signal.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { readStdin, safeJsonParse, resolveSessionId, resolveDataDir } from "./lib.mjs";

/**
 * @typedef {object} StopInput
 * @property {string} [session_id]
 * @property {string} [cwd]
 */

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string | null}
 */
function git(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const raw = await readStdin();
const payload = /** @type {StopInput | null} */ (safeJsonParse(raw));
const cwd =
  payload && typeof payload.cwd === "string" && payload.cwd.length > 0
    ? payload.cwd
    : process.cwd();
const sessionId = resolveSessionId(payload);
const dataDir = resolveDataDir("ship-gate-data");

if (git(["rev-parse", "--is-inside-work-tree"], cwd) !== "true") process.exit(0);

const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
if (!branch || branch === "HEAD") process.exit(0); // detached — stay silent

const head = git(["rev-parse", "HEAD"], cwd);
if (!head) process.exit(0);

/** @type {string | null} */
let detail = null;
const aheadRaw = git(["rev-list", "--count", "@{upstream}..HEAD"], cwd);
if (aheadRaw !== null) {
  const ahead = Number.parseInt(aheadRaw, 10);
  if (Number.isFinite(ahead) && ahead > 0) {
    detail = `${ahead} commit(s) on '${branch}' not pushed to upstream`;
  }
} else if (branch !== "main" && branch !== "master") {
  detail = `branch '${branch}' has no upstream — nothing is pushed`;
}

if (detail === null) process.exit(0);

// Throttle: once per HEAD per session — only new commits re-arm the nudge.
const lastShaFile = path.join(dataDir, `shipgate-last-sha-${sessionId}.txt`);
if (existsSync(lastShaFile)) {
  try {
    if (readFileSync(lastShaFile, "utf8").trim() === head) process.exit(0);
  } catch {
    // best-effort throttle — fall through
  }
}

try {
  writeFileSync(path.join(dataDir, `shipgate-nudge-${sessionId}.flag`), detail);
  writeFileSync(lastShaFile, head);
} catch {
  // best-effort
}
process.exit(0);
