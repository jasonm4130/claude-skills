#!/usr/bin/env node
// @ts-check
// SessionStart hook: write an ISO-8601 timestamp pointer for the retro skill.
// The skill uses this to bound git log / diff queries to "since session start".

import { writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  readStdin,
  safeJsonParse,
  resolveSessionId,
  resolveDataDir,
  nowIso,
} from "./lib.mjs";

/**
 * @typedef {object} SessionStartInput
 * @property {string} [session_id]
 */

const raw = await readStdin();
const payload = /** @type {SessionStartInput | null} */ (safeJsonParse(raw));
const sessionId = resolveSessionId(payload);
const dataDir = resolveDataDir("session-retro-data");
const outPath = path.join(dataDir, `session-start-${sessionId}.txt`);

try {
  writeFileSync(outPath, nowIso());
} catch {
  // best-effort — never crash the session start
}
process.exit(0);
