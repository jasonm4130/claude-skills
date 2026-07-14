# Handoff Security Fix (Batch B) — Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the P1 path-traversal hole in the `handoff` SessionStart loader — a
`.pending` marker naming `../../.env` is read and injected into the next session's
context — and correct the P3 doc error that sends troubleshooting to a nonexistent
hook file.

**Scope change (Codex audit, 2026-07-14):** the statusline overlap-guard race (P2)
was in this batch and has been **pulled out**. Three review rounds and a fresh-session
audit each found a *new* race in the lock design, and the last one showed the
rename-and-restore break cannot be made mutually exclusive without yet another layer.
The right fix is not a fourth patch: the guard is protecting a "fire each band at most
once" invariant, which an exclusive-create marker expresses directly, with no lock, no
liveness check, and no pid-reuse hazard. That is a design change, not a bugfix, so it
goes to its own pass (Batch B2 in the triage doc, where the design is written up).
Nothing here depends on it.

## Threat model (read this before Task 1)

The attacker is a **hostile repository you checked out** — a PR under review, a
dependency, a template. They control files committed in the tree: they can plant
`.claude/handoffs/.pending`, symlinks, and FIFOs. They are **not running a process on
your machine**.

That boundary is deliberate. Node has no `openat`, so a *concurrently running local
attacker* can always win a directory-swap race against any userspace path check (swap
`.claude/handoffs` for a symlink between the check and the open; `O_NOFOLLOW` guards
only the final component). Excluding them is sound: a local process running as you can
read `~/.env` directly — it does not need to exfiltrate through a SessionStart hook.
Against the static-file attacker we *are* defending against, every symlink and FIFO is
already on disk when we look, so `realpath` and `O_NOFOLLOW` see it and refuse.

**What this task does NOT close (Codex audit, P1 — tracked as Batch B3):** a hostile
repo can still commit an ordinary in-tree `.claude/handoffs/evil.md` plus a `.pending`
naming it. That passes every check here — it is a bare filename, a regular file, inside
the directory — and its contents are injected as `additionalContext`. This task closes
**exfiltration** (reading files the repo could not otherwise reach); it does not close
**injection** (attacker-authored text entering context). Injection needs a provenance
boundary — the loader has no way to know the handoff was written by *this machine's*
handoff skill rather than committed by the repo — and that is a design question, not a
patch. Do not write a comment or README line claiming the hostile-checkout route is
"closed"; say what is true: traversal, symlink, and FIFO reads are refused.

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
  exits `0` silently. **A refusal is not an error** — never throw out of a hook.
- Use `path.join`/`path.resolve`, never string concatenation. Use `os.tmpdir()`, never
  a literal `/tmp`.
- **Never re-`import` a module a file already imports.** Both test files below already
  import `node:test`, `node:assert/strict`, `node:fs`, `node:path`, `node:os` and the
  module under test — merge new names into those existing import statements. A
  duplicate `import` declaration is a parse error, not a test failure.
- POSIX-only test cases (FIFO, symlink) must skip on Windows:
  `test("…", { skip: process.platform === "win32" }, …)`.
- Temp dirs in tests are cleaned up with `t.after(() => rmSync(dir, { recursive: true, force: true }))`,
  matching the existing style in `tests/lib.test.mjs`.
- **Run the suite with `bash scripts/run-node-tests.sh`, never `node --test <dir>`.**
  That script exists because Node 24 regressed bare-directory invocation
  (`MODULE_NOT_FOUND`) and its `**` glob silently skips dot-directories. Single files
  (`node --test path/to/one.test.mjs`) are fine.
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
    non-bare names, symlinked final components (via `O_NOFOLLOW`), non-regular files;
    never blocks, never throws.
  - `dirContainedIn(rootDir, dir)` → `true` when `dir`'s realpath is inside `rootDir`'s.

**Background:** `load-pending-handoff.mjs:57` strips whitespace from the marker's
contents and `path.join`s it onto `handoffsDir` with no containment check. A marker
containing `../../.env` resolves outside `.claude/handoffs/` and its contents are
emitted as `additionalContext` at line 91.

Three properties are required, each of which was a finding in a review round:

1. **Bare filename only.** No separators, no `..`. The `/handoff` skill only ever writes
   flat files into `.claude/handoffs/`, so this is a tightening with no behavior loss —
   and it removes every question about symlinked *intermediate* components.
2. **One open, no re-resolution.** `O_NOFOLLOW` makes a symlinked final component fail
   at `open` (ELOOP) instead of being followed, and the descriptor we validate is the
   descriptor we read. A `realpath`-then-`readFileSync` loses to a file swapped for a
   symlink in between.
3. **`O_NONBLOCK`, then `fstat`.** A plain `open()` on a **FIFO blocks until a writer
   appears** — so an `fstat`-based "is it a regular file?" check never runs, and a
   planted FIFO hangs SessionStart forever. Non-blocking open returns immediately;
   *then* `fstat` can reject it. (Regular files ignore `O_NONBLOCK`.)

`O_NOFOLLOW` and `O_NONBLOCK` are POSIX-only; on Windows both `fs.constants` entries are
`undefined`. Fall back to `0` and keep the `lstat` symlink pre-check as the
(non-atomic) best effort that platform allows. Windows has no filesystem FIFOs reachable
this way, so the blocking hazard does not apply there.

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
  // A plain open() on a FIFO blocks until a writer appears — the reason the open must be
  // non-blocking. If this test times out, O_NONBLOCK is missing.
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
`symlinkSync` into the existing `node:fs` import, then append (reuse the file's existing
`run()` helper, which pipes `{"cwd": …}` on stdin):

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
Expected: FAIL — `readContainedFile` / `dirContainedIn` are not exported (import error),
and both loader tests fail on `stdout` containing `super-secret-value`.

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
```

- [ ] **Step 4: Rewire the loader**

In `plugins/handoff/scripts/load-pending-handoff.mjs`, add `readContainedFile`,
`dirContainedIn` to the existing `./lib.mjs` import.

After `handoffsDir` / `pendingFile` are computed (lines 27-28):

```js
// An attacker who can symlink .claude/handoffs -> /etc would exfiltrate with a perfectly
// innocent bare filename, so the directory itself must be contained.
if (!dirContainedIn(cwd, handoffsDir)) {
  process.exit(0);
}
```

Replace the marker read (lines 50-57) — the marker is attacker-controlled and may itself
be a symlink or a FIFO:

```js
const pendingContent = readContainedFile(handoffsDir, ".pending");
if (pendingContent === null) {
  process.exit(0);
}

const handoffFilename = pendingContent.replace(/\s+/g, "");
```

(The empty-filename branch at lines 58-65 stays as-is: unlink the marker, exit 0.)

Replace the path construction and existence check (lines 67-83) with one safe read and
one refusal branch:

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

The existing "consume the marker, then emit" tail (lines 85-92) stays as-is. `existsSync`
is still used at line 30 and `statSync` at line 36; drop `readFileSync` from the import
if nothing else uses it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test plugins/handoff/tests/lib.test.mjs plugins/handoff/tests/load-pending-handoff.test.mjs`
Expected: PASS, including the pre-existing load / missing-file / stale tests — the happy
path (a real flat `.md` handoff) and the missing-handoff path (exit 0, marker consumed)
must both be unchanged.

- [ ] **Step 6: Commit**

```bash
git add plugins/handoff/scripts/lib.mjs plugins/handoff/scripts/load-pending-handoff.mjs \
        plugins/handoff/tests/lib.test.mjs plugins/handoff/tests/load-pending-handoff.test.mjs
git commit -m "fix(handoff): read pending handoff with O_NOFOLLOW|O_NONBLOCK, bare names only (P1)

A .pending marker containing ../../.env resolved outside .claude/handoffs/ and its
contents were injected into the next session's context, so a hostile checked-out repo
could exfiltrate local files into model context. The marker is now restricted to a bare
filename and the file is opened once with O_NOFOLLOW and read from that descriptor — a
resolve-then-read would still lose to a symlink swapped in between. O_NONBLOCK is
required, not cosmetic: a plain open() on a planted FIFO blocks before any fstat check
can reject it, hanging SessionStart. Also refuses a .claude/handoffs directory symlinked
out of the project.

This closes exfiltration, not injection: a repo can still commit an ordinary in-tree
handoff file. That needs a provenance boundary and is tracked separately.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Task 2: Fix the hook filename in the docs + version bump (P3)

**Files:**
- Modify: `plugins/handoff/skills/handoff/SKILL.md:132`
- Modify: `plugins/handoff/.claude-plugin/plugin.json` (version → `0.5.2`)
- Modify: `.claude-plugin/marketplace.json` (`handoff` entry version → `0.5.2`)
- Modify: `plugins/handoff/README.md`
- Test: `scripts/repo-consistency.test.mjs` (existing — asserts the two versions match)

**Interfaces:** none. Depends on Task 1 only in that it documents Task 1's behavior.

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

- [ ] **Step 3: Document Task 1's behavior accurately in the README**

In `plugins/handoff/README.md`, add two or three sentences (do not restructure it):

- The SessionStart loader accepts only a **bare filename** in `.pending` and opens it
  with `O_NOFOLLOW | O_NONBLOCK`, so a marker naming `../../.env`, a symlink, or a FIFO
  is refused and the marker consumed.
- State the limit honestly: this prevents a checked-out repo from making the loader read
  files *outside* `.claude/handoffs/`. It does not verify who *wrote* a handoff, so a
  repo that commits its own handoff file can still get its text into context — treat
  handoffs from an untrusted checkout with the same suspicion as any other file in it.

Do not claim the hostile-checkout route is "closed". Do not mention the statusline lock
— it is unchanged in this batch.

- [ ] **Step 4: Run the full suite**

Run: `bash scripts/run-node-tests.sh`
Expected: PASS, 0 fail — including `scripts/repo-consistency.test.mjs`'s
plugin.json↔marketplace.json version-match assertion, which fails if only one of the two
version bumps landed. (Use this script, not `node --test <dir>`: Node 24 regressed
bare-directory invocation, which is why the script exists.)

- [ ] **Step 5: Commit**

```bash
git add plugins/handoff/skills/handoff/SKILL.md plugins/handoff/.claude-plugin/plugin.json \
        .claude-plugin/marketplace.json plugins/handoff/README.md
git commit -m "docs(handoff): correct SessionStart hook filename, bump to 0.5.2

SKILL.md pointed troubleshooting at load-pending-handoff.sh; the shipped hook runs
load-pending-handoff.mjs (the .sh scripts went away in v0.2). Documents the 0.5.2
containment fix and its stated limit (it prevents reads outside handoffs/, it does not
establish who wrote a handoff).

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Out of scope (all tracked in `docs/plans/2026-07-14-codex-skills-audit-triage.md`)

- **Batch B2 — the statusline overlap guard.** Pulled from this batch; needs the
  idempotent-marker redesign, not a fourth lock patch.
- **Batch B3 — handoff injection / provenance.** A repo can commit its own handoff file
  and have it injected as context. Needs a trust boundary, not a path check.
- **The same double-breaker bug in `codex-review`'s `acquireLock`** — found while working
  this one. Bounded blast radius there (the chain log's append-order verification is the
  real guard; the lock is only a contention reducer), but real.
- Batch C (`deep-dive`) and Batch D (`subagent-driven-development`) findings.
- The `adversarial-agents` README/SKILL.md contradiction (A3).
