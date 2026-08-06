#!/usr/bin/env node
// @ts-check
// Stop hook: measure how far the repo has moved since its docs were last audited
// against each other, and arm a nudge flag past the threshold. Consumed by
// check-consolidation-flag.mjs on UserPromptSubmit.
//
// Why a flag rather than printing: Stop-hook stdout is NOT injected into model
// context (see this plugin's CLAUDE.md). UserPromptSubmit is the event that can
// inject, so Stop measures and records, and the next prompt delivers.
//
// This hook never blocks anything. Contradiction detection cannot meet the
// no-effective-false-positives bar a blocking check needs, so it lives out here.

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  readStdin,
  safeJsonParse,
  resolveSessionId,
  resolveDataDir,
  repoHash,
  gitRepoRoot,
  git,
  deferMarkerPath,
  isAncestor,
  readConsolidationStamp,
  resolveConsolidateThreshold,
  computeConsolidationDrift,
} from "./lib.mjs";

/**
 * @typedef {object} StopInput
 * @property {string} [session_id]
 * @property {string} [cwd]
 */

const raw = await readStdin();
const payload = /** @type {StopInput | null} */ (safeJsonParse(raw));
// A payload that does not parse is "cannot tell", and every anomaly here is silent.
// Arming a flag from process.cwd() under session id "unknown" is a nudge attributed to
// a session that never ran — see the matching guard in check-consolidation-flag.mjs. An array
// passes `safeJsonParse` (it is an object), so check the shape, not just null.
if (payload === null || typeof payload !== "object" || Array.isArray(payload)) process.exit(0);
const cwd =
  payload && typeof payload.cwd === "string" && payload.cwd.length > 0
    ? payload.cwd
    : process.cwd();

const repoRoot = gitRepoRoot(cwd);
if (repoRoot === null) process.exit(0);

// No record, or the record was deleted as an opt-out → this repo has not adopted
// the trigger. Silent, always.
const stampCommit = readConsolidationStamp(repoRoot);
if (stampCommit === null) process.exit(0);

const threshold = resolveConsolidateThreshold();
const drift = computeConsolidationDrift(repoRoot, stampCommit, threshold);
if (drift === null || !drift.stale) process.exit(0);

const head = git(["rev-parse", "HEAD"], repoRoot);
if (head === null) process.exit(0);

const sessionId = resolveSessionId(payload);
const dataDir = resolveDataDir("docs-sync-guard-data");
const rh = repoHash(repoRoot);

// The defer marker lives in `.git/`, not in the plugin data dir: it is written by
// `/docs-consolidate --defer` from a session shell, where CLAUDE_PLUGIN_DATA is not
// exported. It is per-clone, which is exactly the scope of "not now", and it outlives
// the session that said it. The nudge flag and throttle below are session+repo.
const deferFile = deferMarkerPath(repoRoot);
if (deferFile !== null && existsSync(deferFile)) {
  /** @type {string | null} */
  let deferred = null;
  try {
    deferred = readFileSync(deferFile, "utf8").trim();
  } catch {
    // The marker is THERE but unreadable (permissions, I/O error). That is
    // "cannot tell", not "no deferral" — falling through would arm a nudge the
    // user explicitly deferred. Same rule as everywhere else: stay silent.
    process.exit(0);
  }
  if (!deferred) process.exit(0); // present but empty — also cannot tell
  {
    const anc = isAncestor(repoRoot, deferred);
    if (anc === null) process.exit(0); // cannot tell — keep the defer, stay silent
    if (anc === false) {
      // Verified off this history (rebase, force-push). Counting from it would walk
      // the whole rewritten branch and re-arm instantly, so drop it and let ordinary
      // drift decide. Re-deferring is one command.
      try {
        unlinkSync(deferFile);
      } catch {
        /* best-effort */
      }
    } else {
      const since = git(["rev-list", "--count", `${deferred}..HEAD`], repoRoot);
      if (since === null) process.exit(0);
      const n = Number.parseInt(since, 10);
      if (!Number.isFinite(n)) process.exit(0);
      if (n < threshold) process.exit(0);
    }
  }
}

// Throttle: once per HEAD per session — only new commits re-arm the nudge.
const lastShaFile = path.join(dataDir, `consolidate-last-sha-${sessionId}-${rh}.txt`);
if (existsSync(lastShaFile)) {
  try {
    if (readFileSync(lastShaFile, "utf8").trim() === head) process.exit(0);
  } catch {
    // best-effort throttle — fall through
  }
}

try {
  writeFileSync(
    path.join(dataDir, `consolidate-nudge-${sessionId}-${rh}.flag`),
    String(drift.count),
  );
  writeFileSync(lastShaFile, head);
} catch {
  // best-effort
}
process.exit(0);
