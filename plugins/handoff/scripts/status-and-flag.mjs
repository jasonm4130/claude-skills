#!/usr/bin/env node
// @ts-check
// statusLine command — renders context-fill bar, writes flag on first crossing.
// Reads JSON from stdin and outputs a single line of status text to stdout.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { readStdin, safeJsonParse, resolveSessionId, resolveDataDir } from "./lib.mjs";

/**
 * @typedef {Object} StatusInput
 * @property {string} [session_id]
 * @property {{ used_percentage?: number }} [context_window]
 */

function bail() {
  process.stdout.write("?\n");
  process.exit(0);
}

const raw = await readStdin();
const parsed = /** @type {StatusInput | null} */ (safeJsonParse(raw));
if (!parsed) bail();

const pctRaw = parsed && parsed.context_window ? parsed.context_window.used_percentage : undefined;
if (typeof pctRaw !== "number" || !Number.isFinite(pctRaw)) bail();

const currentPct = /** @type {number} */ (pctRaw);
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
