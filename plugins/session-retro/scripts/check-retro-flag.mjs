#!/usr/bin/env node
// @ts-check
// UserPromptSubmit hook. Consumes a per-session retro-nudge flag:
//   - PreCompact flags ("compact imminent") emit an immediate agent-directed
//     nudge — context loss is a hard event.
//   - Stop-origin flags are absorbed silently into a cross-session worthy log
//     (retro-worthy.jsonl), one line per session (dedup by sid).
// Then evaluates the batch condition: once >=RETRO_BATCH_MIN_SESSIONS worthy
// sessions have accrued since the last retro AND >=RETRO_BATCH_MIN_DAYS have
// passed, emit a single agent-directed nudge — at most once per 24h.

import {
  existsSync,
  readFileSync,
  unlinkSync,
  appendFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  readStdin,
  safeJsonParse,
  resolveSessionId,
  resolveDataDir,
  emitAdditionalContext,
  nowIso,
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
const worthyLog = path.join(dataDir, "retro-worthy.jsonl");
const lastRetroFile = path.join(dataDir, "last-retro.txt");
const lastBatchFile = path.join(dataDir, "last-batch-nudge.txt");

// 1. Consume any per-session flag. PreCompact keeps immediate emission;
//    Stop-origin reasons are absorbed silently into the worthy log.
if (existsSync(nudgeFlag)) {
  let reasons = "";
  try {
    reasons = readFileSync(nudgeFlag, "utf8");
  } catch {
    process.exit(0);
  }
  try {
    unlinkSync(nudgeFlag);
  } catch {
    // best-effort
  }
  if (reasons.includes("compact imminent")) {
    emitAdditionalContext(
      "UserPromptSubmit",
      `[session-retro] This session: ${reasons}. Run the retro skill now to capture decisions/learnings before compaction, unless the user objects.`,
    );
    process.exit(0);
  }
  // Dedup: one worthy line per session.
  let seen = false;
  if (existsSync(worthyLog)) {
    try {
      seen = readFileSync(worthyLog, "utf8").includes(`"sid":"${sessionId}"`);
    } catch {
      seen = false;
    }
  }
  if (!seen) {
    try {
      appendFileSync(
        worthyLog,
        JSON.stringify({ ts: nowIso(), sid: sessionId, reasons }) + "\n",
      );
    } catch {
      // best-effort
    }
  }
}

// 2. Batch decision.
const minSessions = Number.parseInt(
  process.env.RETRO_BATCH_MIN_SESSIONS ?? "3",
  10,
);
const minDays = Number.parseInt(process.env.RETRO_BATCH_MIN_DAYS ?? "7", 10);

let lastRetroMs = 0;
if (existsSync(lastRetroFile)) {
  try {
    const t = Date.parse(readFileSync(lastRetroFile, "utf8").trim());
    if (Number.isFinite(t)) lastRetroMs = t;
  } catch {
    lastRetroMs = 0;
  }
}
const daysSince = (Date.now() - lastRetroMs) / 86400000;

let worthyCount = 0;
if (existsSync(worthyLog)) {
  try {
    for (const line of readFileSync(worthyLog, "utf8").split("\n")) {
      if (line.length === 0) continue;
      try {
        const e = JSON.parse(line);
        const t = Date.parse(typeof e.ts === "string" ? e.ts : "");
        if (Number.isFinite(t) && t > lastRetroMs) worthyCount += 1;
      } catch {
        continue;
      }
    }
  } catch {
    worthyCount = 0;
  }
}

let batchNudgedRecently = false;
if (existsSync(lastBatchFile)) {
  try {
    const t = Date.parse(readFileSync(lastBatchFile, "utf8").trim());
    batchNudgedRecently = Number.isFinite(t) && Date.now() - t < 86400000;
  } catch {
    batchNudgedRecently = false;
  }
}

if (worthyCount >= minSessions && daysSince >= minDays && !batchNudgedRecently) {
  try {
    writeFileSync(lastBatchFile, nowIso());
  } catch {
    // best-effort
  }
  emitAdditionalContext(
    "UserPromptSubmit",
    `[session-retro] ${worthyCount} retro-worthy sessions since the last retro (${Math.floor(daysSince)}+ days). Run the retro skill now to batch-capture learnings, unless the user objects.`,
  );
}
process.exit(0);
