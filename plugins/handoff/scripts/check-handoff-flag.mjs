#!/usr/bin/env node
// @ts-check
// UserPromptSubmit handler — injects additionalContext if handoff flag is set.
// Consumes the flag (one-shot).

import { readFileSync, existsSync, unlinkSync } from "node:fs";
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
 * @typedef {Object} UserPromptSubmitInput
 * @property {string} [session_id]
 */

const raw = await readStdin();
const parsed = /** @type {UserPromptSubmitInput | null} */ (safeJsonParse(raw));
const sid = resolveSessionId(parsed);
const dataDir = resolveDataDir("handoff-data");
const flagFile = path.join(dataDir, `handoff-nudge-${sid}.flag`);

if (!existsSync(flagFile)) {
  process.exit(0);
}

let flagContent = "";
try {
  flagContent = readFileSync(flagFile, "utf8");
} catch {
  process.exit(0);
}

try {
  unlinkSync(flagFile);
} catch {
  // best-effort consume
}

const context = `[handoff] ${flagContent}. Consider running /handoff to write a resume doc before /compact or /clear, or /compact if you want to keep the session going.`;
emitAdditionalContext("UserPromptSubmit", context);
