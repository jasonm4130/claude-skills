#!/usr/bin/env node
// @ts-check
// SessionStart handler — auto-loads pending handoff from previous session.
// Reads JSON from stdin (.cwd). Consumes .pending (one-shot, 24h staleness).

import { existsSync, unlinkSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  readStdin,
  safeJsonParse,
  emitAdditionalContext,
  readContainedFile,
  dirContainedIn,
} from "./lib.mjs";

/**
 * @typedef {Object} SessionStartInput
 * @property {string} [cwd]
 */

const raw = await readStdin();
const parsed = /** @type {SessionStartInput | null} */ (safeJsonParse(raw));
const cwd =
  parsed && typeof parsed.cwd === "string" && parsed.cwd.length > 0
    ? parsed.cwd
    : process.cwd();

const handoffsDir = path.join(cwd, ".claude", "handoffs");
const pendingFile = path.join(handoffsDir, ".pending");

// An attacker who can symlink .claude/handoffs -> /etc would exfiltrate with a perfectly
// innocent bare filename, so the directory itself must be contained.
if (!dirContainedIn(cwd, handoffsDir)) {
  process.exit(0);
}

if (!existsSync(pendingFile)) {
  process.exit(0);
}

// Stale check: >24h old
try {
  const st = statSync(pendingFile);
  const ageMs = Date.now() - st.mtimeMs;
  if (ageMs > 24 * 60 * 60 * 1000) {
    try {
      unlinkSync(pendingFile);
    } catch {
      // best-effort
    }
    process.exit(0);
  }
} catch {
  process.exit(0);
}

const pendingContent = readContainedFile(handoffsDir, ".pending");
if (pendingContent === null) {
  process.exit(0);
}

const handoffFilename = pendingContent.replace(/\s+/g, "");
if (handoffFilename.length === 0) {
  try {
    unlinkSync(pendingFile);
  } catch {
    // best-effort
  }
  process.exit(0);
}

const handoffContent = readContainedFile(handoffsDir, handoffFilename);

if (handoffContent === null) {
  // Missing, non-bare, symlinked out of handoffs/, or not a regular file. Consume the
  // marker so a poisoned one cannot retry on every future session.
  try {
    unlinkSync(pendingFile);
  } catch {
    // best-effort
  }
  process.exit(0);
}

try {
  unlinkSync(pendingFile);
} catch {
  // best-effort
}

const context = `[handoff] Loading pending handoff from previous session:\n\n${handoffContent}`;
emitAdditionalContext("SessionStart", context);
