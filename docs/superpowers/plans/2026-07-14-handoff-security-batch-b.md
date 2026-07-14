# Handoff Security & Race Fixes (Batch B) — Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two real defects the Codex/Terra audit found in the `handoff`
plugin — a path-traversal hole in the SessionStart loader (P1) and a TOCTOU race
in the statusline overlap guard (P2) — plus the P3 doc error that points
troubleshooting at a nonexistent hook file.

**Architecture:** Both fixes are local to `plugins/handoff/scripts/`. B1 adds
containment to the one place the `.pending` marker's contents become a path. B2
replaces the check-then-write lock with an atomic `wx` create plus a
rename-based stale-break — the same pattern already shipped and tested in
`plugins/codex-review/.../codex-review.mjs:acquireLock`. The lock helper lands in
`scripts/lib.mjs` (handoff's existing shared-helper module) so it is unit-testable
independently of the statusline's stdin/render path; plugins cannot import across
plugin boundaries, so this is a deliberate re-implementation, not a shared import.

**Tech Stack:** Node 18+ ESM (`.mjs`), stdlib only, `// @ts-check` with JSDoc.
Tests: `node --test`.

## Global Constraints

- Plugin version becomes `0.5.2` in BOTH `plugins/handoff/.claude-plugin/plugin.json`
  AND the `handoff` entry in `.claude-plugin/marketplace.json` (`scripts/repo-consistency.test.mjs`
  asserts they match).
- **ESM only.** Stdlib imports only (`node:fs`, `node:path`, `node:os`, `node:process`,
  `node:test`, `node:assert/strict`). No `package.json`, no third-party packages.
- `// @ts-check` at the top of every script; JSDoc types on new exported functions.
- Graceful degradation is the plugin's contract: a hook script that cannot do its
  job exits `0` silently (statusline prints `?` via `bail()`). **A refusal is not
  an error** — never throw out of a hook.
- Use `path.join`/`path.resolve`, never string concatenation. Use `os.tmpdir()`,
  never a literal `/tmp`.
- Run tests from the repo root: `node --test plugins/handoff/tests/`.
- All commits on branch `fix/handoff-security`. Every commit message ends with:
  `Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw`

---

## Task 1: Contain the `.pending` handoff path (P1 security)

**Files:**
- Modify: `plugins/handoff/scripts/load-pending-handoff.mjs:57-67`
- Modify: `plugins/handoff/scripts/lib.mjs` (add `resolveContained`)
- Test: `plugins/handoff/tests/load-pending-handoff.test.mjs`
- Test: `plugins/handoff/tests/lib.test.mjs`

**Interfaces:**
- Produces: `resolveContained(baseDir, candidate)` in `lib.mjs` — returns the
  resolved absolute path if it stays inside `baseDir`, else `null`. Task 2 does
  not use it.

**Background:** `load-pending-handoff.mjs:57` strips whitespace from the marker's
contents and `path.join`s it onto `handoffsDir` with no containment check. A marker
containing `../../.env` resolves outside `.claude/handoffs/` and its contents get
injected into the next session's context at line 91. Anything that can write one
file into a checked-out repo (a malicious PR, a compromised postinstall) can
exfiltrate local files into model context.

- [ ] **Step 1: Write the failing tests**

In `plugins/handoff/tests/lib.test.mjs`, append:

```js
import { resolveContained } from "../scripts/lib.mjs";

test("resolveContained: keeps plain filenames, refuses escapes", () => {
  const base = "/base/dir";
  assert.equal(resolveContained(base, "handoff.md"), path.join(base, "handoff.md"));
  assert.equal(resolveContained(base, "sub/handoff.md"), path.join(base, "sub", "handoff.md"));
  assert.equal(resolveContained(base, "../../.env"), null);
  assert.equal(resolveContained(base, "/etc/passwd"), null, "absolute paths must not escape");
  assert.equal(resolveContained(base, ".."), null);
  assert.equal(resolveContained(base, ""), null);
  // A sibling directory sharing a name prefix must not pass a naive startsWith check.
  assert.equal(resolveContained(base, "../dir-evil/x.md"), null);
});
```

In `plugins/handoff/tests/load-pending-handoff.test.mjs`, append (match the
existing harness: it builds a temp cwd, writes `.claude/handoffs/`, and runs the
script with `{"cwd": tmp}` on stdin — reuse the file's existing `run()` helper and
temp-dir setup style):

```js
test("traversal: a .pending pointing outside handoffs/ is refused and consumed", async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "handoff-trav-"));
  const handoffsDir = path.join(cwd, ".claude", "handoffs");
  mkdirSync(handoffsDir, { recursive: true });
  writeFileSync(path.join(cwd, "secret.env"), "API_KEY=super-secret-value");
  const pending = path.join(handoffsDir, ".pending");
  writeFileSync(pending, "../../secret.env");

  const { code, stdout } = await run(JSON.stringify({ cwd }));

  assert.equal(code, 0, "a refusal is not an error");
  assert.doesNotMatch(stdout, /super-secret-value/, "traversal target must never reach context");
  assert.equal(stdout.trim(), "", "no additionalContext is emitted for a refused marker");
  assert.equal(existsSync(pending), false, "the poisoned marker is consumed, not left to retry");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test plugins/handoff/tests/lib.test.mjs plugins/handoff/tests/load-pending-handoff.test.mjs`
Expected: FAIL — `resolveContained` is not exported (import error), and the
traversal test fails on `stdout` containing `super-secret-value`.

- [ ] **Step 3: Add `resolveContained` to `lib.mjs`**

Append to `plugins/handoff/scripts/lib.mjs` (the file already imports `node:path`
as `path`; add the import only if absent):

```js
/**
 * Resolve `candidate` against `baseDir`, refusing anything that escapes it.
 * Containment is checked with path.relative, not string prefixes: a naive
 * startsWith("/base/dir") would accept the sibling "/base/dir-evil".
 * @param {string} baseDir
 * @param {string} candidate
 * @returns {string | null} absolute path inside baseDir, or null if it escapes
 */
export function resolveContained(baseDir, candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  const base = path.resolve(baseDir);
  const target = path.resolve(base, candidate);
  const rel = path.relative(base, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return target;
}
```

- [ ] **Step 4: Use it in the loader**

In `plugins/handoff/scripts/load-pending-handoff.mjs`, add `resolveContained` to
the existing `./lib.mjs` import, then replace the path construction at line 67:

```js
const handoffPath = resolveContained(handoffsDir, handoffFilename);

if (handoffPath === null) {
  // Marker escapes .claude/handoffs/ — refuse and consume it so a poisoned
  // marker cannot retry on every subsequent session.
  try {
    unlinkSync(pendingFile);
  } catch {
    // best-effort
  }
  process.exit(0);
}
```

The existing `if (!existsSync(handoffPath))` block below it stays as-is.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test plugins/handoff/tests/lib.test.mjs plugins/handoff/tests/load-pending-handoff.test.mjs`
Expected: PASS, including the pre-existing load/missing/stale tests (no regression).

- [ ] **Step 6: Commit**

```bash
git add plugins/handoff/scripts/lib.mjs plugins/handoff/scripts/load-pending-handoff.mjs \
        plugins/handoff/tests/lib.test.mjs plugins/handoff/tests/load-pending-handoff.test.mjs
git commit -m "fix(handoff): contain .pending handoff path to handoffs/ (P1)

A .pending marker containing ../../.env resolved outside .claude/handoffs/
and its contents were injected into the next session's context. Anything
able to write one file into a checked-out repo could exfiltrate local files
into model context. resolveContained() now refuses any marker that escapes
the handoffs dir (path.relative-based, not a prefix check) and consumes it.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Task 2: Make the statusline overlap guard atomic (P2 race)

**Files:**
- Modify: `plugins/handoff/scripts/lib.mjs` (add `acquireInflightLock`, `releaseInflightLock`)
- Modify: `plugins/handoff/scripts/status-and-flag.mjs:97-123` and the release at `:229-232`
- Test: `plugins/handoff/tests/lib.test.mjs`
- Test: `plugins/handoff/tests/status-and-flag.test.mjs`

**Interfaces:**
- Consumes: nothing from Task 1 (`resolveContained` is unrelated).
- Produces: `acquireInflightLock(lockPath, staleMs)` → an ownership token string,
  or `null` when the lock is held fresh by someone else.
  `releaseInflightLock(lockPath, token)` → void, deletes only a lock we still own.

**Background:** `status-and-flag.mjs:100-119` reads the lock's mtime, decides "not
in flight", and only then writes it. Two concurrent statusline invocations both
pass the check and both write — the exact race the 0.5.1 guard exists to prevent.
They can double-fire the handoff flag and interleave the read-modify-write on
`last-context-pct`.

The current release (`rmSync(heldLockPath, { force: true })` at line 231, via
`bail()` at line 57) is also not ownership-safe: a slow invocation whose lock went
stale and was broken by a replacement will still delete the replacement's lock on
its way out. Fix both together — an atomic acquire is pointless if release is not
ownership-checked.

- [ ] **Step 1: Write the failing tests**

In `plugins/handoff/tests/lib.test.mjs`, append:

```js
import { acquireInflightLock, releaseInflightLock } from "../scripts/lib.mjs";
import { mkdtempSync, writeFileSync, existsSync, utimesSync, readFileSync } from "node:fs";
import os from "node:os";

test("acquireInflightLock: exactly one of two racers wins a free lock", () => {
  const lock = path.join(mkdtempSync(path.join(os.tmpdir(), "handoff-lock-")), "s.lock");
  const a = acquireInflightLock(lock, 2000);
  const b = acquireInflightLock(lock, 2000);
  assert.ok(a, "first acquirer wins");
  assert.equal(b, null, "second acquirer must be refused while the lock is fresh");
  releaseInflightLock(lock, a);
  assert.equal(existsSync(lock), false, "release removes the lock we own");
  assert.ok(acquireInflightLock(lock, 2000), "lock is reusable after release");
});

test("acquireInflightLock: a stale lock is broken and re-acquired", () => {
  const lock = path.join(mkdtempSync(path.join(os.tmpdir(), "handoff-lock-")), "s.lock");
  writeFileSync(lock, "dead-holder");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  const token = acquireInflightLock(lock, 2000);
  assert.ok(token, "a lock older than staleMs is broken and taken");
  assert.equal(readFileSync(lock, "utf8"), token, "the new holder's token is on disk");
});

test("releaseInflightLock: a stale ex-holder cannot delete the replacement's lock", () => {
  const lock = path.join(mkdtempSync(path.join(os.tmpdir(), "handoff-lock-")), "s.lock");
  const stale = acquireInflightLock(lock, 2000);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  const fresh = acquireInflightLock(lock, 2000); // breaks the stale lock, takes it
  assert.ok(fresh);
  releaseInflightLock(lock, stale); // the slow ex-holder finally finishes
  assert.equal(existsSync(lock), true, "the replacement holder's lock must survive");
  assert.equal(readFileSync(lock, "utf8"), fresh);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test plugins/handoff/tests/lib.test.mjs`
Expected: FAIL — `acquireInflightLock` / `releaseInflightLock` are not exported.

- [ ] **Step 3: Add the lock helpers to `lib.mjs`**

Append to `plugins/handoff/scripts/lib.mjs`. Add `openSync`, `writeSync`,
`closeSync`, `statSync`, `renameSync`, `unlinkSync`, `readFileSync` to the existing
`node:fs` import as needed:

```js
/**
 * Atomically take an in-flight lock. Returns an ownership token, or null when
 * another invocation holds it fresh. The check-then-write this replaces let two
 * racers both conclude "not in flight" and both write.
 * @param {string} lockPath
 * @param {number} [staleMs]
 * @returns {string | null}
 */
export function acquireInflightLock(lockPath, staleMs = 2000) {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx"); // exclusive create — the atomic step
      writeSync(fd, token);
      closeSync(fd);
      return token;
    } catch (e) {
      if (e && e.code !== "EEXIST") return null; // unwritable dir etc — caller renders anyway
      let age = 0;
      try {
        age = Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        continue; // vanished between open and stat — retry
      }
      if (age > staleMs) {
        // Atomic stale-break: exactly one breaker wins the rename, so a losing
        // breaker can never delete a replacement holder's fresh lock.
        try {
          renameSync(lockPath, `${lockPath}.stale-${token}`);
          unlinkSync(`${lockPath}.stale-${token}`);
        } catch {
          // another breaker won — fall through and retry the acquire
        }
        continue;
      }
      return null; // held fresh by someone else
    }
  }
  return null;
}

/**
 * Release a lock only if we still own it — a stale ex-holder must not remove the
 * replacement holder's lock.
 * @param {string} lockPath
 * @param {string | null} token
 */
export function releaseInflightLock(lockPath, token) {
  if (token === null) return;
  try {
    if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath);
  } catch {
    // already gone or unreadable — leave it
  }
}
```

- [ ] **Step 4: Rewire `status-and-flag.mjs`**

Add `acquireInflightLock`, `releaseInflightLock` to the existing `./lib.mjs`
import. Replace the guard block (the `try { if (Date.now() - statSync(...) ... }`
through the `try { writeFileSync(inflightLockFile, String(process.pid)); ... }`,
lines 100-123) with:

```js
const lockToken = acquireInflightLock(inflightLockFile, LOCK_FRESH_MS);
if (lockToken === null) {
  // Another invocation is in flight (or the lock dir is unwritable): replay the
  // last render rather than double-firing flags or interleaving the
  // read-modify-write on last-context-pct.
  /** @type {string | null} */
  let cached = null;
  try {
    cached = readFileSync(renderCacheFile, "utf8");
  } catch {
    cached = null;
  }
  if (cached !== null && cached.length > 0) {
    process.stdout.write(cached);
    process.exit(0);
  }
  bail(locPrefix);
}
heldLockToken = lockToken;
heldLockPath = inflightLockFile;
```

Declare `heldLockToken` next to the existing `heldLockPath` declaration (line 48):

```js
/** @type {string | null} */
let heldLockToken = null;
```

Then make both release sites ownership-safe. In `bail()` (line 55-58) and at the
end of the script (lines 229-232), replace `rmSync(heldLockPath, { force: true })`
with:

```js
  releaseInflightLock(heldLockPath, heldLockToken);
```

(Keep the surrounding `if (heldLockPath !== null)` guards and try/catch shape.
`rmSync` may become an unused import — remove it from the `node:fs` import if so.)

**Behavior note — this is intentional:** when the lock cannot be created for a
reason other than EEXIST (e.g. an unwritable data dir), `acquireInflightLock`
returns `null` and the statusline now replays the cached render or bails to `?`,
where the old code rendered anyway. That is the safe direction for a guard whose
job is to prevent double-fired flags, and an unwritable data dir already breaks
flag-writing downstream.

- [ ] **Step 5: Add a statusline-level regression test**

In `plugins/handoff/tests/status-and-flag.test.mjs`, append (match the existing
harness's `run()`/env/temp-dir helpers — it sets `CLAUDE_PLUGIN_DATA` to a temp
dir and pipes a stdin payload):

```js
test("overlap guard: a fresh lock makes a concurrent invocation replay, not re-render", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "handoff-guard-"));
  const sid = "guard-sid";
  writeFileSync(path.join(dataDir, `last-render-${sid}.txt`), "CACHED-RENDER");
  // Simulate an invocation already in flight.
  writeFileSync(path.join(dataDir, `statusline-inflight-${sid}.lock`), "other-holder");

  const { code, stdout } = await run(
    JSON.stringify({ session_id: sid, context_window: { used_percentage: 75 } }),
    { CLAUDE_PLUGIN_DATA: dataDir },
  );

  assert.equal(code, 0);
  assert.equal(stdout, "CACHED-RENDER", "must replay the cached render, not render fresh");
  assert.equal(
    readFileSync(path.join(dataDir, `statusline-inflight-${sid}.lock`), "utf8"),
    "other-holder",
    "the in-flight holder's lock must not be stolen or overwritten",
  );
});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test plugins/handoff/tests/`
Expected: PASS — all handoff tests, including the pre-existing statusline
threshold/band/render tests (no regression).

- [ ] **Step 7: Commit**

```bash
git add plugins/handoff/scripts/lib.mjs plugins/handoff/scripts/status-and-flag.mjs \
        plugins/handoff/tests/lib.test.mjs plugins/handoff/tests/status-and-flag.test.mjs
git commit -m "fix(handoff): atomic statusline overlap guard, ownership-safe release (P2)

The 0.5.1 guard read the lock's mtime, concluded 'not in flight', then wrote
it — so two concurrent statusline invocations both passed the check and both
wrote, which is the exact race the guard exists to prevent (double-fired
flags, interleaved last-context-pct writes). Replaced with an exclusive 'wx'
create plus a rename-based stale-break, and made release ownership-checked so
a stale ex-holder cannot delete the replacement holder's lock.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Task 3: Fix the hook filename in the docs + version bump (P3)

**Files:**
- Modify: `plugins/handoff/skills/handoff/SKILL.md:132`
- Modify: `plugins/handoff/.claude-plugin/plugin.json` (version → `0.5.2`)
- Modify: `.claude-plugin/marketplace.json` (`handoff` entry version → `0.5.2`)
- Modify: `plugins/handoff/README.md` (document the containment + atomic guard)
- Test: `scripts/repo-consistency.test.mjs` (existing — asserts the two versions match)

**Interfaces:** none.

**Background:** SKILL.md tells users the active SessionStart hook is
`load-pending-handoff.sh`; the shipped hook (`hooks/hooks.json:19`) invokes
`load-pending-handoff.mjs`. Anyone troubleshooting a failed auto-load is sent to
a file that does not exist. The `.sh` scripts were replaced by `.mjs` in v0.2.

- [ ] **Step 1: Fix the filename in SKILL.md**

At `plugins/handoff/skills/handoff/SKILL.md:132`, change
`load-pending-handoff.sh` to `load-pending-handoff.mjs`. Grep the whole plugin for
any other `.sh` references to shipped scripts and fix those too:

```bash
grep -rn "load-pending-handoff\.sh\|status-and-flag\.sh\|check-handoff-flag\.sh" plugins/handoff/
```

(Expected: only the SKILL.md:132 hit. If a test or README references the old bash
scripts *as history* — e.g. the "Mirrors v0.1 bash tests" comment at the top of
`tests/load-pending-handoff.test.mjs` — leave it; it is describing v0.1, not
telling the user which file runs.)

- [ ] **Step 2: Bump the version in both registries**

`plugins/handoff/.claude-plugin/plugin.json`: `"version": "0.5.1"` → `"0.5.2"`.
`.claude-plugin/marketplace.json`, the `handoff` entry: `"version": "0.5.1"` → `"0.5.2"`.

- [ ] **Step 3: Note the fixes in the plugin README**

In `plugins/handoff/README.md`, where the overlap guard is described, state that
the guard is atomic (exclusive-create + rename-based stale-break, ownership-safe
release) rather than best-effort, and that the SessionStart loader refuses any
`.pending` marker resolving outside `.claude/handoffs/`. Keep it to the two
sentences the change warrants — do not restructure the README.

- [ ] **Step 4: Run the full suite**

Run: `node --test $(find scripts plugins -name "*.test.mjs" -not -path "*node_modules*")`
Expected: PASS, 0 fail — including `scripts/repo-consistency.test.mjs`'s
plugin.json↔marketplace.json version-match assertion, which fails if only one of
the two version bumps landed.

- [ ] **Step 5: Commit**

```bash
git add plugins/handoff/skills/handoff/SKILL.md plugins/handoff/.claude-plugin/plugin.json \
        .claude-plugin/marketplace.json plugins/handoff/README.md
git commit -m "docs(handoff): correct SessionStart hook filename, bump to 0.5.2

SKILL.md pointed troubleshooting at load-pending-handoff.sh; the shipped hook
runs load-pending-handoff.mjs (the .sh scripts went away in v0.2). Also
documents the 0.5.2 security/race fixes in the README.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Out of scope

- The `deep-dive` (Batch C) and `subagent-driven-development` (Batch D) findings —
  separate branches, separate plans.
- The `adversarial-agents` README/SKILL.md contradiction (A3) — rides with Batch C
  or its own doc branch; it touches neither file here.
- Any behavior change to the handoff threshold/band logic, the flag format, or the
  statusline's rendering. Touch only what the two defects require.
