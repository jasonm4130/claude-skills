#!/usr/bin/env node
// @ts-check
// statusLine command — renders context-fill bar, writes flag on first crossing.
// Reads JSON from stdin and outputs a single line of status text to stdout.

import { readFileSync, writeFileSync, existsSync, statSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  readStdin,
  safeJsonParse,
  resolveSessionId,
  resolveDataDir,
  cachedTranscriptUsage,
  claimBand,
  resetBands,
  bandMarkerPath,
} from "./lib.mjs";

/**
 * @typedef {Object} CurrentUsage
 * @property {number} [input_tokens]
 * @property {number} [cache_creation_input_tokens]
 * @property {number} [cache_read_input_tokens]
 */

/**
 * @typedef {Object} ContextWindow
 * @property {number} [used_percentage]
 * @property {CurrentUsage | null} [current_usage]
 */

/**
 * @typedef {Object} Workspace
 * @property {string} [current_dir]
 * @property {string} [project_dir]
 */

/**
 * @typedef {Object} Worktree
 * @property {string} [name]
 * @property {string} [path]
 * @property {string} [branch]
 */

/**
 * @typedef {Object} StatusInput
 * @property {string} [session_id]
 * @property {ContextWindow} [context_window]
 * @property {string} [transcript_path]
 * @property {string} [cwd]
 * @property {Workspace} [workspace]
 * @property {Worktree} [worktree]
 */

/** Path of the in-flight lock once this run has acquired it. @type {string | null} */
let heldLockPath = null;

/**
 * @param {string} [prefix]
 * @returns {never}
 */
function bail(prefix = "") {
  if (heldLockPath !== null) {
    try {
      rmSync(heldLockPath, { force: true });
    } catch {
      // best-effort; a stuck lock goes stale after LOCK_FRESH_MS anyway
    }
  }
  process.stdout.write(`${prefix}?\n`);
  process.exit(0);
}

const raw = await readStdin();
const parsed = /** @type {StatusInput | null} */ (safeJsonParse(raw));
if (!parsed) bail();

// --- Location prefix: dir basename (+ worktree branch) so parallel sessions
// in different tabs/worktrees are tellable apart at a glance ---
const wsDir =
  parsed && parsed.workspace && typeof parsed.workspace.current_dir === "string" && parsed.workspace.current_dir.length > 0
    ? parsed.workspace.current_dir
    : parsed && typeof parsed.cwd === "string" && parsed.cwd.length > 0
      ? parsed.cwd
      : null;
const wtBranch =
  parsed && parsed.worktree && typeof parsed.worktree.branch === "string" && parsed.worktree.branch.length > 0
    ? parsed.worktree.branch
    : null;
/** @type {string[]} */
const locParts = [];
if (wsDir !== null) locParts.push(path.basename(wsDir));
if (wtBranch !== null) locParts.push(`⎇${wtBranch}`);
const locPrefix = locParts.length > 0 ? `\x1b[2m${locParts.join(" ")}\x1b[0m ` : "";

const sid = resolveSessionId(parsed);
const dataDir = resolveDataDir("handoff-data");

// --- Overlap guard (ccusage#459 lesson): Claude Code can fire the next
// statusline invocation before the previous one finished (e.g. slow JSONL
// fallback). A concurrent run must not double-fire flags or interleave the
// read-modify-write on last-context-pct — replay the previous render instead.
// Best-effort, not a mutex: a torn race costs one duplicate render, and a
// lock orphaned by a crashed run goes stale after LOCK_FRESH_MS.
const LOCK_FRESH_MS = 2000;
const inflightLockFile = path.join(dataDir, `statusline-inflight-${sid}.lock`);
const renderCacheFile = path.join(dataDir, `last-render-${sid}.txt`);
try {
  if (Date.now() - statSync(inflightLockFile).mtimeMs < LOCK_FRESH_MS) {
    /** @type {string | null} */
    let cached = null;
    try {
      cached = readFileSync(renderCacheFile, "utf8");
    } catch {
      cached = null;
    }
    if (cached !== null && cached.length > 0) {
      process.stdout.write(cached);
      process.exit(0);
    }
    bail(locPrefix);
  }
} catch {
  // no lock (or unreadable) — not in flight
}
try {
  writeFileSync(inflightLockFile, String(process.pid));
  heldLockPath = inflightLockFile;
} catch {
  // couldn't take the lock; render anyway — worst case is pre-guard behavior
}

const cw = parsed && parsed.context_window ? parsed.context_window : undefined;
const pctRaw = cw ? cw.used_percentage : undefined;
const transcriptPath =
  parsed && typeof parsed.transcript_path === "string" && parsed.transcript_path.length > 0
    ? parsed.transcript_path
    : null;

// Workaround for CC issue #62210: stdin doesn't expose autoCompactWindow or
// "% until auto-compact". When HANDOFF_EFFECTIVE_MAX_TOKENS is set to a
// positive finite number, compute pct against that ceiling.
// Precedence (issue #6 — JSONL fallback):
//   1. current_usage from stdin when present and non-zero
//   2. JSONL transcript fallback (last main-chain assistant turn)
//   3. Bail to "?" — do NOT silently use raw used_percentage (that's the regression)
// When HANDOFF_EFFECTIVE_MAX_TOKENS is NOT set, preserve existing behavior (raw used_percentage).
// See: https://github.com/jasonm4130/claude-skills/issues/4
//      https://github.com/jasonm4130/claude-skills/issues/6
const effectiveMaxRaw = process.env.HANDOFF_EFFECTIVE_MAX_TOKENS;
const effectiveMax = effectiveMaxRaw !== undefined ? Number(effectiveMaxRaw) : NaN;
const hasEffectiveMax = Number.isFinite(effectiveMax) && effectiveMax > 0;

/** @type {number | undefined} */
let currentPct;

if (hasEffectiveMax) {
  // Step 1: prefer current_usage when present and non-zero
  const cu = cw && cw.current_usage != null ? cw.current_usage : null;
  if (cu !== null) {
    const inputTokens =
      (cu.input_tokens ?? 0) +
      (cu.cache_creation_input_tokens ?? 0) +
      (cu.cache_read_input_tokens ?? 0);
    if (inputTokens > 0) {
      currentPct = (inputTokens / effectiveMax) * 100;
    }
  }

  // Step 2: JSONL fallback when current_usage was absent or zero
  if (currentPct === undefined && transcriptPath !== null) {
    const usage = cachedTranscriptUsage(transcriptPath, dataDir, sid);
    if (usage !== null) {
      const inputTokens = usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
      currentPct = (inputTokens / effectiveMax) * 100;
    }
  }

  // Step 3: bail — do NOT fall through to raw used_percentage
  if (currentPct === undefined) bail(locPrefix);
} else if (typeof pctRaw === "number" && Number.isFinite(pctRaw)) {
  currentPct = pctRaw;
}

if (typeof currentPct !== "number" || !Number.isFinite(currentPct)) bail(locPrefix);

const lastPctFile = path.join(dataDir, `last-context-pct-${sid}.txt`);
const threshold = parseFloat(process.env.HANDOFF_THRESHOLD_PCT ?? "70");

let lastPct = 0;
if (existsSync(lastPctFile)) {
  try {
    const txt = readFileSync(lastPctFile, "utf8").trim();
    const n = parseFloat(txt);
    if (Number.isFinite(n)) lastPct = n;
  } catch {
    lastPct = 0;
  }
}

// Escalating nudges: fire on every 10%-point band ENTERED at/above the threshold. Bands are relative
// to the configured threshold, so a non-decile threshold (e.g. 75) still fires as soon as pct crosses
// it.
//
// The invariant is a TRANSITION, not a level: `band > lastBand` fires on entry from below. That is
// what keeps 72% → 78% silent, and what lets a post-/compact climb back to 85% nudge again instead of
// staying silent forever.
//
// But the gate is a read-modify-write on last-context-pct: two overlapping invocations both read the
// stale lastPct, both pass, and both fire. So the GATE decides whether a band is being entered, and
// claimBand() — an atomic exclusive create — decides WHO acts on it. Correctness therefore does not
// depend on the overlap guard at all.
//
// Do NOT "simplify" this to a claim-only check: a level-keyed marker has no memory of where the
// session came from, so it can express neither behavior above.
const band = currentPct >= threshold ? Math.floor((currentPct - threshold) / 10) : -1;
const lastBand = lastPct >= threshold ? Math.floor((lastPct - threshold) / 10) : -1;

if (band < 0) {
  // Below the threshold: the climb is over (a fresh session, or a /compact). Clear the ladder so a
  // later climb can re-fire. This also self-heals the resolveSessionId "unknown" fallback — a new
  // no-ID session starts low, so it clears the previous one's markers rather than inheriting
  // permanent suppression.
  resetBands(dataDir, sid);
} else if (band > lastBand && claimBand(dataDir, sid, threshold, band)) {
  try {
    writeFileSync(
      path.join(dataDir, `handoff-nudge-${sid}.flag`),
      `context at ${Math.trunc(currentPct)}% (threshold ${threshold}%)`,
    );
  } catch {
    // The claim is only meaningful as "a nudge was DELIVERED". If the flag write failed, nothing was
    // delivered — so give the claim back, or this band is burned for the rest of the session and the
    // nudge is lost permanently. A failed write must never take the bar down either (see Global
    // Constraints), so both the write and the release are swallowed.
    try {
      rmSync(bandMarkerPath(dataDir, sid, threshold, band), { force: true });
    } catch {
      // nothing left to do — the next band will still fire
    }
  }
}

// Update last percentage. Write it EARLY relative to the expensive render (see below): a slow
// invocation that writes stale state after a fresher one has already written is how a post-/compact
// reset gets clobbered.
try {
  writeFileSync(lastPctFile, String(currentPct));
} catch {
  // best-effort
}

// --- Render 10-char block bar ---
const pctInt = Math.trunc(currentPct);
let filled = Math.floor(pctInt / 10);
if (filled < 0) filled = 0;
if (filled > 10) filled = 10;
const empty = 10 - filled;
const bar = "█".repeat(filled) + "░".repeat(empty);

let color;
if (pctInt >= 70) color = "\x1b[0;31m"; // red
else if (pctInt >= 50) color = "\x1b[0;33m"; // yellow
else color = "\x1b[0;32m"; // green
const reset = "\x1b[0m";

const renderLine = `${locPrefix}${color}[${bar}] ${pctInt}%${reset}\n`;
try {
  writeFileSync(renderCacheFile, renderLine);
} catch {
  // cache is an optimization; replay falls back to "?" without it
}
if (heldLockPath !== null) {
  try {
    rmSync(heldLockPath, { force: true });
  } catch {
    // best-effort; goes stale after LOCK_FRESH_MS
  }
}
process.stdout.write(renderLine);
