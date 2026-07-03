// @ts-check
// Shared helpers for ship-gate plugin scripts. Stdlib only.
// Duplicated surface mirrors plugins/handoff/scripts/lib.mjs — CC plugins can't
// share files across plugin boundaries, so the duplication is intentional.

import { mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";

/**
 * Read all of stdin as a utf8 string.
 * @returns {Promise<string>}
 */
export async function readStdin() {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    process.stdin.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    process.stdin.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", reject);
  });
}

/**
 * Parse JSON without throwing.
 * @param {string} raw
 * @returns {object | null}
 */
export function safeJsonParse(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Resolve session_id from a parsed hook payload, with env fallback.
 * @param {object | null} payload
 * @returns {string}
 */
export function resolveSessionId(payload) {
  if (payload && typeof /** @type {any} */ (payload).session_id === "string") {
    const sid = /** @type {any} */ (payload).session_id;
    if (sid.length > 0) return sid;
  }
  const envSid = process.env.CLAUDE_SESSION_ID;
  if (typeof envSid === "string" && envSid.length > 0) return envSid;
  return "unknown";
}

/**
 * Resolve CLAUDE_PLUGIN_DATA, creating the directory if needed.
 * Falls back to `os.tmpdir() + "/<fallbackName>"`.
 * @param {string} fallbackName
 * @returns {string}
 */
export function resolveDataDir(fallbackName) {
  const fromEnv = process.env.CLAUDE_PLUGIN_DATA;
  const dir =
    typeof fromEnv === "string" && fromEnv.length > 0
      ? fromEnv
      : path.join(os.tmpdir(), fallbackName);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort; downstream writers will surface real errors
  }
  return dir;
}

/**
 * Emit a hookSpecificOutput envelope to stdout (issue #53682 safe form).
 * Writes a single JSON object plus trailing newline.
 * @param {string} eventName
 * @param {string} additionalContext
 */
export function emitAdditionalContext(eventName, additionalContext) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(payload) + "\n");
}

/**
 * ISO-8601 UTC timestamp ("YYYY-MM-DDTHH:MM:SSZ"). No fractional seconds.
 * @returns {string}
 */
export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
