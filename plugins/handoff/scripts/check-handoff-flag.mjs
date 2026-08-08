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
//
// Both tiers are OFFERS, not stop-work orders. The original wording ("run it NOW",
// "do not start new work") was written for a harness where auto-compact ended the
// useful session; current Claude Code carries the compaction summary plus the
// remaining unsummarized context into the next window and tells the model outright
// that it need not hand off mid-task. A nudge that interrupts a task to guard
// against a cliff that no longer exists costs more than it saves — so the value
// left here is the deliberate stop (ending for the day, switching machines), where
// the skill's "What we tried" section still records what no summary reproduces.
const context =
  Number(pct) >= 85
    ? `[handoff] Context at ${pct}%. Compaction will carry this session forward on its own — a handoff is NOT needed to survive it, so do not interrupt the current task. If the user is deliberately stopping here or switching machines, offer the handoff:handoff skill (and /clear afterwards).`
    : `[handoff] Context at ${pct}% (past threshold). Compaction handles this automatically — keep working. Mention the handoff:handoff skill only if the user is winding the session down.`;
emitAdditionalContext("UserPromptSubmit", context);
