#!/usr/bin/env node
// @ts-check
// PostToolUse hook: append one JSONL event to events-{session_id}.jsonl per
// tool use. Uses fs.appendFileSync, which on POSIX maps to O_APPEND (atomic
// per PIPE_BUF for events ≪ 4KB). Safe enough on Windows for our concurrency
// (only this script writes to this file). Stop hook aggregates the events
// at evaluation time — see SKILL.md.

import { appendFileSync } from "node:fs";
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
 * @typedef {object} PostToolUseInput
 * @property {string} [session_id]
 * @property {string} [tool_name]
 * @property {object} [tool_input]
 */

const raw = await readStdin();
const payload = /** @type {PostToolUseInput | null} */ (safeJsonParse(raw));

const toolName =
  payload && typeof payload.tool_name === "string" ? payload.tool_name : "";
if (!toolName) {
  process.exit(0);
}

const sessionId = resolveSessionId(payload);
const dataDir = resolveDataDir("session-retro-data");
const eventsPath = path.join(dataDir, `events-${sessionId}.jsonl`);

const event = {
  ts: nowIso(),
  tool: toolName,
  input: payload && payload.tool_input !== undefined ? payload.tool_input : {},
};

try {
  // O_APPEND on POSIX → atomic per PIPE_BUF (typically 4KB; an event line is
  // ~50–600 bytes). Race-free for parallel hook invocations.
  appendFileSync(eventsPath, JSON.stringify(event) + "\n");
} catch {
  // best-effort — never crash the post-tool hook
}
process.exit(0);
