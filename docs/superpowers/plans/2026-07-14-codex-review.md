# codex-review Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `codex-review` plugin whose `codex-plan-review` skill sends finalized plans/specs/design docs/ADRs to OpenAI Codex (GPT-5.6 Terra) for adversarial review via a verdict-loop protocol, with a cross-repo JSONL decision-gate log.

**Architecture:** SKILL.md owns orchestration judgment (when to trigger, walking findings, amending between rounds); a single dependency-free Node script (`codex-review.mjs`) owns deterministic mechanics (codex spawn, event-stream parsing, verdict extraction, atomic chain reservation/guard, logging, stats). One Codex round per script call — Claude sits in the middle of the loop.

**Tech Stack:** Node ≥18 stdlib only (`node:child_process`, `node:fs`, `node:crypto`, `node:util` `parseArgs`), `node --test` for tests. Spec: `docs/superpowers/specs/2026-07-14-codex-plan-review-design.md` (read it before starting any task).

## Global Constraints

- Plugin version is `0.1.0` in BOTH `plugins/codex-review/.claude-plugin/plugin.json` AND the marketplace entry (`scripts/repo-consistency.test.mjs` asserts they match).
- Root `README.md` must contain the literal string `` `codex-review` `` (consistency test asserts it).
- Plugin README install command must be exactly `/plugin install codex-review@jasonm4130-claude-skills`; marketplace-add command must reference `jasonm4130/claude-skills`.
- No npm dependencies. Plain JS, no TypeScript syntax.
- Codex defaults, verbatim: model `gpt-5.6-terra`, effort `high` (as `-c model_reasoning_effort=high`), sandbox `read-only`, timeout 300s.
- Codex process **exit codes are never trusted**; `--output-schema` is never used.
- Log: `~/.claude/codex-review-log.jsonl` (override via env `CODEX_REVIEW_LOG` — tests rely on this); lock file is always `<logPath>.lock`.
- All commits on branch `feat/codex-review`. Run tests from the repo root. Every commit message ends with:
  `Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw`

**Captured real `codex exec --json` event stream** (fixture for parsers — this is the actual current schema, captured 2026-07-14 on codex-cli 0.144.3):

```jsonl
{"type":"thread.started","thread_id":"019f5dcd-74f7-78b2-bf87-286146cf482e"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}
{"type":"turn.completed","usage":{"input_tokens":14396,"cached_input_tokens":9984,"output_tokens":5,"reasoning_output_tokens":0}}
```

Failure terminal events are `{"type":"turn.failed", ...}` or `{"type":"error", ...}` — the parser must treat any of those, or a missing `turn.completed`, as failure.

---

### Task 1: Plugin scaffold + registry invariants

**Files:**
- Create: `plugins/codex-review/.claude-plugin/plugin.json`
- Create: `plugins/codex-review/README.md` (stub — full content in Task 5)
- Modify: `.claude-plugin/marketplace.json` (add entry to `plugins` array, alphabetical position: after `adversarial-agents`, before `deep-dive`)
- Modify: `README.md` (root — add table row, alphabetical position matching)

**Interfaces:**
- Produces: registered plugin dir `plugins/codex-review/` that later tasks populate. Version string `0.1.0` used everywhere.

- [ ] **Step 1: Create the plugin dir and manifest**

`plugins/codex-review/.claude-plugin/plugin.json`:

```json
{
  "name": "codex-review",
  "description": "Cross-provider adversarial plan/design-doc review via OpenAI Codex (GPT-5.6 Terra): verdict-loop protocol, atomic chain guard, cross-repo decision-gate log.",
  "version": "0.1.0",
  "author": {
    "name": "Jason Matthew",
    "email": "jasonm4130@gmail.com"
  },
  "homepage": "https://github.com/jasonm4130/claude-skills",
  "repository": "https://github.com/jasonm4130/claude-skills",
  "license": "MIT",
  "keywords": ["claude-code", "codex", "cross-provider", "plan-review", "design-review", "adversarial-review"]
}
```

`plugins/codex-review/README.md` (stub, replaced in Task 5):

```markdown
# codex-review

Cross-provider adversarial plan/design-doc review via OpenAI Codex. Full docs land with the skill implementation.

Install: `/plugin install codex-review@jasonm4130-claude-skills`
```

- [ ] **Step 2: Run the consistency test to verify it fails for the right reason**

Run: `node --test scripts/repo-consistency.test.mjs`
Expected: FAIL — `every plugins/ dir is registered in marketplace.json and vice versa` (codex-review dir exists, no marketplace entry).

- [ ] **Step 3: Add the marketplace entry**

In `.claude-plugin/marketplace.json`, insert into the `plugins` array between the `adversarial-agents` and `deep-dive` entries:

```json
    {
      "name": "codex-review",
      "source": "./plugins/codex-review",
      "description": "Cross-provider adversarial plan/design-doc review via OpenAI Codex (GPT-5.6 Terra): verdict-loop protocol, atomic chain guard, cross-repo decision-gate log.",
      "version": "0.1.0",
      "author": {
        "name": "Jason Matthew"
      },
      "license": "MIT",
      "keywords": ["codex", "cross-provider", "plan-review", "design-review", "adversarial-review", "claude-code"],
      "category": "productivity"
    },
```

- [ ] **Step 4: Run the consistency test again**

Run: `node --test scripts/repo-consistency.test.mjs`
Expected: FAIL — `README documents every plugin` / `README missing codex-review` (the red→green middle step).

- [ ] **Step 5: Add the root README table row**

In root `README.md`, in the plugin table, insert between the `adversarial-agents` and `deep-dive` rows:

```markdown
| `codex-review` | Cross-provider plan/design review via OpenAI Codex (Terra) | `/plugin install codex-review@jasonm4130-claude-skills` |
```

- [ ] **Step 6: Run the consistency test to verify it passes**

Run: `node --test scripts/repo-consistency.test.mjs`
Expected: PASS (6/6).

- [ ] **Step 7: Commit**

```bash
git add plugins/codex-review/.claude-plugin/plugin.json plugins/codex-review/README.md .claude-plugin/marketplace.json README.md
git commit -m "feat(codex-review): scaffold plugin + registry entries

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

### Task 2: Pure functions — parsing, prompts, identity

**Files:**
- Create: `plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs`
- Create: `plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs`

**Interfaces:**
- Produces (exact exports later tasks consume):
  - `parseEventStream(stdoutText) -> {sessionId: string|null, finalMessage: string|null, terminal: "completed"|"failed"|"missing", usage: object|null}`
  - `parseVerdict(text, mode) -> "APPROVED"|"REVISE"|"PASS"|"CONCERNS"|"UNPARSEABLE"` (mode: `"review"|"audit"`)
  - `countFindings(text) -> {p1: number, p2: number, p3: number}`
  - `buildReviewPrompt(relPath) / buildResumePrompt(relPath) / buildAuditPrompt(relPath) / buildRetryPrompt(mode) -> string`
  - `contentHashOf(buffer) -> string` (16-hex-char sha256 prefix)
  - `mintChainId(relPath, contentHash, ts) -> string` (12-hex-char sha256 prefix)
  - `resolveRepoRoot(artifactAbsPath) -> string` (git toplevel of the artifact's dir, else the dir itself)

- [ ] **Step 1: Write the failing tests**

`plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs`:

```js
// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
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
  assert.ok(resolveRepoRoot(here + "codex-review.mjs").endsWith("claude-skills"));
  assert.equal(resolveRepoRoot("/tmp/nonexistent-dir-xyz/file.md"), "/tmp/nonexistent-dir-xyz");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs`
Expected: FAIL — module has no exports (file doesn't exist yet).

- [ ] **Step 3: Implement the pure functions**

`plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs` (start of file; later tasks append):

```js
#!/usr/bin/env node
// @ts-check
// codex-review.mjs — deterministic mechanics for the codex-plan-review skill.
// Spec: docs/superpowers/specs/2026-07-14-codex-plan-review-design.md
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs`
Expected: PASS (8/8).

- [ ] **Step 5: Commit**

```bash
git add plugins/codex-review/skills/codex-plan-review/scripts/
git commit -m "feat(codex-review): event-stream/verdict parsing, prompts, chain identity

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

### Task 3: Log layer — lock, reservation guard, notes, stats

**Files:**
- Modify: `plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs` (append)
- Modify: `plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs` (append)

**Interfaces:**
- Consumes: `mintChainId`, `contentHashOf` from Task 2.
- Produces (exact exports Task 4 consumes):
  - `logPathDefault() -> string` (env `CODEX_REVIEW_LOG` or `~/.claude/codex-review-log.jsonl`; lock is always `<logPath>.lock`)
  - `readLogLines(logPath) -> object[]` (parsed JSONL, junk lines skipped; missing file → `[]`; **any other read error throws** `.code="LOG_UNREADABLE"` — an unreadable log must never look empty to the guard)
  - `acquireLock(lockPath, staleMs=30000) -> token: string` (throws `.code="LOCK_HELD"` if held and fresh; breaks stale locks once) / `releaseLock(lockPath, token)` (**ownership-safe**: deletes the lock only if it still contains `token`, so a stale ex-holder can't remove a replacement holder's lock)
  - `getChainState(logPath, chainId) -> {open, note}|null` (Task 4 uses this to validate `--chain` before spending quota)
  - `reserveChain({logPath, repo, artifact, contentHash, trigger}) -> {chainId, ts}` — atomic check+append under lock; `trigger` is `"auto"|"forced"`; throws `.code="CHAIN_EXISTS"` (auto only, non-aborted match on **repo+artifact+contentHash** — hash alone would let identical content in different repos/paths suppress each other across the shared log) or `.code="RESERVE_FAILED"` (any lock/IO/log-read failure — fatal both modes)
  - `appendResult(logPath, entry) -> boolean` (non-fatal: false + stderr warning on failure)
  - `appendNote(logPath, {chainId, unique, outcome, comment}) -> void` (throws on unknown chain, duplicate note, invalid outcome, or IO failure)
  - `computeStats(logPath) -> {open: number, byOutcome: object, forced: number, eligible: number, uniqueTotal: number, uniquePer5: number|null, openChainIds: string[]}`
  - `OUTCOMES` = `["audit-pass","audit-concerns-user-approved","audit-concerns-dismissed","cap-revise","aborted"]` (`…-dismissed` = user dispositioned concerns by dismissal-with-reason rather than amendment — distinct class so the gate data stays honest)

- [ ] **Step 1: Write the failing tests (append to the test file)**

```js
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readLogLines, acquireLock, releaseLock, reserveChain, appendResult, appendNote, computeStats, getChainState, OUTCOMES,
} from "./codex-review.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "codexrev-"));

test("reserveChain: auto refuses on existing non-aborted hash; aborted chains don't block", () => {
  const logPath = join(tmp(), "log.jsonl");
  const base = { logPath, repo: "r", artifact: "a.md", contentHash: "aaaa000000000000", trigger: "auto" };
  const { chainId } = reserveChain(base);
  assert.throws(() => reserveChain(base), (e) => e.code === "CHAIN_EXISTS");
  appendNote(logPath, { chainId, unique: 0, outcome: "aborted", comment: "aborted: timeout" });
  assert.ok(reserveChain(base).chainId); // aborted chain no longer blocks
});

test("reserveChain: force bypasses hash check but not IO failure; auto fails closed on unwritable log", () => {
  const dir = tmp();
  const logPath = join(dir, "log.jsonl");
  const base = { logPath, repo: "r", artifact: "a.md", contentHash: "bbbb000000000000" };
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
  const a = { logPath, repo: "r", artifact: "a.md", contentHash: "dddd000000000000", trigger: "auto" };
  reserveChain(a);
  assert.ok(reserveChain({ ...a, artifact: "b.md" }).chainId, "same content at a different path must not be blocked");
  assert.ok(reserveChain({ ...a, repo: "other" }).chainId, "same content in a different repo must not be blocked");
  chmodSync(logPath, 0o000);
  assert.throws(() => reserveChain({ ...a, contentHash: "eeee000000000000" }), (e) => e.code === "RESERVE_FAILED",
    "an unreadable log must fail closed, not look empty");
  chmodSync(logPath, 0o600);
});

test("appendNote validates chain, duplicates, outcome class; appendResult is non-fatal", () => {
  const logPath = join(tmp(), "log.jsonl");
  const { chainId } = reserveChain({ logPath, repo: "r", artifact: "a.md", contentHash: "cccc000000000000", trigger: "auto" });
  assert.throws(() => appendNote(logPath, { chainId: "nope", unique: 0, outcome: "audit-pass" }));
  assert.throws(() => appendNote(logPath, { chainId, unique: 0, outcome: "not-a-class" }));
  appendNote(logPath, { chainId, unique: 2, outcome: "audit-pass", comment: "ok" });
  assert.throws(() => appendNote(logPath, { chainId, unique: 1, outcome: "audit-pass" })); // duplicate
  assert.equal(appendResult(join(tmp(), "no-such-dir-parent", "x", "log.jsonl"), { mode: "review" }), false);
  assert.equal(appendResult(logPath, { mode: "review", chainId, round: 1, verdict: "REVISE" }), true);
});

test("computeStats: eligible = auto && !aborted; uniquePer5; open chains flagged", () => {
  const logPath = join(tmp(), "log.jsonl");
  const mk = (hash, trigger) => reserveChain({ logPath, repo: "r", artifact: "a.md", contentHash: hash, trigger }).chainId;
  const c1 = mk("0000000000000001", "auto");
  appendNote(logPath, { chainId: c1, unique: 2, outcome: "audit-pass" });
  const c2 = mk("0000000000000002", "auto");
  appendNote(logPath, { chainId: c2, unique: 0, outcome: "aborted", comment: "aborted: error" });
  const c3 = mk("0000000000000003", "forced");
  appendNote(logPath, { chainId: c3, unique: 1, outcome: "cap-revise" });
  const c4 = mk("0000000000000004", "auto"); // open, no note
  const s = computeStats(logPath);
  assert.equal(s.eligible, 1);
  assert.equal(s.uniqueTotal, 2);
  assert.equal(s.uniquePer5, 10); // 2 unique / 1 eligible * 5
  assert.equal(s.forced, 1);
  assert.deepEqual(s.openChainIds, [c4]);
  assert.equal(s.byOutcome["aborted"], 1);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs`
Expected: FAIL — new imports not exported.

- [ ] **Step 3: Implement the log layer (append to codex-review.mjs)**

```js
import {
  readFileSync, appendFileSync, mkdirSync, openSync, closeSync, writeSync,
  unlinkSync, statSync, existsSync,
} from "node:fs";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";

export const OUTCOMES = ["audit-pass", "audit-concerns-user-approved", "audit-concerns-dismissed", "cap-revise", "aborted"];

export function logPathDefault() {
  return process.env.CODEX_REVIEW_LOG || joinPath(homedir(), ".claude", "codex-review-log.jsonl");
}

function err(code, message) { const e = new Error(message); e.code = code; return e; }

export function readLogLines(logPath) {
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
    try { out.push(JSON.parse(line)); } catch { /* skip junk */ }
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
      if (age > staleMs) { try { unlinkSync(lockPath); } catch { } continue; }  // break stale, retry
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
  return chainStates(readLogLines(logPath)).get(chainId) ?? null;
}

export function reserveChain({ logPath, repo, artifact, contentHash, trigger }) {
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
    if (trigger === "auto") {
      let lines;
      try {
        lines = readLogLines(logPath);
      } catch (e) {
        throw err("RESERVE_FAILED", `guard cannot read log, failing closed: ${e.message}`);
      }
      for (const { open, note } of chainStates(lines).values()) {
        // Scope: repo + artifact + hash — hash alone would let identical content
        // in different repos/paths suppress each other across the shared log.
        if (open.repo === repo && open.artifact === artifact && open.contentHash === contentHash
            && note?.outcome !== "aborted") {
          throw err("CHAIN_EXISTS", `non-aborted chain ${open.chainId} already exists for ${repo}:${artifact}@${contentHash}`);
        }
      }
    }
    const chainId = mintChainId(artifact, contentHash, ts);
    const line = { ts, chainId, repo, artifact, contentHash, mode: "open", trigger };
    try {
      appendFileSync(logPath, JSON.stringify(line) + "\n");
    } catch (e) {
      throw err("RESERVE_FAILED", `reservation write failed: ${e.message}`);
    }
    return { chainId, ts };
  } finally {
    releaseLock(lockPath, lockToken);
  }
}

export function appendResult(logPath, entry) {
  try {
    mkdirSync(joinPath(logPath, ".."), { recursive: true });
    appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
    return true;
  } catch (e) {
    process.stderr.write(`warn: result log append failed (non-fatal): ${e.message}\n`);
    return false;
  }
}

export function appendNote(logPath, { chainId, unique, outcome, comment }) {
  if (!OUTCOMES.includes(outcome)) throw err("BAD_OUTCOME", `outcome must be one of ${OUTCOMES.join("|")}`);
  const chains = chainStates(readLogLines(logPath));
  const chain = chains.get(chainId);
  if (!chain) throw err("UNKNOWN_CHAIN", `no open line for chain ${chainId}`);
  if (chain.note) throw err("DUPLICATE_NOTE", `chain ${chainId} already has a note`);
  const line = {
    ts: new Date().toISOString(), chainId, mode: "note",
    unique: Number(unique), trigger: chain.open.trigger, outcome, comment: comment ?? "",
  };
  appendFileSync(logPath, JSON.stringify(line) + "\n"); // throws on failure — fatal by design
}

export function computeStats(logPath) {
  const chains = chainStates(readLogLines(logPath));
  const s = { open: 0, byOutcome: {}, forced: 0, eligible: 0, uniqueTotal: 0, uniquePer5: null, openChainIds: [] };
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs`
Expected: PASS (14/14).

- [ ] **Step 5: Commit**

```bash
git add plugins/codex-review/skills/codex-plan-review/scripts/
git commit -m "feat(codex-review): atomic chain reservation guard, notes, gate stats

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

### Task 4: Spawn layer + CLI — review/audit/note/stats subcommands

**Files:**
- Modify: `plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs` (append spawn layer + CLI main)
- Modify: `plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs` (append shim e2e tests)

**Interfaces:**
- Consumes: everything from Tasks 2–3, exact signatures as specified there.
- Produces: CLI contract (what SKILL.md instructs Claude to run):
  - `node codex-review.mjs review <file> (--auto|--force) [--model M] [--effort E] [--timeout S]`
  - `node codex-review.mjs review <file> --resume <sessionId> --chain <chainId> [--retry-verdict] [...]`
  - `node codex-review.mjs audit <file> --chain <chainId> [--resume <sessionId> --retry-verdict] [...]`
  - `node codex-review.mjs note --chain <chainId> --unique <n> --outcome <class> [--comment <text>]`
  - `node codex-review.mjs stats`
  - Result JSON (single object on stdout): `{ok, mode, chainId, sessionId, verdict, findings, finalMessage, usage, durationMs, pendingNoteChainId}`. `verdict` ∈ `APPROVED|REVISE|PASS|CONCERNS|UNPARSEABLE|error|timeout`. `pendingNoteChainId` always echoes the chain that still needs its `note`.
  - Exit codes: `0` normal (including REVISE/CONCERNS/UNPARSEABLE — those are results, not failures); non-zero for: guard refusal, reservation failure, codex missing, timeout, terminal `error`, note validation/write failure.

- [ ] **Step 1: Write the failing shim e2e tests (append to test file)**

The shim is a tiny executable script the tests write into a temp dir prepended to `PATH`, so `spawn("codex", ...)` finds it. It reads a behavior file to decide what stream to emit, and records its argv for assertion.

```js
import { spawnSync, spawn as spawnAsync } from "node:child_process";

const SCRIPT = new URL("./codex-review.mjs", import.meta.url).pathname;

function makeShim(dir, mode) {
  // mode: ok | noverdict | fail | slow | garbage — recorded argv goes to <dir>/argv.json
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
    : "- [P1] one\\n- [P2] two\\nVERDICT: REVISE";
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } }));
}
`;
  writeFileSync(join(dir, "codex"), shim);
  chmodSync(join(dir, "codex"), 0o755);
  return {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SHIM_DIR: dir, SHIM_MODE: mode },
    argv: () => JSON.parse(readFileSync(join(dir, "argv.json"), "utf8")),
  };
}

function runCli(args, env, logPath) {
  return spawnSync("node", [SCRIPT, ...args], {
    env: { ...env, CODEX_REVIEW_LOG: logPath }, encoding: "utf8", timeout: 30_000,
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

test("e2e: malformed (non-JSON) stream → verdict error, non-zero exit", () => {
  const dir = tmp(); const logPath = join(dir, "log.jsonl");
  const artifact = join(dir, "plan.md"); writeFileSync(artifact, "# a plan");
  const shim = makeShim(dir, "garbage");
  const r = runCli(["review", artifact, "--auto"], shim.env, logPath);
  assert.notEqual(r.status, 0);
  assert.equal(JSON.parse(r.stdout).verdict, "error");
});

test("e2e: audit --retry-verdict resumes with the AUDIT-specific nudge", () => {
  const dir = tmp(); const logPath = join(dir, "log.jsonl");
  const artifact = join(dir, "plan.md"); writeFileSync(artifact, "# a plan");
  const shim = makeShim(dir, "ok");
  const first = JSON.parse(runCli(["review", artifact, "--auto"], shim.env, logPath).stdout);
  const a = runCli(["audit", artifact, "--chain", first.chainId, "--resume", "sess-123", "--retry-verdict"], shim.env, logPath);
  assert.equal(a.status, 0, a.stderr);
  const argv = shim.argv();
  assert.deepEqual(argv.slice(0, 3), ["exec", "resume", "sess-123"]);
  assert.match(argv[argv.length - 1], /missing the audit line/);
  assert.doesNotMatch(argv[argv.length - 1], /VERDICT:/);
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
  const opens = readLogLines(logPath).filter((l) => l.mode === "open");
  assert.equal(opens.length, 1, "exactly one reservation line");
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

test("e2e: note + stats close the loop", () => {
  const dir = tmp(); const logPath = join(dir, "log.jsonl");
  const artifact = join(dir, "plan.md"); writeFileSync(artifact, "# a plan");
  const shim = makeShim(dir, "ok");
  const first = JSON.parse(runCli(["review", artifact, "--auto"], shim.env, logPath).stdout);
  const n = runCli(["note", "--chain", first.chainId, "--unique", "1", "--outcome", "audit-pass", "--comment", "dogfood"], shim.env, logPath);
  assert.equal(n.status, 0, n.stderr);
  const s = runCli(["stats"], shim.env, logPath);
  const stats = JSON.parse(s.stdout);
  assert.equal(stats.eligible, 1);
  assert.equal(stats.uniquePer5, 5);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs`
Expected: FAIL — CLI does nothing yet (no main dispatch).

- [ ] **Step 3: Implement spawn layer + CLI main (append to codex-review.mjs)**

```js
import { spawn } from "node:child_process";
import { resolve as resolvePath, relative as relativePath } from "node:path";
import { parseArgs } from "node:util";

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
  if (!existsSync(abs)) die(`artifact not found: ${abs}`);
  const repoRoot = resolveRepoRoot(abs);
  const relPath = relativePath(repoRoot, abs) || abs;
  const repo = repoRoot.split("/").at(-1);
  const hash = contentHashOf(readFileSync(abs)); // recorded per round — artifact changes between rounds
  let chainId = chain, trigger;

  if (!resume && mode === "review") {
    if (auto === force) die("exactly one of --auto or --force is required to open a chain");
    trigger = auto ? "auto" : "forced";
    try {
      chainId = reserveChain({ logPath, repo, artifact: relPath, contentHash: hash, trigger }).chainId;
    } catch (e) {
      die(`refused: ${e.message}`, e.code === "CHAIN_EXISTS" ? 3 : 2);
    }
  } else {
    if (!chainId) die("--chain <chainId> is required for resumed rounds and audits");
    // Validate before spending quota: a typo'd/stale chain id would produce
    // orphan result lines that note can never close.
    const st = getChainState(logPath, chainId);
    if (!st) die(`unknown chain: ${chainId}`, 6);
    if (st.note) die(`chain ${chainId} is already closed (outcome: ${st.note.outcome})`, 6);
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
  if (spawnError) die(`codex could not be spawned (installed? logged in?): ${stderr.slice(0, 500)}`);
  const stream = parseEventStream(stdout);
  // Spec: success requires BOTH a clean terminal event AND a final message.
  const verdict = timedOut ? "timeout"
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
```

Note for the implementer: `round` is computed by counting prior `mode:"review"` lines for the chain (fresh → 1, first resume → 2, …); audits carry no `round`. Every result line records the artifact's `contentHash` at review time, so the log shows which revision each round saw. Resumed rounds and audits validate the chain is open *before* spawning codex. The guard applies only to the fresh-review form — matching the spec exactly.

- [ ] **Step 4: Run the full test file**

Run: `node --test plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs`
Expected: PASS (23/23).

- [ ] **Step 5: Run the repo-wide suites to check nothing else broke**

Run: `node --test scripts/repo-consistency.test.mjs plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs`
Expected: PASS, zero failures.

- [ ] **Step 6: Commit**

```bash
git add plugins/codex-review/skills/codex-plan-review/scripts/
git commit -m "feat(codex-review): codex spawn layer + review/audit/note/stats CLI

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

### Task 5: SKILL.md + full plugin README

**Files:**
- Create: `plugins/codex-review/skills/codex-plan-review/SKILL.md`
- Modify: `plugins/codex-review/README.md` (replace stub with full content)

**Interfaces:**
- Consumes: CLI contract from Task 4 (exact subcommands/flags — do not invent new ones).
- Produces: the model-invocable skill. Frontmatter has NO `disable-model-invocation` key (it must be model-invocable — this differs from adversarial-agents).

- [ ] **Step 1: Write SKILL.md**

`plugins/codex-review/skills/codex-plan-review/SKILL.md` — exact content:

````markdown
---
name: codex-plan-review
description: Cross-provider adversarial review of a finalized plan, spec, design doc, or ADR using OpenAI Codex (GPT-5.6 Terra). AUTO-TRIGGER at plan gates — invoke this skill immediately after any of: (1) a brainstorming spec is written and user-approved, (2) a writing-plans implementation plan is finalized, (3) an ADR draft is completed, (4) an SDD plan is confirmed at its gate. Also invoke on request — "codex review this plan", "get a second opinion on this design", "terra review". Runs a bounded verdict loop (max 3 rounds + 1 audit) via the local codex CLI; each chain burns ChatGPT-subscription quota, so never re-run on the same artifact without an explicit user ask.
---

# Codex Plan Review

Send a finalized plan/spec/design/ADR to OpenAI Codex (Terra, high effort, read-only sandbox) for adversarial review. The script handles mechanics; you handle judgment. Script path (resolve via this skill's base directory): `scripts/codex-review.mjs`, run with `node`.

**The one non-negotiable prompt rule:** the reviewer must never see your self-assessment. The script builds prompts from the file path only — never paste plan content, your confidence, or "tests pass" claims into any codex invocation. (Research: implementer framing degrades Codex review thoroughness 3–4×.)

## Flow

1. **Announce:** "Running Codex plan review (Terra, high effort) — round 1." If `codex` is missing or not logged in (`codex login status`), say so, skip, and continue without blocking the plan.
2. **Preflight:** the artifact must be a file. Write conversation-only plans to their canonical path first (`docs/superpowers/specs/…`, `docs/plans/…`, or scratchpad for throwaways).
3. **Round 1:** `node <skill-dir>/scripts/codex-review.mjs review <file> --auto` (use `--force` only when the user explicitly asked for a re-run). If it refuses with "chain already exists", tell the user this artifact version was already reviewed and stop unless they ask to force.
4. **On `REVISE`:** walk findings one at a time. For accepted findings, amend the plan file. Dismissals require a stated reason in your reply — never silent. Then verify fixes: `… review <file> --resume <sessionId> --chain <chainId>`. Max 3 review rounds total; if still REVISE after round 3, present open findings to the user, log the note (`--outcome cap-revise`), and stop.
5. **On `APPROVED`:** run the final audit: `… audit <file> --chain <chainId>` (fresh Codex session, holistic scope). `AUDIT: PASS` → done. `AUDIT: CONCERNS` → surface findings verbatim and **block**: the plan is not review-complete until the user dispositions each concern. Never re-run the audit; if the user amends in response, the outcome class is `audit-concerns-user-approved` (user-approved, audit-unverified); if the user dismisses the concerns with reasons instead, it is `audit-concerns-dismissed`.
6. **UNPARSEABLE:** retry once — `… review <file> --resume <sessionId> --chain <chainId> --retry-verdict` (or the `audit … --resume <sessionId> --retry-verdict` form). Still unparseable → surface to user, note as aborted.
7. **Always close the chain** (every path: pass, cap, concerns, timeout, error, abort): `… note --chain <chainId> --unique <n> --outcome <audit-pass|audit-concerns-user-approved|audit-concerns-dismissed|cap-revise|aborted> --comment "…"`. A finding counts toward `--unique` only if you judge it real AND it wasn't already known or caught by the Claude-side review stack. The result JSON's `pendingNoteChainId` reminds you which chain is open.
8. **Report one line:** rounds used, final verdict, unique findings, and cumulative gate stats (`… stats`). Include token usage from the result JSON so the user can track quota burn.

## Decision gate (trial until ~2026-07-28)

`stats` must show ≥1 unique finding per 5 eligible chains (`uniquePer5 >= 1`) for the skill to survive. If the trial fails, recommend retiring the skill (escalation paths live in the plugin README).

## Common mistakes

| Mistake | Fix |
|---|---|
| Pasting plan content or your own assessment into a codex prompt | The script's file-path-only prompts are the interface — never bypass them |
| Re-running `--force` because a guard refusal seemed inconvenient | The refusal means this exact content was already reviewed — ask the user |
| Skipping the `note` after a failed/aborted chain | Every chain ends with a note; aborted chains unblock the artifact for future auto-runs |
| Treating `AUDIT: CONCERNS` as advisory | It blocks review-completion until the user dispositions each concern |
| Looping the audit | One audit per chain, ever |
| Trusting codex exit codes or retrying a `verdict:"error"` blindly | Read the result JSON; surface errors to the user |
````

- [ ] **Step 2: Write the full plugin README**

`plugins/codex-review/README.md` — exact content:

````markdown
# codex-review

Cross-provider adversarial **plan/design-doc review** for Claude Code, using OpenAI Codex (GPT-5.6 Terra) as the reviewer. Fills the gap the official [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) plugin doesn't cover (its issue #4): reviewing plans and design docs rather than diffs. Diff review is deliberately out of scope — use the official plugin's `/codex:review` for that.

Design: `docs/superpowers/specs/2026-07-14-codex-plan-review-design.md`. Research: `docs/plans/2026-07-14-codex-adversarial-review-skill-research.md`.

## Install

```
/plugin marketplace add jasonm4130/claude-skills
/plugin install codex-review@jasonm4130-claude-skills
```

Requirements: [Codex CLI](https://github.com/openai/codex) ≥ 0.144 (`brew install codex`), authenticated (`codex login`, ChatGPT subscription or API key).

## What it does

At plan gates (finalized spec/plan/ADR) — or on "codex review this plan" — Claude runs a bounded verdict loop: Terra reviews the artifact file in a read-only sandbox → `VERDICT: APPROVED|REVISE` → Claude amends and resumes (max 3 rounds) → one fresh-session holistic audit (`AUDIT: PASS|CONCERNS`). Every chain is logged to `~/.claude/codex-review-log.jsonl` with a uniqueness judgment for the decision gate.

Key protections (see spec for rationale): reviewer never sees Claude's self-assessment; content-hash guard prevents duplicate auto-reviews of the same artifact version (atomic, cross-session); codex exit codes are never trusted; `--output-schema` is never used; explicit `-m gpt-5.6-terra` on every call.

## Decision gate

Trial until ~2026-07-28: the skill must produce **≥1 confirmed unique finding per ~5 eligible chains** or be retired. Check anytime:

```
node plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs stats
```

## Escalation paths (documented, not built — unlock only if the gate passes)

1. **Diff mode** — wrap `codex review --base <ref>/--uncommitted` with the same logging for headless pipeline use.
2. **SDD integration** — add Codex as an extra reviewer in the subagent-driven-development review stage.
3. **adversarial-agents persona** — a `codex` persona dispatched via Bash CLI instead of an Agent subagent.

If the gate fails: retire this plugin; keep the official plugin for interactive diff review.

## Manual smoke test (run after Codex CLI upgrades)

Headless review behavior churned in codex 0.143→0.144.x; before trusting auto-triggered reviews after an upgrade:

```
echo "# throwaway plan: add a --dry-run flag to foo.sh" > /tmp/smoke-plan.md
node plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs review /tmp/smoke-plan.md --force --timeout 180
# expect: result JSON with a VERDICT, a sessionId, and usage tokens
# then one resume round — this is what validates the sandbox-inheritance assumption:
node plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs review /tmp/smoke-plan.md --resume <sessionId> --chain <chainId> --timeout 180
# expect: a second result JSON with a VERDICT; then close the chain:
node plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs note --chain <chainId> --unique 0 --outcome aborted --comment "aborted: smoke test"
```

The smoke test also validates the one undocumented assumption: resumed sessions inherit the read-only sandbox (resume exposes no `--sandbox` flag).

## Log schema

One JSONL line per event at `~/.claude/codex-review-log.jsonl` (override: `CODEX_REVIEW_LOG`): chain-open reservations (`mode:"open"`, with `trigger:"auto"|"forced"` and `contentHash`), round/audit results (verdict, findings by severity, session id, token usage, duration), and one mandatory closing `note` per chain (`unique`, `outcome`: `audit-pass|audit-concerns-user-approved|audit-concerns-dismissed|cap-revise|aborted`). Reservation and note writes are fatal on failure; result writes are best-effort.
````

- [ ] **Step 3: Verify consistency tests still pass (README install commands are checked)**

Run: `node --test scripts/repo-consistency.test.mjs`
Expected: PASS — install command uses `@jasonm4130-claude-skills`, marketplace-add uses `jasonm4130/claude-skills`.

- [ ] **Step 4: Sanity-check the skill loads (frontmatter is valid YAML, no disable-model-invocation)**

Run: `node -e "const s=require('node:fs').readFileSync('plugins/codex-review/skills/codex-plan-review/SKILL.md','utf8'); const fm=s.split('---')[1]; if(!/name: codex-plan-review/.test(fm)) throw new Error('bad name'); if(/disable-model-invocation/.test(fm)) throw new Error('must be model-invocable'); console.log('frontmatter ok')"`
Expected: `frontmatter ok`

- [ ] **Step 5: Commit**

```bash
git add plugins/codex-review/skills/codex-plan-review/SKILL.md plugins/codex-review/README.md
git commit -m "feat(codex-review): SKILL.md orchestration + full plugin README

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

### Task 6: Full-suite verification + real-Codex smoke test

**Files:**
- No new files; fixes only if verification finds problems.

**Interfaces:**
- Consumes: everything. This task validates the assembled plugin end to end.

- [ ] **Step 1: Run every test suite in the repo that could be affected**

Run: `node --test scripts/repo-consistency.test.mjs plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs && node --test plugins/adversarial-agents/skills/adversarial-agents/skill.test.mjs`
Expected: PASS, zero failures. Quote the pass/fail counts.

- [ ] **Step 2: Real-Codex smoke test (one quota message — this is the documented manual test)**

```bash
echo "# throwaway plan: add a --dry-run flag that prints actions without executing them to scripts/cleanup.sh" > /tmp/smoke-plan.md
node plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs review /tmp/smoke-plan.md --force --timeout 180
```

Expected: exit 0; result JSON with `verdict` of `REVISE` or `APPROVED` (a real verdict, not error/timeout/UNPARSEABLE), a `sessionId`, `usage` with token counts, and `pendingNoteChainId`.

Then run one resume round (second quota message — this validates resume + the sandbox-inheritance assumption on the real CLI):

```bash
node plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs review /tmp/smoke-plan.md --resume <sessionId from above> --chain <chainId from above> --timeout 180
```

Expected: exit 0; a second real verdict; the log line carries `round: 2` and the same `chainId`.

- [ ] **Step 3: Close the smoke-test chain and check stats**

```bash
node plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs note --chain <chainId from step 2> --unique 0 --outcome aborted --comment "aborted: implementation smoke test"
node plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs stats
```

Expected: note ok; stats shows the chain under `byOutcome.aborted`, `eligible` unchanged by it (forced+aborted chains are not eligible).

- [ ] **Step 4: Commit any fixes from verification**

```bash
git add -u plugins/codex-review/
git commit -m "fix(codex-review): verification fixes from full-suite + smoke test

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

(Skip the commit if there were no fixes.)

---

## Post-merge follow-up (orchestrator, NOT an SDD task)

The spec's "project memory entry recording escalation paths + gate" component is deliberately **not** a task in this plan: the memory lives in `~/.claude/projects/…/memory/` (user configuration), and SDD subagents must not write outside the repo. The orchestrating session writes this memory entry itself after the branch merges. Workers: skip it; do not create it.
