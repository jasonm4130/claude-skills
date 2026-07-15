#!/usr/bin/env node
// @ts-check
// codex-review.mjs — deterministic mechanics for the codex-plan-review skill.
// Spec: docs/superpowers/specs/2026-07-14-codex-plan-review-design.md
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { dirname, resolve as resolvePath, relative as relativePath } from "node:path";
import {
  readFileSync, appendFileSync, mkdirSync, openSync, closeSync, writeSync,
  unlinkSync, statSync, existsSync, renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";
import { parseArgs } from "node:util";

export function parseEventStream(stdoutText) {
  let sessionId = null, finalMessage = null, terminal = "missing", usage = null;
  for (const line of stdoutText.split("\n")) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev !== "object") continue;
    if (ev.type === "thread.started" && ev.thread_id) sessionId = ev.thread_id;
    if (ev.type === "item.completed" && ev.item?.type === "agent_message") finalMessage = ev.item.text ?? finalMessage;
    if (ev.type === "turn.completed" && terminal !== "failed") { terminal = "completed"; usage = ev.usage ?? null; }
    if (ev.type === "turn.failed" || ev.type === "error") terminal = "failed"; // sticky — a later turn.completed must not mask it
  }
  return { sessionId, finalMessage, terminal, usage };
}

export function parseVerdict(text, mode) {
  const re = isAuditMode(mode) ? /AUDIT:\s*(PASS|CONCERNS)/g : /VERDICT:\s*(APPROVED|REVISE)/g;
  let last = null;
  for (const m of (text ?? "").matchAll(re)) last = m[1];
  return last ?? "UNPARSEABLE";
}

export function countFindings(text) {
  const counts = { p1: 0, p2: 0, p3: 0 };
  for (const line of (text ?? "").split("\n")) {
    const m = line.match(/\[(P[123])\]/);
    if (m) counts[m[1].toLowerCase()] += 1;
  }
  return counts;
}

const REVIEW_BODY = (relPath) => `You are an adversarial design reviewer. Review the design/plan document at \`${relPath}\`.

Default to skepticism: your job is to break confidence in this artifact, not to validate it. Assume it can fail until the evidence says otherwise. Hunt for: hidden assumptions, failure modes, missing error handling, underspecified interfaces, internal contradictions, and scope creep. Where the document makes claims about code, files, or tools in this repository, check them (read-only).

Report findings as a bullet list, each tagged [P1] (must fix before implementation), [P2] (should fix), or [P3] (nit). For each finding, name the concrete scenario in which the design fails — a finding you cannot tie to a specific failure is not a finding. Severity must be proportionate to the artifact's scope — do not demand enterprise patterns from small local tooling. Do not rubber-stamp; equally, do not manufacture findings — if the design is sound, an APPROVED verdict with zero findings is the correct and expected result, not a failure to look hard enough.

End your final message with exactly one line: VERDICT: APPROVED or VERDICT: REVISE (REVISE if any P1 or P2 finding exists).`;

export function buildReviewPrompt(relPath) { return REVIEW_BODY(relPath); }

export function buildResumePrompt(relPath) {
  return `The artifact at \`${relPath}\` has been revised in response to your findings. Re-review: verify each prior finding is addressed, flag any that are not, and check the revisions did not introduce new problems. Same reporting format. If every prior finding is resolved and you find no new ones, an APPROVED verdict is the correct result — do not hold the artifact open for polish. End your final message with exactly one line: VERDICT: APPROVED or VERDICT: REVISE.`;
}

export function buildAuditPrompt(relPath) {
  return `You are performing a final holistic audit of the design/plan document at \`${relPath}\`. A separate detailed review process has already examined this artifact section by section; your job is NOT another section-by-section pass. Assess the artifact as a whole: internal consistency across sections, completeness (is anything load-bearing missing entirely?), feasibility of the overall approach, and systemic risks that only appear when reading it end to end. Where the document makes claims about this repository, you may check them (read-only). Report at most 5 findings, whole-artifact in scope, same [P1]/[P2]/[P3] tagging. End your final message with exactly one line: AUDIT: PASS or AUDIT: CONCERNS.`;
}

export function buildRetryPrompt(mode) {
  return isAuditMode(mode)
    ? "Your previous message was missing the audit line — end with AUDIT: PASS or AUDIT: CONCERNS."
    : "Your previous message was missing the verdict line — end with VERDICT: APPROVED or VERDICT: REVISE.";
}

/** @param {string} mode */
export function isAuditMode(mode) { return mode === "audit" || mode === "diff-audit"; }
/** @param {string} mode */
export function isDiffMode(mode) { return mode === "diff" || mode === "diff-audit"; }

/**
 * The EXACT command the reviewer is told to run. It must carry --no-textconv/--no-ext-diff, or Codex
 * re-runs an unprotected `git diff` inside its sandbox and a repo-configured driver executes anyway —
 * making our own protection in resolveDiff() pointless. It also guarantees the reviewer sees the same
 * bytes we hashed.
 * @param {string} pinnedRange
 */
const DIFF_CMD = (pinnedRange) => `git diff --no-textconv --no-ext-diff ${pinnedRange} --`;

/** Files git will not diff must be NAMED, never silently absent — silence reads as "nothing to see". */
const undiffableNote = (undiffable) =>
  undiffable.length === 0
    ? ""
    : `\n\nNOT SHOWN in the diff (git will not render them — binary, or marked \`-diff\` in .gitattributes). Their contents changed but you cannot see how. Read them directly if they matter, and treat an unreviewable source file as suspicious in itself:\n${undiffable.map((f) => `- ${f}`).join("\n")}`;

const DIFF_BODY = (range, files, undiffable) => `You are an adversarial code reviewer. Review the changes in \`${range}\` in this repository.

Run \`${DIFF_CMD(range)}\` to see them, and read the surrounding files for context — a diff read in isolation hides most real bugs. Files changed:
${files.map((f) => `- ${f}`).join("\n")}${undiffableNote(undiffable)}

Default to skepticism: your job is to find what is BROKEN, not to validate the change. Assume it is wrong until the code says otherwise. Hunt for: logic errors, off-by-one and boundary bugs, race conditions and TOCTOU, unhandled errors and swallowed exceptions, resource leaks, injection and path traversal, incorrect edge-case handling, and tests that assert nothing or cannot fail.

For each finding give the file and line, and name the concrete input or interleaving that triggers it and what breaks. Treat this as a gate, not a formality: if you cannot name the input that makes it fail, do not report it — not even as a nit. A finding I cannot reproduce from your description is not a finding.

Report as a bullet list, each tagged [P1] (a real bug — must fix), [P2] (should fix), or [P3] (nit). Severity must be proportionate: this is small local tooling, not a distributed system, and it tracks what actually breaks, not how hard you looked. Do not restate the diff, and do not rubber-stamp — but skepticism is about the code, not a quota of findings. If the change is sound, an APPROVED verdict with zero findings is the correct and expected result; do not manufacture or inflate findings to prove you reviewed.

End your final message with exactly one line: VERDICT: APPROVED or VERDICT: REVISE (REVISE if any P1 or P2 finding exists).`;

/** @param {string} pinnedRange @param {string[]} files @param {string[]} undiffable @returns {string} */
export function buildDiffPrompt(pinnedRange, files, undiffable = []) {
  return DIFF_BODY(pinnedRange, files, undiffable);
}

/** @param {string} pinnedRange @param {string[]} undiffable @returns {string} */
export function buildDiffResumePrompt(pinnedRange, undiffable = []) {
  // Deliberately NEUTRAL. Saying "the code has changed in response to your findings" is exactly the
  // implementer framing the Global Constraints forbid — it invites the reviewer to confirm the fixes
  // rather than attack them. Framing degraded findings 3-4x in testing; that rule has no exception for
  // resume rounds.
  return `The code has changed. The new range is \`${pinnedRange}\`. Run \`${DIFF_CMD(pinnedRange)}\` and review it again from scratch: check whether each issue you raised earlier is actually gone from the code (not merely moved, renamed, or commented), and hunt for new problems the changes introduced. Same reporting format and severity rubric.${undiffableNote(undiffable)}

If your earlier issues are genuinely gone and no new ones survive the reproducibility gate, an APPROVED verdict is the correct result — do not keep the change open for polish.

End your final message with exactly one line: VERDICT: APPROVED or VERDICT: REVISE.`;
}

/** @param {string} pinnedRange @param {string[]} undiffable @returns {string} */
export function buildDiffAuditPrompt(pinnedRange, undiffable = []) {
  return `You are performing a final holistic audit of the change \`${pinnedRange}\`. A separate detailed review has already gone through it hunk by hunk; your job is NOT another line-by-line pass. Run \`${DIFF_CMD(pinnedRange)}\` and assess the change AS A WHOLE: does it hang together, does it do what its code implies consistently across every file it touches, are there systemic risks or incoherences that only appear when reading it end to end, and is anything load-bearing missing entirely (an error path, a test, a caller not updated)? Report at most 5 findings, whole-change in scope, same [P1]/[P2]/[P3] tagging.${undiffableNote(undiffable)}

End your final message with exactly one line: AUDIT: PASS or AUDIT: CONCERNS.`;
}

const DEFAULT_TIMEOUT_S = 300;

export function parseTimeoutS(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_TIMEOUT_S;
}

export function contentHashOf(buffer) {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 16);
}

export function mintChainId(relPath, contentHash, ts, entropy = "") {
  return createHash("sha256").update(`${relPath}\0${contentHash}\0${ts}\0${entropy}`).digest("hex").slice(0, 12);
}

export function resolveRepoRoot(artifactAbsPath) {
  const dir = dirname(artifactAbsPath);
  try {
    // stderr ignored: the fallback path (non-repo / missing dir) is expected,
    // and git's "fatal: ..." must not leak into the caller's output stream.
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return dir;
  }
}

/**
 * The repo root containing a DIRECTORY.
 *
 * resolveRepoRoot() takes a FILE path and dirname()s it first, so reusing it here would resolve the
 * PARENT directory's repo — silently running every git command in the wrong place. Its file semantics
 * have existing callers; leave it alone and use this for directories.
 *
 * @param {string} dir
 * @returns {string}
 */
export function repoRootOfDir(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return dir;
  }
}

/**
 * Is this string safe to hand to `git diff` as a range?
 *
 * We spawn git with an argv array, so shell metacharacters cannot inject. But argv is not safety by
 * itself: git parses a leading `-` as a FLAG, and `git diff --output=/tmp/x` WRITES A FILE — inside a
 * tool whose whole safety story is a read-only sandbox.
 *
 * An explicit `..`/`...` range is REQUIRED. A bare ref means "diff the working tree against it", which
 * folds uncommitted changes into the review and makes it unreproducible from the chain record.
 *
 * @param {unknown} range
 * @returns {boolean}
 */
export function isSafeGitRange(range) {
  if (typeof range !== "string" || range.length === 0 || range.length > 200) return false;
  if (range.startsWith("-")) return false; // git would read it as a flag

  // EXACTLY ONE separator. A ref may legally contain dots, so a naive `^REF\.{2,3}REF$` pattern
  // accepts "HEAD..HEAD~1..HEAD" (the second "ref" swallows "HEAD~1..HEAD"). resolveDiff then does
  // `range.split("..")` and destructures only the first two parts — silently reviewing HEAD..HEAD~1,
  // the wrong range, REVERSED, while reporting success. Reviewing the wrong thing and calling it a
  // pass is the exact failure this module exists to prevent.
  const refs = range.split(/\.{2,3}/);
  if (refs.length !== 2) return false;

  const REF = /^[A-Za-z0-9][A-Za-z0-9._/~^-]*$/;
  return refs.every((r) => REF.test(r) && !r.includes(".."));
}

/**
 * Coerce a --max-lines value. Throws on anything that is not a finite positive integer.
 *
 * Written carefully on purpose: `Number("NaN")` is `NaN`, and **`NaN <= 0` is `false`** — so the
 * obvious "reject non-positive" check lets NaN straight through and silently disables the cap.
 * `Infinity` slips past it too.
 *
 * @param {unknown} raw
 * @returns {number}
 */
export function parseMaxLines(raw) {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw err("BAD_MAX_LINES", `--max-lines must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

const MAX_DIFF_BYTES = 400_000;

/**
 * Resolve a git range to its diff, pinned to immutable commit SHAs.
 *
 * Pinning is not a nicety: we hash the diff for the chain record, then tell Codex to run `git diff`
 * itself. If we handed it a symbolic range, a HEAD that moved in between would make the reviewer read
 * different content than the chain recorded — the audit trail would be a lie.
 *
 * Throws a tagged error rather than returning junk: an empty or truncated review that reports
 * VERDICT: APPROVED is worse than no review at all.
 *
 * @param {string} repoRoot
 * @param {string} range
 * @param {{maxLines: number, maxBytes: number}} limits
 * @returns {{text: string, pinnedRange: string, base: string, head: string, lines: number,
 *            bytes: number, files: string[], undiffable: string[]}}
 */
export function resolveDiff(repoRoot, range, limits) {
  if (!isSafeGitRange(range)) {
    throw err("BAD_RANGE", `unsafe or malformed git range: ${JSON.stringify(range)}`);
  }

  // core.quotePath=false: without it git C-quotes any path with a space or non-ASCII character
  // (`"src/\303\251.mjs"`), and we would name a mangled path in the prompt.
  /** @param {string[]} args */
  const git = (args) =>
    execFileSync("git", ["-C", repoRoot, "-c", "core.quotePath=false", ...args], {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });

  const threeDot = range.includes("...");
  const [left, right] = range.split(threeDot ? "..." : "..");

  let base, head;
  try {
    head = git(["rev-parse", "--verify", `${right}^{commit}`]).trim();
    base = threeDot
      ? git(["merge-base", left, right]).trim()          // A...B = changes on B since it left A
      : git(["rev-parse", "--verify", `${left}^{commit}`]).trim();
  } catch (e) {
    throw err("BAD_RANGE", `git could not resolve ${JSON.stringify(range)}: ${String(e.message).split("\n")[0]}`);
  }

  const pinnedRange = `${base}..${head}`;
  // --no-textconv / --no-ext-diff: git's textconv and external-diff drivers EXECUTE configured
  // programs — host-side code execution, outside Codex's read-only sandbox. These flags must appear
  // on EVERY diff invocation, including the one we tell Codex to run (see DIFF_CMD in Task 2).
  const NO_EXEC = ["--no-textconv", "--no-ext-diff"];

  let text, numstat;
  try {
    text = git(["diff", ...NO_EXEC, pinnedRange, "--"]);
    numstat = git(["diff", ...NO_EXEC, "--numstat", pinnedRange, "--"]);
  } catch (e) {
    throw err("BAD_RANGE", `git diff failed for ${pinnedRange}: ${String(e.message).split("\n")[0]}`);
  }

  // numstat prints "added\tdeleted\tpath", with "-\t-" for anything git will not diff: binaries, and
  // — the nasty one — any file a .gitattributes marks `-diff`. Such a file is INVISIBLE in the diff
  // text while still looking like a healthy change. A repo could hide real source from the reviewer.
  /** @type {string[]} */ const files = [];
  /** @type {string[]} */ const undiffable = [];
  for (const row of numstat.split("\n")) {
    if (!row.trim()) continue;
    const [add, del, ...rest] = row.split("\t");
    const p = rest.join("\t").trim();
    if (!p) continue;
    (add === "-" && del === "-" ? undiffable : files).push(p);
  }

  if (files.length === 0) {
    throw err(
      "EMPTY_DIFF",
      undiffable.length > 0
        ? `range ${range} (${pinnedRange}) changes only files git will not diff (${undiffable.join(", ")}) — nothing reviewable`
        : `range ${range} (${pinnedRange}) is empty — nothing to review`,
    );
  }
  if (text.trim().length === 0) {
    throw err("EMPTY_DIFF", `range ${range} (${pinnedRange}) produced no diff text — nothing to review`);
  }

  // Strip the trailing newline first: git's diff ends with one, so split("\n") yields an empty final
  // element and a diff of exactly maxLines would be counted as maxLines + 1 and wrongly refused.
  const lines = text.replace(/\n$/, "").split("\n").length;
  const bytes = Buffer.byteLength(text, "utf8");
  // Lines alone do not bound context: a minified bundle is one line and many megabytes.
  if (lines > limits.maxLines || bytes > limits.maxBytes) {
    throw err(
      "DIFF_TOO_LARGE",
      `diff is ${lines} lines / ${bytes} bytes (limits ${limits.maxLines} / ${limits.maxBytes}) across ` +
        `${files.length} files — narrow the range or raise --max-lines. Refusing rather than ` +
        `truncating: a truncated review that returns APPROVED is worse than no review.`,
    );
  }
  return { text, pinnedRange, base, head, lines, bytes, files, undiffable };
}

export const OUTCOMES = ["audit-pass", "audit-concerns-user-approved", "audit-concerns-dismissed", "cap-revise", "aborted"];

export function logPathDefault() {
  return process.env.CODEX_REVIEW_LOG || joinPath(homedir(), ".claude", "codex-review-log.jsonl");
}

function err(code, message) { const e = new Error(message); e.code = code; return e; }

export function readLogLines(logPath, { strict = false } = {}) {
  let raw;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw err("LOG_UNREADABLE", `log read failed: ${e.message}`); // unreadable must never look empty
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A truncated reservation must not look absent to the guard/notes.
      if (strict) throw err("LOG_CORRUPT", `malformed log line (repair ${logPath} manually): ${line.slice(0, 80)}`);
    }
  }
  return out;
}

/**
 * EXTRA grace for an unparseable lock, ON TOP of the lease — not a competing absolute.
 *
 * A bare `age > EMPTY_LOCK_GRACE_MS` reads as "a far longer grace" but is not one: with a 120s lease
 * and a 60s constant, an empty lock becomes breakable at 120s — the same instant a pid-bearing one
 * does. The grace has silently evaporated at exactly the lease lengths where a mid-write window is
 * most likely. Adding it to staleMs makes it strictly longer for every lease.
 */
const EMPTY_LOCK_GRACE_MS = 60_000;

/** @param {number} pid */
function holderAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return Boolean(e) && /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
  }
}

/**
 * Is this lock breakable? Past its lease AND its holder provably gone.
 *
 * Age alone is NOT enough. Two breakers who both judge the same lock stale on age will cascade: the
 * first breaks it and re-acquires; the second then renames away the FIRST's fresh lock and acquires
 * too, leaving two holders. The rename is atomic; the DECISION to break was made against a lock that
 * no longer exists.
 *
 * An unparseable pid is not proof of death either — an empty file is exactly what a lock looks like
 * between openSync("wx") and writeSync(). But it cannot be immortal, or a crash in that window wedges
 * the log forever; so give it the lease PLUS an extra grace (see EMPTY_LOCK_GRACE_MS: a bare
 * `age > EMPTY_LOCK_GRACE_MS` is not a longer grace at all once staleMs exceeds the constant).
 *
 * @param {string} lockPath
 * @param {number} staleMs
 * @returns {boolean}
 */
function lockIsBreakable(lockPath, staleMs) {
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age <= staleMs) return false;
    const pid = Number.parseInt(String(readFileSync(lockPath, "utf8")).trim().split("-")[0], 10);
    // Mid-write, or a corpse. Strictly more grace than a pid-bearing lock gets, at ANY lease length.
    if (!Number.isInteger(pid) || pid <= 0) return age > staleMs + EMPTY_LOCK_GRACE_MS;
    return !holderAlive(pid);
  } catch {
    return false; // vanished or unreadable — nothing to break
  }
}

export function acquireLock(lockPath, staleMs = 30_000) {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, token);
      closeSync(fd);
      return token;
    } catch (e) {
      if (e.code !== "EEXIST") throw err("RESERVE_FAILED", `lock create failed: ${e.message}`);
      // Capture WHICH lock we are judging. Without this, a break decided against the old lock can be
      // executed against a replacement's fresh one — the double-breaker bug.
      let victim = "";
      try { victim = String(readFileSync(lockPath, "utf8")); } catch { continue; } // vanished — retry

      if (lockIsBreakable(lockPath, staleMs)) {
        const tmp = `${lockPath}.stale-${token}`;
        try {
          renameSync(lockPath, tmp);
          if (String(readFileSync(tmp, "utf8")) === victim) {
            unlinkSync(tmp);          // it really was the lock we judged — break it
          } else {
            renameSync(tmp, lockPath); // NOT ours to break: a fresh holder replaced it. Put it back…
            throw err("LOCK_HELD", `lock held: ${lockPath}`); // …and abort, rather than acquire on top.
          }
        } catch (e) {
          if (e && e.code === "LOCK_HELD") throw e;
          // another breaker won the rename — fall through and retry the acquire
        }
        continue;
      }
      throw err("LOCK_HELD", `lock held: ${lockPath}`);
    }
  }
  throw err("LOCK_HELD", `lock contention: ${lockPath}`);
}

export function releaseLock(lockPath, token) {
  // Ownership-safe: only delete a lock we still own — a stale ex-holder must not
  // remove the replacement holder's lock.
  try {
    if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath);
  } catch { /* already gone or unreadable — leave it */ }
}

function chainStates(lines) {
  // chainId -> {open: line, note: line|null}
  const chains = new Map();
  for (const l of lines) {
    if (l.mode === "open") chains.set(l.chainId, { open: l, note: null });
    else if (l.mode === "note" && chains.has(l.chainId)) chains.get(l.chainId).note = l;
  }
  return chains;
}

export function getChainState(logPath, chainId) {
  return chainStates(readLogLines(logPath, { strict: true })).get(chainId) ?? null;
}

export function reserveChain({ logPath, repo, repoKey, artifact, contentHash, trigger }) {
  const lockPath = logPath + ".lock";
  const ts = new Date().toISOString();
  try { mkdirSync(joinPath(logPath, ".."), { recursive: true }); } catch { }
  let lockToken;
  try {
    lockToken = acquireLock(lockPath);
  } catch (e) {
    throw err("RESERVE_FAILED", `could not acquire lock: ${e.message}`);
  }
  try {
    // Read the log in BOTH modes: an unreadable-but-appendable log under --force
    // would otherwise open a chain that can never be validated or closed.
    let lines;
    try {
      lines = readLogLines(logPath, { strict: true });
    } catch (e) {
      throw err("RESERVE_FAILED", `cannot read log, failing closed: ${e.message}`);
    }
    if (trigger === "auto") {
      for (const { open, note } of chainStates(lines).values()) {
        // Scope: repoKey (canonical absolute root, not basename — two clones named
        // alike must not suppress each other) + artifact + hash.
        if (open.repoKey === repoKey && open.artifact === artifact && open.contentHash === contentHash
            && note?.outcome !== "aborted") {
          throw err("CHAIN_EXISTS", `non-aborted chain ${open.chainId} already exists for ${repoKey}:${artifact}@${contentHash}`);
        }
      }
    }
    // repoKey is part of chain identity — identical path+content in two repos must
    // not be able to mint the same id in the same millisecond. pid+random entropy
    // also guards two racers in the same process/millisecond (only reachable via a
    // concurrent stale-lock break) from minting an identical chainId.
    const chainId = mintChainId(`${repoKey}:${artifact}`, contentHash, ts, `${process.pid}:${randomBytes(8).toString("hex")}`);
    const line = { ts, chainId, repo, repoKey, artifact, contentHash, mode: "open", trigger };
    try {
      appendFileSync(logPath, JSON.stringify(line) + "\n");
    } catch (e) {
      throw err("RESERVE_FAILED", `reservation write failed: ${e.message}`);
    }
    // Auto-uniqueness does NOT rest on the lock (advisory locks can be stale-broken
    // concurrently): after appending, re-read and verify OUR line is the FIRST
    // non-aborted open line for this key. Local-fs append order is total, so
    // exactly one racer wins; losers self-abort their own line and refuse.
    if (trigger === "auto") {
      let after;
      try { after = readLogLines(logPath, { strict: true }); } catch (e) {
        throw err("RESERVE_FAILED", `post-append verification read failed: ${e.message}`);
      }
      const states = chainStates(after);
      const firstOpen = after.find((l) =>
        l.mode === "open" && l.repoKey === repoKey && l.artifact === artifact && l.contentHash === contentHash
        && states.get(l.chainId)?.note?.outcome !== "aborted");
      if (firstOpen && firstOpen.chainId !== chainId) {
        // Lost the race — close our own line so it never blocks anything.
        appendFileSync(logPath, JSON.stringify({
          ts: new Date().toISOString(), chainId, mode: "note",
          unique: 0, trigger, outcome: "aborted", comment: "aborted: lost reservation race",
        }) + "\n");
        throw err("CHAIN_EXISTS", `chain ${firstOpen.chainId} won the reservation race for ${repo}:${artifact}@${contentHash}`);
      }
    }
    return { chainId, ts };
  } finally {
    releaseLock(lockPath, lockToken);
  }
}

export function appendResult(logPath, entry) {
  try {
    // No mkdirSync here (unlike reserveChain): a missing log directory means no
    // chain was ever opened for this path, which is itself the failure to report.
    appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
    return true;
  } catch (e) {
    process.stderr.write(`warn: result log append failed (non-fatal): ${e.message}\n`);
    return false;
  }
}

export function appendNote(logPath, { chainId, unique, outcome, comment }) {
  const n = Number(unique);
  if (!Number.isInteger(n) || n < 0) throw err("BAD_UNIQUE", `--unique must be a non-negative integer, got: ${unique}`);
  if (!OUTCOMES.includes(outcome)) throw err("BAD_OUTCOME", `outcome must be one of ${OUTCOMES.join("|")}`);
  // Same lock as reservation: duplicate-rejection must not be a racy read-then-append.
  const lockPath = logPath + ".lock";
  let token;
  try {
    token = acquireLock(lockPath);
  } catch (e) {
    throw err("NOTE_FAILED", `could not lock log for note: ${e.message}`);
  }
  try {
    const lines = readLogLines(logPath, { strict: true });
    const chain = chainStates(lines).get(chainId);
    if (!chain) throw err("UNKNOWN_CHAIN", `no open line for chain ${chainId}`);
    if (chain.note) throw err("DUPLICATE_NOTE", `chain ${chainId} already has a note`);
    // Lifecycle: the claimed outcome must match recorded events, or the gate's
    // sole success metric can be corrupted by a bookkeeping slip. "aborted" is
    // the always-allowed escape hatch.
    if (outcome !== "aborted") {
      const hasAudit = (v) => lines.some((l) => l.chainId === chainId && isAuditMode(l.mode) && l.verdict === v);
      const hasReview = (v) => lines.some((l) => l.chainId === chainId && (l.mode === "review" || l.mode === "diff") && l.verdict === v);
      const ok = outcome === "audit-pass" ? hasAudit("PASS")
        : outcome === "cap-revise" ? hasReview("REVISE")
        : hasAudit("CONCERNS"); // both audit-concerns-* classes
      if (!ok) {
        throw err("LIFECYCLE_MISMATCH",
          `outcome ${outcome} does not match recorded events for chain ${chainId}; if a best-effort result append was lost, repair ${logPath} manually`);
      }
    }
    const line = {
      ts: new Date().toISOString(), chainId, mode: "note",
      unique: n, trigger: chain.open.trigger, outcome, comment: comment ?? "",
    };
    appendFileSync(logPath, JSON.stringify(line) + "\n"); // throws on failure — fatal by design
  } finally {
    releaseLock(lockPath, token);
  }
}

export function computeStats(logPath) {
  // Tolerant read (stats must work on a damaged log), but corruption is
  // counted and reported — never hidden.
  let raw;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw err("LOG_UNREADABLE", `log read failed: ${e.message}`);
    raw = "";
  }
  const lines = [];
  let corruptLines = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { lines.push(JSON.parse(line)); } catch { corruptLines++; }
  }
  const chains = chainStates(lines);
  const s = { open: 0, byOutcome: {}, forced: 0, eligible: 0, uniqueTotal: 0, uniquePer5: null, openChainIds: [], corruptLines };
  for (const [chainId, { open, note }] of chains) {
    if (!note) { s.open++; s.openChainIds.push(chainId); continue; }
    s.byOutcome[note.outcome] = (s.byOutcome[note.outcome] ?? 0) + 1;
    if (note.trigger === "forced") s.forced++;
    if (note.trigger === "auto" && note.outcome !== "aborted") {
      s.eligible++;
      s.uniqueTotal += note.unique || 0;
    }
  }
  if (s.eligible > 0) s.uniquePer5 = (s.uniqueTotal / s.eligible) * 5;
  return s;
}

export function runCodex(args, { cwd, timeoutMs }) {
  return new Promise((resolveP) => {
    let child;
    try {
      child = spawn("codex", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolveP({ stdout: "", stderr: String(e.message), timedOut: false, spawnError: true });
      return;
    }
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => { clearTimeout(timer); resolveP({ stdout, stderr: stderr + e.message, timedOut, spawnError: true }); });
    child.on("close", () => { clearTimeout(timer); resolveP({ stdout, stderr, timedOut, spawnError: false }); });
  });
}

function die(msg, code = 1) { process.stderr.write(msg + "\n"); process.exit(code); }

async function runRound({ file, mode, resume, chain, retryVerdict, auto, force, model, effort, timeoutS, maxLines }) {
  const logPath = logPathDefault();

  let repoRoot, relPath, hash, diffFiles = [], diffUndiffable = [], pinnedRange = "";
  if (isDiffMode(mode)) {
    repoRoot = repoRootOfDir(process.cwd()); // NOT resolveRepoRoot — that dirname()s its argument
    let d;
    try {
      d = resolveDiff(repoRoot, file, { maxLines, maxBytes: MAX_DIFF_BYTES }); // `file` carries the range
    } catch (e) {
      die(`refused: ${e.message}`, e.code === "DIFF_TOO_LARGE" ? 7 : 2);
    }
    pinnedRange = d.pinnedRange;
    // The chain's identity is the SYMBOLIC range — stable across rounds, exactly as a plan's file path
    // is. It must NOT be the pinned SHAs: runRound validates a resume with an exact artifact match, so
    // a pinned artifact would stop matching the moment a fix commit moved <head>, and --resume would
    // be rejected before Codex ever ran. The 3-round protocol would be impossible.
    relPath = `diff:${file}`;
    // The per-round content hash — the analogue of a plan file's bytes. Hash a MANIFEST, not just the
    // rendered diff text: a change confined to binary or `-diff`-marked files produces identical diff
    // text, so hashing the text alone would report "already reviewed" for a genuinely new change. The
    // pinned SHAs and the undiffable paths are part of what was reviewed, so they are part of its
    // identity.
    hash = contentHashOf(Buffer.from(JSON.stringify({
      pinnedRange: d.pinnedRange,
      files: d.files,
      undiffable: d.undiffable,
      text: d.text,
    }), "utf8"));
    diffFiles = d.files;
    diffUndiffable = d.undiffable;
  } else {
    const abs = resolvePath(file);
    let fileStat;
    try { fileStat = statSync(abs); } catch { die(`artifact not found: ${abs}`); }
    if (!fileStat.isFile()) die(`artifact must be a regular file: ${abs}`);
    repoRoot = resolveRepoRoot(abs);
    relPath = relativePath(repoRoot, abs) || abs;
    hash = contentHashOf(readFileSync(abs));
  }
  const repo = repoRoot.split("/").at(-1);
  let chainId = chain, trigger;

  if (!resume && (mode === "review" || mode === "diff")) {
    if (auto === force) die("exactly one of --auto or --force is required to open a chain");
    trigger = auto ? "auto" : "forced";
    try {
      chainId = reserveChain({ logPath, repo, repoKey: repoRoot, artifact: relPath, contentHash: hash, trigger }).chainId;
    } catch (e) {
      die(`refused: ${e.message}`, e.code === "CHAIN_EXISTS" ? 3 : 2);
    }
  } else {
    if (!chainId) die("--chain <chainId> is required for resumed rounds and audits");
    // Validate before spending quota: a typo'd/stale chain id would produce
    // orphan result lines that note can never close.
    let st;
    try { st = getChainState(logPath, chainId); } catch (e) { die(`log unusable: ${e.message}`, 2); }
    if (!st) die(`unknown chain: ${chainId}`, 6);
    if (st.note) die(`chain ${chainId} is already closed (outcome: ${st.note.outcome})`, 6);
    if (st.open.repoKey !== repoRoot || st.open.artifact !== relPath) {
      die(`chain ${chainId} belongs to ${st.open.repoKey}:${st.open.artifact}, not ${repoRoot}:${relPath}`, 6);
    }
    if (resume) {
      let priorSessions = [];
      try {
        priorSessions = readLogLines(logPath)
          .filter((l) => l.chainId === chainId && l.mode === mode && l.sessionId)
          .map((l) => l.sessionId);
      } catch { /* log unreadable — validated at reservation; handled below */ }
      if (isAuditMode(mode)) {
        // audit --resume exists ONLY to retry that audit's own UNPARSEABLE session —
        // strict on all three counts, or the one-audit boundary is bypassable.
        if (!retryVerdict) die("audit --resume is only valid with --retry-verdict", 6);
        if (!priorSessions.includes(resume)) die(`session ${resume} is not a recorded audit session for chain ${chainId}`, 6);
        let latestAudit;
        try {
          latestAudit = readLogLines(logPath)
            .filter((l) => l.chainId === chainId && isAuditMode(l.mode) && l.verdict).at(-1);
        } catch { /* validated strict at getChainState already */ }
        if (latestAudit?.verdict !== "UNPARSEABLE") {
          die(`audit --resume is only for an UNPARSEABLE audit; recorded verdict: ${latestAudit?.verdict ?? "none"}`, 6);
        }
      } else {
        // Review-resume: bind when records exist; result appends are best-effort,
        // so an empty record set only warns.
        if (priorSessions.length > 0 && !priorSessions.includes(resume)) {
          die(`session ${resume} is not recorded for chain ${chainId} (${mode})`, 6);
        }
        if (priorSessions.length === 0) {
          process.stderr.write("warn: no recorded sessions for this chain (result logging is best-effort); proceeding\n");
        }
      }
    }
  }

  if (isAuditMode(mode)) {
    // --retry-verdict exists ONLY to re-ask an UNPARSEABLE audit for its verdict line, within its own
    // session. Without this, it is a bypass: a fresh (non-resumed) retry would skip the guard below
    // and spend quota on a second real audit after a PASS.
    if (retryVerdict && !resume) {
      die("audit --retry-verdict is only valid with --resume (it re-asks an unparseable audit for its verdict)", 6);
    }
    if (!retryVerdict) {
      const priorAudits = readLogLines(logPath).filter(
        (l) => l.chainId === chainId && isAuditMode(l.mode) && l.verdict && l.verdict !== "UNPARSEABLE",
      );
      if (priorAudits.length > 0) {
        die(`chain ${chainId} already has an audit (${priorAudits.at(-1).verdict}); the audit is run once`, 6);
      }
    }
  }

  let round;
  if (mode === "review" || mode === "diff") {
    try {
      // l.mode === mode, not a hardcoded "review": a diff chain's rounds are logged with mode:"diff",
      // and counting only "review" lines would leave round stuck at 1 forever for diff chains — the
      // round cap below would then never trigger.
      round = 1 + readLogLines(logPath).filter((l) => l.chainId === chainId && l.mode === mode).length;
    } catch { round = undefined; } // result logging is best-effort; never block the round on this
  }

  // The protocol is 3 rounds + 1 audit, and until now NOTHING enforced it — round was recorded and
  // never checked, so a caller could burn unlimited paid rounds. Enforce BEFORE runCodex is spawned:
  // refusing after spending the quota would defeat the point.
  const MAX_REVIEW_ROUNDS = 3;
  if ((mode === "review" || mode === "diff") && round > MAX_REVIEW_ROUNDS) {
    die(
      `chain ${chainId} has already used ${MAX_REVIEW_ROUNDS} review rounds — the protocol is ` +
        `${MAX_REVIEW_ROUNDS} rounds + 1 audit. Run the audit, or close the chain with ` +
        `\`note --outcome cap-revise\`.`,
      6,
    );
  }

  const prompt = retryVerdict ? buildRetryPrompt(mode)
    : resume && mode === "diff" ? buildDiffResumePrompt(pinnedRange, diffUndiffable)
    : resume && mode === "review" ? buildResumePrompt(relPath)
    : mode === "diff-audit" ? buildDiffAuditPrompt(pinnedRange, diffUndiffable)
    : mode === "audit" ? buildAuditPrompt(relPath)
    : mode === "diff" ? buildDiffPrompt(pinnedRange, diffFiles, diffUndiffable)
    : buildReviewPrompt(relPath);
  const modelArgs = ["-m", model, "-c", `model_reasoning_effort=${effort}`];
  const args = resume
    ? ["exec", "resume", resume, "--json", ...modelArgs, "--skip-git-repo-check", prompt]
    : ["exec", "--json", "--sandbox", "read-only", ...modelArgs, "--skip-git-repo-check", prompt];

  const t0 = Date.now();
  const { stdout, stderr, timedOut, spawnError } = await runCodex(args, { cwd: repoRoot, timeoutMs: timeoutS * 1000 });
  // Never die() after reservation without emitting result JSON: the caller needs
  // pendingNoteChainId to close the chain, or it stays open and blocks auto-runs.
  if (spawnError) process.stderr.write(`codex could not be spawned (installed? logged in?): ${stderr.slice(0, 300)}\n`);
  const stream = parseEventStream(stdout);
  // Spec: success requires BOTH a clean terminal event AND a final message.
  const verdict = spawnError ? "error"
    : timedOut ? "timeout"
    : stream.terminal !== "completed" || !stream.finalMessage ? "error"
    : parseVerdict(stream.finalMessage, mode);
  const findings = countFindings(stream.finalMessage ?? "");
  const result = {
    ok: verdict !== "error" && verdict !== "timeout",
    mode, chainId, sessionId: stream.sessionId, verdict, findings,
    finalMessage: stream.finalMessage, usage: stream.usage,
    durationMs: Date.now() - t0, pendingNoteChainId: chainId,
  };
  appendResult(logPath, {
    chainId, repo, artifact: relPath, contentHash: hash, mode, round, pinnedRange,
    verdict, findings, sessionId: stream.sessionId, model, effort,
    usage: stream.usage, durationMs: result.durationMs,
  });
  process.stdout.write(JSON.stringify(result, null, 1) + "\n");
  if (!result.ok) process.exit(4);
}

const USAGE = "usage: codex-review.mjs <review|diff|audit|diff-audit|note|stats> …";

export async function main(argv) {
  const [cmd, ...rest] = argv;
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: rest, allowPositionals: true,
      options: {
        auto: { type: "boolean" }, force: { type: "boolean" },
        resume: { type: "string" }, chain: { type: "string" },
        "retry-verdict": { type: "boolean" },
        model: { type: "string", default: "gpt-5.6-terra" },
        effort: { type: "string", default: "high" },
        timeout: { type: "string", default: "300" },
        "max-lines": { type: "string", default: "4000" },
        unique: { type: "string" }, outcome: { type: "string" }, comment: { type: "string" },
      },
    }));
  } catch (e) {
    die(`${e.message}\n${USAGE}`);
  }
  if ((cmd === "review" || cmd === "audit" || cmd === "diff" || cmd === "diff-audit") && !positionals[0]) {
    die(`${cmd} requires a <file> argument\n${USAGE}`);
  }
  let maxLines;
  try { maxLines = parseMaxLines(values["max-lines"]); } catch (e) { die(`${e.message}\n${USAGE}`); }
  const common = {
    file: positionals[0], resume: values.resume, chain: values.chain,
    retryVerdict: values["retry-verdict"], auto: !!values.auto, force: !!values.force,
    model: values.model, effort: values.effort, timeoutS: parseTimeoutS(values.timeout), maxLines,
  };
  if (cmd === "review") return runRound({ ...common, mode: "review" });
  if (cmd === "audit") return runRound({ ...common, mode: "audit" });
  if (cmd === "diff") return runRound({ ...common, mode: "diff" });
  if (cmd === "diff-audit") return runRound({ ...common, mode: "diff-audit" });
  if (cmd === "note") {
    if (!values.chain || values.unique === undefined || !values.outcome) die("note requires --chain, --unique, --outcome");
    try {
      appendNote(logPathDefault(), { chainId: values.chain, unique: values.unique, outcome: values.outcome, comment: values.comment });
    } catch (e) { die(`note failed: ${e.message}`, 5); }
    process.stdout.write(JSON.stringify({ ok: true, mode: "note", chainId: values.chain }) + "\n");
    return;
  }
  if (cmd === "stats") {
    process.stdout.write(JSON.stringify(computeStats(logPathDefault()), null, 1) + "\n");
    return;
  }
  die(USAGE);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main(process.argv.slice(2));
}
