# Handoff Security & Race Fixes (Batch B) — Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two real defects the Codex/Terra audit found in the `handoff`
plugin — a path-traversal hole in the SessionStart loader (P1) and a TOCTOU race in
the statusline overlap guard (P2) — plus the P3 doc error that points
troubleshooting at a nonexistent hook file.

## Threat model (read this before Task 1)

The attacker is a **hostile repository you checked out** — a PR you are reviewing, a
dependency, a template. They control *files committed in the tree*: they can plant
`.claude/handoffs/.pending`, symlinks, and FIFOs. They are **not running a process
on your machine**.

That boundary is deliberate, and it is what makes this fixable. Node has no
`openat`, so a *concurrently running local attacker* can always win a directory-swap
race against any userspace path check (swap `.claude/handoffs` for a symlink between
the check and the open; `O_NOFOLLOW` only guards the final component). Two facts
make that an acceptable exclusion:

- A local attacker process with your uid can read `~/.env` directly. It does not
  need to exfiltrate through a SessionStart hook. If they are running code as you,
  this hook is not the weak link.
- Against the static-file attacker we *are* defending against, every symlink and
  FIFO is already on disk when we look, so `realpath` and `O_NOFOLLOW` see them and
  refuse.

So: Task 1 closes the committed-hostile-tree route completely, and does **not**
claim to close the concurrent-local-process route. Do not write a code comment or
README line that says otherwise.

**Architecture:** Both fixes are local to `plugins/handoff/scripts/`.

Task 1 never "validates a path and then reads it" — a validate-then-read is a TOCTOU
by construction. The marker is restricted to a **bare filename**; the file is opened
**once**, with `O_NOFOLLOW | O_NONBLOCK`, and read from that descriptor. The check
*is* the use.

Task 2 rebuilds the lock on three primitives, each closing a race the previous
design left open:
- **Create by `link()`, not `open(wx)`** — the token is written to a private temp
  file *first*, so the lock never exists in a partially-written state that a reader
  could mistake for a dead holder.
- **Break by rename-verify-restore** — a breaker deletes only the exact lock it
  observed, so two breakers cannot cascade into deleting each other's fresh lock.
- **Never break a live holder** — a stale-by-mtime lock whose pid is still alive is
  left alone, because the guarded work (an unbounded synchronous transcript read)
  can outrun any lease.

Both helpers live in `scripts/lib.mjs` (handoff's existing shared-helper module) so
they are unit-testable independently of the hook scripts. Plugins cannot import
across plugin boundaries, so this is a deliberate re-implementation, not a shared
import — and it is **not** a copy of `codex-review`'s `acquireLock`, which has the
double-breaker bug this design fixes (tracked separately in the triage doc).

**Tech Stack:** Node 18+ ESM (`.mjs`), stdlib only, `// @ts-check` with JSDoc.
Tests: `node --test`.

## Global Constraints

- Plugin version becomes `0.5.2` in BOTH `plugins/handoff/.claude-plugin/plugin.json`
  AND the `handoff` entry in `.claude-plugin/marketplace.json` (`scripts/repo-consistency.test.mjs`
  asserts they match).
- **ESM only.** Stdlib imports only (`node:fs`, `node:path`, `node:os`, `node:process`,
  `node:child_process`, `node:test`, `node:assert/strict`). No `package.json`, no
  third-party packages.
- `// @ts-check` at the top of every script; JSDoc types on new exported functions.
- Graceful degradation is the plugin's contract: a hook script that cannot do its job
  exits `0` silently (statusline prints `?` via `bail()`). **A refusal is not an
  error** — never throw out of a hook.
- Use `path.join`/`path.resolve`, never string concatenation. Use `os.tmpdir()`, never
  a literal `/tmp`.
- **Never re-`import` a module a file already imports.** Every test file below already
  imports `node:test`, `node:assert/strict`, `node:fs`, `node:path`, `node:os` and the
  module under test — merge new names into those existing import statements. A
  duplicate `import` declaration is a parse error, not a test failure.
- POSIX-only test cases (FIFO, symlink) must be skipped on Windows:
  `test("…", { skip: process.platform === "win32" }, …)`.
- Temp dirs in tests are cleaned up with `t.after(() => rmSync(dir, { recursive: true, force: true }))`,
  matching the existing style in `tests/lib.test.mjs`.
- Run tests from the repo root: `node --test plugins/handoff/tests/`.
- All commits on branch `fix/handoff-security`. Every commit message ends with:
  `Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw`

---

## Task 1: Read the pending handoff without following anything out of `handoffs/` (P1)

**Files:**
- Modify: `plugins/handoff/scripts/lib.mjs` (add `readContainedFile`, `dirContainedIn`)
- Modify: `plugins/handoff/scripts/load-pending-handoff.mjs:27-92`
- Test: `plugins/handoff/tests/lib.test.mjs`
- Test: `plugins/handoff/tests/load-pending-handoff.test.mjs`

**Interfaces:**
- Produces (Task 2 uses neither):
  - `readContainedFile(baseDir, name)` → contents as a string, or `null`. Refuses
    non-bare names, symlinked final components (via `O_NOFOLLOW`), non-regular files,
    and never blocks or throws.
  - `dirContainedIn(rootDir, dir)` → `true` when `dir`'s realpath is inside `rootDir`'s.

**Background:** `load-pending-handoff.mjs:57` strips whitespace from the marker's
contents and `path.join`s it onto `handoffsDir` with no containment check. A marker
containing `../../.env` resolves outside `.claude/handoffs/` and its contents get
injected into the next session's context at line 91.

Three things have to be true, and each was a finding in a prior review round:

1. **Bare filename only.** No separators, no `..`. The `/handoff` skill only ever
   writes flat files into `.claude/handoffs/`, so this is a tightening with no
   behavior loss — and it removes every question about symlinked *intermediate*
   components within the base.
2. **One open, no re-resolution.** `O_NOFOLLOW` makes a symlinked final component
   fail at `open` (ELOOP) instead of being followed, and the descriptor we validate
   is the descriptor we read. A `realpath`-then-`readFileSync` loses to a file
   swapped for a symlink in between.
3. **`O_NONBLOCK`, then `fstat`.** A plain `open()` on a **FIFO blocks until a writer
   appears** — so an `fstat`-based "is it a regular file?" check never runs, and a
   planted FIFO hangs SessionStart forever. Opening non-blocking returns immediately;
   *then* `fstat` can reject it. (Regular files ignore `O_NONBLOCK`.)

`O_NOFOLLOW` and `O_NONBLOCK` are POSIX-only; on Windows both `fs.constants` entries
are `undefined`. Fall back to `0` and keep the `lstat` symlink pre-check as the
(non-atomic) best effort that platform allows. Windows has no filesystem FIFOs
reachable this way, so the blocking hazard does not apply there.

- [ ] **Step 1: Write the failing tests**

In `plugins/handoff/tests/lib.test.mjs`, merge into the existing imports:
- into the existing `node:fs` import: `mkdirSync`, `symlinkSync`, `realpathSync`
- into the existing `../scripts/lib.mjs` import: `readContainedFile`, `dirContainedIn`
- add: `import { execFileSync } from "node:child_process";`

Then append:

```js
test("readContainedFile: reads a plain file, refuses non-bare names", (t) => {
  // realpathSync the temp base: on macOS os.tmpdir() sits under /var -> /private/var.
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "handoff-read-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  writeFileSync(path.join(base, "handoff.md"), "the handoff body");
  mkdirSync(path.join(base, "sub"));
  writeFileSync(path.join(base, "sub", "nested.md"), "nested");

  assert.equal(readContainedFile(base, "handoff.md"), "the handoff body");
  assert.equal(readContainedFile(base, "missing.md"), null, "a nonexistent file is refused");
  assert.equal(readContainedFile(base, "../../.env"), null, "traversal is refused");
  assert.equal(readContainedFile(base, "sub/nested.md"), null, "only bare filenames are accepted");
  assert.equal(readContainedFile(base, "/etc/passwd"), null, "absolute paths are refused");
  assert.equal(readContainedFile(base, ".."), null);
  assert.equal(readContainedFile(base, ""), null);
  assert.equal(readContainedFile(base, "bad\0name.md"), null, "a NUL byte must not throw");
  assert.equal(readContainedFile(base, "sub"), null, "a directory is not a regular file");
});

test("readContainedFile: refuses a symlinked target", { skip: process.platform === "win32" }, (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "handoff-symlink-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, "handoffs");
  mkdirSync(base);
  writeFileSync(path.join(root, "secret.env"), "API_KEY=super-secret-value");
  symlinkSync(path.join(root, "secret.env"), path.join(base, "innocent.md"));

  assert.equal(readContainedFile(base, "innocent.md"), null, "O_NOFOLLOW must refuse, not follow");
});

test("readContainedFile: a FIFO is refused without hanging", { skip: process.platform === "win32" }, (t) => {
  // A plain open() on a FIFO blocks until a writer appears — the reason the open
  // must be non-blocking. If this test times out, O_NONBLOCK is missing.
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "handoff-fifo-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  execFileSync("mkfifo", [path.join(base, "trap.md")]);

  assert.equal(readContainedFile(base, "trap.md"), null, "a FIFO is not a regular file");
});

test("dirContainedIn: true inside the root, false for an escaping symlink", { skip: process.platform === "win32" }, (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "handoff-dir-")));
  const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), "handoff-out-")));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const inner = path.join(root, ".claude", "handoffs");
  mkdirSync(inner, { recursive: true });
  assert.equal(dirContainedIn(root, inner), true);

  const escaped = path.join(root, "escaped");
  symlinkSync(outside, escaped);
  assert.equal(dirContainedIn(root, escaped), false, ".claude/handoffs symlinked out must not pass");
  assert.equal(dirContainedIn(root, path.join(root, "nope")), false, "a missing dir is not contained");
});
```

In `plugins/handoff/tests/load-pending-handoff.test.mjs`, merge `mkdirSync`,
`symlinkSync` into the existing `node:fs` import, then append (reuse the file's
existing `run()` helper, which pipes `{"cwd": …}` on stdin):

```js
test("traversal: a .pending pointing outside handoffs/ is refused and consumed", async (t) => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "handoff-trav-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
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

test("traversal: a symlinked handoff target is refused and consumed", { skip: process.platform === "win32" }, async (t) => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "handoff-symtrav-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const handoffsDir = path.join(cwd, ".claude", "handoffs");
  mkdirSync(handoffsDir, { recursive: true });
  writeFileSync(path.join(cwd, "secret.env"), "API_KEY=super-secret-value");
  symlinkSync(path.join(cwd, "secret.env"), path.join(handoffsDir, "innocent.md"));
  const pending = path.join(handoffsDir, ".pending");
  writeFileSync(pending, "innocent.md");

  const { code, stdout } = await run(JSON.stringify({ cwd }));

  assert.equal(code, 0);
  assert.doesNotMatch(stdout, /super-secret-value/, "a symlink out of handoffs/ must not be followed");
  assert.equal(existsSync(pending), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test plugins/handoff/tests/lib.test.mjs plugins/handoff/tests/load-pending-handoff.test.mjs`
Expected: FAIL — `readContainedFile` / `dirContainedIn` are not exported (import
error), and both loader tests fail on `stdout` containing `super-secret-value`.

- [ ] **Step 3: Add the helpers to `lib.mjs`**

Append to `plugins/handoff/scripts/lib.mjs`. Add `openSync`, `closeSync`, `fstatSync`,
`lstatSync`, `readFileSync`, `realpathSync`, `constants` to its `node:fs` import as
needed (`path` is already imported).

```js
// POSIX-only flags; undefined on Windows, where we fall back to 0 and rely on the
// (necessarily non-atomic) lstat pre-check. Windows has no filesystem FIFOs reachable
// this way, so the blocking hazard O_NONBLOCK guards against does not apply there.
const O_NOFOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const O_NONBLOCK = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;

/**
 * Read `name` from `baseDir` without following anything out of it.
 *
 * Deliberately not resolve-then-read: a validate-then-read is a TOCTOU — the
 * validated file can be swapped for a symlink before the read. `name` must be a bare
 * filename, and the file is opened once with O_NOFOLLOW, so the descriptor we
 * validate is the descriptor we read.
 *
 * O_NONBLOCK matters: a plain open() on a FIFO blocks until a writer appears, so an
 * fstat-based regular-file check would never run and a planted FIFO would hang
 * SessionStart. Non-blocking open returns immediately; fstat then rejects it.
 *
 * Threat model: a hostile *checked-out repo* (static files). A concurrently running
 * local attacker could still swap an intermediate directory between checks — Node has
 * no openat — but such an attacker can read your files directly anyway.
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
```

- [ ] **Step 4: Rewire the loader**

In `plugins/handoff/scripts/load-pending-handoff.mjs`, add `readContainedFile`,
`dirContainedIn` to the existing `./lib.mjs` import.

After `handoffsDir` / `pendingFile` are computed (lines 27-28):

```js
// An attacker who can symlink .claude/handoffs -> /etc would exfiltrate with a
// perfectly innocent bare filename, so the directory itself must be contained.
if (!dirContainedIn(cwd, handoffsDir)) {
  process.exit(0);
}
```

Replace the marker read (lines 50-57) — the marker is attacker-controlled and may
itself be a symlink or a FIFO:

```js
const pendingContent = readContainedFile(handoffsDir, ".pending");
if (pendingContent === null) {
  process.exit(0);
}

const handoffFilename = pendingContent.replace(/\s+/g, "");
```

(The empty-filename branch at lines 58-65 stays as-is: unlink the marker, exit 0.)

Replace the path construction and existence check (lines 67-83) with one safe read
and one refusal branch:

```js
const handoffContent = readContainedFile(handoffsDir, handoffFilename);

if (handoffContent === null) {
  // Missing, non-bare, symlinked out of handoffs/, or not a regular file. Consume the
  // marker so a poisoned one cannot retry on every future session.
  try {
    unlinkSync(pendingFile);
  } catch {
    // best-effort
  }
  process.exit(0);
}
```

The existing "consume the marker, then emit" tail (lines 85-92) stays as-is.
`existsSync` is still used at line 30 and `statSync` at line 36; drop `readFileSync`
from the import if nothing else uses it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test plugins/handoff/tests/lib.test.mjs plugins/handoff/tests/load-pending-handoff.test.mjs`
Expected: PASS, including the pre-existing load / missing-file / stale tests — the
happy path (a real flat `.md` handoff) and the missing-handoff path (exit 0, marker
consumed) must both be unchanged.

- [ ] **Step 6: Commit**

```bash
git add plugins/handoff/scripts/lib.mjs plugins/handoff/scripts/load-pending-handoff.mjs \
        plugins/handoff/tests/lib.test.mjs plugins/handoff/tests/load-pending-handoff.test.mjs
git commit -m "fix(handoff): read pending handoff with O_NOFOLLOW|O_NONBLOCK, bare names only (P1)

A .pending marker containing ../../.env resolved outside .claude/handoffs/ and its
contents were injected into the next session's context, so a hostile checked-out repo
could exfiltrate local files into model context. The marker is now restricted to a
bare filename and the file is opened once with O_NOFOLLOW and read from that
descriptor — a resolve-then-read would still lose to a symlink swapped in between.
O_NONBLOCK is required, not cosmetic: a plain open() on a planted FIFO blocks before
any fstat check can reject it, hanging SessionStart. Also refuses a .claude/handoffs
directory symlinked out of the project.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Task 2: Rebuild the statusline overlap guard as a correct lock (P2)

**Files:**
- Modify: `plugins/handoff/scripts/lib.mjs` (add `isProcessAlive`, `acquireInflightLock`, `releaseInflightLock`)
- Modify: `plugins/handoff/scripts/status-and-flag.mjs:48-58, 97-123, 229-232`
- Test: `plugins/handoff/tests/lib.test.mjs`
- Test: `plugins/handoff/tests/status-and-flag.test.mjs`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `isProcessAlive(pid)` → boolean;
  `acquireInflightLock(lockPath, staleMs?, hardMaxMs?)` → ownership token, or `null`;
  `releaseInflightLock(lockPath, token)` → void.

**Background:** `status-and-flag.mjs:100-119` reads the lock's mtime, decides "not in
flight", and only then writes it. Two concurrent invocations both pass the check and
both write — the exact race the 0.5.1 guard exists to prevent (double-fired flags,
interleaved `last-context-pct` read-modify-write).

Getting this right took four races, each found by a review round. **All four fixes
are load-bearing; do not simplify any of them away.**

1. **Create must be atomic *with its content*.** `open(wx)` then `write(token)` leaves
   a window where the lock exists but is empty; a reader parses `""` as pid `NaN`,
   concludes "dead holder", and breaks a lock whose creator is very much alive.
   Instead: write the token to a private temp file, then `linkSync(tmp, lockPath)` —
   `link` fails with `EEXIST` if the lock exists, so it is exactly as exclusive as
   `wx`, but the lock is **never observable in a partial state**.
2. **A breaker must delete only the lock it observed.** The naive
   `renameSync(lockPath, …)` + `unlink` is wrong: two breakers can both see the same
   stale lock; the first breaks it and re-acquires; the second's *unconditional*
   rename then moves the winner's **fresh** lock away and deletes it — and now both
   hold "the" lock. Fix: rename to a private name, **read what you actually moved**,
   and if it is not the stale holder you inspected, `link` it back (link cannot
   clobber a third holder) instead of deleting it.
3. **Never break a live holder.** The guarded work is a synchronous, *unbounded*
   JSONL transcript read. No lease can be proven longer than it, and there is no
   evidence in this repo that Claude Code kills a slow statusline (the 5s timeouts in
   `hooks/hooks.json` are hook timeouts, not the statusLine command's). So a
   stale-by-mtime lock is broken only when its holder pid is **not alive**.
4. **`hardMaxMs` (60s) is an escape hatch, and it is the one residual.** A recycled
   pid could make a dead holder's lock look live forever, freezing the guard into
   replaying cached renders. So a lock past the hard cap is broken regardless of
   liveness — which means a >60s live holder *can* be displaced, and its later
   release could in principle delete a replacement's lock. Two things bound that:
   release renames-and-verifies (see below), and a statusline still running after 60
   seconds is already pathological. **State this residual; do not claim it away.**

Release is symmetric with the break: `rename` the lock to a private name (atomically
taking whatever is at the path), *then* check the content. If it is our token, delete
it. If it is not — we were hard-cap-broken and replaced — `link` it back. The decision
is made on a file only we can name, so there is no check-then-act on the shared path.

- [ ] **Step 1: Write the failing tests**

In `plugins/handoff/tests/lib.test.mjs`, merge into the existing imports:
- into the existing `node:fs` import: `utimesSync`, `readFileSync`, `readdirSync`
- into the existing `../scripts/lib.mjs` import: `isProcessAlive`, `acquireInflightLock`, `releaseInflightLock`
- into the `node:child_process` import added in Task 1: `spawn`

Then append:

```js
const DEAD_PID = 2_147_483_646; // above every platform's pid_max — never alive

test("isProcessAlive: true for this process, false for a pid that cannot exist", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(DEAD_PID), false);
  assert.equal(isProcessAlive(NaN), false);
  assert.equal(isProcessAlive(0), false);
});

test("acquireInflightLock: a second acquirer is refused while the lock is held", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "s.lock");
  const a = acquireInflightLock(lock);
  assert.ok(a, "first acquirer wins");
  assert.equal(acquireInflightLock(lock), null, "second acquirer is refused");
  releaseInflightLock(lock, a);
  assert.equal(existsSync(lock), false, "release removes the lock we own");
  assert.ok(acquireInflightLock(lock), "lock is reusable after release");
});

test("acquireInflightLock: a stale lock from a DEAD holder is broken and re-acquired", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "s.lock");
  writeFileSync(lock, `${DEAD_PID}:dead-token`);
  const old = new Date(Date.now() - 30_000);
  utimesSync(lock, old, old);
  const token = acquireInflightLock(lock);
  assert.ok(token, "a stale lock whose holder is gone must be broken");
  assert.equal(readFileSync(lock, "utf8"), token, "the new holder's token is on disk");
});

test("acquireInflightLock: a stale lock from a LIVE holder is NOT broken", (t) => {
  // The regression test for the unbounded JSONL read: a slow but living invocation
  // keeps its lock however far past the lease it runs.
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "s.lock");
  writeFileSync(lock, `${process.pid}:live-token`); // this test process is alive
  const old = new Date(Date.now() - 30_000);        // well past the 2s lease
  utimesSync(lock, old, old);
  assert.equal(acquireInflightLock(lock), null, "a live holder's lock must never be stolen");
  assert.equal(readFileSync(lock, "utf8"), `${process.pid}:live-token`, "and must be left intact");
});

test("acquireInflightLock: hardMaxMs breaks even a live-looking lock (pid-reuse escape hatch)", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "s.lock");
  writeFileSync(lock, `${process.pid}:live-token`);
  const ancient = new Date(Date.now() - 120_000); // past the 60s hard cap
  utimesSync(lock, ancient, ancient);
  assert.ok(acquireInflightLock(lock), "a lock past hardMaxMs is broken regardless of liveness");
});

test("acquireInflightLock: a breaker that lost the race does not delete the winner's fresh lock", (t) => {
  // The double-breaker cascade, made deterministic: `holder` is what THIS breaker
  // observed. Simulate losing the race by replacing the lock with a fresh winner's
  // between observation and break — the loser must restore it, not delete it.
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-break-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "s.lock");
  // A stale, dead-holder lock: eligible for breaking.
  writeFileSync(lock, `${DEAD_PID}:stale-token`);
  const old = new Date(Date.now() - 30_000);
  utimesSync(lock, old, old);
  // Breaker A wins: it breaks the stale lock and takes a fresh one.
  const winner = acquireInflightLock(lock);
  assert.ok(winner);
  // Breaker B now runs with the SAME stale observation. It must not delete A's lock.
  const loser = acquireInflightLock(lock);
  assert.equal(loser, null, "the losing breaker must not acquire");
  assert.equal(readFileSync(lock, "utf8"), winner, "the winner's fresh lock must survive intact");
  assert.equal(
    readdirSync(dir).filter((f) => f.includes(".stale-") || f.includes(".tmp-")).length,
    0,
    "no temp/stale scratch files may be left behind",
  );
});

test("releaseInflightLock: only the owning token deletes the lock", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "s.lock");
  const mine = acquireInflightLock(lock);
  releaseInflightLock(lock, "somebody-elses-token");
  assert.equal(existsSync(lock), true, "a non-owner must not delete the lock");
  assert.equal(readFileSync(lock, "utf8"), mine, "and must leave it intact");
  releaseInflightLock(lock, mine);
  assert.equal(existsSync(lock), false);
});

test("acquireInflightLock: mutual exclusion holds under real concurrency", async (t) => {
  // spawnSync in a loop would NOT test this — each child would run to completion
  // before the next starts, so even a check-then-write would show one winner. Start
  // every child first; each announces readiness and spins until all N are ready, so
  // they contend for real. Then each acquires/releases in a loop, bracketing a
  // critical section with markers; any overlap means mutual exclusion broke.
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-race-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "s.lock");
  const journal = path.join(dir, "journal.log");
  const readyDir = path.join(dir, "ready");
  mkdirSync(readyDir);
  writeFileSync(journal, "");
  const libUrl = new URL("../scripts/lib.mjs", import.meta.url).href;
  const N = 6;
  const src = `
    import { acquireInflightLock, releaseInflightLock } from ${JSON.stringify(libUrl)};
    import { writeFileSync, appendFileSync, readdirSync } from "node:fs";
    const lock = ${JSON.stringify(lock)}, journal = ${JSON.stringify(journal)}, readyDir = ${JSON.stringify(readyDir)};
    writeFileSync(readyDir + "/" + process.pid, "");          // announce readiness
    while (readdirSync(readyDir).length < ${N}) {}            // real barrier: spin until all are up
    for (let i = 0; i < 15; i++) {
      const t = acquireInflightLock(lock);
      if (t === null) continue;                              // contended — that is a legal outcome
      appendFileSync(journal, "IN " + process.pid + "\\n");
      for (let s = 0; s < 2000; s++) {}                      // hold it briefly
      appendFileSync(journal, "OUT " + process.pid + "\\n");
      releaseInflightLock(lock, t);
    }
  `;
  await Promise.all(
    Array.from({ length: N }, () =>
      new Promise((resolve) => {
        const c = spawn(process.execPath, ["--input-type=module", "-e", src], { stdio: "ignore" });
        c.on("close", resolve);
      }),
    ),
  );
  // Mutual exclusion <=> the journal is a sequence of matched IN/OUT pairs from the
  // same pid, never nested. A single interleaved pair proves two holders coexisted.
  const lines = readFileSync(journal, "utf8").trim().split("\n").filter(Boolean);
  assert.ok(lines.length >= 2, `expected some critical sections to run (got ${lines.length} lines)`);
  /** @type {string | null} */
  let inside = null;
  for (const line of lines) {
    const [kind, pid] = line.split(" ");
    if (kind === "IN") {
      assert.equal(inside, null, `pid ${pid} entered while pid ${inside} was inside — mutual exclusion broke`);
      inside = pid;
    } else {
      assert.equal(inside, pid, `pid ${pid} exited but pid ${inside} was inside`);
      inside = null;
    }
  }
  assert.equal(inside, null, "every critical section must have closed");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test plugins/handoff/tests/lib.test.mjs`
Expected: FAIL — the three lock helpers are not exported yet, so every new lock test
fails at import (the concurrency test's children cannot import them, leaving the
journal empty).

- [ ] **Step 3: Add the lock helpers to `lib.mjs`**

Append to `plugins/handoff/scripts/lib.mjs`. Add `writeFileSync`, `linkSync`,
`statSync`, `renameSync`, `unlinkSync` to its `node:fs` import as needed
(`readFileSync` / `closeSync` were added in Task 1).

```js
const LOCK_STALE_MS = 2000;
const LOCK_HARD_MAX_MS = 60_000;

/**
 * Is `pid` a live process? EPERM means it exists but belongs to another user.
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return Boolean(e) && /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
  }
}

/**
 * Move `lockPath` aside and delete it ONLY if it still holds `expected`. If it holds
 * anything else, link it back — someone replaced it between our observation and now,
 * and deleting it would leave two live holders.
 *
 * link() cannot clobber: if a third party has already created a new lock at lockPath,
 * the link fails with EEXIST and theirs wins. The decision is made on a private name,
 * so there is no check-then-act on the shared path.
 *
 * @param {string} lockPath
 * @param {string} expected  the exact lock content we observed
 * @param {string} scratch   a private path only this caller can name
 * @returns {boolean} true if the expected lock was removed
 */
function removeLockIfUnchanged(lockPath, expected, scratch) {
  try {
    renameSync(lockPath, scratch); // atomically take whatever is at lockPath
  } catch {
    return false; // already gone
  }
  /** @type {string | null} */
  let moved = null;
  try {
    moved = readFileSync(scratch, "utf8");
  } catch {
    // unreadable — treat as not-ours and try to put it back
  }
  if (moved === expected) {
    try {
      unlinkSync(scratch);
    } catch {
      // best-effort
    }
    return true;
  }
  try {
    linkSync(scratch, lockPath); // restore; EEXIST means a newer holder already exists
  } catch {
    // best-effort
  }
  try {
    unlinkSync(scratch);
  } catch {
    // best-effort
  }
  return false;
}

/**
 * Atomically take the in-flight lock. Returns an ownership token, or null when another
 * invocation holds it.
 *
 * Four rules, all load-bearing (each was a real race in an earlier revision):
 *
 *  - Create by link(), not open("wx"): the token is written to a private temp file
 *    first, so the lock is never observable half-written. An empty lock parses as pid
 *    NaN — "dead" — and would be broken out from under a live creator.
 *  - Break only the lock you observed (removeLockIfUnchanged): two breakers seeing the
 *    same stale lock must not cascade into deleting each other's fresh replacement.
 *  - Never break a LIVE holder: the guarded work is an unbounded synchronous transcript
 *    read, so no lease can be proven longer than it. Only a dead holder's lock is stale.
 *  - hardMaxMs bounds pid reuse — and is the one residual: a >60s live holder can be
 *    displaced, and a statusline running that long is already pathological.
 *
 * @param {string} lockPath
 * @param {number} [staleMs]
 * @param {number} [hardMaxMs]
 * @returns {string | null}
 */
export function acquireInflightLock(lockPath, staleMs = LOCK_STALE_MS, hardMaxMs = LOCK_HARD_MAX_MS) {
  const token = `${process.pid}:${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const scratch = `${lockPath}.tmp-${token}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(scratch, token); // fully written before it is ever visible as a lock
      linkSync(scratch, lockPath); // atomic exclusive create — EEXIST if held
      return token;
    } catch (e) {
      if (Boolean(e) && /** @type {NodeJS.ErrnoException} */ (e).code !== "EEXIST") return null;
      let age;
      let holder;
      try {
        age = Date.now() - statSync(lockPath).mtimeMs;
        holder = readFileSync(lockPath, "utf8");
      } catch {
        continue; // vanished under us — retry
      }
      if (age <= staleMs) return null; // held, fresh
      const holderPid = Number.parseInt(holder.split(":")[0], 10);
      if (isProcessAlive(holderPid) && age < hardMaxMs) return null; // slow but alive — leave it
      if (!removeLockIfUnchanged(lockPath, holder, `${lockPath}.stale-${token}`)) {
        return null; // someone replaced it first; their lock stands
      }
    } finally {
      try {
        unlinkSync(scratch);
      } catch {
        // already consumed by the link, or never created
      }
    }
  }
  return null;
}

/**
 * Release the lock if we still own it. Symmetric with the break: rename first, decide
 * second — so the ownership check happens on a file only we can name, not via a
 * check-then-act on the shared path.
 * @param {string} lockPath
 * @param {string | null} token
 */
export function releaseInflightLock(lockPath, token) {
  if (typeof token !== "string" || token.length === 0) return;
  removeLockIfUnchanged(lockPath, token, `${lockPath}.rel-${token}`);
}
```

**Note on the `finally`:** `unlinkSync(scratch)` runs on every path. After a
successful `linkSync` the scratch name is a second hardlink to the same inode —
removing it leaves the lock intact at `lockPath`. That is the intended cleanup, not a
bug; the concurrency test asserts no `.tmp-`/`.stale-` files survive.

- [ ] **Step 4: Rewire `status-and-flag.mjs`**

Add `acquireInflightLock`, `releaseInflightLock` to the existing `./lib.mjs` import.

Next to the existing `let heldLockPath = null;` (line 48), add **one** declaration:

```js
/** @type {string | null} */
let heldLockToken = null;
```

Keep `LOCK_FRESH_MS = 2000` at line 97 — the lease no longer has to outlast the work,
because a live holder is never broken. Replace its comment:

```js
// A concurrent invocation must not double-fire flags or interleave the read-modify-write
// on last-context-pct — replay the previous render instead. The lease only decides when a
// lock becomes *eligible* for breaking; acquireInflightLock additionally refuses to break a
// lock whose holder process is still alive, so a slow JSONL fallback cannot be displaced
// mid-flight.
const LOCK_FRESH_MS = 2000;
```

Replace the whole guard block (lines 100-123) with:

```js
const lockToken = acquireInflightLock(inflightLockFile, LOCK_FRESH_MS);
if (lockToken === null) {
  // Another invocation is in flight (or the lock dir is unwritable): replay the last
  // render rather than double-firing flags.
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

Then, in `bail()` (lines 55-58) and at the end of the script (lines 229-232), replace
`rmSync(heldLockPath, { force: true })` with:

```js
  releaseInflightLock(heldLockPath, heldLockToken);
```

Keep the surrounding `if (heldLockPath !== null)` guards and try/catch shape. `rmSync`
may become an unused import — remove it from the `node:fs` import if so.

**Behavior note — intentional:** when the lock cannot be created for a reason other
than EEXIST (an unwritable data dir), `acquireInflightLock` returns `null` and the
statusline replays the cached render or bails to `?`, where the old code rendered
anyway. That is the safe direction for a guard whose job is to prevent double-fired
flags, and an unwritable data dir already breaks flag-writing downstream.

- [ ] **Step 5: Add a statusline-level regression test**

In `plugins/handoff/tests/status-and-flag.test.mjs`, append (reuse the file's existing
`run(stdinPayload, extraEnv)` helper and `t.after` cleanup; merge new `node:fs` names
into the existing import). The lock is written with a **live** pid — the point is that
a live holder is never displaced:

```js
test("overlap guard: an in-flight lock makes a concurrent invocation replay, not re-render", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "handoff-guard-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const sid = "guard-sid";
  writeFileSync(path.join(dataDir, `last-render-${sid}.txt`), "CACHED-RENDER");
  const otherLock = path.join(dataDir, `statusline-inflight-${sid}.lock`);
  const otherToken = `${process.pid}:other-holder`; // a live holder
  writeFileSync(otherLock, otherToken);

  const { code, stdout } = await run(
    JSON.stringify({ session_id: sid, context_window: { used_percentage: 75 } }),
    { CLAUDE_PLUGIN_DATA: dataDir },
  );

  assert.equal(code, 0);
  assert.equal(stdout, "CACHED-RENDER", "must replay the cached render, not render fresh");
  assert.equal(readFileSync(otherLock, "utf8"), otherToken, "the in-flight holder's lock must survive");
});
```

Use whatever mechanism the file's existing tests use to point the script at a temp data
dir (`resolveDataDir("handoff-data")` in `lib.mjs` decides it) — do not invent a new
env var.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test plugins/handoff/tests/`
Expected: PASS — all handoff tests, including the pre-existing statusline
threshold/band/render tests (no regression).

- [ ] **Step 7: Commit**

```bash
git add plugins/handoff/scripts/lib.mjs plugins/handoff/scripts/status-and-flag.mjs \
        plugins/handoff/tests/lib.test.mjs plugins/handoff/tests/status-and-flag.test.mjs
git commit -m "fix(handoff): rebuild statusline overlap guard as a correct lock (P2)

The 0.5.1 guard read the lock's mtime, concluded 'not in flight', then wrote it — so
two concurrent invocations both passed the check and both wrote, the exact race it
exists to prevent. Fixing it properly took four coupled changes:

- create by link() from a fully-written temp file, so the lock is never observable
  half-written (an empty lock parses as pid NaN — 'dead' — and gets broken out from
  under its live creator);
- break only the lock you observed (rename, verify, restore-by-link), so two breakers
  cannot cascade into deleting each other's fresh replacement;
- never break a LIVE holder — the guarded work is an unbounded synchronous transcript
  read, so no lease can be proven longer than it;
- a 60s hard cap bounds pid reuse, and is the documented residual.

Release is symmetric with the break, so ownership is decided on a private name rather
than by a check-then-act on the shared path.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Task 3: Fix the hook filename in the docs + version bump (P3)

**Files:**
- Modify: `plugins/handoff/skills/handoff/SKILL.md:132`
- Modify: `plugins/handoff/.claude-plugin/plugin.json` (version → `0.5.2`)
- Modify: `.claude-plugin/marketplace.json` (`handoff` entry version → `0.5.2`)
- Modify: `plugins/handoff/README.md`, `plugins/handoff/CLAUDE.md`
- Test: `scripts/repo-consistency.test.mjs` (existing — asserts the two versions match)

**Interfaces:** none.

**Background:** SKILL.md tells users the active SessionStart hook is
`load-pending-handoff.sh`; the shipped hook (`hooks/hooks.json:19`) invokes
`load-pending-handoff.mjs`. Anyone troubleshooting a failed auto-load is sent to a file
that does not exist. The `.sh` scripts were replaced by `.mjs` in v0.2.

- [ ] **Step 1: Fix the filename in SKILL.md**

At `plugins/handoff/skills/handoff/SKILL.md:132`, change `load-pending-handoff.sh` to
`load-pending-handoff.mjs`. Then grep for other stale `.sh` references:

```bash
grep -rn "load-pending-handoff\.sh\|status-and-flag\.sh\|check-handoff-flag\.sh" plugins/handoff/
```

Expected: only the SKILL.md:132 hit. Leave historical references alone — the "Mirrors
v0.1 bash tests" comment atop `tests/load-pending-handoff.test.mjs` describes v0.1, it
does not tell the user which file runs.

- [ ] **Step 2: Bump the version in both registries**

`plugins/handoff/.claude-plugin/plugin.json`: `"version": "0.5.1"` → `"0.5.2"`.
`.claude-plugin/marketplace.json`, `handoff` entry: `"version": "0.5.1"` → `"0.5.2"`.

- [ ] **Step 3: Document the two fixes accurately**

In `plugins/handoff/README.md` (and the one-line `status-and-flag.mjs` description in
`plugins/handoff/CLAUDE.md`), state what now holds — and do not overclaim:

- The SessionStart loader accepts only a **bare filename** in `.pending` and opens it
  with `O_NOFOLLOW | O_NONBLOCK`, so a marker naming `../../.env`, a symlink, or a FIFO
  is refused and consumed. This closes exfiltration by a **hostile checked-out repo**;
  a concurrently running local attacker is explicitly out of scope (Node has no
  `openat`, and such an attacker can read your files directly anyway).
- The statusline overlap guard creates its lock atomically with its content, breaks
  only the lock it observed, and **never breaks the lock of a live process** — so a
  slow transcript read cannot be displaced mid-flight. A 60s hard cap bounds pid reuse.

Do not write "race-free" or "ownership-safe release" as a standalone claim. Two or
three sentences — do not restructure the README.

- [ ] **Step 4: Run the full suite**

Run: `node --test $(find scripts plugins -name "*.test.mjs" -not -path "*node_modules*")`
Expected: PASS, 0 fail — including `scripts/repo-consistency.test.mjs`'s
plugin.json↔marketplace.json version-match assertion, which fails if only one of the two
version bumps landed.

- [ ] **Step 5: Commit**

```bash
git add plugins/handoff/skills/handoff/SKILL.md plugins/handoff/.claude-plugin/plugin.json \
        .claude-plugin/marketplace.json plugins/handoff/README.md plugins/handoff/CLAUDE.md
git commit -m "docs(handoff): correct SessionStart hook filename, bump to 0.5.2

SKILL.md pointed troubleshooting at load-pending-handoff.sh; the shipped hook runs
load-pending-handoff.mjs (the .sh scripts went away in v0.2). Also documents the 0.5.2
containment and liveness-aware-guard fixes, and their stated limits.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Out of scope

- The `deep-dive` (Batch C) and `subagent-driven-development` (Batch D) findings —
  separate branches, separate plans.
- The `adversarial-agents` README/SKILL.md contradiction (A3).
- **The same double-breaker bug in `codex-review`'s `acquireLock`** — found while
  fixing this one. Its blast radius there is bounded (the chain log's append-order
  verification is the real guard; the lock is only a contention reducer), so it is
  tracked in the triage doc as its own item rather than smuggled into this branch.
- Any behavior change to the handoff threshold/band logic, the flag format, or the
  statusline's rendering. Touch only what the two defects require.
