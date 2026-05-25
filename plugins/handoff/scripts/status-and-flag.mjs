#!/usr/bin/env node
// @ts-check
// statusLine command — renders context-fill bar, writes flag on first crossing.
// Reads JSON from stdin and outputs a single line of status text to stdout.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { readStdin, safeJsonParse, resolveSessionId, resolveDataDir } from "./lib.mjs";

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
 * @typedef {Object} StatusInput
 * @property {string} [session_id]
 * @property {ContextWindow} [context_window]
 */

function bail() {
  process.stdout.write("?\n");
  process.exit(0);
}

const raw = await readStdin();
const parsed = /** @type {StatusInput | null} */ (safeJsonParse(raw));
if (!parsed) bail();

const cw = parsed && parsed.context_window ? parsed.context_window : undefined;
const pctRaw = cw ? cw.used_percentage : undefined;

// Workaround for CC issue #62210: stdin doesn't expose autoCompactWindow or
// "% until auto-compact". When HANDOFF_EFFECTIVE_MAX_TOKENS is set to a
// positive finite number, compute pct against that ceiling using the
// input-only token fields documented for current_usage.
// See: https://github.com/jasonm4130/claude-skills/issues/4
const effectiveMaxRaw = process.env.HANDOFF_EFFECTIVE_MAX_TOKENS;
const effectiveMax = effectiveMaxRaw !== undefined ? Number(effectiveMaxRaw) : NaN;
const useEffective =
  Number.isFinite(effectiveMax) &&
  effectiveMax > 0 &&
  cw !== undefined &&
  cw.current_usage !== null &&
  cw.current_usage !== undefined;

/** @type {number | undefined} */
let currentPct;

if (useEffective) {
  const cu = /** @type {CurrentUsage} */ (cw.current_usage);
  const inputTokens =
    (cu.input_tokens ?? 0) +
    (cu.cache_creation_input_tokens ?? 0) +
    (cu.cache_read_input_tokens ?? 0);
  currentPct = (inputTokens / effectiveMax) * 100;
} else if (typeof pctRaw === "number" && Number.isFinite(pctRaw)) {
  currentPct = pctRaw;
}

if (typeof currentPct !== "number" || !Number.isFinite(currentPct)) bail();

const sid = resolveSessionId(parsed);
const dataDir = resolveDataDir("handoff-data");

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

// First-crossing detection
if (currentPct >= threshold && lastPct < threshold) {
  const flagFile = path.join(dataDir, `handoff-nudge-${sid}.flag`);
  writeFileSync(flagFile, `context at ${currentPct}% (threshold ${threshold}%)`);
}

// Always update last percentage
writeFileSync(lastPctFile, String(currentPct));

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

process.stdout.write(`${color}[${bar}] ${pctInt}%${reset}\n`);
