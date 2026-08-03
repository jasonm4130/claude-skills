#!/usr/bin/env node
// @ts-check
// PostToolUse hook: record which repos this session edited *source* in.
// Consumed by stop-check-context-md.mjs, which only nudges about a missing
// CONTEXT.md for a repo that actually saw source work — opening a terminal in
// a repo is not evidence you're doing domain work there.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  readStdin,
  safeJsonParse,
  resolveSessionId,
  resolveDataDir,
  findRepoRoot,
} from "./lib.mjs";

/**
 * @typedef {object} PostToolUseInput
 * @property {string} [session_id]
 * @property {string} [tool_name]
 * @property {{ file_path?: string, notebook_path?: string }} [tool_input]
 */

// Prose and config carry no domain vocabulary worth a glossary — editing a
// README or a lockfile must not arm the nudge.
const NON_SOURCE_EXT = new Set([
  ".md", ".mdx", ".txt", ".rst", ".adoc",
  ".json", ".jsonc", ".json5", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
  ".lock", ".csv", ".tsv", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
]);

const raw = await readStdin();
const payload = /** @type {PostToolUseInput | null} */ (safeJsonParse(raw));
if (!payload) process.exit(0);

const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
if (!/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(toolName)) process.exit(0);

const input = payload.tool_input ?? {};
const filePath =
  typeof input.file_path === "string" && input.file_path.length > 0
    ? input.file_path
    : typeof input.notebook_path === "string" && input.notebook_path.length > 0
      ? input.notebook_path
      : null;
if (!filePath) process.exit(0);

// An extension-less file is config, not domain source: `path.extname` returns
// "" for every dotfile and for bare names alike (`.env`, `.gitignore`,
// `Dockerfile`, `Makefile`, `LICENSE`), so without this they all slip past the
// deny-list below and arm an offer that can only ever be made once.
const ext = path.extname(filePath).toLowerCase();
if (ext === "" || NON_SOURCE_EXT.has(ext)) process.exit(0);

const repoRoot = findRepoRoot(path.dirname(path.resolve(filePath)));
if (!repoRoot) process.exit(0);

const sessionId = resolveSessionId(payload);
const dataDir = resolveDataDir("domain-modeling-data");
const editsFile = path.join(dataDir, `source-edits-${sessionId}.txt`);

// Dedupe on write — a long session edits the same repo hundreds of times and
// the Stop hook only ever needs the distinct set.
try {
  if (existsSync(editsFile)) {
    const seen = readFileSync(editsFile, "utf8").split("\n");
    if (seen.includes(repoRoot)) process.exit(0);
  }
  appendFileSync(editsFile, `${repoRoot}\n`);
} catch {
  // best-effort — a missed marker costs a nudge, not correctness
}
process.exit(0);
