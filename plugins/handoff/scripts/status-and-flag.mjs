#!/usr/bin/env node
// @ts-check
// statusLine command — renders context-fill bar, writes flag on first crossing.
// Reads JSON from stdin and outputs a single line of status text to stdout.

import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
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
  acquireInflightLock,
  pickContextTokens,
  shouldResetBands,
  gitBranchDirty,
  selectRateLimits,
  assembleStatusLine,
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
 * @typedef {Object} Model
 * @property {string} [display_name]
 */
/**
 * @typedef {Object} RateWindow
 * @property {number} [used_percentage]
 */
/**
 * @typedef {Object} RateLimits
 * @property {RateWindow} [five_hour]
 * @property {RateWindow} [seven_day]
 */

/**
 * @typedef {Object} StatusInput
 * @property {string} [session_id]
 * @property {ContextWindow} [context_window]
 * @property {string} [transcript_path]
 * @property {string} [cwd]
 * @property {Workspace} [workspace]
 * @property {Worktree} [worktree]
 * @property {Model} [model]
 * @property {RateLimits} [rate_limits]
 */

/** Path of the in-flight lock once this run has acquired it. @type {string | null} */
let heldLockPath = null;

/** Release the in-flight lock, but only if it is still ours — a replacement's lock is not ours to
 * delete. Not race-free, and it does not need to be: the nudge is idempotent, so the worst case is
 * one duplicate render. */
function releaseLock() {
  if (heldLockPath === null) return;
  try {
    if (readFileSync(heldLockPath, "utf8").trim() === String(process.pid)) {
      rmSync(heldLockPath, { force: true });
    }
  } catch {
    // already gone, or unreadable — nothing to do
  }
  heldLockPath = null;
}

/**
 * @param {string} [prefix]
 * @returns {never}
 */
function bail(prefix = "") {
  releaseLock();
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

// --- Overlap guard. ccusage#459 shows statusline invocations DO pile up in production (34 concurrent
// node processes, 300% CPU) despite the docs' cancel-and-replace claim, so a guard is warranted.
//
// This is a PERFORMANCE guard, not a mutex, and it does not need to be a correct one: the nudge is
// idempotent (claimBand), so a torn race costs one duplicate render, which is invisible — Claude Code
// displays one status line. Do not reintroduce lock ceremony here: four attempts at a "correct" lock
// each produced a new race, and none of them needed to exist.
const LOCK_STALE_MS = 2000;
const inflightLockFile = path.join(dataDir, `statusline-inflight-${sid}.lock`);
const renderCacheFile = path.join(dataDir, `last-render-${sid}.txt`);

if (!acquireInflightLock(inflightLockFile, LOCK_STALE_MS)) {
  // Someone else is in flight (or we lost a cold-start race). Replay rather than recompute.
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
heldLockPath = inflightLockFile;

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

/** @type {number | null} */
let contextTokens = null;

if (hasEffectiveMax) {
  const transcriptUsage = transcriptPath !== null ? cachedTranscriptUsage(transcriptPath, dataDir, sid) : null;
  const cu = cw && cw.current_usage != null ? cw.current_usage : null;
  contextTokens = pickContextTokens(transcriptUsage, cu);
  // Step 3: bail — do NOT fall through to raw used_percentage
  if (contextTokens === null) bail(locPrefix);
  currentPct = (contextTokens / effectiveMax) * 100;
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
const RESET_DROP_EPSILON_PCT = 1;
const band = currentPct >= threshold ? Math.floor((currentPct - threshold) / 10) : -1;
const lastBand = lastPct >= threshold ? Math.floor((lastPct - threshold) / 10) : -1;

if (shouldResetBands(currentPct, lastPct, threshold, RESET_DROP_EPSILON_PCT)) {
  // Below the threshold, or a real decrease (e.g. a /compact) while still above it: the climb is
  // over. Clear the ladder so a later climb can re-fire. This also self-heals the resolveSessionId
  // "unknown" fallback — a new no-ID session starts low, so it clears the previous one's markers
  // rather than inheriting permanent suppression.
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

const pctInt = Math.trunc(currentPct);

// --- Resolve display segments (success path only — never on the bail/replay path) ---
const identity = wsDir !== null ? path.basename(wsDir) : "";
// Fast path: stdin worktree.branch when present; else shell out.
let branch = wtBranch;
let dirty = 0;
if (wsDir !== null) {
  const git = gitBranchDirty(wsDir);
  if (git !== null) {
    if (branch === null) branch = git.label;
    dirty = git.dirty;
  }
}
const RATE_LIMIT_SURFACE_PCT = 50;
const rateLimits = selectRateLimits(parsed && parsed.rate_limits, RATE_LIMIT_SURFACE_PCT);
const modelName =
  parsed && parsed.model && typeof parsed.model.display_name === "string" && parsed.model.display_name.length > 0
    ? parsed.model.display_name
    : "";
const budget = Number.parseInt(process.env.COLUMNS ?? "", 10);

const renderLine =
  assembleStatusLine({
    identity,
    branch,
    dirty,
    pctInt,
    tokens: contextTokens,
    model: modelName,
    rateLimits,
    budget: Number.isFinite(budget) && budget > 0 ? budget : 120,
  }) + "\n";

try {
  writeFileSync(renderCacheFile, renderLine);
} catch {
  // cache is an optimization; replay falls back to "?" without it
}
releaseLock();
process.stdout.write(renderLine);
