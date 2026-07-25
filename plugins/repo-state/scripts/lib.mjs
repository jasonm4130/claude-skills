// @ts-check
// Shared helpers for repo-state plugin scripts. Stdlib only.
// The readStdin/safeJsonParse/resolveSessionId/resolveDataDir/emitAdditionalContext
// surface mirrors plugins/ship-gate/scripts/lib.mjs — CC plugins can't share files
// across plugin boundaries, so the duplication is intentional.

import { mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import process from "node:process";

/** Repo-relative path of the artifact this plugin guards. */
export const STATE_DOC_REL = "docs/CURRENT_STATE.md";

/** Commits of drift before the doc is treated as stale. */
export const DEFAULT_THRESHOLD = 25;

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
 * Run git, exposing the exit status. `merge-base --is-ancestor` answers via exit
 * code (0 yes / 1 no / 128 broken), so the status has to survive.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{status: number, stdout: string}}
 */
export function gitRun(args, cwd) {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return {
    status: typeof res.status === "number" ? res.status : -1,
    stdout: (res.stdout || "").trim(),
  };
}

/**
 * Run git, returning stdout on success and null on any failure.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string | null}
 */
export function git(args, cwd) {
  const r = gitRun(args, cwd);
  return r.status === 0 ? r.stdout : null;
}

/**
 * Repo root for a cwd, or null when not inside a work tree.
 * @param {string} cwd
 * @returns {string | null}
 */
export function gitRepoRoot(cwd) {
  if (git(["rev-parse", "--is-inside-work-tree"], cwd) !== "true") return null;
  return git(["rev-parse", "--show-toplevel"], cwd);
}

/**
 * Read the stamp from the state doc.
 *
 * The stamp records the source commit the doc DESCRIBES — the parent of the
 * doc's own commit — because a committed file cannot carry the SHA of the commit
 * containing it: its bytes are an input to that hash.
 *
 * @param {string} repoRoot
 * @returns {{commit: string, generated: string} | null}
 */
export function readStamp(repoRoot) {
  let text;
  try {
    text = readFileSync(path.join(repoRoot, STATE_DOC_REL), "utf8");
  } catch {
    return null; // doc absent — this repo has not adopted repo-state
  }
  const m = /<!--\s*repo-state:\s*commit=([0-9a-fA-F]{7,40})\s+generated=(\S+)\s*-->/.exec(text);
  if (!m) return null; // present but unparseable — fail open, never block a session
  return { commit: m[1].toLowerCase(), generated: m[2] };
}

/**
 * Resolve the drift threshold from the environment.
 *
 * Strict: only a plain positive integer is honoured. `0`, negatives, decimals and
 * junk all fall back to the default — an unvalidated parse is the difference
 * between warning on every single turn and never warning at all.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function resolveThreshold(env = process.env) {
  const raw = env.REPO_STATE_DRIFT_THRESHOLD;
  if (typeof raw !== "string") return DEFAULT_THRESHOLD;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_THRESHOLD;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_THRESHOLD;
}

/**
 * @typedef {object} Drift
 * @property {boolean} stale
 * @property {"fresh"|"behind"|"diverged"|"unknown-commit"} reason
 * @property {number | null} count commits of non-doc drift, when countable
 */

/**
 * Measure drift between the doc's stamp and HEAD.
 *
 * Returns null for every "cannot tell" case (not a repo, git broken, shallow
 * clone) — the caller stays silent. This hook must never be the reason a session
 * breaks, so ambiguity always fails open.
 *
 * @param {string} repoRoot
 * @param {string} stampCommit
 * @param {number} threshold
 * @returns {Drift | null}
 */
export function computeDrift(repoRoot, stampCommit, threshold) {
  if (git(["rev-parse", "HEAD"], repoRoot) === null) return null;

  // Stamp object missing entirely: history was rewritten hard, or the doc was
  // copied in from elsewhere. Either way its claims are unverifiable.
  if (gitRun(["cat-file", "-e", `${stampCommit}^{commit}`], repoRoot).status !== 0) {
    return { stale: true, reason: "unknown-commit", count: null };
  }

  const ancestry = gitRun(["merge-base", "--is-ancestor", stampCommit, "HEAD"], repoRoot).status;
  if (ancestry === 1) return { stale: true, reason: "diverged", count: null };
  if (ancestry !== 0) return null; // 128 or spawn failure — cannot tell, stay quiet

  // Exclude the doc's own commits, or a refresh instantly re-arms itself at drift 1.
  const countRaw = git(
    ["rev-list", "--count", `${stampCommit}..HEAD`, "--", `:(exclude)${STATE_DOC_REL}`],
    repoRoot,
  );
  if (countRaw === null) return null;
  const count = Number.parseInt(countRaw, 10);
  if (!Number.isFinite(count)) return null;

  return count >= threshold
    ? { stale: true, reason: "behind", count }
    : { stale: false, reason: "fresh", count };
}

/**
 * One-line human description of why the doc is not trustworthy.
 * @param {Drift} drift
 * @returns {string}
 */
export function describeDrift(drift) {
  switch (drift.reason) {
    case "behind":
      return `${drift.count} commit(s) behind HEAD`;
    case "diverged":
      return "the commit it documents is no longer on this branch (rebased or force-pushed)";
    case "unknown-commit":
      return "the commit it documents does not exist in this repo";
    default:
      return "current";
  }
}
