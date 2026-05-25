#!/usr/bin/env node
// @ts-check
// PreCompact hook: always write a retro-nudge flag before context is compacted.
// No threshold, no flag check — context loss is a hard event regardless of
// prior state. PreCompact fires 1-2x per long session at most, so always
// writing the flag is fine UX. The flag is consumed by check-retro-flag.mjs
// on the next UserPromptSubmit.

import { writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  readStdin,
  safeJsonParse,
  resolveSessionId,
  resolveDataDir,
} from "./lib.mjs";

/**
 * @typedef {object} PreCompactInput
 * @property {string} [session_id]
 */

const raw = await readStdin();
const payload = /** @type {PreCompactInput | null} */ (safeJsonParse(raw));
const sessionId = resolveSessionId(payload);
const dataDir = resolveDataDir("session-retro-data");
const nudgeFlag = path.join(dataDir, `retro-nudge-${sessionId}.flag`);

try {
  writeFileSync(nudgeFlag, "compact imminent");
} catch {
  // best-effort
}
process.exit(0);
