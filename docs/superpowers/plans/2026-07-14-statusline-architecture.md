# Statusline Architecture Fix (Batch B2) — Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the handoff statusline's concurrency story on the right primitives. Research:
`docs/plans/2026-07-14-statusline-architecture-research.md`.

## Why the 0.5.1 guard is the wrong shape

Four Codex rounds each found a *new* race in the lock (partial-write parsing as a dead pid; two
stale-breakers cascade-deleting each other's fresh lock; a losing breaker's restore losing to a third
acquirer; live-holder displacement at the pid-reuse cap). That is not a patching problem — it is the
wrong primitive. The research says why:

1. **Concurrency is real** — the docs claim cancel-and-replace, but ccusage
   [#459](https://github.com/ryoppippi/ccusage/issues/459) is a production report of 34 simultaneous
   statusline processes, 300% CPU, 3GB RAM. So a guard is warranted.
2. **But there is no documented statusLine timeout.** statusLine is *not* a hook; hook timeouts do
   not apply. Any design resting on "Claude Code will kill a slow one" rests on nothing.
3. **The three production tools** (ccusage, ccstatusline, claude-powerline) all use **no OS-level
   locking** — best-effort marker files with TTL + mtime + pid-liveness, serving stale output during
   overlap. None treats the marker as a correctness mutex.
4. **The expensive path is the root cause.** The unbounded synchronous transcript read is what makes
   an invocation slow enough to overlap at all. ccusage's fix was to *cache the parse*.

**Architecture:** four changes.

- **Task 1 — put the two atomic primitives in `lib.mjs`, where they can be tested.** The fire-arbiter
  and the lock-acquire are the only two places atomicity matters, and inline in a statusLine script
  they can only be exercised by spawning a child — which cannot deterministically reproduce either
  race. As `lib.mjs` exports they get real unit tests.
- **Task 2 — make flag-firing idempotent.** The invariant is a **transition** ("fire when the session
  *enters* a band from below"), not a level. `band > lastBand` already expresses that; keep it. What
  it cannot do is survive two invocations reading the same stale `lastPct` — both pass, both fire. So
  keep the gate for the semantics and add the **exclusive-create marker as the tie-breaker**.
  **Correctness stops depending on the guard**, with no observable behavior change.
- **Task 3 — cache the transcript derivation** on `mtime + size`. Removes the slow path that creates
  the overlap pressure in the first place.
- **Task 4 — demote the overlap guard to a performance guard** (don't pile up; replay the cached
  render), keeping pid-liveness. It no longer has to be a correct mutex, because Task 2 means nothing
  correctness-critical rides on it.

**Tech Stack:** Node 18+ ESM, stdlib only, `// @ts-check`. Tests: `node --test`.

## Accepted residual races

The 0.5.1 design failed because each round closed one race and opened another. This design closes the
one race that matters — the double-nudge — and then **stops**. These three remain open *by decision*.
Do not "fix" them in this plan; do not write documentation that claims they are closed.

1. **A slow invocation carrying a stale pre-`/compact` reading can undo a post-`/compact` reset** — by
   writing its high `lastPct` back, or by claiming a high band, after the reset ran. The next climb
   then compares against a `lastBand` that no longer reflects reality, and **a nudge can be delayed to
   a higher band than it should have fired at.** This is the one residual that can *cost* the user
   something rather than merely annoy them, so state it plainly rather than burying it.

   Not closed, because every local fix is worse: a generation counter's increment is itself a
   read-modify-write (reintroducing the exact bug class this redesign removes), and nothing in the
   statusLine payload gives us a monotonic sequence to fence on. Instead the window is *shrunk* on two
   fronts: Task 3's cache removes the multi-second transcript read that made invocations slow enough
   to overlap in the first place, and Task 2 writes state immediately after deriving the pct rather
   than after rendering. It needs a compact boundary AND an overlap inside a window now measured in
   microseconds.

2. **A concurrent `resetBands()` can delete a claim a racer just created**, allowing one duplicate
   nudge. Same window as (1). A duplicate nudge is advisory text shown twice.

3. **Two invocations can both judge a lock stale and both break it**, so one deletes the other's fresh
   lock and both proceed; and **the lock release is TOCTOU** (`readFileSync` the pid, then `rmSync` —
   Node has no compare-and-unlink). Cost of both: one duplicate *render*, which is invisible — Claude
   Code displays one status line, and the nudge is idempotent regardless.

**What is actually guaranteed:** no double-nudge from concurrent claims; no nudge lost to a failed
state write (a claim that fails to deliver is released); no crashed statusline (every state write is
caught); no permanently frozen bar (an abandoned lock is always eventually breakable). The tests pin
each of these. What is *not* guaranteed is nudge timing across a `/compact` boundary under overlap —
see (1).

## Global Constraints

- Plugin version becomes `0.6.0` (new on-disk state: per-band marker files and a transcript-parse
  cache) in BOTH `plugins/handoff/.claude-plugin/plugin.json` AND the `handoff` entry in
  `.claude-plugin/marketplace.json`. The nudge flag's name and plain-text format are **unchanged**.
- **ESM only, stdlib only**, `// @ts-check`, JSDoc on new exports. No `package.json`.
- **Graceful degradation is absolute:** the statusline must always exit 0 and print *something*
  (a render, or `?` via `bail()`). **Every state write — marker, flag, last-pct, cache, lock — must be
  inside a `try/catch`.** An unguarded `writeFileSync` that throws (e.g. the path is a directory, or
  the disk is full) kills the bar.
- **Never claim a timeout-based guarantee, and never claim the guard is a mutex.** There is no
  documented statusLine timeout. The guard is best-effort by design; say so.
- Run the full suite with `bash scripts/run-node-tests.sh`, never `node --test <dir>` (Node 24
  regressed bare-directory invocation).
- All commits on branch `feat/statusline-architecture`. Every commit message ends with:
  `Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw`

---

## Task 1: Put the atomic primitives in `lib.mjs`

**Files:**
- Modify: `plugins/handoff/scripts/lib.mjs` (imports + four new exports)
- Test: `plugins/handoff/tests/lib.test.mjs`

**Interfaces — produced, consumed by Tasks 2 and 4:**
- `bandMarkerPath(dataDir, sid, threshold, band)` → `string`
- `claimBand(dataDir, sid, threshold, band)` → `boolean` — `true` **iff this call created the marker**
- `resetBands(dataDir, sid)` → `void` — removes every band marker for the session
- `acquireInflightLock(lockPath, staleMs)` → `boolean` — `true` iff this call now holds the lock

**Why these live here.** Both races that matter are settled by a single atomic filesystem operation
(`{ flag: "wx" }`). Inline in `status-and-flag.mjs`, the only way to test them is to spawn two child
processes and hope they overlap — a test that can pass spuriously and therefore proves nothing. As
`lib.mjs` exports, the EEXIST branch is directly and deterministically reachable: pre-create the
marker, call the function, assert `false`. That is the difference between testing the race and
testing Node.

**The threshold is part of the marker's identity — but it is not the threshold-change mechanism.**
A band number is meaningless without the threshold that defines it: "band 0" is 70-80% under a
threshold of 70 and 80-90% under a threshold of 80. Putting the threshold in the filename keeps a
marker self-describing and stops markers from two different thresholds colliding on the same name.

**What actually governs a threshold change is the transition gate, not the marker.** Both `band` and
`lastBand` are recomputed against the *current* threshold on every invocation, so:
- **Raising** the threshold (70 → 80) makes the gate quieter — with `lastPct` 82, both `band` and
  `lastBand` compute to 0, so nothing fires. Correct: the user asked to be nudged *less*, and they
  were already nudged at 82% under the old threshold.
- **Lowering** it (70 → 60) re-arms the gate — `lastBand` becomes 2 while a later 95% reading is band
  3, so it fires.

Do **not** claim anywhere that a changed threshold "starts a fresh ladder" — the marker namespace is
fresh, but the gate is what decides, and it never even consults a marker it doesn't reach.

- [ ] **Step 1: Write the failing tests**

Append to `plugins/handoff/tests/lib.test.mjs`. Merge the new names into the existing
`../scripts/lib.mjs` and `node:fs` imports.

```js
test("claimBand: exactly one of N callers claiming the same band wins", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-claim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // The EEXIST branch, reached deterministically — no child processes, no hoping two spawns overlap.
  const results = [0, 1, 2, 3].map(() => claimBand(dir, "sid", 70, 0));
  assert.deepEqual(results, [true, false, false, false], "the first claim wins; the rest see EEXIST");
  assert.equal(existsSync(bandMarkerPath(dir, "sid", 70, 0)), true);
});

test("claimBand: different bands are independent claims", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-claim2-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(claimBand(dir, "sid", 70, 0), true);
  assert.equal(claimBand(dir, "sid", 70, 1), true, "band 1 is a separate claim from band 0");
  assert.equal(claimBand(dir, "sid", 70, 1), false, "but band 1 is still claim-once");
});

test("claimBand: a band's identity includes its threshold", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-claim3-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // "band 0" means 70-80% under a threshold of 70 and 80-90% under a threshold of 80 — different
  // bands, so different markers. This is about marker identity, NOT about what happens when a user
  // changes HANDOFF_THRESHOLD_PCT: the transition gate governs that, and it may never reach here.
  assert.equal(claimBand(dir, "sid", 70, 0), true);
  assert.equal(claimBand(dir, "sid", 80, 0), true, "a different threshold is a different band");
  assert.equal(claimBand(dir, "sid", 70, 0), false, "…and each is still claim-once");
});

test("claimBand: an unwritable data dir returns false rather than throwing", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-claim4-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The statusline must never die on a state-write failure.
  assert.equal(claimBand(path.join(dir, "does-not-exist"), "sid", 70, 0), false);
});

test("resetBands: clears this session's ladder across thresholds, leaves other sessions alone", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-reset-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  claimBand(dir, "mine", 70, 0);
  claimBand(dir, "mine", 80, 1);
  claimBand(dir, "other", 70, 0);

  resetBands(dir, "mine");

  assert.equal(existsSync(bandMarkerPath(dir, "mine", 70, 0)), false);
  assert.equal(existsSync(bandMarkerPath(dir, "mine", 80, 1)), false, "reset spans thresholds");
  assert.equal(existsSync(bandMarkerPath(dir, "other", 70, 0)), true, "another session is untouched");
  assert.equal(claimBand(dir, "mine", 70, 0), true, "after a reset, the band can be claimed again");
});

test("resetBands: a session id that PREFIXES another does not eat its markers", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-reset2-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  claimBand(dir, "a", 70, 0);
  claimBand(dir, "a-x", 70, 0); // "handoff-fired-a-x-t70-b0" starts with "handoff-fired-a-"

  resetBands(dir, "a");

  assert.equal(existsSync(bandMarkerPath(dir, "a", 70, 0)), false, "our own marker is cleared");
  assert.equal(
    existsSync(bandMarkerPath(dir, "a-x", 70, 0)), true,
    "a bare-prefix match would have deleted this — the reset must anchor on the full marker name",
  );
});

test("acquireInflightLock: acquires when free, refuses when a LIVE holder is present", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "l.lock");

  assert.equal(acquireInflightLock(lock, 2000), true, "a free lock is acquired");
  assert.equal(readFileSync(lock, "utf8"), String(process.pid));

  // A live holder (this process), fresh. A second acquire must lose — and must NOT overwrite the pid.
  assert.equal(acquireInflightLock(lock, 2000), false, "a held lock is not stolen");
  assert.equal(readFileSync(lock, "utf8"), String(process.pid), "the holder's lock is intact");
});

test("acquireInflightLock: refuses to displace a LIVE holder even past the lease", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-lock2-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "l.lock");
  writeFileSync(lock, String(process.pid)); // this process is alive
  const old = new Date(Date.now() - 30_000);
  utimesSync(lock, old, old); // and its lock is far past the 2s lease

  // There is NO statusLine timeout, so a slow invocation can outlive any lease we pick. Age alone
  // must never justify a break — this is the bug that produced double-fires in 0.5.1.
  assert.equal(acquireInflightLock(lock, 2000), false, "an old lock held by a LIVE process is not stale");
  assert.equal(readFileSync(lock, "utf8"), String(process.pid));
});

test("acquireInflightLock: breaks a lock that is BOTH past the lease AND held by a dead pid", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-lock3-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "l.lock");
  writeFileSync(lock, "2147483646"); // a pid that cannot exist
  const old = new Date(Date.now() - 30_000);
  utimesSync(lock, old, old);

  assert.equal(acquireInflightLock(lock, 2000), true, "a dead holder's stale lock must not freeze the bar forever");
  assert.equal(readFileSync(lock, "utf8"), String(process.pid), "we are the new holder");
});

test("acquireInflightLock: a FRESH empty lock is not treated as a dead holder", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-lock4-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "l.lock");
  writeFileSync(lock, ""); // create() has returned but write() has not landed yet

  // parseInt("") is NaN. Treating NaN as "dead" would steal the lock from a live process mid-write —
  // one of the four races that killed 0.5.1.
  assert.equal(acquireInflightLock(lock, 2000), false, "an unparseable pid is NOT proof the holder is dead");
  assert.equal(readFileSync(lock, "utf8"), "", "the mid-write holder's lock is untouched");
});

test("acquireInflightLock: an ANCIENT empty lock is broken — a crash must not freeze the bar forever", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-lock5-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "l.lock");
  writeFileSync(lock, ""); // a process died between create() and write()
  const ancient = new Date(Date.now() - 60_000);
  utimesSync(lock, ancient, ancient);

  // The complement of the test above, and the reason EMPTY_LOCK_GRACE_MS exists: if "unparseable"
  // meant "alive" forever, this lock would be immortal and every future invocation would replay a
  // stale render or "?" — the bar would freeze permanently. The create→write window is microseconds,
  // so a lock still empty after 10s is a corpse.
  assert.equal(acquireInflightLock(lock, 2000), true, "an ancient empty lock is breakable");
  assert.equal(readFileSync(lock, "utf8"), String(process.pid), "we are the new holder");
});
```

- [ ] **Step 2: Run them and verify they fail**

Run: `node --test plugins/handoff/tests/lib.test.mjs`
Expected: FAIL — none of `claimBand`, `bandMarkerPath`, `resetBands`, `acquireInflightLock` are
exported yet.

- [ ] **Step 3: Implement the helpers**

First fix the imports at the top of `lib.mjs`. The current list has **neither `statSync` nor
`writeFileSync`** — add every name the new code uses:

```js
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
```

Then append:

```js
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
```

And the predicate it depends on. Two hazards pull in opposite directions here, and the code has to
serve both:

- **An unparseable pid must not read as "dead".** `Number.parseInt("")` is `NaN` and `holderAlive(NaN)`
  is `false`, so a naive check would judge an empty, partially-written lock a *corpse* and steal it
  from a process that is very much alive. That is one of the four races that killed 0.5.1.
- **But an empty lock must not be immortal either.** A process that crashes between `create()` and
  `write()` leaves an empty file forever. If unparseable always means "alive", that lock is never
  breakable, and every future invocation replays a stale render or `?` — the bar freezes permanently.
  That is *worse* than the race above.

Both are satisfied by giving an unparseable lock its own, much longer grace period. The create→write
window is microseconds; a lock that has been empty for ten seconds is not a racer, it is a corpse.

```js
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
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `node --test plugins/handoff/tests/lib.test.mjs`
Expected: PASS — all nine new tests, plus every pre-existing `lib.mjs` test.

- [ ] **Step 5: Commit**

```bash
git add plugins/handoff/scripts/lib.mjs plugins/handoff/tests/lib.test.mjs
git commit -m "feat(handoff): atomic band-claim and lock-acquire primitives in lib.mjs

Both races that matter in the statusline are settled by one atomic filesystem op ({ flag: 'wx' }).
Inline in status-and-flag.mjs they could only be exercised by spawning children and hoping they
overlapped — a test that passes spuriously proves nothing. As lib.mjs exports, the EEXIST branch is
deterministically reachable.

claimBand() is an idempotency key, not a mutex: no lease, no liveness check, no pid-reuse hazard.
acquireInflightLock() is explicitly best-effort, and never breaks a lock on age alone — there is no
statusLine timeout, so a slow invocation can outlive any lease, and an unparseable pid is not proof
of death (that is what a lock looks like mid-write).

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Task 2: Make band-firing idempotent

**Files:**
- Modify: `plugins/handoff/scripts/status-and-flag.mjs:179-207` (the lastPct read → band → flag → write block)
- Test: `plugins/handoff/tests/status-and-flag.test.mjs`

**Interfaces:** consumes `claimBand`, `resetBands` from Task 1. Nothing new is produced.

**Background — read before writing code.**

The invariant is a **transition**, not a level: *fire when the session enters a band from below.*
`status-and-flag.mjs:199-204` gets that right today, and **two behaviors depend on it**:

1. **Moving within a band does not re-fire.** `status-and-flag.test.mjs:82` seeds `last-context-pct`
   at 76, invokes at 78%, asserts **no** flag. Band 0 → band 0 is not a transition.
2. **A `/compact` resets the ladder.** 90% (band 2 fired) → `/compact` drops to 40% → climbing back to
   85% **fires again**. A user who compacts and refills genuinely needs the nudge again.

So do **not** replace the gate with a level-keyed marker: a marker keyed on band *N* has no memory of
where the session came from, so it can express neither behavior.

What the gate cannot do is survive concurrency — it is a read-modify-write on `last-context-pct`, so
two overlapping invocations both read the stale `lastPct`, both compute `band > lastBand`, and **both
fire**. That double-nudge is the entire reason the 0.5.1 overlap lock exists.

**Keep the gate for the semantics; let `claimBand()` decide who acts on it.** Observable behavior is
unchanged in every sequential case; the concurrent double-nudge becomes impossible.

- [ ] **Step 1: Write the failing tests**

Append to `plugins/handoff/tests/status-and-flag.test.mjs`, reusing the existing
`run(stdinPayload, extraEnv)` helper and `t.after` cleanup. Merge new `node:fs` names into the
existing import.

Note on what these prove: the deterministic proof that exactly one racer fires lives in
`lib.test.mjs` (Task 1's `claimBand` tests). These are **integration** tests — they prove the script
is wired to the arbiter and that the two transition behaviors survive.

```js
test("a band already claimed does not re-fire, even after the nudge flag is consumed", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "handoff-claimed-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const sid = "claimed-sid";
  const env = { CLAUDE_PLUGIN_DATA: dataDir, HANDOFF_THRESHOLD_PCT: "70" };
  const flagFile = path.join(dataDir, `handoff-nudge-${sid}.flag`);
  // Simulate the winner of a race having already claimed band 0, while last-context-pct is still
  // stale (the loser's view). The gate passes; the claim must not.
  writeFileSync(path.join(dataDir, `last-context-pct-${sid}.txt`), "65");
  writeFileSync(path.join(dataDir, `handoff-fired-${sid}-t70-b0`), "");

  await run(JSON.stringify({ session_id: sid, context_window: { used_percentage: 75 } }), env);

  assert.equal(existsSync(flagFile), false, "the band was already claimed — the loser must not nudge");
});

test("a /compact drop below the threshold resets the ladder, so a later climb re-fires", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "handoff-compact-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const sid = "compact-sid";
  const env = { CLAUDE_PLUGIN_DATA: dataDir, HANDOFF_THRESHOLD_PCT: "70" };
  const flagFile = path.join(dataDir, `handoff-nudge-${sid}.flag`);
  const at = (pct) => run(JSON.stringify({ session_id: sid, context_window: { used_percentage: pct } }), env);

  await at(85); // enters band 1 — fires
  assert.equal(existsSync(flagFile), true, "the first climb fires");
  rmSync(flagFile); // check-handoff-flag.mjs consumes it on UserPromptSubmit

  await at(40); // /compact — the climb is over
  assert.deepEqual(
    readdirSync(dataDir).filter((f) => f.startsWith(`handoff-fired-${sid}-`)), [],
    "dropping below the threshold clears the ladder",
  );

  await at(85); // a FRESH entry into band 1
  assert.equal(existsSync(flagFile), true, "a post-compact climb must re-nudge; a permanent marker would suppress it forever");
});

test("moving WITHIN a band does not re-fire (the transition gate still governs)", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "handoff-within-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const sid = "within-sid";
  const env = { CLAUDE_PLUGIN_DATA: dataDir, HANDOFF_THRESHOLD_PCT: "70" };
  const flagFile = path.join(dataDir, `handoff-nudge-${sid}.flag`);

  await run(JSON.stringify({ session_id: sid, context_window: { used_percentage: 72 } }), env);
  assert.equal(existsSync(flagFile), true, "crossing into band 0 fires");
  rmSync(flagFile);

  await run(JSON.stringify({ session_id: sid, context_window: { used_percentage: 78 } }), env);
  assert.equal(existsSync(flagFile), false, "72% → 78% stays in band 0 — no re-fire");
});

test("climbing into a HIGHER band fires again", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "handoff-escalate-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const sid = "esc-sid";
  const env = { CLAUDE_PLUGIN_DATA: dataDir, HANDOFF_THRESHOLD_PCT: "70" };
  const flagFile = path.join(dataDir, `handoff-nudge-${sid}.flag`);

  await run(JSON.stringify({ session_id: sid, context_window: { used_percentage: 75 } }), env);
  rmSync(flagFile);
  await run(JSON.stringify({ session_id: sid, context_window: { used_percentage: 85 } }), env);

  assert.equal(existsSync(flagFile), true, "85% is band 1 — a new band");
  assert.deepEqual(
    readdirSync(dataDir).filter((f) => f.startsWith(`handoff-fired-${sid}-`)).sort(),
    [`handoff-fired-${sid}-t70-b0`, `handoff-fired-${sid}-t70-b1`],
  );
});

test("a failed nudge write exits 0 AND releases the claim, so the nudge is not lost forever", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "handoff-wfail-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const sid = "wfail-sid";
  const env = { CLAUDE_PLUGIN_DATA: dataDir, HANDOFF_THRESHOLD_PCT: "70" };
  const flagPath = path.join(dataDir, `handoff-nudge-${sid}.flag`);
  // A directory where the nudge flag should go: every write to it throws EISDIR.
  mkdirSync(flagPath);

  const { code } = await run(
    JSON.stringify({ session_id: sid, context_window: { used_percentage: 75 } }), env);

  assert.equal(code, 0, "a failed state write must never take the statusline down");
  // The claim means "a nudge was DELIVERED". Nothing was delivered, so the claim must be given back —
  // otherwise this band is burned for the rest of the session and the nudge is lost permanently.
  assert.equal(
    existsSync(bandMarkerPath(dataDir, sid, 70, 0)), false,
    "an undelivered nudge must not leave the band claimed",
  );

  // Prove the retry actually works: remove the obstruction, and the same band fires.
  rmSync(flagPath, { recursive: true });
  writeFileSync(path.join(dataDir, `last-context-pct-${sid}.txt`), "65"); // re-arm the transition gate
  await run(JSON.stringify({ session_id: sid, context_window: { used_percentage: 75 } }), env);
  assert.equal(existsSync(flagPath), true, "the band can still fire once the write can succeed");
});
```

- [ ] **Step 2: Run them and verify they fail for the right reason**

Run: `node --test plugins/handoff/tests/status-and-flag.test.mjs`

Expected: the marker-asserting tests and the write-failure test FAIL. The within-band and
higher-band tests should already **PASS** — they encode behavior the gate provides today and that
this task must not break. **If either of those two fails, stop: you have broken the gate.**

- [ ] **Step 3: Rewire the fire decision**

In `status-and-flag.mjs`, replace lines 193-207 (the band comment through the
`writeFileSync(lastPctFile, …)` call). **Keep the `lastPct` read block (lines 179-191) exactly as-is**
— it is still load-bearing.

```js
// Escalating nudges: fire on every 10%-point band ENTERED at/above the threshold. Bands are relative
// to the configured threshold, so a non-decile threshold (e.g. 75) still fires as soon as pct crosses
// it.
//
// The invariant is a TRANSITION, not a level: `band > lastBand` fires on entry from below. That is
// what keeps 72% → 78% silent, and what lets a post-/compact climb back to 85% nudge again instead of
// staying silent forever.
//
// But the gate is a read-modify-write on last-context-pct: two overlapping invocations both read the
// stale lastPct, both pass, and both fire. So the GATE decides whether a band is being entered, and
// claimBand() — an atomic exclusive create — decides WHO acts on it. Correctness therefore does not
// depend on the overlap guard at all.
//
// Do NOT "simplify" this to a claim-only check: a level-keyed marker has no memory of where the
// session came from, so it can express neither behavior above.
const band = currentPct >= threshold ? Math.floor((currentPct - threshold) / 10) : -1;
const lastBand = lastPct >= threshold ? Math.floor((lastPct - threshold) / 10) : -1;

if (band < 0) {
  // Below the threshold: the climb is over (a fresh session, or a /compact). Clear the ladder so a
  // later climb can re-fire. This also self-heals the resolveSessionId "unknown" fallback — a new
  // no-ID session starts low, so it clears the previous one's markers rather than inheriting
  // permanent suppression.
  resetBands(dataDir, sid);
} else if (band > lastBand && claimBand(dataDir, sid, threshold, band)) {
  try {
    writeFileSync(
      path.join(dataDir, `handoff-nudge-${sid}.flag`),
      `context at ${Math.trunc(currentPct)}% (threshold ${threshold}%)`,
    );
  } catch {
    // The claim is only meaningful as "a nudge was DELIVERED". If the flag write failed, nothing was
    // delivered — so give the claim back, or this band is burned for the rest of the session and the
    // nudge is lost permanently. A failed write must never take the bar down either (see Global
    // Constraints), so both the write and the release are swallowed.
    try {
      rmSync(bandMarkerPath(dataDir, sid, threshold, band), { force: true });
    } catch {
      // nothing left to do — the next band will still fire
    }
  }
}

// Update last percentage. Write it EARLY relative to the expensive render (see below): a slow
// invocation that writes stale state after a fresher one has already written is how a post-/compact
// reset gets clobbered.
try {
  writeFileSync(lastPctFile, String(currentPct));
} catch {
  // best-effort
}
```

Import `bandMarkerPath` alongside `claimBand` and `resetBands`, and add `rmSync` to the `node:fs`
import if it is not already there.

**Ordering matters here.** This whole block must run *before* the render work below it, not after.
`last-context-pct` is written by every invocation, and a slow one writing a stale value after a
fresher one has already written is exactly how a post-`/compact` reset gets undone (see "Accepted
residual races" #1). Doing the state write immediately after the pct is derived — rather than after
the bar is rendered — shrinks that window from "the length of a render" to "a few microseconds". It
does not close it, and the plan does not claim it does.

Import `claimBand` and `resetBands` from `./lib.mjs`, and add `mkdirSync` to the test file's
`node:fs` import (the write-failure test needs it).

**Do not touch `check-handoff-flag.mjs`.** It unlinks exactly `handoff-nudge-<sid>.flag`
(`check-handoff-flag.mjs:26,40`) and does not glob — confirm that is still true and leave it alone. If
it ever deleted a `handoff-fired-*` marker, the arbiter would be defeated.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `node --test plugins/handoff/tests/status-and-flag.test.mjs plugins/handoff/tests/check-handoff-flag.test.mjs plugins/handoff/tests/integration.test.mjs`
Expected: PASS — the new tests **and** every pre-existing threshold/band/wording test, especially
`status-and-flag.test.mjs:82`.

- [ ] **Step 5: Commit**

```bash
git add plugins/handoff/scripts/status-and-flag.mjs plugins/handoff/tests/status-and-flag.test.mjs
git commit -m "feat(handoff): make band firing idempotent under concurrency

The nudge invariant is a TRANSITION — fire on entering a band from below — which is why the
last-context-pct gate stays: it is what keeps 72%->78% silent and what lets a post-/compact climb
re-nudge. But that gate is a read-modify-write, so two overlapping statusline invocations both read
the stale lastPct, both pass, and both fire. That double-nudge is the entire reason the 0.5.1 overlap
lock exists.

Keep the gate for the semantics; let claimBand()'s atomic exclusive create decide who acts on it.
Correctness no longer depends on the overlap guard. Dropping below the threshold clears the ladder,
so a compact-then-refill still escalates.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Task 3: Cache the transcript derivation on mtime + size

**Files:**
- Modify: `plugins/handoff/scripts/lib.mjs` (add `cachedTranscriptUsage`)
- Modify: `plugins/handoff/scripts/status-and-flag.mjs:163-168` (the JSONL fallback call site)
- Test: `plugins/handoff/tests/lib.test.mjs`

**Interfaces:**
- Produces: `cachedTranscriptUsage(transcriptPath, dataDir, sid)` → the same
  `{ inputTokens, cacheCreationTokens, cacheReadTokens }` shape as
  `lastAssistantUsageFromTranscript`, or `null`.

**Background:** `lastAssistantUsageFromTranscript` does a full synchronous `readFileSync` of the
transcript and splits it in memory (`lib.mjs:126-161`). The transcript grows unboundedly and the
statusline runs on a ~300ms debounce — this is the slow path that lets invocations pile up
(ccusage#459: 34 concurrent processes; Claude Code's own #34092 is the same shape). Every surveyed
tool does the same full read; ccusage makes it affordable by **caching the parse keyed on transcript
mtime**.

Cache key: **the transcript path, plus its `mtimeMs` and `size`.** All three are needed:
- `size` alone misses a same-length rewrite; `mtimeMs` alone can miss a same-millisecond append on a
  coarse-granularity filesystem. Together they are the standard pair.
- **The path is needed because the cache filename is keyed on `sid`, and `resolveSessionId` falls
  back to the literal string `"unknown"`** (`lib.mjs:57`). Two different no-ID sessions with different
  transcripts share the `unknown` cache file; if their transcripts happen to match on mtime+size,
  one would be served the other's token counts.

**Scope this key honestly:** it is sound for an *append-only* file, which is what a Claude Code
transcript is. It would not detect a same-size in-place rewrite landing inside the filesystem's
timestamp granularity. Do not claim the key detects arbitrary in-place edits — it does not, and it
does not need to.

**Note the return shape:** `lastAssistantUsageFromTranscript` returns **camelCase**
`{ inputTokens, cacheCreationTokens, cacheReadTokens }` — *not* the snake_case field names it reads
out of the JSONL. The cache must round-trip that shape verbatim.

- [ ] **Step 1: Write the failing tests**

Append to `plugins/handoff/tests/lib.test.mjs`:

```js
const assistantLine = (n) => JSON.stringify({
  type: "assistant",
  message: { usage: { input_tokens: n, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
});

test("cachedTranscriptUsage: parses, caches to disk, re-parses when the transcript changes", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-tc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, "t.jsonl");
  writeFileSync(transcript, assistantLine(100) + "\n");

  const first = cachedTranscriptUsage(transcript, dir, "sid");
  assert.ok(first);
  assert.equal(first.inputTokens, 100);

  const cached = JSON.parse(readFileSync(path.join(dir, "transcript-usage-sid.json"), "utf8"));
  assert.equal(typeof cached.mtimeMs, "number");
  assert.equal(typeof cached.size, "number");
  assert.equal(cached.usage.inputTokens, 100, "the cache round-trips the camelCase shape");

  writeFileSync(transcript, assistantLine(100) + "\n" + assistantLine(250) + "\n");
  assert.equal(
    cachedTranscriptUsage(transcript, dir, "sid").inputTokens, 250,
    "a changed transcript is re-parsed, not served stale",
  );
});

test("cachedTranscriptUsage: an UNCHANGED transcript is served from the cache, not re-parsed", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-tc-hit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, "t.jsonl");
  writeFileSync(transcript, assistantLine(100) + "\n");
  const st = statSync(transcript);

  // Prime the cache with a value the transcript does NOT contain. If the implementation re-parses it
  // returns 100; if it honours the key it returns 999. This is the only portable way to prove a HIT
  // rather than a silent re-parse.
  writeFileSync(path.join(dir, "transcript-usage-sid.json"), JSON.stringify({
    transcriptPath: transcript, mtimeMs: st.mtimeMs, size: st.size,
    usage: { inputTokens: 999, cacheCreationTokens: 0, cacheReadTokens: 0 },
  }));

  assert.equal(cachedTranscriptUsage(transcript, dir, "sid").inputTokens, 999, "served from the cache");
});

test("cachedTranscriptUsage: a DIFFERENT transcript is never served another's cache", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-tc-x-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Two no-ID sessions both resolve to sid "unknown" and share one cache file. Give them different
  // transcripts with IDENTICAL size (same byte length) — mtime+size alone could collide.
  const a = path.join(dir, "a.jsonl");
  const b = path.join(dir, "b.jsonl");
  writeFileSync(a, assistantLine(111) + "\n");
  writeFileSync(b, assistantLine(222) + "\n");
  assert.equal(statSync(a).size, statSync(b).size, "same byte length — the collision this guards");

  assert.equal(cachedTranscriptUsage(a, dir, "unknown").inputTokens, 111);
  assert.equal(
    cachedTranscriptUsage(b, dir, "unknown").inputTokens, 222,
    "a different transcript must not be served the first one's usage",
  );
});

test("cachedTranscriptUsage: a corrupt cache file is ignored, not fatal", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-tc2-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, "t.jsonl");
  writeFileSync(transcript, assistantLine(7) + "\n");
  writeFileSync(path.join(dir, "transcript-usage-sid.json"), "{not json");

  assert.equal(cachedTranscriptUsage(transcript, dir, "sid").inputTokens, 7, "falls back to a fresh parse");
});

test("cachedTranscriptUsage: VALID JSON with a malformed usage shape re-parses", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-tc3-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, "t.jsonl");
  writeFileSync(transcript, assistantLine(42) + "\n");
  const st = statSync(transcript);
  // Parses fine, key matches — but usage has no fields. Returning it verbatim yields NaN downstream
  // and bails the bar to "?" while a perfectly good transcript sits on disk.
  writeFileSync(path.join(dir, "transcript-usage-sid.json"), JSON.stringify({
    transcriptPath: transcript, mtimeMs: st.mtimeMs, size: st.size, usage: {},
  }));

  const r = cachedTranscriptUsage(transcript, dir, "sid");
  assert.equal(r.inputTokens, 42, "a structurally-invalid cached usage falls back to a fresh parse");
  assert.equal(Number.isFinite(r.cacheReadTokens), true);
});

test("cachedTranscriptUsage: a missing transcript returns null without throwing", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-tc4-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(cachedTranscriptUsage(path.join(dir, "nope.jsonl"), dir, "sid"), null);
});

test("cachedTranscriptUsage: 'no assistant turn yet' is CACHED, not re-scanned every tick", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-tc5-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, "t.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "user", message: {} }) + "\n"); // no assistant turn

  assert.equal(cachedTranscriptUsage(transcript, dir, "sid"), null);

  // null is a valid, cacheable answer. Early in a session this state persists across many ticks, and
  // re-scanning the whole transcript each time is exactly the expensive path this cache exists to
  // remove — so the miss must be recorded, not just the hit.
  const c = JSON.parse(readFileSync(path.join(dir, "transcript-usage-sid.json"), "utf8"));
  assert.equal(c.usage, null, "the negative result is cached");
  assert.equal(c.transcriptPath, transcript);
  assert.equal(cachedTranscriptUsage(transcript, dir, "sid"), null, "and is served from the cache");
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `node --test plugins/handoff/tests/lib.test.mjs`
Expected: FAIL — `cachedTranscriptUsage` is not exported.

- [ ] **Step 3: Implement the cache**

Append to `lib.mjs`:

```js
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
```

- [ ] **Step 4: Use it at the call site**

In `status-and-flag.mjs:164`, swap `lastAssistantUsageFromTranscript(transcriptPath)` for
`cachedTranscriptUsage(transcriptPath, dataDir, sid)` and update the import. Keep the surrounding
precedence logic (stdin `current_usage` → JSONL fallback → bail to `?`) **exactly as-is** — this task
changes how *expensive* the fallback is, not when it runs.

- [ ] **Step 5: Run the tests**

Run: `node --test plugins/handoff/tests/lib.test.mjs plugins/handoff/tests/status-and-flag.test.mjs`
Expected: PASS, including the pre-existing JSONL-fallback tests.

- [ ] **Step 6: Commit**

```bash
git add plugins/handoff/scripts/lib.mjs plugins/handoff/scripts/status-and-flag.mjs \
        plugins/handoff/tests/lib.test.mjs
git commit -m "perf(handoff): cache the transcript parse on path + mtime + size

The JSONL fallback is a full synchronous read of an unboundedly-growing file, on a ~300ms debounce.
That is the slow path that lets statusline invocations pile up — ccusage#459 reported 34 concurrent
processes, 300% CPU, 3GB RAM from exactly this, and Claude Code's own #34092 is the same shape.
Caching the parse is the proven fix (ccusage does the same).

The transcript PATH is part of the key, not just mtime+size: the cache file is named by session id,
and resolveSessionId falls back to the literal 'unknown', so two no-ID sessions share one cache file
and must not be served each other's token counts.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Task 4: Demote the overlap guard to a performance guard

**Files:**
- Modify: `plugins/handoff/scripts/status-and-flag.mjs:91-123` (the guard) and its two release sites
  (`bail()` at :55, and the tail at :229)
- Test: `plugins/handoff/tests/status-and-flag.test.mjs`

**Interfaces:** consumes `acquireInflightLock` from Task 1.

**Background:** with Task 2, nothing correctness-critical depends on the guard — `claimBand` is atomic
on its own. What the guard is *actually* for is what ccusage built it for: **not piling up**. Keep it,
keep pid-liveness, and stop pretending it is a mutex.

The 0.5.1 release path is also wrong: `rmSync(heldLockPath, { force: true })` unconditionally deletes
whatever is at that path, including a *replacement's* lock. Check ownership first.

**Say what is true.** The guard never breaks a lock whose holder is alive, and never breaks one on age
alone. It does **not** guarantee no displacement ever: two invocations can both judge the same lock
stale and both break it, so one can delete the other's fresh lock. That is accepted — the cost is one
duplicate render. Do not write "never displaced" anywhere.

- [ ] **Step 1: Write the tests**

Append to `plugins/handoff/tests/status-and-flag.test.mjs`:

```js
test("overlap guard: a concurrent run replays the cached render instead of recomputing", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "handoff-guard-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const sid = "guard-sid";
  writeFileSync(path.join(dataDir, `last-render-${sid}.txt`), "CACHED-RENDER");
  // A LIVE holder (this test process), with a lock far past the lease. 0.5.1 would have stolen it on
  // age alone — and a slow transcript read really can outlive a 2s lease, because there is no
  // statusLine timeout.
  const lock = path.join(dataDir, `statusline-inflight-${sid}.lock`);
  writeFileSync(lock, String(process.pid));
  const old = new Date(Date.now() - 30_000);
  utimesSync(lock, old, old);

  const { code, stdout } = await run(
    JSON.stringify({ session_id: sid, context_window: { used_percentage: 75 } }),
    { CLAUDE_PLUGIN_DATA: dataDir },
  );

  assert.equal(code, 0);
  assert.equal(stdout, "CACHED-RENDER", "a concurrent run replays the last render");
  assert.equal(readFileSync(lock, "utf8"), String(process.pid), "a LIVE holder's lock survives");
});

test("overlap guard: a DEAD holder's stale lock is broken so the bar cannot freeze forever", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "handoff-guard2-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const sid = "dead-sid";
  const lock = path.join(dataDir, `statusline-inflight-${sid}.lock`);
  writeFileSync(lock, "2147483646"); // a pid that cannot exist
  const old = new Date(Date.now() - 30_000);
  utimesSync(lock, old, old);

  const { code, stdout } = await run(
    JSON.stringify({ session_id: sid, context_window: { used_percentage: 42 } }),
    { CLAUDE_PLUGIN_DATA: dataDir },
  );

  assert.equal(code, 0);
  assert.match(stdout, /42%/, "a dead holder's lock must not freeze the bar forever");
});

test("overlap guard: the lock is released on the normal path", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "handoff-rel-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const sid = "rel-sid";

  await run(JSON.stringify({ session_id: sid, context_window: { used_percentage: 42 } }),
    { CLAUDE_PLUGIN_DATA: dataDir });

  assert.equal(
    existsSync(path.join(dataDir, `statusline-inflight-${sid}.lock`)), false,
    "a completed run leaves no lock behind",
  );
});

test("overlap guard: a stale lock is broken, taken, and released — the bar recovers", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "handoff-own-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const sid = "own-sid";
  const lock = path.join(dataDir, `statusline-inflight-${sid}.lock`);
  writeFileSync(lock, "2147483646"); // dead holder
  const old = new Date(Date.now() - 30_000);
  utimesSync(lock, old, old);

  const { code, stdout } = await run(
    JSON.stringify({ session_id: sid, context_window: { used_percentage: 42 } }),
    { CLAUDE_PLUGIN_DATA: dataDir },
  );

  assert.equal(code, 0);
  assert.match(stdout, /42%/, "the run breaks the dead holder's lock and renders");
  assert.equal(existsSync(lock), false, "and releases its own lock on the way out");
});
```

- [ ] **Step 2: Run and verify the live-holder test fails**

Run: `node --test plugins/handoff/tests/status-and-flag.test.mjs`
Expected: FAIL on the live-holder test — 0.5.1 sees a 30s-old lock, calls it stale on age alone, and
steals it.

- [ ] **Step 3: Rewrite the guard**

Replace `status-and-flag.mjs:91-123`:

```js
// --- Overlap guard. ccusage#459 shows statusline invocations DO pile up in production (34 concurrent
// node processes, 300% CPU) despite the docs' cancel-and-replace claim, so a guard is warranted.
//
// This is a PERFORMANCE guard, not a mutex, and it does not need to be a correct one: the nudge is
// idempotent (claimBand), so a torn race costs one duplicate render, which is invisible — Claude Code
// displays one status line. Do not reintroduce lock ceremony here: four attempts at a "correct" lock
// each produced a new race, and none of them needed to exist.
const LOCK_STALE_MS = 2000;
const inflightLockFile = path.join(dataDir, `statusline-inflight-${sid}.lock`);
const renderCacheFile = path.join(dataDir, `last-render-${sid}.txt`);

if (!acquireInflightLock(inflightLockFile, LOCK_STALE_MS)) {
  // Someone else is in flight (or we lost a cold-start race). Replay rather than recompute.
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
heldLockPath = inflightLockFile;
```

Then make both release sites ownership-checked. In `bail()` (:55) and at the tail (:229), replace
`rmSync(heldLockPath, { force: true })` with a call to one shared helper defined near `bail`:

```js
/** Release the in-flight lock, but only if it is still ours — a replacement's lock is not ours to
 * delete. Not race-free, and it does not need to be: the nudge is idempotent, so the worst case is
 * one duplicate render. */
function releaseLock() {
  if (heldLockPath === null) return;
  try {
    if (readFileSync(heldLockPath, "utf8").trim() === String(process.pid)) {
      rmSync(heldLockPath, { force: true });
    }
  } catch {
    // already gone, or unreadable — nothing to do
  }
  heldLockPath = null;
}
```

Import `acquireInflightLock` from `./lib.mjs`.

- [ ] **Step 4: Run the tests**

Run: `node --test plugins/handoff/tests/status-and-flag.test.mjs plugins/handoff/tests/lib.test.mjs plugins/handoff/tests/integration.test.mjs`
Expected: PASS, including the pre-existing render/threshold tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/handoff/scripts/status-and-flag.mjs plugins/handoff/tests/status-and-flag.test.mjs
git commit -m "refactor(handoff): the overlap guard is a performance guard, not a mutex

Research (docs/plans/2026-07-14-statusline-architecture-research.md): statusline invocations really do
pile up (ccusage#459 — 34 concurrent processes) despite the docs' cancel-and-replace claim, so a guard
is warranted; but all three production statusline tools use best-effort markers with pid-liveness, not
locks. With band firing now idempotent, nothing correctness-critical rides on this guard, so it stops
pretending to be a mutex: a torn race costs one duplicate render.

Never breaks a lock on age alone (there is no statusLine timeout, so a slow invocation can outlive any
lease), and never deletes a lock it does not own. Two racing stale-breakers can still collide — that is
accepted and documented, not defended.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Task 5: Docs + version bump to 0.6.0

**Files:**
- Modify: `plugins/handoff/README.md` (the "What it does" #1 blurb, and the State-files table)
- Modify: `plugins/handoff/CLAUDE.md` (the `status-and-flag.mjs` line)
- Modify: `plugins/handoff/.claude-plugin/plugin.json` (→ `0.6.0`)
- Modify: `.claude-plugin/marketplace.json` (`handoff` entry → `0.6.0`)

- [ ] **Step 1: Bump both registries** to `0.6.0`. Minor, not patch: new on-disk state
  (`handoff-fired-<sid>-t<threshold>-b<N>`, `transcript-usage-<sid>.json`).

- [ ] **Step 2: Add the new state files to README.md's table**

| File | Location | Description |
|---|---|---|
| `handoff-fired-<sid>-t<thr>-b<N>` | `$CLAUDE_PLUGIN_DATA` | Per-band claim marker — the atomic arbiter that makes a nudge fire at most once per band, however many invocations race. Cleared when context drops below the threshold. |
| `transcript-usage-<sid>.json` | `$CLAUDE_PLUGIN_DATA` | Cached transcript parse, keyed on the transcript's path + mtime + size |

- [ ] **Step 2b: Fix the stale test command in `plugins/handoff/CLAUDE.md`**

`plugins/handoff/CLAUDE.md:54` still tells developers to run `node --test plugins/handoff/tests/` —
the exact bare-directory invocation this repo bans, because Node 24 regressed it (MODULE_NOT_FOUND,
and its `**` glob skips dot-directories). Replace that line with `bash scripts/run-node-tests.sh` for
the full suite, keeping the single-file `node --test <file>` example below it, which is fine.

- [ ] **Step 3: Document the architecture** in README.md and CLAUDE.md. State plainly:
  - Nudges are **idempotent per band** — an atomic exclusive-create marker, not a lock, is what
    guarantees one nudge per band. Dropping below the threshold resets the ladder, so a
    compact-then-refill escalates again.
  - The transcript parse is **cached on path + mtime + size**, so the expensive path runs only when
    the transcript actually changed.
  - The overlap guard is a **performance guard** (don't pile up; replay the cached render). It never
    breaks a lock on age alone or one whose holder is alive — but it is **explicitly not a mutex**,
    and correctness does not depend on it.
  - **No timeout claim anywhere.** statusLine is not a hook and has no documented timeout.

- [ ] **Step 4: Run the full suite**

Run: `bash scripts/run-node-tests.sh`
Expected: PASS, 0 fail — including `scripts/repo-consistency.test.mjs`'s plugin.json ↔
marketplace.json version match.

- [ ] **Step 5: Commit**

```bash
git add plugins/handoff/README.md plugins/handoff/CLAUDE.md \
        plugins/handoff/.claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "docs(handoff): statusline architecture, bump to 0.6.0

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Out of scope

- **B3 (handoff provenance/injection)** — a repo can still commit its own handoff file. Needs a trust
  boundary; tracked separately.
- **A malicious `session_id`** containing path separators would escape `$CLAUDE_PLUGIN_DATA`. This is
  pre-existing (`last-context-pct-${sid}.txt` has the same shape) and is not made worse here. Track it
  with B3 as part of the same trust-boundary question; do not fix it in this plan.
- Batch C (`deep-dive`).
- `refreshInterval` — Claude Code supports it (min 1s); we do not set it.
- Backfilling markers for sessions already in flight when 0.6.0 lands: such a session re-fires its
  current band once. Acceptable; do not build a migration.
