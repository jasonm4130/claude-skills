// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, utimesSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseEventStream, parseVerdict, countFindings,
  buildReviewPrompt, buildResumePrompt, buildAuditPrompt, buildRetryPrompt,
  contentHashOf, mintChainId, resolveRepoRoot,
  readLogLines, acquireLock, releaseLock, reserveChain, appendResult, appendNote, computeStats, getChainState, OUTCOMES,
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

test("contentHashOf and mintChainId are deterministic short hashes", () => {
  const h = contentHashOf(Buffer.from("hello"));
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.equal(h, contentHashOf(Buffer.from("hello")));
  const id = mintChainId("docs/plan.md", h, "2026-07-14T00:00:00Z");
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.notEqual(id, mintChainId("docs/plan.md", h, "2026-07-14T00:00:01Z"));
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

test("lock: held fresh lock refuses; stale lock broken; release is ownership-safe", () => {
  const lockPath = join(tmp(), "log.jsonl.lock");
  const t1 = acquireLock(lockPath);
  assert.throws(() => acquireLock(lockPath), (e) => e.code === "LOCK_HELD");
  releaseLock(lockPath, t1);
  const t2 = acquireLock(lockPath);
  const old = (Date.now() - 60_000) / 1000;
  utimesSync(lockPath, old, old); // simulate a crashed/paused holder
  const t3 = acquireLock(lockPath, 30_000); // breaks the stale lock instead of throwing
  releaseLock(lockPath, t2); // the paused ex-holder returns: must NOT delete t3's lock
  assert.ok(existsSync(lockPath), "ownership-safe release must not remove another holder's lock");
  releaseLock(lockPath, t3);
  assert.ok(!existsSync(lockPath));
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
