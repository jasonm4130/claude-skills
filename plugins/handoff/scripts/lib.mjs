// @ts-check
// Shared helpers for handoff plugin scripts. Stdlib only.

import {
  mkdirSync,
  readFileSync,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  realpathSync,
  constants,
} from "node:fs";
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

/**
 * @typedef {Object} AssistantUsage
 * @property {number} inputTokens
 * @property {number} cacheCreationTokens
 * @property {number} cacheReadTokens
 */

/**
 * Scan a JSONL transcript file backwards for the last main-chain assistant
 * entry and return its token usage. Main-chain = type "assistant" AND
 * isSidechain !== true. Returns null if the file doesn't exist, is empty,
 * has no matching entry, or any I/O error occurs.
 * @param {string} transcriptPath - Absolute path to the session's JSONL file.
 * @returns {AssistantUsage | null}
 */
export function lastAssistantUsageFromTranscript(transcriptPath) {
  /** @type {string} */
  let content;
  try {
    content = readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }

  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    /** @type {any} */
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      entry !== null &&
      typeof entry === "object" &&
      entry.type === "assistant" &&
      entry.isSidechain !== true
    ) {
      const usage = entry.message && entry.message.usage ? entry.message.usage : {};
      return {
        inputTokens: Number(usage.input_tokens ?? 0) || 0,
        cacheCreationTokens: Number(usage.cache_creation_input_tokens ?? 0) || 0,
        cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0) || 0,
      };
    }
  }
  return null;
}

// POSIX-only flags; undefined on Windows, where we fall back to 0 and rely on the
// (necessarily non-atomic) lstat pre-check. Windows has no filesystem FIFOs reachable
// this way, so the blocking hazard O_NONBLOCK guards against does not apply there.
const O_NOFOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const O_NONBLOCK = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;

/**
 * Read `name` from `baseDir` without following anything out of it.
 *
 * Deliberately not resolve-then-read: a validate-then-read is a TOCTOU — the validated
 * file can be swapped for a symlink before the read. `name` must be a bare filename, and
 * the file is opened once with O_NOFOLLOW, so the descriptor we validate is the
 * descriptor we read.
 *
 * O_NONBLOCK matters: a plain open() on a FIFO blocks until a writer appears, so an
 * fstat-based regular-file check would never run and a planted FIFO would hang
 * SessionStart.
 *
 * Threat model: a hostile *checked-out repo* (static files). A concurrently running local
 * attacker could still swap an intermediate directory between checks — Node has no openat
 * — but such an attacker can read your files directly anyway. This refuses reads that
 * escape the directory; it does not establish that the file's *author* was trusted.
 *
 * Refuses (returns null, never throws — the content is attacker-controlled): non-bare
 * names, traversal, NUL bytes, missing files, symlinked final components, and anything
 * that is not a regular file.
 *
 * @param {string} baseDir
 * @param {string} name
 * @returns {string | null}
 */
export function readContainedFile(baseDir, name) {
  if (typeof name !== "string" || name.length === 0) return null;
  if (name !== path.basename(name) || name === "." || name === "..") return null;
  const target = path.join(baseDir, name);
  /** @type {number | undefined} */
  let fd;
  try {
    if (lstatSync(target).isSymbolicLink()) return null; // fast refusal; O_NOFOLLOW is the real guard
    fd = openSync(target, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return null;
    return readFileSync(fd, "utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * True when `dir` really lives inside `rootDir` — realpath'd, so a symlinked
 * .claude/handoffs pointing at /etc does not pass. Uses path.relative, not a string
 * prefix: startsWith("/root") would accept the sibling "/root-evil".
 * @param {string} rootDir
 * @param {string} dir
 * @returns {boolean}
 */
export function dirContainedIn(rootDir, dir) {
  try {
    const root = realpathSync(path.resolve(rootDir));
    const real = realpathSync(path.resolve(dir));
    const rel = path.relative(root, real);
    return rel === "" ? true : !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}
