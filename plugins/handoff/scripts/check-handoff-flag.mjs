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
  dataDirCandidates,
  emitAdditionalContext,
} from "./lib.mjs";

/**
 * @typedef {Object} UserPromptSubmitInput
 * @property {string} [session_id]
 */

const raw = await readStdin();
const parsed = /** @type {UserPromptSubmitInput | null} */ (safeJsonParse(raw));
const sid = resolveSessionId(parsed);
// The statusLine writer and this hook resolve different data dirs in production
// (see dataDirCandidates in lib.mjs), so look in every candidate, not just ours.
const flagFile = dataDirCandidates("handoff-data")
  .map((dir) => path.join(dir, `handoff-nudge-${sid}.flag`))
  .find((p) => existsSync(p));

if (flagFile === undefined) {
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

// Name the skill plugin-qualified. An unqualified "the handoff skill" is a name
// the model guesses — `Skill(handoff)` resolves to "Unknown skill: handoff",
// which is exactly how the session-retro nudge failed 4 times before its fix.
const context =
  Number(pct) >= 85
    ? `[handoff] Context at ${pct}% — run the handoff:handoff skill NOW, then tell the user to /clear and resume from the handoff. Do not start new work.`
    : `[handoff] Context at ${pct}% (past threshold). Wrap the current step, then run the handoff:handoff skill before starting anything new; suggest /clear to the user.`;
emitAdditionalContext("UserPromptSubmit", context);
