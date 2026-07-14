#!/usr/bin/env node
// @ts-check
// codex-review.mjs — deterministic mechanics for the codex-plan-review skill.
// Spec: docs/superpowers/specs/2026-07-14-codex-plan-review-design.md
import { createHash } from "node:crypto";
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
  const re = mode === "audit" ? /AUDIT:\s*(PASS|CONCERNS)/g : /VERDICT:\s*(APPROVED|REVISE)/g;
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

Report findings as a bullet list, each tagged [P1] (must fix before implementation), [P2] (should fix), or [P3] (nit). Severity must be proportionate to the artifact's scope — do not demand enterprise patterns from small local tooling. Do not rubber-stamp; do not restate the document.

End your final message with exactly one line: VERDICT: APPROVED or VERDICT: REVISE (REVISE if any P1 or P2 finding exists).`;

export function buildReviewPrompt(relPath) { return REVIEW_BODY(relPath); }

export function buildResumePrompt(relPath) {
  return `The artifact at \`${relPath}\` has been revised in response to your findings. Re-review: verify each prior finding is addressed, flag any that are not, and check the revisions did not introduce new problems. Same reporting format. End your final message with exactly one line: VERDICT: APPROVED or VERDICT: REVISE.`;
}

export function buildAuditPrompt(relPath) {
  return `You are performing a final holistic audit of the design/plan document at \`${relPath}\`. A separate detailed review process has already examined this artifact section by section; your job is NOT another section-by-section pass. Assess the artifact as a whole: internal consistency across sections, completeness (is anything load-bearing missing entirely?), feasibility of the overall approach, and systemic risks that only appear when reading it end to end. Where the document makes claims about this repository, you may check them (read-only). Report at most 5 findings, whole-artifact in scope, same [P1]/[P2]/[P3] tagging. End your final message with exactly one line: AUDIT: PASS or AUDIT: CONCERNS.`;
}

export function buildRetryPrompt(mode) {
  return mode === "audit"
    ? "Your previous message was missing the audit line — end with AUDIT: PASS or AUDIT: CONCERNS."
    : "Your previous message was missing the verdict line — end with VERDICT: APPROVED or VERDICT: REVISE.";
}

export function contentHashOf(buffer) {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 16);
}

export function mintChainId(relPath, contentHash, ts) {
  return createHash("sha256").update(`${relPath}\0${contentHash}\0${ts}`).digest("hex").slice(0, 12);
}

export function resolveRepoRoot(artifactAbsPath) {
  const dir = dirname(artifactAbsPath);
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return dir;
  }
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
      let age = 0;
      try { age = Date.now() - statSync(lockPath).mtimeMs; } catch { continue; } // vanished — retry
      if (age > staleMs) {
        // Atomic stale-break: rename first — exactly one breaker wins the rename,
        // so a losing breaker can never delete a replacement holder's fresh lock.
        try {
          renameSync(lockPath, `${lockPath}.stale-${token}`);
          unlinkSync(`${lockPath}.stale-${token}`);
        } catch { /* another breaker won — fall through and retry acquire */ }
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
    // not be able to mint the same id in the same millisecond.
    const chainId = mintChainId(`${repoKey}:${artifact}`, contentHash, ts);
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
      const has = (m, v) => lines.some((l) => l.chainId === chainId && l.mode === m && l.verdict === v);
      const ok = outcome === "audit-pass" ? has("audit", "PASS")
        : outcome === "cap-revise" ? has("review", "REVISE")
        : has("audit", "CONCERNS"); // both audit-concerns-* classes
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

async function runRound({ file, mode, resume, chain, retryVerdict, auto, force, model, effort, timeoutS }) {
  const logPath = logPathDefault();
  const abs = resolvePath(file);
  let fileStat;
  try { fileStat = statSync(abs); } catch { die(`artifact not found: ${abs}`); }
  if (!fileStat.isFile()) die(`artifact must be a regular file: ${abs}`);
  const repoRoot = resolveRepoRoot(abs);
  const relPath = relativePath(repoRoot, abs) || abs;
  const repo = repoRoot.split("/").at(-1);
  const hash = contentHashOf(readFileSync(abs)); // recorded per round — artifact changes between rounds
  let chainId = chain, trigger;

  if (!resume && mode === "review") {
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
      if (mode === "audit") {
        // audit --resume exists ONLY to retry that audit's own UNPARSEABLE session —
        // strict on all three counts, or the one-audit boundary is bypassable.
        if (!retryVerdict) die("audit --resume is only valid with --retry-verdict", 6);
        if (!priorSessions.includes(resume)) die(`session ${resume} is not a recorded audit session for chain ${chainId}`, 6);
        let latestAudit;
        try {
          latestAudit = readLogLines(logPath)
            .filter((l) => l.chainId === chainId && l.mode === "audit" && l.verdict).at(-1);
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

  let round;
  if (mode === "review") {
    try {
      round = 1 + readLogLines(logPath).filter((l) => l.chainId === chainId && l.mode === "review").length;
    } catch { round = undefined; } // result logging is best-effort; never block the round on this
  }

  const prompt = retryVerdict ? buildRetryPrompt(mode)
    : resume && mode === "review" ? buildResumePrompt(relPath)
    : mode === "audit" ? buildAuditPrompt(relPath)
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
    chainId, repo, artifact: relPath, contentHash: hash, mode, round,
    verdict, findings, sessionId: stream.sessionId, model, effort,
    usage: stream.usage, durationMs: result.durationMs,
  });
  process.stdout.write(JSON.stringify(result, null, 1) + "\n");
  if (!result.ok) process.exit(4);
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest, allowPositionals: true,
    options: {
      auto: { type: "boolean" }, force: { type: "boolean" },
      resume: { type: "string" }, chain: { type: "string" },
      "retry-verdict": { type: "boolean" },
      model: { type: "string", default: "gpt-5.6-terra" },
      effort: { type: "string", default: "high" },
      timeout: { type: "string", default: "300" },
      unique: { type: "string" }, outcome: { type: "string" }, comment: { type: "string" },
    },
  });
  const common = {
    file: positionals[0], resume: values.resume, chain: values.chain,
    retryVerdict: values["retry-verdict"], auto: !!values.auto, force: !!values.force,
    model: values.model, effort: values.effort, timeoutS: Number(values.timeout),
  };
  if (cmd === "review") return runRound({ ...common, mode: "review" });
  if (cmd === "audit") return runRound({ ...common, mode: "audit" });
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
  die("usage: codex-review.mjs <review|audit|note|stats> …");
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main(process.argv.slice(2));
}
