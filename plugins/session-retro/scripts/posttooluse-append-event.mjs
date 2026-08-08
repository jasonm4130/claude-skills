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
 * @property {string} [hook_event_name]
 * @property {boolean} [is_error]
 * @property {any} [error]
 * @property {any} [tool_error]
 */

// Keep the serialized line under PIPE_BUF so the O_APPEND atomicity claimed in
// the header actually holds. It did not before: 3108 events in the live store
// exceeded this, the largest at 118,989 bytes.
// PIPE_BUF is the guarantee boundary for the *whole append*, and we append
// `line + "\n"` — so the JSON itself gets one byte less than PIPE_BUF.
const PIPE_BUF = 4096;
const MAX_EVENT_BYTES = PIPE_BUF - 1;
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
 * Derive a tri-state outcome.
 *
 * The signal is WHICH HOOK EVENT FIRED, not a field. Captured from a live
 * session (2026-08-09): a successful call fires `PostToolUse` carrying a
 * tool-specific `tool_response` with no `is_error` and no `success` field
 * (Write: {content, filePath, originalFile, structuredPatch, type,
 * userModified}; Bash: {interrupted, isImage, noOutputExpected, stderr,
 * stdout}). A failing call fires `PostToolUseFailure` instead, with NO
 * `tool_response` at all and a top-level `error` string ("Exit code 7").
 *
 * So field-sniffing for `is_error` finds nothing on either path. The explicit
 * checks below are kept only as forward-compatible fallbacks for payload
 * shapes that do carry a flag; they are not the primary route.
 *
 * `null` means "this payload did not identify itself" — an unrecognised hook
 * event. Never coerce it to false downstream.
 *
 * @param {PostToolUseInput} payload
 * @returns {{ ok: boolean | null, err?: string }}
 */
function deriveOutcome(payload) {
  const resp = payload.tool_response;
  const evName = payload.hook_event_name;

  // Explicit flags win when a payload actually carries one.
  if (resp && typeof resp === "object" && typeof resp.is_error === "boolean") {
    return resp.is_error ? { ok: false, err: errText(resp) } : { ok: true };
  }
  if (typeof payload.is_error === "boolean") {
    return payload.is_error
      ? { ok: false, err: errText(payload.error ?? resp ?? payload.tool_error) }
      : { ok: true };
  }

  // The real production path: the event name is the outcome.
  if (evName === "PostToolUseFailure") {
    return {
      ok: false,
      err: errText(payload.error ?? payload.tool_error ?? "tool call failed"),
    };
  }
  if (evName === "PostToolUse") return { ok: true };

  // Last resort for an unnamed payload that still carries an error field.
  if (payload.error || payload.tool_error) {
    return { ok: false, err: errText(payload.error ?? payload.tool_error) };
  }
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
