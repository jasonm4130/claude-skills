#!/usr/bin/env node
// @ts-check
// UserPromptSubmit hook. Consumes a per-session retro-nudge flag (Stop- or
// PreCompact-origin) silently into the cross-session worthy log
// (retro-worthy.jsonl), one line per session (dedup by sid). Nothing about a
// single session ever interrupts the user.
//
// Then evaluates the END-OF-DAY offer: past RETRO_EOD_HOUR local time (default
// 16), at most once per calendar day (last-eod-offer.txt holds the local date
// of the last offer), and only once >=RETRO_BATCH_MIN_SESSIONS worthy sessions
// have accrued since the last retro AND >=RETRO_BATCH_MIN_DAYS have passed.

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
  unprocessedWorthySessions,
} from "./lib.mjs";

/**
 * @typedef {object} UserPromptSubmitInput
 * @property {string} [session_id]
 */

const DEFAULT_EOD_HOUR = 16;

/**
 * "Now", injectable. RETRO_NOW (ISO-8601, or epoch millis) replaces the wall
 * clock so the day/hour gates are testable without sleeping or waiting for
 * 16:00. Unparseable values fall back to the real clock.
 * @returns {Date}
 */
function resolveNow() {
  const raw = process.env.RETRO_NOW;
  if (typeof raw === "string" && raw.length > 0) {
    const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
    if (Number.isFinite(ms)) return new Date(ms);
  }
  return new Date();
}

/**
 * Local (not UTC) calendar date as YYYY-MM-DD — the identity of "today" for the
 * once-per-day gate. toISOString() would be wrong here: it would roll the day
 * over at local 17:00 for a UTC+7 user.
 * @param {Date} d
 * @returns {string}
 */
function localDate(d) {
  const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const raw = await readStdin();
const payload = /** @type {UserPromptSubmitInput | null} */ (safeJsonParse(raw));
const sessionId = resolveSessionId(payload);
const dataDir = resolveDataDir("session-retro-data");

const nudgeFlag = path.join(dataDir, `retro-nudge-${sessionId}.flag`);
const worthyLog = path.join(dataDir, "retro-worthy.jsonl");
const lastRetroFile = path.join(dataDir, "last-retro.txt");
const eodOfferFile = path.join(dataDir, "last-eod-offer.txt");

// 1. Consume any per-session flag into the worthy log. Both origins are silent:
//    a compaction marks the session worthy (its reason is "compact imminent")
//    and waits for the day's offer like everything else.
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

// 2. End-of-day gates, cheapest first.
const now = resolveNow();

const eodHourEnv = Number.parseInt(process.env.RETRO_EOD_HOUR ?? "", 10);
// A garbage value must not silence the offer forever (NaN >= n is always false).
const eodHour = Number.isFinite(eodHourEnv) ? eodHourEnv : DEFAULT_EOD_HOUR;
if (now.getHours() < eodHour) process.exit(0);

const today = localDate(now);
if (existsSync(eodOfferFile)) {
  try {
    if (readFileSync(eodOfferFile, "utf8").trim() === today) process.exit(0);
  } catch {
    // unreadable → treat as no offer today
  }
}

// 3. Batch decision (unchanged RETRO_BATCH_* contract).
const minSessions = Number.parseInt(
  process.env.RETRO_BATCH_MIN_SESSIONS ?? "3",
  10,
);
const minDays = Number.parseInt(process.env.RETRO_BATCH_MIN_DAYS ?? "1", 10);

let lastRetroMs = 0;
if (existsSync(lastRetroFile)) {
  try {
    const t = Date.parse(readFileSync(lastRetroFile, "utf8").trim());
    if (Number.isFinite(t)) lastRetroMs = t;
  } catch {
    lastRetroMs = 0;
  }
}
const daysSince = (now.getTime() - lastRetroMs) / 86400000;

// Worthy count = unprocessed worthy sessions, by identity set-difference
// (retro-worthy.jsonl minus retro-processed.jsonl). The one-time upgrade
// migration runs inside the helper. retro-worthy.jsonl is append-only and is
// never rewritten here — a retro clears its batch by appending to the processed
// ledger (mark-retro-done.mjs), not by pruning this file.
const worthyCount = unprocessedWorthySessions(dataDir).length;

if (worthyCount >= minSessions && daysSince >= minDays) {
  try {
    writeFileSync(eodOfferFile, today + "\n");
  } catch {
    // best-effort
  }
  // With no last-retro.txt, daysSince is days-since-epoch — a garbage figure;
  // say "no retro recorded yet" instead of interpolating it.
  const cadence =
    lastRetroMs === 0
      ? "no retro recorded yet"
      : `${Math.floor(daysSince)}+ days since the last retro`;
  emitAdditionalContext(
    "UserPromptSubmit",
    `[session-retro] End of day: ${worthyCount} retro-worthy sessions accrued (${cadence}). Run the session-retro:retro skill now to batch-capture the learnings, unless the user objects.`,
  );
}
process.exit(0);
