// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync, spawn as spawnAsync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, utimesSync, existsSync, appendFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseEventStream, parseVerdict, countFindings,
  buildReviewPrompt, buildResumePrompt, buildAuditPrompt, buildRetryPrompt,
  contentHashOf, mintChainId, resolveRepoRoot, parseTimeoutS,
  readLogLines, acquireLock, releaseLock, reserveChain, appendResult, appendNote, computeStats, getChainState, OUTCOMES,
  repoRootOfDir, isSafeGitRange, parseMaxLines, resolveDiff,
  isAuditMode, isDiffMode, buildDiffPrompt, buildDiffResumePrompt, buildDiffAuditPrompt,
} from "./codex-review.mjs";

// Real stream captured from codex-cli 0.144.3 on 2026-07-14.
const FIXTURE = [
  '{"type":"thread.started","thread_id":"019f5dcd-74f7-78b2-bf87-286146cf482e"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}',
  '{"type":"turn.completed","usage":{"input_tokens":14396,"cached_input_tokens":9984,"output_tokens":5,"reasoning_output_tokens":0}}',
].join("\n");

test("parseEventStream extracts session, message, terminal, usage from real fixture", () => {
  const r = parseEventStream(FIXTURE);
  assert.equal(r.sessionId, "019f5dcd-74f7-78b2-bf87-286146cf482e");
  assert.equal(r.finalMessage, "OK");
  assert.equal(r.terminal, "completed");
  assert.equal(r.usage.output_tokens, 5);
});

test("parseEventStream: turn.failed and error events are terminal failures, and failure is sticky", () => {
  for (const line of ['{"type":"turn.failed","error":{"message":"boom"}}', '{"type":"error","message":"boom"}']) {
    const r = parseEventStream(FIXTURE.replace(/^\{"type":"turn\.completed".*$/m, line));
    assert.equal(r.terminal, "failed");
  }
  const sticky = FIXTURE.replace(/^\{"type":"turn\.completed".*$/m, '{"type":"turn.failed","error":{"message":"boom"}}')
    + '\n{"type":"turn.completed","usage":{}}';
  assert.equal(parseEventStream(sticky).terminal, "failed", "a later turn.completed must not mask an earlier failure");
});

test("parseEventStream: missing terminal event, junk lines, last agent_message wins", () => {
  const s = [
    "not json at all",
    '{"type":"thread.started","thread_id":"abc"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"second"}}',
  ].join("\n");
  const r = parseEventStream(s);
  assert.equal(r.terminal, "missing");
  assert.equal(r.finalMessage, "second");
});

test("parseVerdict: last occurrence wins, mode-scoped, UNPARSEABLE fallback", () => {
  assert.equal(parseVerdict("blah\nVERDICT: REVISE\nmore\nVERDICT: APPROVED", "review"), "APPROVED");
  assert.equal(parseVerdict("AUDIT: CONCERNS", "audit"), "CONCERNS");
  assert.equal(parseVerdict("AUDIT: PASS", "review"), "UNPARSEABLE");
  assert.equal(parseVerdict("VERDICT: APPROVED", "audit"), "UNPARSEABLE");
  assert.equal(parseVerdict("no verdict here", "review"), "UNPARSEABLE");
});

test("countFindings counts tagged lines per severity", () => {
  const text = "- [P1] broken thing\n- [P2] risky thing\n- [P2] other risk\nprose\n- [P3] nit";
  assert.deepEqual(countFindings(text), { p1: 1, p2: 2, p3: 1 });
});

test("prompts reference the path only, never inline content; retry prompts are mode-specific", () => {
  const p = buildReviewPrompt("docs/plan.md");
  assert.ok(p.includes("docs/plan.md"));
  assert.ok(p.includes("VERDICT: APPROVED") && p.includes("VERDICT: REVISE"));
  assert.ok(buildResumePrompt("docs/plan.md").includes("revised"));
  assert.ok(buildAuditPrompt("docs/plan.md").includes("AUDIT: PASS"));
  assert.ok(buildRetryPrompt("review").includes("VERDICT:"));
  assert.ok(buildRetryPrompt("audit").includes("AUDIT:"));
  assert.ok(!buildRetryPrompt("audit").includes("VERDICT:"));
});

// Regression: the 2026-07-15 clean-pass fix landed in the review/diff prompts
// and was never applied to the two audit builders. Plan-mode audits then
// returned PASS 0 times in 50 while diff audits passed 28% — the asymmetry in
// the prompts showed up directly in the verdict distribution.
test("audit prompts grant a respected clean pass and gate CONCERNS on severity", () => {
  for (const p of [buildAuditPrompt("docs/plan.md"), buildDiffAuditPrompt("main...HEAD")]) {
    assert.match(p, /AUDIT: PASS with zero findings is the expected outcome/,
      "audit prompt lost its respected-clean-pass grant");
    assert.match(p, /at least one \[P1\], or two or more \[P2\]/,
      "audit prompt lost its severity floor");
    assert.match(p, /cannot tie to a named failure scenario is not a finding/,
      "audit prompt lost its reproducibility gate");
  }
});

// Regression: `audit-concerns-user-approved` was being written by unattended
// runs where no human was ever asked, putting false attribution into the log.
test("audit-concerns-unattended is a valid outcome and passes the CONCERNS lifecycle check", () => {
  assert.ok(OUTCOMES.includes("audit-concerns-unattended"));
  const logPath = join(tmp(), "log.jsonl");
  const { chainId } = reserveChain({ logPath, repo: "r", repoKey: "/x/r", artifact: "a.md", contentHash: "dddd000000000000", trigger: "auto" });
  // Without a recorded CONCERNS audit the lifecycle check must reject it.
  assert.throws(
    () => appendNote(logPath, { chainId, unique: 1, outcome: "audit-concerns-unattended", comment: "" }),
    (e) => /** @type {any} */ (e).code === "LIFECYCLE_MISMATCH",
  );
  assert.equal(appendResult(logPath, { chainId, mode: "audit", verdict: "CONCERNS" }), true);
  appendNote(logPath, { chainId, unique: 1, outcome: "audit-concerns-unattended", comment: "no interactive turn" });
  assert.equal(readLogLines(logPath).filter((l) => l.mode === "note").at(-1).outcome, "audit-concerns-unattended");
});

test("review and diff prompts grant a respected clean pass and gate findings on reproducibility", () => {
  // Counters the documented LLM-reviewer over-rejection bias: an adversarial reviewer with no
  // legitimate "nothing to fix" state, tuned to always find something, systematically rejects
  // correct code. See docs/plans/2026-07-15-ai-reviewer-calibration-and-clean-pass-research.md.
  const review = buildReviewPrompt("docs/plan.md");
  const diff = buildDiffPrompt("aaa111..bbb222", ["src/x.mjs"]);
  for (const p of [review, diff]) {
    assert.match(p, /zero findings/i, "an APPROVED-with-no-findings result must be legitimized, not treated as a miss");
  }
  // Reproducibility gate: a finding whose triggering input cannot be named is not reportable.
  assert.match(diff, /do not report it/i, "diff mode must gate findings on a named triggering input");
  assert.match(review, /is not a finding/i, "plan mode must tie each finding to a concrete failure scenario");
});

test("contentHashOf and mintChainId are deterministic short hashes", () => {
  const h = contentHashOf(Buffer.from("hello"));
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.equal(h, contentHashOf(Buffer.from("hello")));
  const id = mintChainId("docs/plan.md", h, "2026-07-14T00:00:00Z");
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.notEqual(id, mintChainId("docs/plan.md", h, "2026-07-14T00:00:01Z"));
});

test("mintChainId: entropy param prevents identical ids for identical relPath+hash+ts", () => {
  const ts = "2026-07-14T00:00:00.000Z";
  const a = mintChainId("docs/plan.md", "hash", ts, "1:aaa");
  const b = mintChainId("docs/plan.md", "hash", ts, "2:bbb");
  assert.notEqual(a, b, "same-millisecond racers must not mint the same chainId");
  assert.equal(mintChainId("docs/plan.md", "hash", ts, "same"), mintChainId("docs/plan.md", "hash", ts, "same"));
});

test("parseTimeoutS: numeric strings pass through; non-numeric/missing fall back to the 300s default", () => {
  assert.equal(parseTimeoutS("300"), 300);
  assert.equal(parseTimeoutS("45"), 45);
  assert.equal(parseTimeoutS("abc"), 300, "a bad --timeout value must fall back, not become an immediate kill");
  assert.equal(parseTimeoutS(undefined), 300);
});

test("resolveRepoRoot: git repo resolves to toplevel, non-repo falls back to dir", () => {
  const here = new URL(".", import.meta.url).pathname;
  // Ground-truth the expected toplevel via git itself rather than hardcoding a
  // repo directory name — this suite also runs inside SDD task worktrees
  // (e.g. claude-skills-t2), where the literal repo name differs from "claude-skills".
  const expectedToplevel = execFileSync("git", ["-C", here, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  assert.equal(resolveRepoRoot(here + "codex-review.mjs"), expectedToplevel);
  assert.equal(resolveRepoRoot("/tmp/nonexistent-dir-xyz/file.md"), "/tmp/nonexistent-dir-xyz");
});

const tmp = () => mkdtempSync(join(tmpdir(), "codexrev-"));

test("reserveChain: auto refuses on existing non-aborted hash; aborted chains don't block", () => {
  const logPath = join(tmp(), "log.jsonl");
  const base = { logPath, repo: "r", repoKey: "/x/r", artifact: "a.md", contentHash: "aaaa000000000000", trigger: "auto" };
  const { chainId } = reserveChain(base);
  assert.throws(() => reserveChain(base), (e) => e.code === "CHAIN_EXISTS");
  appendNote(logPath, { chainId, unique: 0, outcome: "aborted", comment: "aborted: timeout" });
  assert.ok(reserveChain(base).chainId); // aborted chain no longer blocks
});

test("reserveChain: force bypasses hash check but not IO failure; auto fails closed on unwritable log", () => {
  const dir = tmp();
  const logPath = join(dir, "log.jsonl");
  const base = { logPath, repo: "r", repoKey: "/x/r", artifact: "a.md", contentHash: "bbbb000000000000" };
  reserveChain({ ...base, trigger: "auto" });
  assert.ok(reserveChain({ ...base, trigger: "forced" }).chainId); // duplicate hash allowed under force
  const roDir = join(dir, "ro"); mkdirSync(roDir); chmodSync(roDir, 0o500);
  const roLog = join(roDir, "log.jsonl");
  assert.throws(() => reserveChain({ ...base, logPath: roLog, trigger: "auto" }), (e) => e.code === "RESERVE_FAILED");
  assert.throws(() => reserveChain({ ...base, logPath: roLog, trigger: "forced" }), (e) => e.code === "RESERVE_FAILED");
});

test("reserveChain: repeated forced reservations of identical content never collide on chainId", () => {
  const logPath = join(tmp(), "log.jsonl");
  const base = { logPath, repo: "r", repoKey: "/x/r", artifact: "a.md", contentHash: "ffff000000000000", trigger: "forced" };
  const ids = new Set();
  for (let i = 0; i < 50; i++) ids.add(reserveChain(base).chainId);
  assert.equal(ids.size, 50, "entropy in the chainId seed must prevent collisions even at identical timestamps");
});

test("lock: held fresh lock refuses; stale lock broken; release is ownership-safe", () => {
  const lockPath = join(tmp(), "log.jsonl.lock");
  const t1 = acquireLock(lockPath);
  assert.throws(() => acquireLock(lockPath), (e) => e.code === "LOCK_HELD");
  releaseLock(lockPath, t1);
  // A crashed holder: a pid that cannot exist. Ageing a lock held by THIS (live) process no longer
  // makes it breakable — that is the point of the fix.
  const t2 = `2147483646-1-crashed`;
  writeFileSync(lockPath, t2);
  const old = (Date.now() - 60_000) / 1000;
  utimesSync(lockPath, old, old);
  const t3 = acquireLock(lockPath, 30_000); // breaks the DEAD holder's stale lock
  releaseLock(lockPath, t2);                // the ex-holder returns: must NOT delete t3's lock
  assert.ok(existsSync(lockPath), "ownership-safe release must not remove another holder's lock");
  releaseLock(lockPath, t3);
  assert.ok(!existsSync(lockPath));
});

test("acquireLock: does NOT break a stale-looking lock whose holder is ALIVE", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "l.lock");
  // A lock held by THIS (alive) process, aged past the lease. Age alone must never justify a break:
  // two breakers who both judge it stale will cascade — the second renames away the FIRST's fresh
  // lock, and both end up holding it.
  writeFileSync(lock, `${process.pid}-1-abc`);
  const old = new Date(Date.now() - 120_000);
  utimesSync(lock, old, old);

  assert.throws(() => acquireLock(lock, 30_000), /held/i, "a live holder's lock must not be broken");
  assert.equal(readFileSync(lock, "utf8"), `${process.pid}-1-abc`, "and must be left intact");
});

test("acquireLock: DOES break a stale lock whose holder is dead", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-lock2-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "l.lock");
  writeFileSync(lock, "2147483646-1-abc"); // a pid that cannot exist
  const old = new Date(Date.now() - 120_000);
  utimesSync(lock, old, old);

  const token = acquireLock(lock, 30_000);
  assert.ok(token, "a dead holder's stale lock must not wedge the log forever");
  assert.equal(readFileSync(lock, "utf8"), token);
});

test("acquireLock: a FRESH empty lock is a holder mid-write, not a corpse", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-lock3-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "l.lock");
  writeFileSync(lock, ""); // openSync("wx") returned; writeSync has not landed yet
  assert.throws(() => acquireLock(lock, 30_000), /held/i, "an unparseable pid is not proof of death");
});

test("acquireLock: an ANCIENT empty lock IS broken — a crash mid-write must not wedge the log", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-lock4-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "l.lock");
  writeFileSync(lock, ""); // a process died between openSync and writeSync
  const ancient = new Date(Date.now() - 600_000);
  utimesSync(lock, ancient, ancient);

  assert.ok(acquireLock(lock, 30_000), "if 'unparseable' meant 'alive' forever, this lock would be immortal");
});

test("acquireLock: the empty-lock grace is ADDED to the lease, not raced against it", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-lock4b-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "l.lock");
  writeFileSync(lock, "");
  const old = new Date(Date.now() - 130_000);
  utimesSync(lock, old, old);

  // Lease 120s, grace 60s, age 130s. `age > EMPTY_LOCK_GRACE_MS` alone would say "breakable" — the
  // 60s grace evaporates entirely whenever the lease exceeds it, which is exactly when a mid-write
  // window is most likely. It must take staleMs + grace = 180s.
  assert.throws(() => acquireLock(lock, 120_000), /held/i);
});

test("acquireLock: a free lock is acquired", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-lock5-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "l.lock");
  const token = acquireLock(lock, 30_000);
  assert.equal(readFileSync(lock, "utf8"), token);
});

test("guard scope is repo+artifact+hash; identical content elsewhere doesn't block; unreadable log fails closed", () => {
  const logPath = join(tmp(), "log.jsonl");
  const a = { logPath, repo: "r", repoKey: "/x/r", artifact: "a.md", contentHash: "dddd000000000000", trigger: "auto" };
  reserveChain(a);
  assert.ok(reserveChain({ ...a, artifact: "b.md" }).chainId, "same content at a different path must not be blocked");
  assert.ok(reserveChain({ ...a, repoKey: "/y/r" }).chainId, "a same-named clone at a different path must not be blocked");
  chmodSync(logPath, 0o000);
  assert.throws(() => reserveChain({ ...a, contentHash: "eeee000000000000" }), (e) => e.code === "RESERVE_FAILED",
    "an unreadable log must fail closed, not look empty");
  assert.throws(() => reserveChain({ ...a, contentHash: "eeee000000000000", trigger: "forced" }), (e) => e.code === "RESERVE_FAILED",
    "force must also refuse an unreadable log — an unvalidatable chain corrupts the gate");
  chmodSync(logPath, 0o600);
});

test("appendNote validates chain, duplicates, outcome class, unique, and lifecycle; appendResult is non-fatal", () => {
  const logPath = join(tmp(), "log.jsonl");
  const { chainId } = reserveChain({ logPath, repo: "r", repoKey: "/x/r", artifact: "a.md", contentHash: "cccc000000000000", trigger: "auto" });
  assert.throws(() => appendNote(logPath, { chainId: "nope", unique: 0, outcome: "audit-pass" }));
  assert.throws(() => appendNote(logPath, { chainId, unique: 0, outcome: "not-a-class" }));
  for (const bad of [-1, 1.5, NaN, Infinity, "abc"]) {
    assert.throws(() => appendNote(logPath, { chainId, unique: bad, outcome: "audit-pass" }), (e) => e.code === "BAD_UNIQUE");
  }
  // lifecycle: an outcome must match recorded events — audit-pass with no passing audit refuses
  assert.throws(() => appendNote(logPath, { chainId, unique: 2, outcome: "audit-pass" }), (e) => e.code === "LIFECYCLE_MISMATCH");
  assert.equal(appendResult(logPath, { chainId, mode: "audit", verdict: "PASS" }), true);
  appendNote(logPath, { chainId, unique: 2, outcome: "audit-pass", comment: "ok" });
  assert.throws(() => appendNote(logPath, { chainId, unique: 1, outcome: "audit-pass" })); // duplicate
  assert.equal(appendResult(join(tmp(), "no-such-dir-parent", "x", "log.jsonl"), { mode: "review" }), false);
});

test("strict reads: a malformed log line is fatal to guard and notes, counted by stats", () => {
  const logPath = join(tmp(), "log.jsonl");
  const a = { logPath, repo: "r", repoKey: "/x/r", artifact: "a.md", contentHash: "abcd000000000000", trigger: "auto" };
  const { chainId } = reserveChain(a);
  appendFileSync(logPath, '{"ts":"2026-07-14","chainId":"tru\n'); // truncated mid-write
  assert.throws(() => reserveChain({ ...a, contentHash: "abce000000000000" }), (e) => e.code === "RESERVE_FAILED",
    "guard must not treat corrupted state as absent");
  assert.throws(() => appendNote(logPath, { chainId, unique: 0, outcome: "aborted" }),
    (e) => e.code === "LOG_CORRUPT" || e.code === "NOTE_FAILED");
  assert.equal(computeStats(logPath).corruptLines, 1);
});

test("computeStats: eligible = auto && !aborted; uniquePer5; open chains flagged", () => {
  const logPath = join(tmp(), "log.jsonl");
  const mk = (hash, trigger) => reserveChain({ logPath, repo: "r", repoKey: "/x/r", artifact: "a.md", contentHash: hash, trigger }).chainId;
  const c1 = mk("0000000000000001", "auto");
  appendResult(logPath, { chainId: c1, mode: "audit", verdict: "PASS" });
  appendNote(logPath, { chainId: c1, unique: 2, outcome: "audit-pass" });
  const c2 = mk("0000000000000002", "auto");
  appendNote(logPath, { chainId: c2, unique: 0, outcome: "aborted", comment: "aborted: error" });
  const c3 = mk("0000000000000003", "forced");
  appendResult(logPath, { chainId: c3, mode: "review", verdict: "REVISE" });
  appendNote(logPath, { chainId: c3, unique: 1, outcome: "cap-revise" });
  const c4 = mk("0000000000000004", "auto"); // open, no note
  const s = computeStats(logPath);
  assert.equal(s.corruptLines, 0);
  assert.equal(s.eligible, 1);
  assert.equal(s.uniqueTotal, 2);
  assert.equal(s.uniquePer5, 10); // 2 unique / 1 eligible * 5
  assert.equal(s.forced, 1);
  assert.deepEqual(s.openChainIds, [c4]);
  assert.equal(s.byOutcome["aborted"], 1);
});

const SCRIPT = new URL("./codex-review.mjs", import.meta.url).pathname;

function makeShim(dir, mode) {
  // mode: ok | noverdict | fail | slow | garbage | auditpass — recorded argv goes to <dir>/argv.json
  const shim = `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.SHIM_DIR + "/argv.json", JSON.stringify(process.argv.slice(2)));
const mode = process.env.SHIM_MODE;
if (mode === "slow") { setTimeout(() => process.exit(0), 10_000); return; }
if (mode === "garbage") { console.log("<<<definitely not json>>>"); return; }
console.log(JSON.stringify({ type: "thread.started", thread_id: "sess-123" }));
if (mode === "fail") {
  console.log(JSON.stringify({ type: "turn.failed", error: { message: "boom" } }));
} else {
  const text = mode === "noverdict" ? "- [P1] thing\\nno verdict here"
    : mode === "auditpass" ? "All coherent as a whole.\\nAUDIT: PASS"
    : "- [P1] one\\n- [P2] two\\nVERDICT: REVISE";
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } }));
}
`;
  writeFileSync(join(dir, "codex"), shim);
  chmodSync(join(dir, "codex"), 0o755);
  return {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SHIM_DIR: dir, SHIM_MODE: mode },
    // null (not a throw) when codex was never invoked — a refused-before-spawn test asserts exactly
    // that absence.
    argv: () => {
      try { return JSON.parse(readFileSync(join(dir, "argv.json"), "utf8")); }
      catch (e) { if (e.code === "ENOENT") return null; throw e; }
    },
  };
}

function runCli(args, env, logPath, { cwd } = {}) {
  return spawnSync("node", [SCRIPT, ...args], {
    env: { ...env, CODEX_REVIEW_LOG: logPath }, encoding: "utf8", timeout: 30_000, ...(cwd ? { cwd } : {}),
  });
}

test("e2e: fresh auto review — verdict, findings, log lines, exact codex args", () => {
  const dir = tmp(); const logPath = join(dir, "log.jsonl");
  const artifact = join(dir, "plan.md"); writeFileSync(artifact, "# a plan");
  const shim = makeShim(dir, "ok");
  const r = runCli(["review", artifact, "--auto"], shim.env, logPath);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.verdict, "REVISE");
  assert.deepEqual(out.findings, { p1: 1, p2: 1, p3: 0 });
  assert.equal(out.sessionId, "sess-123");
  assert.equal(out.pendingNoteChainId, out.chainId);
  const argv = shim.argv();
  assert.deepEqual(argv.slice(0, 3), ["exec", "--json", "--sandbox"]);
  assert.ok(argv.includes("read-only") && argv.includes("-m") && argv.includes("gpt-5.6-terra"));
  assert.ok(argv.includes("model_reasoning_effort=high") && argv.includes("--skip-git-repo-check"));
  const lines = readLogLines(logPath);
  assert.equal(lines[0].mode, "open");
  assert.equal(lines[1].mode, "review");
  assert.equal(lines[1].verdict, "REVISE");
});

test("e2e: second auto review of same content refuses (guard); --force proceeds", () => {
  const dir = tmp(); const logPath = join(dir, "log.jsonl");
  const artifact = join(dir, "plan.md"); writeFileSync(artifact, "# same");
  const shim = makeShim(dir, "ok");
  assert.equal(runCli(["review", artifact, "--auto"], shim.env, logPath).status, 0);
  const refused = runCli(["review", artifact, "--auto"], shim.env, logPath);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /chain .* already exists/);
  assert.equal(runCli(["review", artifact, "--force"], shim.env, logPath).status, 0);
});

test("e2e: resume round uses exact resume argv and honors --retry-verdict", () => {
  const dir = tmp(); const logPath = join(dir, "log.jsonl");
  const artifact = join(dir, "plan.md"); writeFileSync(artifact, "# a plan");
  const shim = makeShim(dir, "ok");
  const first = JSON.parse(runCli(["review", artifact, "--auto"], shim.env, logPath).stdout);
  const r = runCli(["review", artifact, "--resume", first.sessionId, "--chain", first.chainId, "--retry-verdict"], shim.env, logPath);
  assert.equal(r.status, 0, r.stderr);
  const argv = shim.argv();
  assert.deepEqual(argv.slice(0, 3), ["exec", "resume", "sess-123"]);
  assert.ok(argv.includes("--json") && argv.includes("-m"));
  assert.ok(argv.includes("--skip-git-repo-check"), "resume must work for non-repo scratchpad artifacts too");
  assert.match(argv[argv.length - 1], /missing the verdict line/);
  const lines = readLogLines(logPath);
  assert.equal(lines.at(-1).chainId, first.chainId); // chain propagated
  assert.equal(lines.at(-1).round, 2); // fresh was round 1
  assert.ok(lines.at(-1).contentHash, "each round records the revision it reviewed");
});

test("e2e: bogus or closed --chain refuses before spending quota", () => {
  const dir = tmp(); const logPath = join(dir, "log.jsonl");
  const artifact = join(dir, "plan.md"); writeFileSync(artifact, "# a plan");
  const shim = makeShim(dir, "ok");
  const bogus = runCli(["review", artifact, "--resume", "sess-123", "--chain", "ffffffffffff"], shim.env, logPath);
  assert.notEqual(bogus.status, 0);
  assert.match(bogus.stderr, /unknown chain/);
  const first = JSON.parse(runCli(["review", artifact, "--auto"], shim.env, logPath).stdout);
  runCli(["note", "--chain", first.chainId, "--unique", "0", "--outcome", "aborted", "--comment", "aborted: test"], shim.env, logPath);
  const closed = runCli(["review", artifact, "--resume", first.sessionId, "--chain", first.chainId], shim.env, logPath);
  assert.notEqual(closed.status, 0);
  assert.match(closed.stderr, /already closed/);
});

test("e2e: spawn failure after reservation still emits result JSON with pendingNoteChainId", () => {
  const dir = tmp(); const logPath = join(dir, "log.jsonl");
  const artifact = join(dir, "plan.md"); writeFileSync(artifact, "# a plan");
  // process.execPath, not "node": node lives under mise on this machine, so a
  // stripped PATH must only remove codex from lookup, not node itself.
  const r = spawnSync(process.execPath, [SCRIPT, "review", artifact, "--auto"], {
    env: { ...process.env, PATH: "/usr/bin:/bin", CODEX_REVIEW_LOG: logPath }, // no codex on PATH
    encoding: "utf8", timeout: 30_000,
  });
  assert.notEqual(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.verdict, "error");
  assert.ok(out.pendingNoteChainId, "caller must be able to close the orphaned chain as aborted");
});

test("e2e: chain bound to another artifact refuses before spawning", () => {
  const dir = tmp(); const logPath = join(dir, "log.jsonl");
  const a1 = join(dir, "plan-a.md"); writeFileSync(a1, "# plan a");
  const a2 = join(dir, "plan-b.md"); writeFileSync(a2, "# plan b");
  const shim = makeShim(dir, "ok");
  const first = JSON.parse(runCli(["review", a1, "--auto"], shim.env, logPath).stdout);
  const r = runCli(["review", a2, "--resume", first.sessionId, "--chain", first.chainId], shim.env, logPath);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /belongs to/);
});

test("e2e: malformed (non-JSON) stream → verdict error, non-zero exit", () => {
  const dir = tmp(); const logPath = join(dir, "log.jsonl");
  const artifact = join(dir, "plan.md"); writeFileSync(artifact, "# a plan");
  const shim = makeShim(dir, "garbage");
  const r = runCli(["review", artifact, "--auto"], shim.env, logPath);
  assert.notEqual(r.status, 0);
  assert.equal(JSON.parse(r.stdout).verdict, "error");
});

test("e2e: audit --retry-verdict resumes only the audit's own recorded session", () => {
  const dir = tmp(); const logPath = join(dir, "log.jsonl");
  const artifact = join(dir, "plan.md"); writeFileSync(artifact, "# a plan");
  const shim = makeShim(dir, "ok");
  const first = JSON.parse(runCli(["review", artifact, "--auto"], shim.env, logPath).stdout);
  // audit --resume before ANY audit ran must refuse (no recorded audit session)
  const early = runCli(["audit", artifact, "--chain", first.chainId, "--resume", "sess-123", "--retry-verdict"], shim.env, logPath);
  assert.notEqual(early.status, 0);
  assert.match(early.stderr, /not a recorded audit session/);
  // fresh audit records its session (shim always reports sess-123)…
  assert.equal(runCli(["audit", artifact, "--chain", first.chainId], shim.env, logPath).status, 0);
  // …audit --resume without --retry-verdict refuses…
  const noRetry = runCli(["audit", artifact, "--chain", first.chainId, "--resume", "sess-123"], shim.env, logPath);
  assert.notEqual(noRetry.status, 0);
  assert.match(noRetry.stderr, /only valid with --retry-verdict/);
  // …and the legitimate retry (recorded audit verdict is UNPARSEABLE — the "ok"
  // shim has no AUDIT line) resumes with the AUDIT-specific nudge.
  const a = runCli(["audit", artifact, "--chain", first.chainId, "--resume", "sess-123", "--retry-verdict"], shim.env, logPath);
  assert.equal(a.status, 0, a.stderr);
  const argv = shim.argv();
  assert.deepEqual(argv.slice(0, 3), ["exec", "resume", "sess-123"]);
  assert.match(argv[argv.length - 1], /missing the audit line/);
  assert.doesNotMatch(argv[argv.length - 1], /VERDICT:/);
  // A COMPLETED audit (real verdict) must not be resumable — one audit per chain.
  const a2 = join(dir, "plan2.md"); writeFileSync(a2, "# plan two");
  const second = JSON.parse(runCli(["review", a2, "--auto"], shim.env, logPath).stdout);
  runCli(["audit", a2, "--chain", second.chainId], { ...shim.env, SHIM_MODE: "auditpass" }, logPath);
  const done = runCli(["audit", a2, "--chain", second.chainId, "--resume", "sess-123", "--retry-verdict"], shim.env, logPath);
  assert.notEqual(done.status, 0);
  assert.match(done.stderr, /only for an UNPARSEABLE audit/);
});

test("e2e: concurrent auto opens on the same artifact — exactly one wins", async () => {
  const dir = tmp(); const logPath = join(dir, "log.jsonl");
  const artifact = join(dir, "plan.md"); writeFileSync(artifact, "# a plan");
  const shim = makeShim(dir, "ok");
  const env = { ...shim.env, CODEX_REVIEW_LOG: logPath };
  const run = () => new Promise((res) => {
    const c = spawnAsync("node", [SCRIPT, "review", artifact, "--auto"], { env });
    c.on("close", (code) => res(code));
  });
  const codes = await Promise.all([run(), run()]);
  assert.equal(codes.filter((c) => c === 0).length, 1, `expected exactly one winner, got exit codes ${codes}`);
  // Correctness is append-order verification, not the lock: a losing racer may
  // have appended an open line, but it must have self-aborted it.
  const lines = readLogLines(logPath);
  const aborted = new Set(lines.filter((l) => l.mode === "note" && l.outcome === "aborted").map((l) => l.chainId));
  const liveOpens = lines.filter((l) => l.mode === "open" && !aborted.has(l.chainId));
  assert.equal(liveOpens.length, 1, "exactly one non-aborted reservation");
});

test("e2e: terminal failure event → verdict error + non-zero exit; audit variant parses AUDIT", () => {
  const dir = tmp(); const logPath = join(dir, "log.jsonl");
  const artifact = join(dir, "plan.md"); writeFileSync(artifact, "# a plan");
  const failShim = makeShim(dir, "fail");
  const r = runCli(["review", artifact, "--auto"], failShim.env, logPath);
  assert.notEqual(r.status, 0);
  assert.equal(JSON.parse(r.stdout).verdict, "error");
  // audit against a fresh artifact/chain, shim emits VERDICT-less review text → audit-mode UNPARSEABLE
  const dir2 = tmp(); const log2 = join(dir2, "log.jsonl");
  const artifact2 = join(dir2, "plan.md"); writeFileSync(artifact2, "# b plan");
  const shim2 = makeShim(dir2, "noverdict");
  const first = JSON.parse(runCli(["review", artifact2, "--auto"], shim2.env, log2).stdout);
  assert.equal(first.verdict, "UNPARSEABLE");
  const a = runCli(["audit", artifact2, "--chain", first.chainId], shim2.env, log2);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(JSON.parse(a.stdout).verdict, "UNPARSEABLE"); // no AUDIT line in shim output either
});

test("e2e: timeout kills codex, verdict timeout, non-zero exit", () => {
  const dir = tmp(); const logPath = join(dir, "log.jsonl");
  const artifact = join(dir, "plan.md"); writeFileSync(artifact, "# a plan");
  const shim = makeShim(dir, "slow");
  const start = Date.now();
  const r = runCli(["review", artifact, "--auto", "--timeout", "2"], shim.env, logPath);
  assert.ok(Date.now() - start < 8_000, "should not wait for the slow shim");
  assert.notEqual(r.status, 0);
  assert.equal(JSON.parse(r.stdout).verdict, "timeout");
});

test("e2e: review → audit → note → stats close the loop with lifecycle intact", () => {
  const dir = tmp(); const logPath = join(dir, "log.jsonl");
  const artifact = join(dir, "plan.md"); writeFileSync(artifact, "# a plan");
  const shim = makeShim(dir, "ok");
  const first = JSON.parse(runCli(["review", artifact, "--auto"], shim.env, logPath).stdout);
  // note before any audit must refuse (lifecycle) …
  const early = runCli(["note", "--chain", first.chainId, "--unique", "1", "--outcome", "audit-pass"], shim.env, logPath);
  assert.notEqual(early.status, 0);
  // … audit passes (auditpass shim), then the note is legal
  const a = runCli(["audit", artifact, "--chain", first.chainId], { ...shim.env, SHIM_MODE: "auditpass" }, logPath);
  assert.equal(JSON.parse(a.stdout).verdict, "PASS");
  const n = runCli(["note", "--chain", first.chainId, "--unique", "1", "--outcome", "audit-pass", "--comment", "dogfood"], shim.env, logPath);
  assert.equal(n.status, 0, n.stderr);
  const s = runCli(["stats"], shim.env, logPath);
  const stats = JSON.parse(s.stdout);
  assert.equal(stats.eligible, 1);
  assert.equal(stats.uniquePer5, 5);
});

test("cli: missing <file> and unknown flags die with usage, not a stack trace", () => {
  const logPath = join(tmp(), "log.jsonl");
  const noFile = runCli(["review"], process.env, logPath);
  assert.equal(noFile.status, 1);
  assert.match(noFile.stderr, /review requires a <file> argument/);
  assert.match(noFile.stderr, /usage:/);
  assert.doesNotMatch(noFile.stderr, /TypeError/);
  const badFlag = runCli(["review", "plan.md", "--bogus"], process.env, logPath);
  assert.equal(badFlag.status, 1);
  assert.match(badFlag.stderr, /usage:/);
  assert.doesNotMatch(badFlag.stderr, /at .*\(node:/, "parseArgs failure must not print a raw stack trace");
});

test("resolveRepoRoot: fallback path leaks nothing to stderr", () => {
  // Reproduces the SDD plan-conflict: git's "fatal: cannot change to …" used to
  // inherit the parent's stderr whenever the non-repo fallback fired.
  const r = spawnSync(process.execPath, [
    "-e",
    `import(${JSON.stringify("file://" + SCRIPT)}).then(m => process.stdout.write(m.resolveRepoRoot("/tmp/nonexistent-dir-xyz/plan.md")))`,
  ], { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.stdout, "/tmp/nonexistent-dir-xyz");
  assert.equal(r.stderr, "", "git fatal output must not leak through resolveRepoRoot");
});

/** A throwaway git repo with two commits on main. Returns its root. */
function fixtureRepo(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-diff-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: ["ignore", "pipe", "ignore"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  // Isolate from the developer machine's global hooksPath (e.g. a gitleaks pre-commit hook that
  // itself runs `git diff --cached` without --no-textconv): without this, a global hook's OWN diff
  // call can trip a configured textconv driver and falsely implicate resolveDiff()'s --no-textconv.
  git("config", "core.hooksPath", "/dev/null");
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "first");
  writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "second");
  return dir;
}

const LIMITS = { maxLines: 4000, maxBytes: 400_000 };

test("repoRootOfDir: resolves the repo of the DIRECTORY, not its parent", (t) => {
  const repo = fixtureRepo(t);
  // resolveRepoRoot() dirname()s its argument (it takes a FILE path). Reusing it for a directory
  // would resolve the PARENT's repo — silently running every git command in the wrong place.
  // realpathSync: on macOS, os.tmpdir() lives under /var, a symlink to /private/var — git resolves
  // symlinks when reporting --show-toplevel, mkdtempSync does not.
  assert.equal(repoRootOfDir(repo), realpathSync(repo));
});

test("isSafeGitRange: accepts the shapes we actually use", () => {
  for (const r of ["main...HEAD", "main..HEAD", "HEAD~3..HEAD", "origin/main...HEAD",
                   "v0.1.0..v0.2.0", "feat/some-branch...main", "abc1234..def5678"]) {
    assert.equal(isSafeGitRange(r), true, `${r} should be accepted`);
  }
});

test("isSafeGitRange: rejects anything git would read as a FLAG", () => {
  // `git diff --output=/tmp/x` WRITES A FILE, in a tool whose safety story is a read-only sandbox.
  // An argv array stops shell injection, not flag injection.
  for (const r of ["--output=/tmp/pwned", "-O/tmp/pwned", "--ext-diff", "-z"]) {
    assert.equal(isSafeGitRange(r), false, `${r} must be rejected: git parses it as a flag`);
  }
});

test("isSafeGitRange: requires an explicit two- or three-dot range", () => {
  // A bare ref means "diff the WORKING TREE against it" — uncommitted changes make the review
  // non-deterministic and unreproducible from the chain record.
  for (const r of ["HEAD", "main", "abc1234"]) {
    assert.equal(isSafeGitRange(r), false, `${r} is a bare ref, not a range`);
  }
});

test("isSafeGitRange: rejects junk", () => {
  for (const r of ["", " ", "a b", "a;b", "a$(id)b", "a|b", "a\nb", "..", "...", "a'b", '"', "a".repeat(300)]) {
    assert.equal(isSafeGitRange(r), false, `${JSON.stringify(r)} must be rejected`);
  }
  assert.equal(isSafeGitRange(null), false);
  assert.equal(isSafeGitRange(undefined), false);
});

test("parseMaxLines: NaN and Infinity must NOT silently disable the limit", () => {
  // `NaN <= 0` is FALSE, so a naive "reject non-positive" check lets NaN through and disables the cap.
  for (const bad of ["NaN", "abc", "Infinity", "-1", "0", "1.5", "", undefined]) {
    assert.throws(() => parseMaxLines(bad), /positive integer/i, `${bad} must be rejected`);
  }
  assert.equal(parseMaxLines("500"), 500);
  assert.equal(parseMaxLines(500), 500);
});

test("resolveDiff: pins a symbolic range to immutable SHAs", (t) => {
  const repo = fixtureRepo(t);
  const d = resolveDiff(repo, "HEAD~1..HEAD", LIMITS);

  assert.match(d.text, /\+two/, "the diff text contains the added line");
  assert.deepEqual(d.files, ["a.txt"]);
  assert.match(d.base, /^[0-9a-f]{40}$/, "base is pinned to a full SHA");
  assert.match(d.head, /^[0-9a-f]{40}$/, "head is pinned to a full SHA");
  assert.equal(d.pinnedRange, `${d.base}..${d.head}`);
  // The pinned range is what we hash AND what Codex is told to run. A symbolic range would let HEAD
  // move between the two, so the reviewer would read different content than the chain recorded.
  assert.doesNotMatch(d.pinnedRange, /HEAD|main/);
});

test("resolveDiff: a three-dot range pins base to the MERGE BASE", (t) => {
  const repo = fixtureRepo(t);
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const mergeBase = git("merge-base", "HEAD~1", "HEAD").trim();
  const d = resolveDiff(repo, "HEAD~1...HEAD", LIMITS);
  assert.equal(d.base, mergeBase, "A...B means 'changes on B since it diverged from A'");
});

test("resolveDiff: an EMPTY diff is refused, not reviewed", (t) => {
  const repo = fixtureRepo(t);
  // Reviewing nothing and returning APPROVED is the worst possible outcome — it LOOKS like a pass.
  assert.throws(() => resolveDiff(repo, "HEAD..HEAD", LIMITS), /empty/i);
});

test("resolveDiff: an oversized diff is refused, not silently truncated", (t) => {
  const repo = fixtureRepo(t);
  assert.throws(() => resolveDiff(repo, "HEAD~1..HEAD", { maxLines: 1, maxBytes: 400_000 }), /too large|narrow/i);
  assert.throws(() => resolveDiff(repo, "HEAD~1..HEAD", { maxLines: 4000, maxBytes: 10 }), /too large|narrow/i);
});

test("resolveDiff: a bad range fails loudly rather than reviewing the wrong thing", (t) => {
  const repo = fixtureRepo(t);
  assert.throws(() => resolveDiff(repo, "no-such-ref..HEAD", LIMITS));
  assert.throws(() => resolveDiff(repo, "--output=/tmp/pwned", LIMITS), /unsafe|malformed/i);
});

test("resolveDiff: a file hidden by .gitattributes '-diff' is REPORTED, never silently dropped", (t) => {
  const repo = fixtureRepo(t);
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: ["ignore", "pipe", "ignore"] });
  // A repo can mark real SOURCE as -diff. git then shows nothing for it, while the diff still looks
  // healthy — source code hidden from the reviewer, and silence reads as a pass.
  writeFileSync(path.join(repo, ".gitattributes"), "secret.mjs -diff\n");
  writeFileSync(path.join(repo, "secret.mjs"), "export const x = 1;\n");
  writeFileSync(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
  git("add", "-A");
  git("commit", "-q", "-m", "hide");

  const d = resolveDiff(repo, "HEAD~1..HEAD", LIMITS);
  assert.ok(d.undiffable.includes("secret.mjs"), "an undiffable file must be surfaced, not dropped");
  assert.equal(d.files.includes("secret.mjs"), false, "and must not be listed as reviewable");
  assert.ok(d.files.includes("a.txt"), "the genuinely reviewable file is still reviewed");
});

test("resolveDiff: refuses when EVERY changed file is undiffable", (t) => {
  const repo = fixtureRepo(t);
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: ["ignore", "pipe", "ignore"] });
  writeFileSync(path.join(repo, ".gitattributes"), "*.bin -diff\n");
  git("add", "-A");
  git("commit", "-q", "-m", "attrs");
  writeFileSync(path.join(repo, "blob.bin"), " binary ");
  git("add", "-A");
  git("commit", "-q", "-m", "binary only");

  // Reviewing nothing and returning APPROVED is the worst possible outcome.
  assert.throws(() => resolveDiff(repo, "HEAD~1..HEAD", LIMITS), /nothing reviewable|empty/i);
});

test("resolveDiff: does not run a repo-configured textconv program", (t) => {
  const repo = fixtureRepo(t);
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: ["ignore", "pipe", "ignore"] });
  const marker = path.join(repo, "TEXTCONV_RAN");
  // git textconv/external-diff drivers execute configured PROGRAMS — host-side code execution,
  // outside Codex's read-only sandbox. --no-textconv/--no-ext-diff must prevent it.
  git("config", "diff.pwned.textconv", `sh -c 'touch ${marker}' --`);
  writeFileSync(path.join(repo, ".gitattributes"), "*.txt diff=pwned\n");
  git("add", "-A");
  git("commit", "-q", "-m", "attrs");
  writeFileSync(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "third");

  resolveDiff(repo, "HEAD~1..HEAD", LIMITS);
  assert.equal(existsSync(marker), false, "textconv must not execute: --no-textconv is load-bearing");
});

test("isAuditMode / isDiffMode classify every mode", () => {
  assert.equal(isAuditMode("audit"), true);
  assert.equal(isAuditMode("diff-audit"), true);
  assert.equal(isAuditMode("review"), false);
  assert.equal(isAuditMode("diff"), false);
  assert.equal(isDiffMode("diff"), true);
  assert.equal(isDiffMode("diff-audit"), true);
  assert.equal(isDiffMode("review"), false);
  assert.equal(isDiffMode("audit"), false);
});

test("parseVerdict: diff uses the VERDICT contract, diff-audit uses the AUDIT contract", () => {
  assert.equal(parseVerdict("x\nVERDICT: REVISE", "diff"), "REVISE");
  assert.equal(parseVerdict("x\nVERDICT: APPROVED", "diff"), "APPROVED");
  assert.equal(parseVerdict("x\nAUDIT: CONCERNS", "diff-audit"), "CONCERNS");
  assert.equal(parseVerdict("x\nAUDIT: PASS", "diff-audit"), "PASS");
  assert.equal(parseVerdict("no verdict", "diff"), "UNPARSEABLE");
});

test("buildDiffPrompt: instructs a CODE review of the PINNED range and names the files", () => {
  const p = buildDiffPrompt("aaa111..bbb222", ["src/a.mjs", "src/b.mjs"]);
  assert.match(p, /aaa111\.\.bbb222/);
  assert.match(p, /src\/a\.mjs/);
  assert.match(p, /src\/b\.mjs/);
  assert.match(p, /VERDICT: APPROVED or VERDICT: REVISE/);
  assert.match(p, /\[P1\]/);
});

test("buildDiffAuditPrompt: uses the AUDIT verdict line and the pinned range", () => {
  const p = buildDiffAuditPrompt("aaa111..bbb222");
  assert.match(p, /aaa111\.\.bbb222/);
  assert.match(p, /AUDIT: PASS or AUDIT: CONCERNS/);
  assert.doesNotMatch(p, /design\/plan document/, "a diff audit must not describe a plan document");
});

test("buildDiffResumePrompt: re-reviews CODE, not a revised document", () => {
  const p = buildDiffResumePrompt("aaa111..bbb222");
  assert.match(p, /aaa111\.\.bbb222/);
  assert.match(p, /VERDICT: APPROVED or VERDICT: REVISE/);
  assert.doesNotMatch(p, /document/i, "the plan-mode resume prompt would say 'the artifact ... has been revised'");
});

test("diff prompts do NOT smuggle in intent, a plan, or a self-assessment", () => {
  // Framing degraded findings 3-4x in testing. The diff must stand on its own merits.
  for (const p of [buildDiffPrompt("a..b", ["x.mjs"]), buildDiffResumePrompt("a..b"), buildDiffAuditPrompt("a..b")]) {
    assert.doesNotMatch(p, /the (author|implementer) (says|claims|believes)/i);
    assert.doesNotMatch(p, /is intended to|is meant to|aims to/i);
    assert.doesNotMatch(p, /\bplan\b|\bspec\b/i);
  }
});

test("CLI e2e: a diff chain opens, RESUMES after a fix commit, audits once, and closes", (t) => {
  const repo = fixtureRepo(t);
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logPath = path.join(dir, "log.jsonl");
  const shim = makeShim(dir, "ok");
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: ["ignore", "pipe", "ignore"] });
  const cli = (argv) => runCli(argv, { ...shim.env }, logPath, { cwd: repo });

  // A feature branch, so the range `main...HEAD` is STABLE as fix commits land. This is the whole
  // usage convention: a fixed base against a moving tip. A range like `HEAD~1..HEAD` would name a
  // different artifact every round and could not be resumed at all.
  git("checkout", "-q", "-b", "feature");
  writeFileSync(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "feature work");
  const RANGE = "main...HEAD";

  const r1 = JSON.parse(cli(["diff", RANGE, "--force"]).stdout);
  assert.equal(r1.mode, "diff");
  assert.ok(r1.chainId);

  // A fix commit moves HEAD. The SAME symbolic range still names this branch's changes — which is
  // exactly why the chain's artifact must be the symbolic range and not the SHA-pinned one. Pinned,
  // the artifact would stop matching here and the resume would be refused.
  writeFileSync(path.join(repo, "a.txt"), "one\ntwo\nfixed\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "fix");

  const r2 = JSON.parse(cli(["diff", RANGE, "--chain", r1.chainId, "--resume", r1.sessionId]).stdout);
  assert.equal(r2.chainId, r1.chainId, "the resumed round stays on the SAME chain");

  // The "ok" shim mode always emits VERDICT: REVISE text regardless of which CLI mode invoked it
  // (it only reads SHIM_MODE, not argv) — so the audit round needs "auditpass" to produce an
  // AUDIT: line, exactly as the existing plan-mode "review -> audit" e2e test does.
  const a1 = JSON.parse(runCli(["diff-audit", RANGE, "--chain", r1.chainId], { ...shim.env, SHIM_MODE: "auditpass" }, logPath, { cwd: repo }).stdout);
  assert.equal(a1.mode, "diff-audit");
  assert.ok(["PASS", "CONCERNS"].includes(a1.verdict));

  const a2 = cli(["diff-audit", RANGE, "--chain", r1.chainId]);
  assert.notEqual(a2.status, 0, "a SECOND audit must be refused — the audit is run once");
  assert.match(a2.stderr, /already has an audit/i);

  // --retry-verdict must not be a bypass for that guard.
  const a3 = cli(["diff-audit", RANGE, "--chain", r1.chainId, "--retry-verdict"]);
  assert.notEqual(a3.status, 0, "--retry-verdict without --resume must not start a fresh second audit");

  // And the chain can actually be closed. appendNote hard-codes mode names; without the widening,
  // every non-aborted diff outcome throws LIFECYCLE_MISMATCH and the chain jams open forever.
  const note = cli(["note", "--chain", r1.chainId, "--unique", "2",
                    "--outcome", a1.verdict === "PASS" ? "audit-pass" : "audit-concerns-user-approved"]);
  assert.equal(note.status, 0, `note must close a diff chain: ${note.stderr}`);
});

test("CLI e2e: a 4th review round is refused BEFORE spending quota", (t) => {
  const repo = fixtureRepo(t);
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-cap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logPath = path.join(dir, "log.jsonl");
  const shim = makeShim(dir, "ok");
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: ["ignore", "pipe", "ignore"] });
  const cli = (argv) => runCli(argv, { ...shim.env }, logPath, { cwd: repo });

  git("checkout", "-q", "-b", "feature");
  writeFileSync(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "work");
  const RANGE = "main...HEAD";

  const r1 = JSON.parse(cli(["diff", RANGE, "--force"]).stdout);
  cli(["diff", RANGE, "--chain", r1.chainId, "--resume", r1.sessionId]); // round 2
  cli(["diff", RANGE, "--chain", r1.chainId, "--resume", r1.sessionId]); // round 3

  // The protocol is 3 rounds + 1 audit, and until now NOTHING enforced it — round was recorded and
  // never checked, so a caller could burn unlimited paid rounds.
  const r4 = cli(["diff", RANGE, "--chain", r1.chainId, "--resume", r1.sessionId]);
  assert.notEqual(r4.status, 0, "a 4th review round must be refused");
  assert.match(r4.stderr, /3 review rounds|rounds \+ 1 audit/i);
});

test("CLI e2e: an oversized diff is refused before any codex call", (t) => {
  const repo = fixtureRepo(t);
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-cli2-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shim = makeShim(dir, "ok");
  const r = runCli(["diff", "HEAD~1..HEAD", "--force", "--max-lines", "1"],
    { ...shim.env }, path.join(dir, "log.jsonl"), { cwd: repo });

  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /too large|narrow/i);
  assert.equal(shim.argv(), null, "codex must never be invoked for a refused diff — no quota spent");
});

// --- Regressions found by codex-review's own diff mode, reviewing the commit that introduced it.
// First evidence that diff mode finds real code bugs — the open question it was built to answer.

test("isSafeGitRange: rejects a range with MORE THAN ONE separator", () => {
  // A ref may legally contain dots, so a naive `^REF\.{2,3}REF$` accepts this: the second "ref"
  // swallows "HEAD~1..HEAD". resolveDiff then split("..")s it, destructures only the first two
  // parts, and silently reviews HEAD..HEAD~1 — the WRONG range, REVERSED, reporting success.
  for (const r of ["HEAD..HEAD~1..HEAD", "a..b..c", "a...b...c", "main..HEAD..HEAD"]) {
    assert.equal(isSafeGitRange(r), false, `${r} has two separators and must be rejected`);
  }
  assert.equal(isSafeGitRange("main...HEAD"), true, "one separator is still fine");
  assert.equal(isSafeGitRange("v1.2.3..v1.3.0"), true, "dots WITHIN a ref are still fine");
});

test("resolveDiff: a diff of exactly maxLines is accepted, not off-by-one refused", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-offby1-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: ["ignore", "pipe", "ignore"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  git("config", "core.hooksPath", "/dev/null");
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "first");
  writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "second");

  // Count the diff's lines INDEPENDENTLY. Deriving the expected count from resolveDiff itself would
  // be vacuous: the off-by-one would cancel out on both sides and the test would pass against the
  // buggy code (it did).
  const raw = execFileSync("git", ["-C", dir, "diff", "--no-textconv", "--no-ext-diff", "HEAD~1..HEAD", "--"],
    { encoding: "utf8" });
  const trueLines = raw.replace(/\n$/, "").split("\n").length;

  const d = resolveDiff(dir, "HEAD~1..HEAD", { maxLines: 100000, maxBytes: 400000 });
  assert.equal(d.lines, trueLines, "git's diff ends with a newline; counting the empty trailing element inflates the count by one");

  assert.doesNotThrow(
    () => resolveDiff(dir, "HEAD~1..HEAD", { maxLines: trueLines, maxBytes: 400000 }),
    "a diff of exactly maxLines must be accepted, not off-by-one refused",
  );
  assert.throws(
    () => resolveDiff(dir, "HEAD~1..HEAD", { maxLines: trueLines - 1, maxBytes: 400000 }),
    /too large|narrow/i,
    "one line over the limit is still refused",
  );
});
