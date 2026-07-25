#!/usr/bin/env node
// @ts-check
// Stop hook: measure drift at turn end and arm a refresh nudge, consumed by
// check-state-flag.mjs on the next UserPromptSubmit.
//
// Activity-triggered, not calendar-triggered: a repo that saw no commits produces
// no drift and therefore no nudge, while a repo taking 78 commits a week arms
// several times a week. That asymmetry is the whole point — the cron this replaces
// rebuilt dormant repos every Sunday and still let the busiest one drift a full
// week between runs.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  readStdin,
  safeJsonParse,
  resolveSessionId,
  resolveDataDir,
  gitRepoRoot,
  readStamp,
  resolveThreshold,
  computeDrift,
  describeDrift,
  git,
} from "./lib.mjs";

const raw = await readStdin();
const payload = safeJsonParse(raw);
const cwd =
  payload && typeof /** @type {any} */ (payload).cwd === "string" && /** @type {any} */ (payload).cwd.length > 0
    ? /** @type {any} */ (payload).cwd
    : process.cwd();
const sessionId = resolveSessionId(payload);
const dataDir = resolveDataDir("repo-state-data");

const repoRoot = gitRepoRoot(cwd);
if (!repoRoot) process.exit(0);

const stamp = readStamp(repoRoot);
if (!stamp) process.exit(0);

const head = git(["rev-parse", "HEAD"], repoRoot);
if (!head) process.exit(0);

const drift = computeDrift(repoRoot, stamp.commit, resolveThreshold());
if (!drift || !drift.stale) process.exit(0);

// Throttle: once per HEAD per session — only new commits re-arm the nudge.
const lastShaFile = path.join(dataDir, `repostate-last-sha-${sessionId}.txt`);
if (existsSync(lastShaFile)) {
  try {
    if (readFileSync(lastShaFile, "utf8").trim() === head) process.exit(0);
  } catch {
    // best-effort throttle — fall through
  }
}

try {
  writeFileSync(path.join(dataDir, `repostate-nudge-${sessionId}.flag`), describeDrift(drift));
  writeFileSync(lastShaFile, head);
} catch {
  // best-effort
}
process.exit(0);
