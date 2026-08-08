#!/usr/bin/env node
// @ts-check
// PostToolUse hook: append one JSONL event to events-{session_id}.jsonl per
// tool use. Uses fs.appendFileSync, which on POSIX maps to O_APPEND (atomic
// per PIPE_BUF, typically 4KB). Safe enough on Windows for our concurrency
// (only this script writes to this file). Stop hook aggregates the events
// at evaluation time — see SKILL.md.
//
// Events are *enforced* under MAX_EVENT_BYTES rather than assumed to be small.
// The previous version assumed "events ≪ 4KB" and was wrong: 3108 events in
// the live store exceeded PIPE_BUF, the largest at 118,989 bytes, so parallel
// appends could interleave and corrupt lines. See the byte-budget block below.

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
 * @property {any} [tool_response]
 * @property {string} [tool_use_id]
 * @property {boolean} [is_error]
 * @property {any} [tool_error]
 */

// Keep the serialized line under PIPE_BUF so the O_APPEND atomicity claimed in
// the header actually holds. It did not before: 3108 events in the live store
// exceeded this, the largest at 118,989 bytes.
const MAX_EVENT_BYTES = 4096;
const MAX_ERR_CHARS = 200;

/**
 * Extract a bounded human-readable error string from a tool response.
 * @param {any} resp
 * @returns {string}
 */
function errText(resp) {
  let s;
  if (typeof resp === "string") s = resp;
  else if (resp && typeof resp === "object")
    s = typeof resp.error === "string" ? resp.error : JSON.stringify(resp);
  else s = String(resp);
  return s.slice(0, MAX_ERR_CHARS);
}

/**
 * Derive a tri-state outcome. `null` means "no signal in this payload" and must
 * never be coerced to false downstream — 43.6% of real tool results carry no
 * is_error at all, and a Bash response has no exit code, so stderr content and
 * failure are not distinguishable here. Inventing a boolean would manufacture
 * failures that never happened.
 * @param {PostToolUseInput} payload
 * @returns {{ ok: boolean | null, err?: string }}
 */
function deriveOutcome(payload) {
  const resp = payload.tool_response;
  // Precedence 1: explicit flag on the response object.
  if (resp && typeof resp === "object" && typeof resp.is_error === "boolean") {
    return resp.is_error ? { ok: false, err: errText(resp) } : { ok: true };
  }
  // Precedence 2: explicit flag on the payload envelope.
  if (typeof payload.is_error === "boolean") {
    return payload.is_error
      ? { ok: false, err: errText(resp ?? payload.tool_error) }
      : { ok: true };
  }
  // Precedence 3: a populated tool_error field.
  if (payload.tool_error) {
    return { ok: false, err: errText(payload.tool_error) };
  }
  // Precedence 4: no recognised signal. Unknown stays unknown.
  return { ok: null };
}

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

const outcome = deriveOutcome(payload ?? {});

/** @type {Record<string, any>} */
const event = {
  ts: nowIso(),
  v: 2,
  tool: toolName,
  input: payload && payload.tool_input !== undefined ? payload.tool_input : {},
  ok: outcome.ok,
};
if (outcome.err !== undefined) event.err = outcome.err;
if (payload && typeof payload.tool_use_id === "string")
  event.id = payload.tool_use_id;

// Budget enforcement. Only `input` is unbounded (a Write body, a long Bash
// command), so it is the only field clipped — ts/tool/ok/err/id are already
// small. On truncation `input` becomes a clipped JSON *string* rather than an
// object, and `input_truncated` marks it so downstream analysis can tell a
// short payload from a clipped one.
let line = JSON.stringify(event);
if (Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) {
  event.input = "";
  event.input_truncated = true;
  const overhead = Buffer.byteLength(JSON.stringify(event), "utf8");
  const room = MAX_EVENT_BYTES - overhead;
  const raw = JSON.stringify(
    payload && payload.tool_input !== undefined ? payload.tool_input : {},
  );
  // Clip conservatively: JSON-escaping can expand a char to up to 6 bytes.
  event.input = room > 0 ? raw.slice(0, Math.max(0, Math.floor(room / 6))) : "";
  line = JSON.stringify(event);
}

try {
  // O_APPEND on POSIX → atomic per PIPE_BUF (typically 4KB; an event line is
  // ~50–600 bytes). Race-free for parallel hook invocations.
  appendFileSync(eventsPath, line + "\n");
} catch {
  // best-effort — never crash the post-tool hook
}
process.exit(0);
