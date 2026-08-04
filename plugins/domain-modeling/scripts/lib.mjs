// @ts-check
// Shared helpers for domain-modeling plugin scripts. Stdlib only.
// Duplicated surface mirrors plugins/ship-gate/scripts/lib.mjs — CC plugins
// can't share files across plugin boundaries, so the duplication is intentional.

import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import process from "node:process";

/**
 * Read all of stdin as a utf8 string.
 * @returns {Promise<string>}
 */
export async function readStdin() {
  // A TTY never reaches EOF, so waiting for "end" would hang a hand-run script
  // forever. Hooks always pipe, so this only affects interactive invocation.
  if (process.stdin.isTTY) return "";
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
 * Path of the "already offered" claim file for a repo. One file per repo rather
 * than lines in a shared list: the consumer creates it with O_CREAT|O_EXCL, so
 * two concurrent sessions in the same repo can't both win the one-time offer.
 * The repo path goes in the file body, so the claims stay greppable.
 * @param {string} dataDir
 * @param {string} repo absolute repo root
 * @returns {string}
 */
export function repoClaimPath(dataDir, repo) {
  const digest = createHash("sha256").update(repo).digest("hex").slice(0, 16);
  return path.join(dataDir, `offered-${digest}.claim`);
}

/**
 * Walk up from `start` to the nearest directory containing `.git` (a dir for a
 * normal clone, a file for a worktree/submodule). Returns null if none found.
 *
 * The result is canonicalized, because the repo root is what `repoClaimPath`
 * hashes into the one-per-repo claim. Reaching the same checkout through a
 * symlink (`/tmp/repo-link` -> `/work/repo`) otherwise yields two different
 * digests, and a guarantee that reads "once per repo, ever" quietly becomes
 * once per path spelling.
 * @param {string} start absolute path to a file or directory
 * @returns {string | null}
 */
export function findRepoRoot(start) {
  let dir = path.resolve(start);
  try {
    dir = realpathSync(dir);
  } catch {
    // The directory may not exist yet (a Write creating a new tree). A lexical
    // path is still worth walking — it just doesn't get the symlink guarantee.
  }
  // `path.dirname` is pure string manipulation, so this converges on the
  // filesystem root on its own; the bound is belt-and-braces against an exotic
  // path that never reduces. It is derived from the path's own depth rather
  // than fixed, because a fixed bound is a silent miss for anything deeper: at
  // exactly 64 levels the old limit spent its last iteration on the leaf and
  // returned null without ever testing the root.
  const limit = dir.split(path.sep).length + 1;
  for (let i = 0; i < limit; i++) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}
