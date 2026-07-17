#!/usr/bin/env node
// @ts-check
// Invoked by the /retro skill after a successful interview (or an accepted
// Step-1 skip). Reads the batch snapshot (retro-batch-{sid}.json) written by
// collect-batch-sessions.mjs and APPENDS its processedSids to the append-only
// retro-processed.jsonl ledger (identity cleanup — never a rewrite of any shared
// log). Also writes the per-session fired flag and the last-retro cadence hint.
// Session id comes from stdin payload or argv[2].

import { writeFileSync, readFileSync, appendFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  readStdin,
  safeJsonParse,
  resolveSessionId,
  resolveDataDir,
  nowIso,
} from "./lib.mjs";

/**
 * @typedef {object} MarkRetroDoneInput
 * @property {string} [session_id]
 */

const raw = await readStdin();
const payload = /** @type {MarkRetroDoneInput | null} */ (safeJsonParse(raw));
const argSid =
  typeof process.argv[2] === "string" && process.argv[2].length > 0
    ? process.argv[2]
    : null;
const sessionId = argSid ?? resolveSessionId(payload);
const dataDir = resolveDataDir("session-retro-data");

const batchPath = path.join(dataDir, `retro-batch-${sessionId}.json`);

/** @type {string | null} */
let boundaryTs = null;
/** @type {string[]} */
let processedSids = [];
try {
  const snap = JSON.parse(readFileSync(batchPath, "utf8"));
  if (snap && typeof snap === "object") {
    if (typeof snap.boundaryTs === "string") boundaryTs = snap.boundaryTs;
    if (Array.isArray(snap.processedSids)) {
      processedSids = snap.processedSids.filter(
        (/** @type {unknown} */ s) => typeof s === "string" && s.length > 0,
      );
    }
  }
} catch {
  // No snapshot (bare invocation / legacy) → append nothing, cadence = now().
}

try {
  // Append the interviewed sids to the append-only ledger. Atomic per PIPE_BUF;
  // never a read-modify-write, so a concurrent worthy-log append can't be lost.
  if (processedSids.length > 0) {
    const body =
      processedSids
        .map((sid) => JSON.stringify({ ts: nowIso(), sid }))
        .join("\n") + "\n";
    appendFileSync(path.join(dataDir, "retro-processed.jsonl"), body);
  }
  writeFileSync(path.join(dataDir, `retro-fired-${sessionId}.flag`), nowIso());
  // last-retro.txt is now only the days-cadence hint. Prefer the collector's
  // read-time boundary; fall back to now() when no snapshot was present.
  writeFileSync(path.join(dataDir, "last-retro.txt"), boundaryTs ?? nowIso());
} catch {
  // best-effort
}

// Clear the consumed snapshot so a later retro starts fresh.
try {
  unlinkSync(batchPath);
} catch {
  // best-effort — absent is fine
}
process.exit(0);
