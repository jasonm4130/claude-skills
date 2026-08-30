#!/usr/bin/env node
// @ts-check
// UserPromptSubmit hook. Consumes a per-session retro-nudge flag (Stop- or
// PreCompact-origin) silently into the cross-session worthy log
// (retro-worthy.jsonl), one line per session (dedup by sid). Nothing about a
// single session ever interrupts the user.
//
// Then evaluates the END-OF-DAY offer: past RETRO_EOD_HOUR local time (default
// 16), at most once per calendar day (eod-offer-<local date>.txt is claimed
// exclusively by the day's winner), and only once >=RETRO_BATCH_MIN_SESSIONS worthy sessions
// have accrued since the last retro AND >=RETRO_BATCH_MIN_DAYS have passed.

import {
  existsSync,
  readFileSync,
  readdirSync,
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
  emitOffer,
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
// Per-day claim marker: the date in the NAME (not the content) is what makes
// the once-per-day guarantee atomic — `wx` on a path unique to the day has
// exactly one winner, with no read-modify-write to race on.
const eodOfferFileFor = (localDay) =>
  path.join(dataDir, `eod-offer-${localDay}.txt`);
// Pre-0.8.1 marker; read-only legacy check so an upgrade mid-day doesn't re-offer.
const legacyEodOfferFile = path.join(dataDir, "last-eod-offer.txt");

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
// A garbage value must not silence the offer forever: NaN >= n is always false,
// and an out-of-range hour (24, 99) can never be < getHours(), so both fall back.
const eodHour =
  Number.isFinite(eodHourEnv) && eodHourEnv >= 0 && eodHourEnv <= 23
    ? eodHourEnv
    : DEFAULT_EOD_HOUR;
if (now.getHours() < eodHour) process.exit(0);

const today = localDate(now);
if (existsSync(eodOfferFileFor(today))) process.exit(0);
if (existsSync(legacyEodOfferFile)) {
  try {
    if (readFileSync(legacyEodOfferFile, "utf8").trim() === today) process.exit(0);
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
  // Claim today's offer atomically before emitting: exclusive-create on the
  // per-day path has exactly one winner — a concurrent session's create throws
  // EEXIST and forfeits silently. No stale-marker rotation exists to race on;
  // yesterday's file is simply a different path.
  try {
    writeFileSync(eodOfferFileFor(today), now.toISOString() + "\n", {
      flag: "wx",
    });
  } catch {
    process.exit(0);
  }
  // Winner sweeps STRICTLY OLDER day markers (and the legacy one), best-effort.
  // Older-only, not "not mine": a cross-midnight straggler (RETRO_EOD_HOUR=0 —
  // claim yesterday's marker at 23:59, sweep at 00:01) must not delete the new
  // day's freshly-claimed marker. YYYY-MM-DD compares lexicographically.
  try {
    for (const f of readdirSync(dataDir)) {
      const m = /^eod-offer-(\d{4}-\d{2}-\d{2})\.txt$/.exec(f);
      if ((m && m[1] < today) || f === "last-eod-offer.txt") {
        try {
          unlinkSync(path.join(dataDir, f));
        } catch {
          // best-effort
        }
      }
    }
  } catch {
    // best-effort
  }
  // With no last-retro.txt, daysSince is days-since-epoch — a garbage figure;
  // say "no retro recorded yet" instead of interpolating it.
  const cadence =
    lastRetroMs === 0
      ? "no retro recorded yet"
      : `${Math.floor(daysSince)}+ days since the last retro`;
  emitOffer(
    "UserPromptSubmit",
    `[session-retro] ${worthyCount} retro-worthy sessions have accrued (${cadence}). ` +
      `Want me to run the retro now and batch-capture what they taught? It reads the recorded events, not the full transcripts, so it is quick. ` +
      `Say no and I'll drop it until the next batch.`,
    `[session-retro] The user has just been shown an end-of-day offer to run the session-retro:retro skill over ${worthyCount} accrued sessions. ` +
      `Do not start it unprompted; run it only if they take it up.`,
  );
}
process.exit(0);
