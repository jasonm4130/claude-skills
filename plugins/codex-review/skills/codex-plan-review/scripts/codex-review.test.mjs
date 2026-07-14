// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  parseEventStream, parseVerdict, countFindings,
  buildReviewPrompt, buildResumePrompt, buildAuditPrompt, buildRetryPrompt,
  contentHashOf, mintChainId, resolveRepoRoot,
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
