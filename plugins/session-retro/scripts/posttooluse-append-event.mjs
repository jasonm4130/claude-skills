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
  classifyCommand,
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

// Fields the Stop aggregator pattern-matches over. Clipped last — see the
// budget block below.
const CLASSIFIER_KEYS = new Set(["command"]);

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

// Classify the FULL command before the byte budget can clip it. A >4KB command
// with `npm test` in the middle would otherwise lose the classifier to any
// head+tail clip, and Stop would miss the "ran tests" trigger.
const clf = classifyCommand(/** @type {any} */ (event.input)?.command);
if (clf) event.clf = clf;

// Budget enforcement. Only `input` is unbounded (a Write body, a long Bash
// command), so it is the only field clipped — ts/tool/ok/err/id are already
// small.
//
// `input` MUST stay an object. The Stop aggregator reads input.file_path and
// input.command and falls back to {} for a non-object, so stringifying the
// whole payload silently zeroed "files touched" and stopped long Bash commands
// matching the tests/commit regexes. Instead, clip the longest string values in
// place — short structured keys like file_path survive untouched — and clip
// from the middle so a command's head and tail both remain matchable.
// `input_truncated` lists the clipped keys.
let line = JSON.stringify(event);
if (Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) {
  /** @type {Record<string, any>} */
  const clipped = { ...(event.input && typeof event.input === "object" ? event.input : {}) };
  /** @type {string[]} */
  const marks = [];

  // Repeatedly halve the longest string value until the line fits.
  for (let guard = 0; guard < 40; guard++) {
    event.input = clipped;
    event.input_truncated = marks.length ? marks : true;
    line = JSON.stringify(event);
    if (Buffer.byteLength(line, "utf8") <= MAX_EVENT_BYTES) break;

    // `command` carries the classifiers the Stop hook greps for (test runs,
    // commits), and they can sit anywhere in the string — a middle-of-command
    // `npm test` is lost to any head+tail clip. So spend the whole budget on
    // the other fields first and only clip `command` when nothing else can
    // give. Residual limit: a single command over the budget is still clipped
    // and can lose a classifier. That is unavoidable at a fixed line size.
    let key = "";
    let len = 0;
    for (const pass of [0, 1]) {
      for (const k of Object.keys(clipped)) {
        if (pass === 0 && CLASSIFIER_KEYS.has(k)) continue;
        const v = clipped[k];
        const l =
          typeof v === "string" ? v.length : JSON.stringify(v ?? "").length;
        if (l > len) {
          len = l;
          key = k;
        }
      }
      if (key && len > 16) break;
    }
    if (!key || len <= 16) break;

    const v = clipped[key];
    const s = typeof v === "string" ? v : JSON.stringify(v);
    const keep = Math.max(8, Math.floor(s.length / 2));
    const head = Math.ceil(keep / 2);
    const tail = keep - head;
    clipped[key] = s.slice(0, head) + "…" + s.slice(s.length - tail);
    if (!marks.includes(key)) marks.push(key);
  }
}

try {
  // O_APPEND on POSIX → atomic per PIPE_BUF (typically 4KB; an event line is
  // ~50–600 bytes). Race-free for parallel hook invocations.
  appendFileSync(eventsPath, line + "\n");
} catch {
  // best-effort — never crash the post-tool hook
}
process.exit(0);
