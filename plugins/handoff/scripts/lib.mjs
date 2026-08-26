// @ts-check
// Shared helpers for handoff plugin scripts. Stdlib only.

import {
  readFileSync,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  realpathSync,
  constants,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
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

/**
 * Does git TRACK this file? If so, the repo shipped it — this machine did not write it.
 *
 * This is the provenance test the pending-handoff loader was missing. Containment (`readContainedFile`)
 * stops a marker from reading files OUTSIDE handoffs/; it does nothing about a hostile repo that simply
 * COMMITS its own `.claude/handoffs/evil.md` plus a `.pending` naming it. The loader then announces
 * attacker-authored text as "from your previous session" — the framing that gets a model to act on it as
 * its own notes rather than treat it as untrusted repo data.
 *
 * The invariant that closes it: handoffs are gitignored BY DESIGN (the skill tells you to add
 * `/.claude/handoffs/`). So:
 *   - a handoff this machine wrote is untracked, always;
 *   - a fresh clone CANNOT produce an untracked-but-present ignored file — git will not create one.
 * Therefore, for the realistic attack (clone a hostile repo), "tracked" is an exact test for
 * "attacker-supplied", with no new state, no hash index, and no user friction.
 *
 * Fails OPEN — returns false — when git is absent, this is not a repo, or the call errors: no repo means
 * no repo-supplied hazard, and refusing a legitimate handoff is a worse failure than the bug. Never
 * throws and always bounded: this runs on SessionStart and must not wedge startup.
 *
 * ASK GIT FROM THE FILE'S OWN DIRECTORY, not from the project root. Running `git -C <projectRoot>` only
 * ever consults the OUTERMOST repo, and a hostile parent can make `.claude/handoffs/` a SUBMODULE: the
 * parent then tracks nothing but a gitlink, `ls-files` reports the payload as untracked, and the whole
 * guard waves it through — while `clone --recurse-submodules` populates it for real. Running git from
 * the containing directory resolves the INNERMOST repo that actually governs the file, which is the one
 * whose answer matters. It is also correct in the ordinary case: git walks up to the project repo.
 *
 * @param {string} dir       directory to resolve the repository from — pass the file's own directory
 * @param {string} filePath  absolute path to test
 * @returns {boolean}        true only if git positively reports the file as tracked
 */
export function gitTracksFile(dir, filePath) {
  try {
    const r = spawnSync("git", ["-C", dir, "ls-files", "--error-unmatch", "--", filePath], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return r.status === 0;
  } catch {
    return false;
  }
}
