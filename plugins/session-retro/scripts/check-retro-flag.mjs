#!/usr/bin/env node
// @ts-check
// UserPromptSubmit hook: check for a retro-nudge flag and, if present,
// inject additionalContext so the agent surfaces the suggestion in its own
// voice. Deletes the flag after consuming it (fire-once-per-set).

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  readStdin,
  safeJsonParse,
  resolveSessionId,
  resolveDataDir,
  emitAdditionalContext,
} from "./lib.mjs";

/**
 * @typedef {object} UserPromptSubmitInput
 * @property {string} [session_id]
 */

const raw = await readStdin();
const payload = /** @type {UserPromptSubmitInput | null} */ (safeJsonParse(raw));
const sessionId = resolveSessionId(payload);
const dataDir = resolveDataDir("session-retro-data");
const nudgeFlag = path.join(dataDir, `retro-nudge-${sessionId}.flag`);

if (!existsSync(nudgeFlag)) process.exit(0);

/** @type {string} */
let reasons;
try {
  reasons = readFileSync(nudgeFlag, "utf8");
} catch {
  process.exit(0);
}

try {
  unlinkSync(nudgeFlag);
} catch {
  // best-effort — fire-once is desirable but a failed unlink shouldn't block emission
}

emitAdditionalContext(
  "UserPromptSubmit",
  `[session-retro] This session: ${reasons}. Consider running /retro to capture decisions/learnings before /clear.`,
);
process.exit(0);
