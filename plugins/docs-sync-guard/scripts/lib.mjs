// @ts-check
// Shared helpers for docs-sync-guard plugin scripts. Stdlib only.
// Duplicated surface mirrors plugins/session-retro/scripts/lib.mjs — CC plugins can't
// share files across plugin boundaries, so the duplication is intentional.

import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
 * Emit a PreToolUse permission-decision envelope to stdout.
 * `deny` feeds `reason` back to Claude as feedback; `ask` prompts the user;
 * `allow` skips the interactive prompt. Writes a single JSON object plus newline.
 * @param {"allow" | "deny" | "ask"} decision
 * @param {string} reason
 */
export function emitPermissionDecision(decision, reason) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(payload) + "\n");
}

// ---------------------------------------------------------------------------
// Consolidation trigger (v0.3.0) — the non-blocking half of this plugin.
//
// The gate above answers "did this commit update its covering docs?". Everything
// below answers "have these docs drifted apart since anyone last checked them
// against each other?", and nudges out of band rather than blocking.
//
// THE RULE THAT SHAPES ALL OF IT: every anomaly returns null (caller stays silent),
// never "stale". A nudge toward optional work must never fire on "I cannot tell" —
// that is the effective false positive that gets a tool switched off. It is also
// what removes shallow-clone special-casing entirely: both shallow variants land on
// the missing-object / not-an-ancestor paths, which are already silent.
// ---------------------------------------------------------------------------

/** Repo-relative path of the consolidation record. */
export const RECORD_REL = ".docs-sync";

/**
 * Absolute path of the defer marker, which lives in `.git/` rather than in
 * CLAUDE_PLUGIN_DATA.
 *
 * The nudge flag and throttle are hook-only, so the plugin data dir suits them. The
 * defer marker is different: `/docs-consolidate --defer` writes it from a SESSION
 * shell, and CLAUDE_PLUGIN_DATA is not exported there (verified: unset in the Bash
 * tool's environment). Anything keyed off that variable would have the writer and the
 * reader disagreeing about the directory, and defer would silently never work.
 *
 * `.git/` is computable identically from both sides, is per-clone — which is exactly
 * the scope of "not now" — and is never committed.
 *
 * @param {string} repoRoot
 * @returns {string | null}
 */
export function deferMarkerPath(repoRoot) {
  const gitDir = git(["rev-parse", "--absolute-git-dir"], repoRoot);
  return gitDir === null ? null : path.join(gitDir, "docs-sync-defer");
}

/** Commits of drift before a consolidation pass is suggested. */
export const DEFAULT_CONSOLIDATE_THRESHOLD = 50;

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
 * Stable short hash of a repo root, for keying per-repo state files.
 * @param {string} repoRoot
 * @returns {string}
 */
export function repoHash(repoRoot) {
  return createHash("sha1").update(repoRoot).digest("hex").slice(0, 12);
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
 * Emit a hookSpecificOutput envelope carrying additionalContext.
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
 * NOTE: second-resolution, so it is NOT a reliable way to force a byte change in
 * the record. Callers must verify the file actually changed before committing.
 * @returns {string}
 */
export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Resolve the drift threshold from the environment.
 *
 * Strict: only a plain positive integer is honoured. `0`, negatives, decimals and
 * junk all fall back to the default — an unvalidated parse is the difference
 * between nudging on every single turn and never nudging at all.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {number}
 */
export function resolveConsolidateThreshold(env = process.env) {
  const raw = env.DOCS_SYNC_CONSOLIDATE_THRESHOLD;
  if (typeof raw !== "string") return DEFAULT_CONSOLIDATE_THRESHOLD;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_CONSOLIDATE_THRESHOLD;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CONSOLIDATE_THRESHOLD;
}

/**
 * Read the audited SHA from the consolidation record.
 *
 * TWO READS, TWO PURPOSES — do not collapse them, each catches a failure the other
 * does not:
 *
 *   working tree   existence only. Deleting the record is the opt-out, and it takes
 *                  effect immediately rather than waiting to be committed.
 *   HEAD:.docs-sync the authoritative SHA. An uncommitted record — `--init` whose
 *                  commit failed or was abandoned, or a hand-edited line — must not
 *                  be able to activate or reset the trigger, because that would
 *                  silence a stale repo with a file nobody committed.
 *
 * @param {string} repoRoot
 * @returns {string | null}
 */
export function readConsolidationStamp(repoRoot) {
  if (!existsSync(path.join(repoRoot, RECORD_REL))) return null;
  const committed = git(["show", `HEAD:${RECORD_REL}`], repoRoot);
  if (committed === null) return null;
  const m = /^docs-sync:\s*audited=([0-9a-fA-F]{7,40})\b/m.exec(committed);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Is `sha` a commit that exists here AND is an ancestor of HEAD?
 *
 * `false` means verified-not (missing object, or genuinely off this history).
 * `null` means the question could not be answered — git broken, exit 128, spawn
 * failure. Callers must treat null as "leave everything as it is": it is also what
 * a shallow clone produces, and deleting state on it would let one transient git
 * error erase a user's deliberate decision.
 *
 * @param {string} repoRoot
 * @param {string} sha
 * @returns {boolean | null}
 */
export function isAncestor(repoRoot, sha) {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return false;
  // `rev-parse --verify --quiet`, NOT `cat-file -e`: callers delete state on a
  // verified `false`, so "the object is gone" and "git could not answer" must not
  // collapse together. Measured exit codes (spawned directly, no shell):
  //
  //   rev-parse --verify --quiet <missing>^{commit}   → 1    (verified absent)
  //   rev-parse --verify --quiet <present>^{commit}   → 0
  //   ...outside a repository                         → 128  (cannot tell)
  //
  // `cat-file -e <missing>^{commit}` returns 128 for BOTH, because peeling an
  // object that isn't there is a fatal error rather than a negative answer.
  const exists = gitRun(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], repoRoot);
  if (exists.status === 1) return false;
  if (exists.status !== 0) return null;
  const anc = gitRun(["merge-base", "--is-ancestor", sha, "HEAD"], repoRoot);
  if (anc.status === 0) return true;
  if (anc.status === 1) return false;
  return null;
}

/**
 * @typedef {object} Drift
 * @property {boolean} stale
 * @property {number} count commits since the audited tree, INCLUDING the record commit
 */

/**
 * Measure drift between the audited commit and HEAD.
 *
 * `count` includes the record commit itself, so a fresh record reads 1 and the
 * nudge fires after `threshold - 1` further commits. Do NOT "fix" that off-by-one
 * with `-- ':(exclude).docs-sync'`: a pathspec triggers history simplification and
 * the count silently stops meaning what it appears to mean.
 *
 * @param {string} repoRoot
 * @param {string} stampCommit
 * @param {number} threshold
 * @returns {Drift | null}
 */
export function computeConsolidationDrift(repoRoot, stampCommit, threshold) {
  if (git(["rev-parse", "HEAD"], repoRoot) === null) return null;
  if (isAncestor(repoRoot, stampCommit) !== true) return null;

  const raw = git(["rev-list", "--count", `${stampCommit}..HEAD`], repoRoot);
  if (raw === null) return null;
  const count = Number.parseInt(raw, 10);
  if (!Number.isFinite(count)) return null;

  return { stale: count >= threshold, count };
}
