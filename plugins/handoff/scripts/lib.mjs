// @ts-check
// Shared helpers for handoff plugin scripts. Stdlib only.

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  rmSync,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  realpathSync,
  constants,
} from "node:fs";
import { spawnSync } from "node:child_process";
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

/**
 * A cached usage record is usable only if it carries all three finite token counts. JSON.parse
 * succeeding is NOT enough: a valid-JSON-but-malformed cache such as {"usage":{}} with a matching key
 * would otherwise be returned as-is, producing NaN downstream and bailing the bar to "?" — the exact
 * failure the "always fall back to a fresh parse" promise exists to prevent.
 *
 * @param {any} u
 * @returns {boolean}
 */
function isUsageShape(u) {
  return (
    u !== null &&
    typeof u === "object" &&
    Number.isFinite(u.inputTokens) &&
    Number.isFinite(u.cacheCreationTokens) &&
    Number.isFinite(u.cacheReadTokens)
  );
}

/**
 * lastAssistantUsageFromTranscript, with a disk cache keyed on the transcript's path + mtime + size.
 *
 * The parse is a full synchronous read of an unboundedly-growing file, on a ~300ms debounce — that is
 * the slow path that lets invocations pile up (ccusage#459: 34 concurrent statusline processes, 300%
 * CPU). Caching the parse is the proven fix; ccusage does the same, keyed on transcript mtime.
 *
 * The PATH is part of the key because the cache filename is keyed on sid, and resolveSessionId falls
 * back to the literal "unknown" — two no-ID sessions share one cache file, and must not be served
 * each other's token counts.
 *
 * Every failure path falls back to a fresh parse: a cache is an optimization, never a correctness
 * dependency.
 *
 * @param {string} transcriptPath
 * @param {string} dataDir
 * @param {string} sid
 * @returns {{inputTokens: number, cacheCreationTokens: number, cacheReadTokens: number} | null}
 */
export function cachedTranscriptUsage(transcriptPath, dataDir, sid) {
  /** @type {{mtimeMs: number, size: number}} */
  let stat;
  try {
    const st = statSync(transcriptPath);
    stat = { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null; // no transcript — nothing to parse or cache
  }

  const cacheFile = path.join(dataDir, `transcript-usage-${sid}.json`);
  try {
    const c = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (c && c.transcriptPath === transcriptPath && c.mtimeMs === stat.mtimeMs && c.size === stat.size) {
      // A cached null is a VALID, cacheable answer ("this transcript has no main-chain assistant turn
      // yet") — early in a session that state persists across many ticks, and re-scanning the whole
      // file each time is precisely the expensive path this function exists to remove. Distinguish it
      // from a malformed record by requiring an explicit null, not a falsy one.
      if (c.usage === null) return null;
      if (isUsageShape(c.usage)) return c.usage;
    }
  } catch {
    // missing or corrupt cache — fall through to a fresh parse
  }

  const usage = lastAssistantUsageFromTranscript(transcriptPath);
  try {
    writeFileSync(cacheFile, JSON.stringify({ transcriptPath, ...stat, usage }));
  } catch {
    // the cache is an optimization; a failed write must not fail the render
  }
  return usage;
}

/**
 * Pick the context token total, transcript-primary. Output tokens are excluded
 * (matches Claude Code's own used_percentage definition).
 * @param {{inputTokens:number,cacheCreationTokens:number,cacheReadTokens:number}|null} transcriptUsage
 * @param {{input_tokens?:number,cache_creation_input_tokens?:number,cache_read_input_tokens?:number}|null} currentUsage
 * @returns {number|null}
 */
export function pickContextTokens(transcriptUsage, currentUsage) {
  if (transcriptUsage !== null) {
    const t = transcriptUsage.inputTokens + transcriptUsage.cacheCreationTokens + transcriptUsage.cacheReadTokens;
    if (t > 0) return t;
  }
  if (currentUsage !== null && typeof currentUsage === "object") {
    const c =
      (currentUsage.input_tokens ?? 0) +
      (currentUsage.cache_creation_input_tokens ?? 0) +
      (currentUsage.cache_read_input_tokens ?? 0);
    if (c > 0) return c;
  }
  return null;
}

/**
 * Should the nudge-band ladder reset this render? Below-threshold covers a fresh
 * session and the resolveSessionId "unknown" self-heal; the decrease branch covers
 * a real compaction (trustworthy because the transcript-primary reading is
 * monotonic-up within a segment).
 * @param {number} currentPct
 * @param {number} lastPct
 * @param {number} threshold
 * @param {number} dropEpsilon
 * @returns {boolean}
 */
export function shouldResetBands(currentPct, lastPct, threshold, dropEpsilon) {
  if (currentPct < threshold) return true;
  if (currentPct < lastPct - dropEpsilon) return true;
  return false;
}

const GIT_TIMEOUT_MS = 250;

/**
 * Resolve the current branch label + dirty count for a working directory by
 * shelling to git. Same option shape as gitTracksFile. Returns null for a
 * non-git dir, a missing git binary, a timeout, or any error — the caller then
 * omits the whole git segment; git never takes the bar down.
 * @param {string} cwd
 * @param {number} [timeoutMs]
 * @returns {{ label: string, dirty: number } | null}
 */
export function gitBranchDirty(cwd, timeoutMs = GIT_TIMEOUT_MS) {
  /** @type {import("node:child_process").SpawnSyncOptionsWithStringEncoding} */
  const opts = { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] };
  try {
    /** @type {string} */
    let label;
    const b = spawnSync("git", ["-C", cwd, "symbolic-ref", "--quiet", "--short", "HEAD"], opts);
    if (b.status === 0 && typeof b.stdout === "string" && b.stdout.trim().length > 0) {
      label = b.stdout.trim();
    } else {
      const r = spawnSync("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], opts);
      if (r.status === 0 && typeof r.stdout === "string" && r.stdout.trim().length > 0) {
        label = "@" + r.stdout.trim();
      } else {
        return null; // not a git repo (or git unavailable / timed out)
      }
    }
    const s = spawnSync("git", ["-C", cwd, "status", "--porcelain"], opts);
    const dirty =
      s.status === 0 && typeof s.stdout === "string"
        ? s.stdout.split("\n").filter((l) => l.trim().length > 0).length
        : 0;
    return { label, dirty };
  } catch {
    return null;
  }
}

/**
 * @param {string} name model display name
 * @returns {"amber"|"plain"} amber only for the Fable family (2x-tier flag)
 */
export function modelColor(name) {
  return /fable/i.test(String(name)) ? "amber" : "plain";
}

/**
 * @param {any} rateLimits stdin rate_limits (may be undefined / partial)
 * @param {number} surfacePct
 * @returns {Array<{label:string, pct:number, red:boolean}>}
 */
export function selectRateLimits(rateLimits, surfacePct) {
  /** @type {Array<{label:string, pct:number, red:boolean}>} */
  const out = [];
  const windows = [
    ["5h", "five_hour"],
    ["7d", "seven_day"],
  ];
  for (const [label, key] of windows) {
    const w = rateLimits && rateLimits[key];
    const pct = w && w.used_percentage;
    if (typeof pct === "number" && Number.isFinite(pct) && pct >= surfacePct) {
      out.push({ label, pct: Math.trunc(pct), red: pct >= 80 });
    }
  }
  return out;
}

/**
 * @param {number} tokens
 * @returns {string} e.g. "(287k)"
 */
export function tokensSuffix(tokens) {
  return `(${Math.round(tokens / 1000)}k)`;
}

const SGR_RE = /\x1b\[[0-9;]*m/g;

/**
 * @param {string} s
 * @returns {number} code-point length after stripping SGR escapes
 */
export function visibleWidth(s) {
  return [...s.replace(SGR_RE, "")].length;
}

/**
 * End-truncate to `max` code points with a trailing "…" (best-effort; every code
 * point counts as width 1).
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
export function truncateEnd(s, max) {
  if (max <= 0) return "";
  const cps = [...s];
  if (cps.length <= max) return s;
  if (max === 1) return "…";
  return cps.slice(0, max - 1).join("") + "…";
}

const A_RED = "\x1b[0;31m";
const A_AMBER = "\x1b[0;33m";
const A_GREEN = "\x1b[0;32m";
const A_DIM = "\x1b[2m";
const A_RESET = "\x1b[0m";
const IDENTITY_MAX_CHARS = 24;
const BRANCH_MAX_CHARS = 24;

/**
 * Assemble the adaptive status line. Pure and deterministic; the caller resolves
 * git/model/rate-limit data first and passes it in.
 * @param {{
 *   identity: string,
 *   branch: string | null,
 *   dirty: number,
 *   pctInt: number,
 *   tokens: number | null,
 *   model: string,
 *   rateLimits: Array<{label:string, pct:number, red:boolean}>,
 *   budget: number,
 * }} d
 * @returns {string}
 */
export function assembleStatusLine(d) {
  const budget = d.budget > 0 ? d.budget : 120;
  const red = d.pctInt >= 70;
  let filled = Math.floor(d.pctInt / 10);
  if (filled < 0) filled = 0;
  if (filled > 10) filled = 10;
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  const barColor = red ? A_RED : d.pctInt >= 50 ? A_AMBER : A_GREEN;
  const tokSfx = red && d.tokens != null ? ` ${tokensSuffix(d.tokens)}` : "";
  const barText = `${bar} ${d.pctInt}%${tokSfx}`;
  const barColored = `${barColor}${barText}${A_RESET}`;

  const modelIsAmber = modelColor(d.model) === "amber";
  const sep = ` ${A_DIM}·${A_RESET} `;

  /**
   * identity cluster text for a given dirty/branch/identity choice
   * @type {(identity: string, branch: string|null, showDirty: boolean) => string}
   */
  const idText = (identity, branch, showDirty) =>
    identity + (branch ? ` ⎇${branch}` : "") + (showDirty && d.dirty > 0 ? ` ±${d.dirty}` : "");
  /** @type {(t: string) => string} */
  const idColored = (t) => `${A_DIM}${t}${A_RESET}`;
  /** @type {(name: string) => string} */
  const modelColored = (name) => (modelIsAmber ? `${A_AMBER}${name}${A_RESET}` : name);

  /** build the rate-limit cluster {plain, colored} or null */
  const buildRl = () => {
    if (!d.rateLimits.length) return null;
    const anyRed = d.rateLimits.some((w) => w.red);
    const parts = d.rateLimits.map((w) => {
      const p = `${w.label} ${w.pct}%`;
      return { p, c: `${w.red ? A_RED : A_AMBER}${p}${A_RESET}` };
    });
    const warnP = anyRed ? "⚠ " : "";
    const warnC = anyRed ? `${A_RED}⚠ ${A_RESET}` : "";
    return { plain: warnP + parts.map((x) => x.p).join(" "), colored: warnC + parts.map((x) => x.c).join(" ") };
  };

  /**
   * Assemble a full candidate for a config; returns {width, colored}. Clusters with empty
   * plain text (e.g. no identity when wsDir is unknown, no model name) are dropped rather
   * than left as a dangling " · " separator — graceful degradation applies to every
   * segment, not just the conditional ones.
   * @type {(showRl: boolean, showDirty: boolean, shortModel: boolean) => {width: number, colored: string}}
   */
  const candidate = (showRl, showDirty, shortModel) => {
    const identityStr = idText(d.identity, d.branch, showDirty);
    const modelName = shortModel ? d.model.split(" ")[0] : d.model;
    const clusters = [
      { p: identityStr, c: idColored(identityStr) },
      { p: barText, c: barColored },
      { p: modelName, c: modelColored(modelName) },
    ].filter((x) => x.p.length > 0);
    const rl = showRl ? buildRl() : null;
    if (rl) clusters.push({ p: rl.plain, c: rl.colored });
    const plain = clusters.map((x) => x.p).join(" · ");
    const colored = clusters.map((x) => x.c).join(sep);
    return { width: [...plain].length, colored };
  };

  // Progressive drops, right -> left.
  const attempts = [
    [true, true, false],
    [false, true, false], // 1. drop rate-limits
    [false, false, false], // 2. drop dirty
    [false, false, true], // 3. shorten model
  ];
  for (const [showRl, showDirty, shortModel] of attempts) {
    const c = candidate(showRl, showDirty, shortModel);
    if (c.width <= budget) return c.colored;
  }

  // 4. Budget-aware clamp of the identity cluster (branch trimmed first because it
  //    sits at the end of the cluster string). Model is already shortened, no dirty/rl.
  // An empty model (or empty identity, e.g. wsDir unknown) is dropped rather than left as a
  // dangling separator — same graceful-degradation rule as the candidate() clusters above.
  const shortModelName = d.model.split(" ")[0];
  const idStr = d.identity + (d.branch ? ` ⎇${d.branch}` : "");
  const modelPart = shortModelName.length > 0 ? `${sep}${modelColored(shortModelName)}` : "";
  const modelOverhead = shortModelName.length > 0 ? [...shortModelName].length + 3 : 0;
  const overhead = [...barText].length + modelOverhead + 3; // " · " before the bar
  const idBudget = budget - overhead;
  if (idStr.length === 0 || idBudget < 2) {
    // No room for any identity (or none to show): core (+ model when present).
    return `${barColored}${modelPart}`;
  }
  const clamped = truncateEnd(idStr, Math.min(idBudget, IDENTITY_MAX_CHARS + BRANCH_MAX_CHARS + 2));
  return `${idColored(clamped)}${sep}${barColored}${modelPart}`;
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

/**
 * Where a session's "band N already fired" marker lives.
 *
 * The threshold is part of a band's IDENTITY: "band 0" means 70-80% under a threshold of 70 and
 * 80-90% under a threshold of 80. Naming the marker after both keeps it self-describing and stops
 * markers from two different thresholds colliding on one filename.
 *
 * This is NOT the mechanism for handling a changed HANDOFF_THRESHOLD_PCT — the transition gate in
 * status-and-flag.mjs governs that, and may never reach this function. See Task 1's background.
 *
 * @param {string} dataDir
 * @param {string} sid
 * @param {number} threshold
 * @param {number} band
 * @returns {string}
 */
export function bandMarkerPath(dataDir, sid, threshold, band) {
  return path.join(dataDir, `handoff-fired-${sid}-t${threshold}-b${band}`);
}

/**
 * Atomically claim a band for this session. Returns true IFF this call created the marker.
 *
 * This is the whole concurrency story for nudges. `{ flag: "wx" }` is an exclusive create: of N
 * concurrent invocations claiming the same band, exactly one succeeds and the rest get EEXIST. It is
 * an idempotency key, not a mutex — no lease, no liveness check, no pid-reuse hazard.
 *
 * Scope of the guarantee: at most one nudge per band, under any interleaving of CLAIMS. It is not
 * absolute across a concurrent resetBands() — see "Accepted residual races" in the plan.
 *
 * Returns false (never throws) on any I/O failure: a statusline must not die on a state write.
 *
 * @param {string} dataDir
 * @param {string} sid
 * @param {number} threshold
 * @param {number} band
 * @returns {boolean}
 */
export function claimBand(dataDir, sid, threshold, band) {
  try {
    writeFileSync(bandMarkerPath(dataDir, sid, threshold, band), "", { flag: "wx" });
    return true;
  } catch {
    return false; // EEXIST (someone else fired it) or an I/O failure — either way, do not nudge.
  }
}

/**
 * Clear a session's whole ladder, across every threshold it has used.
 *
 * Called when context drops below the threshold — the climb is over (a /compact, or a fresh
 * session). Without this, the band marker from a previous climb would suppress the post-compact
 * nudge permanently.
 *
 * @param {string} dataDir
 * @param {string} sid
 * @returns {void}
 */
export function resetBands(dataDir, sid) {
  try {
    // Match the marker shape EXACTLY, not a bare prefix. `handoff-fired-${sid}-` would make session
    // "a" delete session "a-x"'s markers, since "handoff-fired-a-x-t70-b0" starts with
    // "handoff-fired-a-". Anchor on the full name and escape the sid.
    const esc = sid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^handoff-fired-${esc}-t-?[\\d.]+-b\\d+$`);
    for (const f of readdirSync(dataDir)) {
      if (re.test(f)) rmSync(path.join(dataDir, f), { force: true });
    }
  } catch {
    // Best-effort. A surviving marker costs at most one missed nudge on the next climb — lower bands
    // still fire, so the user is still nudged. Not worth a lock.
  }
}

/**
 * Is the holder process still running? EPERM means it exists but we may not signal it — still alive.
 * @param {number} pid
 * @returns {boolean}
 */
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
 * An unparseable lock gets a far longer grace than a pid-bearing one. See EMPTY_LOCK_GRACE_MS.
 */
const EMPTY_LOCK_GRACE_MS = 10_000;

/**
 * A lock is breakable only when it is past its lease AND we can conclude the holder is gone.
 *
 * A pid-bearing lock: past the lease and the process is gone → breakable.
 *
 * An unparseable lock (empty, or garbage): this is exactly what a lock looks like in the window
 * between create() and write(), so we must NOT read it as a dead holder — that steals it from a live
 * process mid-write. But we cannot call it alive forever either, or a crash between those two calls
 * freezes the bar permanently. The create→write window is microseconds, so anything still unparseable
 * after EMPTY_LOCK_GRACE_MS is a corpse: break it.
 *
 * @param {string} lockPath
 * @param {number} staleMs
 * @returns {boolean}
 */
function isStaleAndDead(lockPath, staleMs) {
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age <= staleMs) return false;
    const holder = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    if (!Number.isInteger(holder) || holder <= 0) return age > EMPTY_LOCK_GRACE_MS;
    return !holderAlive(holder);
  } catch {
    return false;
  }
}

/**
 * Take the statusline's in-flight lock. Returns true iff this call now holds it.
 *
 * BEST-EFFORT BY DESIGN — this is a performance guard (don't pile up), not a mutex. Nudge
 * correctness rides on claimBand(), not on this. Do not add lock ceremony here: four attempts at a
 * "correct" lock each produced a new race, and none of them needed to exist.
 *
 * A lock is breakable only if it is BOTH past the lease AND its holder is provably gone. Age alone
 * is never enough: there is no documented statusLine timeout, so a slow invocation can outlive any
 * lease. An unparseable pid (an empty, partially-written lock) is likewise NOT proof of death.
 *
 * Residual accepted race: two invocations can both judge the same lock stale and both break it, so
 * one can delete the other's freshly-created lock and both proceed. The cost is one duplicate
 * render, which is invisible — Claude Code shows one status line, and the nudge is idempotent.
 *
 * @param {string} lockPath
 * @param {number} staleMs
 * @returns {boolean}
 */
export function acquireInflightLock(lockPath, staleMs) {
  try {
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    // EEXIST: someone holds it. Either we lost a cold-start race to a live holder — never displace it
    // — or the lock is genuinely abandoned. Only isStaleAndDead() can tell those apart.
  }

  if (!isStaleAndDead(lockPath, staleMs)) return false;
  try {
    rmSync(lockPath, { force: true });
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    return false; // another breaker beat us to it — render unheld
  }
}
