#!/usr/bin/env node
// @ts-check
// Stop hook: aggregate events-{session_id}.jsonl, evaluate thresholds, write
// a retro-nudge flag file if retro-worthy AND no retro fired this session.
// The flag is consumed by check-retro-flag.mjs on UserPromptSubmit.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  readStdin,
  safeJsonParse,
  resolveSessionId,
  resolveDataDir,
  TESTS_RE,
  COMMIT_RE,
} from "./lib.mjs";

/**
 * @typedef {object} StopInput
 * @property {string} [session_id]
 */

/**
 * @typedef {object} EventRecord
 * @property {string} [ts]
 * @property {string} [tool]
 * @property {{ file_path?: string, command?: string }} [input]
 */

const raw = await readStdin();
const payload = /** @type {StopInput | null} */ (safeJsonParse(raw));
const sessionId = resolveSessionId(payload);
const dataDir = resolveDataDir("session-retro-data");

const eventsPath = path.join(dataDir, `events-${sessionId}.jsonl`);
const firedFlag = path.join(dataDir, `retro-fired-${sessionId}.flag`);
const nudgeFlag = path.join(dataDir, `retro-nudge-${sessionId}.flag`);

// Suppress: already retro'd this session
if (existsSync(firedFlag)) process.exit(0);
// Nothing to evaluate
if (!existsSync(eventsPath)) process.exit(0);

/** @type {string} */
let contents;
try {
  contents = readFileSync(eventsPath, "utf8");
} catch {
  process.exit(0);
}

const lines = contents.split("\n");

let edits = 0;
let writes = 0;
let bashCalls = 0;
/** @type {Set<string>} */
const files = new Set();
/** @type {string | null} */
let firstTs = null;
/** @type {string | null} */
let lastTs = null;
let ranTests = false;
let ranCommit = false;

// Regexes live in lib.mjs so the PostToolUse hook classifies the full command
// before clipping. These still run here as the fallback for pre-v2 events,
// which carry no `clf`.
const testsRe = TESTS_RE;
const commitRe = COMMIT_RE;

for (const line of lines) {
  if (line.length === 0) continue;
  /** @type {EventRecord | null} */
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    continue;
  }
  if (!ev || typeof ev !== "object") continue;

  const tool = typeof ev.tool === "string" ? ev.tool : "";
  const input = ev.input && typeof ev.input === "object" ? ev.input : {};

  if (tool === "Edit") {
    edits += 1;
    const fp = typeof input.file_path === "string" ? input.file_path : "";
    if (fp) files.add(fp);
  } else if (tool === "Write") {
    writes += 1;
    const fp = typeof input.file_path === "string" ? input.file_path : "";
    if (fp) files.add(fp);
  } else if (tool === "Bash") {
    bashCalls += 1;
    // Prefer the flags recorded at hook time against the unclipped command;
    // fall back to re-matching the stored (possibly clipped) string.
    const clf = ev.clf && typeof ev.clf === "object" ? ev.clf : null;
    if (clf?.t) ranTests = true;
    if (clf?.c) ranCommit = true;
    const cmd = typeof input.command === "string" ? input.command : "";
    if (cmd) {
      if (testsRe.test(cmd)) ranTests = true;
      if (commitRe.test(cmd)) ranCommit = true;
    }
  }

  const ts = typeof ev.ts === "string" ? ev.ts : "";
  if (ts) {
    if (firstTs === null || ts < firstTs) firstTs = ts;
    if (lastTs === null || ts > lastTs) lastTs = ts;
  }
}

// Duration via Date.parse — handles ISO-8601 natively, no BSD/GNU date branching.
let durationSec = 0;
if (firstTs && lastTs) {
  const firstMs = Date.parse(firstTs);
  const lastMs = Date.parse(lastTs);
  if (Number.isFinite(firstMs) && Number.isFinite(lastMs)) {
    durationSec = Math.floor((lastMs - firstMs) / 1000);
  }
}
const durationMin = Math.floor(durationSec / 60);
const totalTools = edits + writes + bashCalls;
const editWrite = edits + writes;
const filesCount = files.size;

/** @type {string[]} */
const reasons = [];

if (editWrite >= 3 && filesCount >= 2) {
  reasons.push(`${editWrite} edits across ${filesCount} files`);
}
if (durationSec >= 1200) {
  reasons.push(`${durationMin} minutes of work`);
}
if (ranCommit) {
  reasons.push("committed during session");
}
if (ranTests && editWrite >= 2) {
  // Only mention this if not already covered by the edits+files trigger
  if (!(editWrite >= 3 && filesCount >= 2)) {
    reasons.push(`ran tests + ${editWrite} edits`);
  }
}
if (totalTools >= 30) {
  reasons.push(`${totalTools} tool calls`);
}

if (reasons.length === 0) process.exit(0);

const triggerReason = reasons.join(" + ");
try {
  writeFileSync(nudgeFlag, triggerReason);
} catch {
  // best-effort
}
process.exit(0);
