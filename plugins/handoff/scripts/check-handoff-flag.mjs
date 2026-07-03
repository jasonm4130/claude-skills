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

// Severity-tiered, agent-directed wording. Parse the percentage back out of
// the flag content rather than trusting a specific format beyond the number.
const match = flagContent.match(/context at (\d+)%/);
const pct = match ? match[1] : "?";

const context =
  Number(pct) >= 85
    ? `[handoff] Context at ${pct}% — run the handoff skill NOW, then tell the user to /clear and resume from the handoff. Do not start new work.`
    : `[handoff] Context at ${pct}% (past threshold). Wrap the current step, then run the handoff skill before starting anything new; suggest /clear to the user.`;
emitAdditionalContext("UserPromptSubmit", context);
