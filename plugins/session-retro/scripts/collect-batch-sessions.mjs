#!/usr/bin/env node
// @ts-check
// Step 1 of /retro. Resolves the batch to retrospect: the unprocessed worthy
// sessions (retro-worthy.jsonl minus retro-processed.jsonl, by identity) plus
// the current session, aggregates each session's event log, and emits ONE JSON
// snapshot to stdout AND to retro-batch-{sid}.json. Steps 2 and 6 reuse that one
// snapshot — the skill never re-invokes the collector. Session id from argv[2]
// or the stdin payload, mirroring mark-retro-done.mjs.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  readStdin,
  safeJsonParse,
  resolveSessionId,
  resolveDataDir,
  nowIso,
  unprocessedWorthySessions,
} from "./lib.mjs";

/**
 * @typedef {object} CollectInput
 * @property {string} [session_id]
 */

/**
 * @typedef {object} BatchSession
 * @property {string} sid
 * @property {boolean} isCurrent
 * @property {string | null} startDate
 * @property {number} edits
 * @property {number} writes
 * @property {number} bashCalls
 * @property {string[]} filesTouched
 * @property {string} reasons
 * @property {string | null} firstTs
 * @property {string | null} lastTs
 */

const raw = await readStdin();
const payload = /** @type {CollectInput | null} */ (safeJsonParse(raw));
const argSid =
  typeof process.argv[2] === "string" && process.argv[2].length > 0
    ? process.argv[2]
    : null;
const sessionId = argSid ?? resolveSessionId(payload);
const dataDir = resolveDataDir("session-retro-data");

// Read time — feeds last-retro.txt (days-cadence) at cleanup; not a membership cut.
const boundaryTs = nowIso();

// Unprocessed worthy sessions (migration-seeded, identity set-difference),
// file order = oldest-first / newest-last.
let worthy = unprocessedWorthySessions(dataDir);

// Safety cap: guard a cold-start backlog. Drain OLDEST-first (file order is
// oldest→newest) so a continuously-active user can't have newer sessions
// perpetually displace older queued ones — the backlog empties FIFO across
// successive retros. Dropped (newest) sids stay unprocessed for the next retro.
const maxSessions = Number.parseInt(
  process.env.RETRO_BATCH_MAX_SESSIONS ?? "12",
  10,
);
/** @type {number | undefined} */
let cappedFrom;
if (Number.isFinite(maxSessions) && maxSessions > 0 && worthy.length > maxSessions) {
  cappedFrom = worthy.length;
  worthy = worthy.slice(0, maxSessions);
}

// processedSids = the worthy sids this batch owns (cleanup marks exactly these).
const processedSids = worthy.map((w) => w.sid);
/** @type {Map<string, string>} */
const reasonsBySid = new Map(worthy.map((w) => [w.sid, w.reasons]));

// Batch = worthy ∪ current. If the current sid already has a worthy line it's in
// `worthy` (and thus processedSids); otherwise it's a current-only entry.
const batchSids = [...processedSids];
if (!batchSids.includes(sessionId)) batchSids.push(sessionId);

const batch = batchSids.map((sid) =>
  aggregateSession(sid, reasonsBySid.get(sid) ?? ""),
);

const snapshot = {
  boundaryTs,
  processedSids,
  totalSessions: batch.length,
  ...(cappedFrom !== undefined ? { cappedFrom } : {}),
  batch,
};

const json = JSON.stringify(snapshot);
process.stdout.write(json + "\n");
try {
  writeFileSync(path.join(dataDir, `retro-batch-${sessionId}.json`), json + "\n");
} catch {
  // Best-effort. Steps 1-2 use the stdout above (the agent has the snapshot);
  // only Step 6's mark-retro-done reads this file. If the write failed, the
  // batch simply isn't marked processed and is re-offered at the next retro —
  // retro-worthy.jsonl is untouched, so no data is lost.
}
process.exit(0);

/**
 * Aggregate one session's event log. Missing/unreadable → zero counts, never a
 * throw. Parsing mirrors stop-write-retro-flag.mjs.
 * @param {string} sid
 * @param {string} reasons
 * @returns {BatchSession}
 */
function aggregateSession(sid, reasons) {
  let edits = 0;
  let writes = 0;
  let bashCalls = 0;
  /** @type {Set<string>} */
  const files = new Set();
  /** @type {string | null} */
  let firstTs = null;
  /** @type {string | null} */
  let lastTs = null;

  try {
    const lines = readFileSync(
      path.join(dataDir, `events-${sid}.jsonl`),
      "utf8",
    ).split("\n");
    for (const line of lines) {
      if (line.length === 0) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (!ev || typeof ev !== "object") continue;
      const tool = typeof ev.tool === "string" ? ev.tool : "";
      const input = ev.input && typeof ev.input === "object" ? ev.input : {};
      if (tool === "Edit") {
        edits += 1;
        if (typeof input.file_path === "string" && input.file_path)
          files.add(input.file_path);
      } else if (tool === "Write") {
        writes += 1;
        if (typeof input.file_path === "string" && input.file_path)
          files.add(input.file_path);
      } else if (tool === "Bash") {
        bashCalls += 1;
      }
      const ts = typeof ev.ts === "string" ? ev.ts : "";
      if (ts) {
        if (firstTs === null || ts < firstTs) firstTs = ts;
        if (lastTs === null || ts > lastTs) lastTs = ts;
      }
    }
  } catch {
    // missing/unreadable events file → zero counts
  }

  /** @type {string | null} */
  let startDate = null;
  try {
    startDate =
      readFileSync(path.join(dataDir, `session-start-${sid}.txt`), "utf8").trim() ||
      null;
  } catch {
    // no start marker
  }

  return {
    sid,
    isCurrent: sid === sessionId,
    startDate,
    edits,
    writes,
    bashCalls,
    filesTouched: [...files],
    reasons,
    firstTs,
    lastTs,
  };
}
