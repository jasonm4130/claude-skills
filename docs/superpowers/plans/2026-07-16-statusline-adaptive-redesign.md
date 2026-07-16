# Statusline Adaptive Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the handoff context bar from flickering and give it an adaptive, four-segment display (context bar, model, rate-limits, git) that stays calm by default.

**Architecture:** Flip the context reading to be transcript-primary (stable, once-per-turn) instead of reading the volatile per-request stdin frame; that single change also removes the spurious nudge re-fire. Add one decrease-based band-reset condition (trustworthy now that the source is monotonic-up). Then compose the display from small pure helpers (git shell-out, rate-limit selection, model color, width fitting) assembled into one colored line.

**Tech Stack:** Node.js 18+ ESM (`.mjs`), stdlib only, `node:child_process` `spawnSync` for git, `node --test` for tests.

**Source spec:** `docs/superpowers/specs/2026-07-16-statusline-adaptive-redesign-design.md` (codex-approved).

## Global Constraints

- **ESM only.** Every script is `.mjs`. No CommonJS, no `package.json`, no `require`.
- **Stdlib only.** Allowed imports: `node:fs`, `node:fs/promises`, `node:path`, `node:os`, `node:process`, `node:child_process`, `node:url`, `node:test`, `node:assert/strict`. No network, no third-party packages.
- **`// @ts-check` at the top of every file**, with JSDoc `@typedef` for stdin payload shapes.
- **Graceful degradation:** any segment whose source is absent, malformed, or times out is omitted — never `NaN%`, `undefined`, or an error, and **never takes the bar down**. A failed write must never fail the render.
- **Engine floor stays `>=2.1.110`** — do NOT raise it. `COLUMNS` (only populated from 2.1.153) is therefore best-effort; when unset, default the width budget to 120.
- **`HANDOFF_EFFECTIVE_MAX_TOKENS` behavior preserved.** When unset, keep the existing raw `used_percentage` path unchanged. The 400k denominator is unchanged.
- **Use `path.join`, never string concatenation, for paths. Use `os.tmpdir()`, never `/tmp`.**
- **Version bump 0.7.0 → 0.8.0** in BOTH `plugins/handoff/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` (the handoff entry) — `scripts/repo-consistency.test.mjs` enforces they are equal.
- **Token sum** is always `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` (output excluded).
- **Tunable named constants:** `RATE_LIMIT_SURFACE_PCT = 50`, `RESET_DROP_EPSILON_PCT = 1`, `GIT_TIMEOUT_MS = 250`, `BRANCH_MAX_CHARS = 24`, `IDENTITY_MAX_CHARS = 24`.
- Run tests with `node --test <file>` (repo convention).

---

### Task 1: Stability engine — transcript-primary source + decrease-based band reset

This is the core bug fix (addresses the user's "fills and empties wildly" complaint). Two pure helpers plus wiring in the source-selection and band-reset regions of `status-and-flag.mjs`.

**Files:**
- Modify: `plugins/handoff/scripts/lib.mjs` (add `pickContextTokens`, `shouldResetBands`)
- Modify: `plugins/handoff/scripts/status-and-flag.mjs:159-190` (source selection), `:221-247` (band reset)
- Test: `plugins/handoff/tests/lib.test.mjs`

**Interfaces:**
- Produces:
  - `pickContextTokens(transcriptUsage, currentUsage) → number | null` — `transcriptUsage` is `{inputTokens, cacheCreationTokens, cacheReadTokens} | null` (from `cachedTranscriptUsage`); `currentUsage` is stdin `context_window.current_usage` (`{input_tokens?, cache_creation_input_tokens?, cache_read_input_tokens?} | null`). Returns the transcript token sum when it is > 0, else the stdin sum when > 0, else `null`.
  - `shouldResetBands(currentPct, lastPct, threshold, dropEpsilon) → boolean` — true when `currentPct < threshold` OR `currentPct < lastPct - dropEpsilon`.
- Consumes: `cachedTranscriptUsage` (existing, `lib.mjs:206`), `resetBands`/`claimBand` (existing).

- [ ] **Step 1: Write the failing tests for `pickContextTokens`**

Append to `plugins/handoff/tests/lib.test.mjs` (imports: add `pickContextTokens, shouldResetBands` to the existing `from "../scripts/lib.mjs"` import).

```js
test("pickContextTokens: transcript is primary when its sum is positive", () => {
  const transcript = { inputTokens: 100, cacheCreationTokens: 20, cacheReadTokens: 30 };
  const current = { input_tokens: 999, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  assert.equal(pickContextTokens(transcript, current), 150);
});

test("pickContextTokens: falls back to stdin only when transcript is null", () => {
  const current = { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 2 };
  assert.equal(pickContextTokens(null, current), 17);
});

test("pickContextTokens: transcript sum of zero falls through to stdin", () => {
  const transcript = { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const current = { input_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  assert.equal(pickContextTokens(transcript, current), 8);
});

test("pickContextTokens: null when neither source is usable", () => {
  assert.equal(pickContextTokens(null, null), null);
  assert.equal(pickContextTokens(null, {}), null);
});
```

- [ ] **Step 2: Write the failing tests for `shouldResetBands`**

```js
test("shouldResetBands: resets below threshold", () => {
  assert.equal(shouldResetBands(65, 60, 70, 1), true);
});

test("shouldResetBands: resets on a real decrease while still above threshold", () => {
  // 85% -> 75% compaction: still above 70, but the reading dropped -> reset the ladder
  assert.equal(shouldResetBands(75, 85, 70, 1), true);
});

test("shouldResetBands: does NOT reset on monotonic growth", () => {
  assert.equal(shouldResetBands(76, 75, 70, 1), false);
});

test("shouldResetBands: epsilon absorbs sub-point wobble", () => {
  assert.equal(shouldResetBands(74.6, 75, 70, 1), false); // 0.4 drop < epsilon
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test plugins/handoff/tests/lib.test.mjs`
Expected: FAIL — `pickContextTokens is not defined` / `shouldResetBands is not defined`.

- [ ] **Step 4: Implement both helpers in `lib.mjs`**

Add near the other exported helpers in `plugins/handoff/scripts/lib.mjs`:

```js
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
```

- [ ] **Step 5: Wire transcript-primary source into `status-and-flag.mjs`**

Add `pickContextTokens, shouldResetBands` to the existing `import { ... } from "./lib.mjs"` block. Replace the `if (hasEffectiveMax) { ... }` body at `status-and-flag.mjs:162-185` (Step 1/Step 2/Step 3 comment block) with transcript-first selection. Introduce a `contextTokens` variable that survives for the render (Task 4 consumes it):

```js
/** @type {number | null} */
let contextTokens = null;

if (hasEffectiveMax) {
  const transcriptUsage = transcriptPath !== null ? cachedTranscriptUsage(transcriptPath, dataDir, sid) : null;
  const cu = cw && cw.current_usage != null ? cw.current_usage : null;
  contextTokens = pickContextTokens(transcriptUsage, cu);
  // Step 3: bail — do NOT fall through to raw used_percentage
  if (contextTokens === null) bail(locPrefix);
  currentPct = (contextTokens / effectiveMax) * 100;
} else if (typeof pctRaw === "number" && Number.isFinite(pctRaw)) {
  currentPct = pctRaw;
}
```

(Keep the `if (typeof currentPct !== "number" || !Number.isFinite(currentPct)) bail(locPrefix);` line that follows.)

- [ ] **Step 6: Wire the decrease-based reset into the band region**

At `status-and-flag.mjs:221-247`, add the epsilon constant near the threshold and change the reset condition from `band < 0` to `shouldResetBands(...)`. The band/lastBand computation and the `else if` nudge branch are unchanged:

```js
const RESET_DROP_EPSILON_PCT = 1;
const band = currentPct >= threshold ? Math.floor((currentPct - threshold) / 10) : -1;
const lastBand = lastPct >= threshold ? Math.floor((lastPct - threshold) / 10) : -1;

if (shouldResetBands(currentPct, lastPct, threshold, RESET_DROP_EPSILON_PCT)) {
  resetBands(dataDir, sid);
} else if (band > lastBand && claimBand(dataDir, sid, threshold, band)) {
  // ... existing flag-write body unchanged ...
}
```

- [ ] **Step 7: Run the full handoff suite to verify green**

Run: `node --test plugins/handoff/tests/lib.test.mjs plugins/handoff/tests/status-and-flag.test.mjs`
Expected: PASS — the new lib tests pass and the existing status-and-flag tests still pass (the reset change is a strict superset of `band < 0`, and transcript-primary is transparent to those fixtures).

- [ ] **Step 8: Commit**

```bash
git add plugins/handoff/scripts/lib.mjs plugins/handoff/scripts/status-and-flag.mjs plugins/handoff/tests/lib.test.mjs
git commit -m "feat(handoff): transcript-primary context source + decrease-based band reset"
```

---

### Task 2: Git segment helper (branch + dirty via spawnSync)

A single impure helper that shells to git for the always-visible branch and dirty count, degrading to `null` on any failure. Not wired into the render yet.

**Files:**
- Modify: `plugins/handoff/scripts/lib.mjs` (add `gitBranchDirty`)
- Test: `plugins/handoff/tests/lib.test.mjs`

**Interfaces:**
- Produces: `gitBranchDirty(cwd, timeoutMs?) → { label: string, dirty: number } | null` — `label` is the branch name, or `@<sha7>` when detached; `dirty` is the count of `git status --porcelain` lines. Returns `null` for a non-git directory, missing `git`, a timeout, or any error.
- Consumes: `spawnSync` (`node:child_process`, already imported in `lib.mjs` for `gitTracksFile`).

- [ ] **Step 1: Write the failing integration tests**

Append to `plugins/handoff/tests/lib.test.mjs` (add `gitBranchDirty` to the lib import; add `spawnSync` to the `node:child_process` import if not already present):

```js
function initRepo(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-git-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const g = (args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  writeFileSync(path.join(dir, "a.txt"), "1");
  g(["add", "a.txt"]);
  g(["commit", "-qm", "init"]);
  return { dir, g };
}

test("gitBranchDirty: clean repo on a branch reports label + dirty 0", (t) => {
  const { dir } = initRepo(t);
  assert.deepEqual(gitBranchDirty(dir), { label: "main", dirty: 0 });
});

test("gitBranchDirty: counts an untracked file as dirty", (t) => {
  const { dir } = initRepo(t);
  writeFileSync(path.join(dir, "b.txt"), "2");
  assert.deepEqual(gitBranchDirty(dir), { label: "main", dirty: 1 });
});

test("gitBranchDirty: detached HEAD reports @<sha>", (t) => {
  const { dir, g } = initRepo(t);
  const sha = g(["rev-parse", "--short", "HEAD"]).stdout.trim();
  g(["checkout", "-q", sha]);
  const r = gitBranchDirty(dir);
  assert.equal(r?.label, "@" + sha);
});

test("gitBranchDirty: null for a non-git directory", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-nongit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(gitBranchDirty(dir), null);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test plugins/handoff/tests/lib.test.mjs`
Expected: FAIL — `gitBranchDirty is not defined`.

- [ ] **Step 3: Implement `gitBranchDirty` in `lib.mjs`**

```js
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
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test plugins/handoff/tests/lib.test.mjs`
Expected: PASS (all four `gitBranchDirty` tests green).

- [ ] **Step 5: Commit**

```bash
git add plugins/handoff/scripts/lib.mjs plugins/handoff/tests/lib.test.mjs
git commit -m "feat(handoff): gitBranchDirty helper for the git status segment"
```

---

### Task 3: Segment formatters — model color, rate-limit selection, tokens suffix

Three small pure helpers for the display. No wiring yet.

**Files:**
- Modify: `plugins/handoff/scripts/lib.mjs` (add `modelColor`, `selectRateLimits`, `tokensSuffix`)
- Test: `plugins/handoff/tests/lib.test.mjs`

**Interfaces:**
- Produces:
  - `modelColor(name) → "amber" | "plain"` — `amber` iff the model name matches `/fable/i`.
  - `selectRateLimits(rateLimits, surfacePct) → Array<{label:string, pct:number, red:boolean}>` — `rateLimits` is stdin `rate_limits` (may be undefined/partial). Emits `5h` then `7d` windows whose `used_percentage` is a finite number `>= surfacePct`; each `pct` is truncated to an integer; `red` is `pct >= 80`. Absent or non-numeric windows are dropped.
  - `tokensSuffix(tokens) → string` — `"(NNNk)"`, tokens rounded to nearest thousand.

- [ ] **Step 1: Write the failing tests**

Append to `plugins/handoff/tests/lib.test.mjs` (add the three names to the lib import):

```js
test("modelColor: Fable is amber, others plain", () => {
  assert.equal(modelColor("Fable 5"), "amber");
  assert.equal(modelColor("claude-fable-5"), "amber");
  assert.equal(modelColor("Opus 4.8"), "plain");
  assert.equal(modelColor("Sonnet 5"), "plain");
});

test("selectRateLimits: drops absent/below-threshold, keeps surfaced, flags red", () => {
  assert.deepEqual(selectRateLimits(undefined, 50), []);
  assert.deepEqual(selectRateLimits({}, 50), []);
  assert.deepEqual(
    selectRateLimits({ five_hour: { used_percentage: 45 }, seven_day: { used_percentage: 84.6 } }, 50),
    [{ label: "7d", pct: 84, red: true }], // 5h below 50 dropped; 7d surfaced + red
  );
  assert.deepEqual(
    selectRateLimits({ five_hour: { used_percentage: 60 } }, 50),
    [{ label: "5h", pct: 60, red: false }], // 7d absent -> dropped, no NaN
  );
});

test("selectRateLimits: non-numeric used_percentage is dropped, never NaN", () => {
  assert.deepEqual(selectRateLimits({ five_hour: { used_percentage: "oops" }, seven_day: {} }, 50), []);
});

test("tokensSuffix: rounds to thousands", () => {
  assert.equal(tokensSuffix(287400), "(287k)");
  assert.equal(tokensSuffix(1000), "(1k)");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test plugins/handoff/tests/lib.test.mjs`
Expected: FAIL — the three helpers are not defined.

- [ ] **Step 3: Implement the three helpers in `lib.mjs`**

```js
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
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test plugins/handoff/tests/lib.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/handoff/scripts/lib.mjs plugins/handoff/tests/lib.test.mjs
git commit -m "feat(handoff): model-color, rate-limit-select, tokens-suffix formatters"
```

---

### Task 4: Adaptive render assembly + width fitting + wiring

Compose all segments into one colored line with adaptive surfacing and best-effort width fitting, then wire it into the success render path of `status-and-flag.mjs`. Width helpers are pure; assembly is pure and unit-tested; the wiring is covered by the spawn-based integration harness.

**Files:**
- Modify: `plugins/handoff/scripts/lib.mjs` (add `visibleWidth`, `truncateEnd`, `assembleStatusLine`)
- Modify: `plugins/handoff/scripts/status-and-flag.mjs:258-279` (render block) and the typedefs at `:28-55` (add `model`, `rate_limits`)
- Test: `plugins/handoff/tests/lib.test.mjs` (assembly units), `plugins/handoff/tests/status-and-flag.test.mjs` (wiring)

**Interfaces:**
- Consumes: `modelColor`, `selectRateLimits`, `tokensSuffix` (Task 3); `gitBranchDirty` (Task 2); `contextTokens`, `currentPct` (Task 1).
- Produces:
  - `visibleWidth(str) → number` — code-point length after stripping SGR escapes.
  - `truncateEnd(str, max) → string` — end-truncate to `max` code points with a `…` (best-effort; treats every code point as width 1).
  - `assembleStatusLine(d) → string` — the final colored line (no trailing newline). `d` = `{ identity, branch, dirty, pctInt, tokens, model, rateLimits, budget }` where `branch` is `string | null`, `tokens` is `number | null`, `rateLimits` is the `selectRateLimits` output, `budget` is the column budget.

- [ ] **Step 1: Write the failing tests for `visibleWidth` and `truncateEnd`**

Append to `plugins/handoff/tests/lib.test.mjs` (add `visibleWidth, truncateEnd, assembleStatusLine` to the lib import):

```js
test("visibleWidth: ignores ANSI SGR escapes", () => {
  assert.equal(visibleWidth("\x1b[0;31mabc\x1b[0m"), 3);
  assert.equal(visibleWidth("main"), 4);
});

test("truncateEnd: leaves short strings, ellipsizes long ones", () => {
  assert.equal(truncateEnd("main", 24), "main");
  assert.equal(truncateEnd("feature/very-long-branch-name", 10), "feature/v…");
  assert.equal(truncateEnd("x", 0), "");
});
```

- [ ] **Step 2: Write the failing tests for `assembleStatusLine`**

Assert on the ANSI-stripped line (`visibleWidth` is not enough — strip and compare text):

```js
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("assembleStatusLine: calm line — core + model, no conditional segments", () => {
  const line = strip(assembleStatusLine({
    identity: "claude-skills", branch: "main", dirty: 0,
    pctInt: 24, tokens: 96000, model: "Opus 4.8", rateLimits: [], budget: 120,
  }));
  assert.equal(line, "claude-skills ⎇main · ███░░░░░░░ 24% · Opus 4.8");
});

test("assembleStatusLine: busy line — dirty, red tokens, rate-limits with warn", () => {
  const line = strip(assembleStatusLine({
    identity: "claude-skills-t2", branch: "sdd/t2", dirty: 5,
    pctInt: 71, tokens: 287000, model: "Fable 5",
    rateLimits: [{ label: "5h", pct: 84, red: true }, { label: "7d", pct: 21, red: false }],
    budget: 120,
  }));
  assert.equal(line, "claude-skills-t2 ⎇sdd/t2 ±5 · ███████░░░ 71% (287k) · Fable 5 · ⚠ 5h 84% 7d 21%");
});

test("assembleStatusLine: tokens suffix only appears when red (>=70)", () => {
  const green = strip(assembleStatusLine({
    identity: "x", branch: null, dirty: 0, pctInt: 40, tokens: 160000,
    model: "Opus 4.8", rateLimits: [], budget: 120,
  }));
  assert.ok(!green.includes("("), "no token suffix below red");
});

test("assembleStatusLine: width drops rate-limits first, then dirty, then shortens model", () => {
  const d = {
    identity: "claude-skills-t2", branch: "sdd/t2", dirty: 5, pctInt: 71, tokens: 287000,
    model: "Fable 5", rateLimits: [{ label: "5h", pct: 84, red: true }], budget: 44,
  };
  const line = strip(assembleStatusLine(d));
  assert.ok(!line.includes("5h"), "rate-limits dropped first");
  assert.ok(visibleWidth(line) <= 44 || !line.includes("±5"), "dirty dropped next when still over");
});

test("assembleStatusLine: budget-aware clamp fits a narrow known width", () => {
  const line = assembleStatusLine({
    identity: "some-long-identity-name", branch: "a-fairly-long-branch", dirty: 3,
    pctInt: 55, tokens: null, model: "Sonnet 5",
    rateLimits: [{ label: "5h", pct: 90, red: true }], budget: 40,
  });
  assert.ok(visibleWidth(line) <= 40, `expected <=40 cols, got ${visibleWidth(line)}: ${strip(line)}`);
  assert.ok(strip(line).includes("55%"), "core is never dropped");
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test plugins/handoff/tests/lib.test.mjs`
Expected: FAIL — `visibleWidth` / `truncateEnd` / `assembleStatusLine` not defined.

- [ ] **Step 4: Implement the width helpers and assembly in `lib.mjs`**

```js
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

  /** identity cluster text for a given dirty/branch/identity choice */
  const idText = (identity, branch, showDirty) =>
    identity + (branch ? ` ⎇${branch}` : "") + (showDirty && d.dirty > 0 ? ` ±${d.dirty}` : "");
  const idColored = (t) => `${A_DIM}${t}${A_RESET}`;
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

  /** assemble a full candidate for a config; returns {width, colored} */
  const candidate = (showRl, showDirty, shortModel) => {
    const identityStr = idText(d.identity, d.branch, showDirty);
    const modelName = shortModel ? d.model.split(" ")[0] : d.model;
    const clusters = [
      { p: identityStr, c: idColored(identityStr) },
      { p: barText, c: barColored },
      { p: modelName, c: modelColored(modelName) },
    ];
    let plain = clusters.map((x) => x.p).join(" · ");
    let colored = clusters.map((x) => x.c).join(sep);
    const rl = showRl ? buildRl() : null;
    if (rl) {
      plain += ` · ${rl.plain}`;
      colored += `${sep}${rl.colored}`;
    }
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
  const shortModelName = d.model.split(" ")[0];
  const idStr = d.identity + (d.branch ? ` ⎇${d.branch}` : "");
  const overhead = [...barText].length + [...shortModelName].length + 6; // two " · " separators
  const idBudget = budget - overhead;
  if (idBudget < 2) {
    // No room for any identity: core + model only (may still soft-wrap below the floor).
    return `${barColored}${sep}${modelColored(shortModelName)}`;
  }
  const clamped = truncateEnd(idStr, Math.min(idBudget, IDENTITY_MAX_CHARS + BRANCH_MAX_CHARS + 2));
  return `${idColored(clamped)}${sep}${barColored}${sep}${modelColored(shortModelName)}`;
}
```

- [ ] **Step 5: Run the assembly unit tests to verify pass**

Run: `node --test plugins/handoff/tests/lib.test.mjs`
Expected: PASS (calm/busy/tokens/width/clamp all green). If the calm/busy string assertions differ by a stray separator or space, adjust the assembly spacing — the assertions are the contract.

- [ ] **Step 6: Wire the assembly into the render path of `status-and-flag.mjs`**

First extend the typedefs at `status-and-flag.mjs:28-55` — add a `Model` typedef and `rate_limits` to `StatusInput`:

```js
/**
 * @typedef {Object} Model
 * @property {string} [display_name]
 */
/**
 * @typedef {Object} RateWindow
 * @property {number} [used_percentage]
 */
/**
 * @typedef {Object} RateLimits
 * @property {RateWindow} [five_hour]
 * @property {RateWindow} [seven_day]
 */
```

Add `model` and `rate_limits` properties to the `StatusInput` typedef, and add `gitBranchDirty, selectRateLimits, assembleStatusLine` to the `import { ... } from "./lib.mjs"` block.

Then replace the render block at `status-and-flag.mjs:258-279` (from `// --- Render 10-char block bar ---` through the final `process.stdout.write(renderLine)`) with the adaptive assembly. Keep the render-cache write and `releaseLock()`:

```js
// --- Resolve display segments (success path only — never on the bail/replay path) ---
const identity = wsDir !== null ? path.basename(wsDir) : "";
// Fast path: stdin worktree.branch when present; else shell out.
let branch = wtBranch;
let dirty = 0;
if (wsDir !== null) {
  const git = gitBranchDirty(wsDir);
  if (git !== null) {
    if (branch === null) branch = git.label;
    dirty = git.dirty;
  }
}
const RATE_LIMIT_SURFACE_PCT = 50;
const rateLimits = selectRateLimits(parsed && parsed.rate_limits, RATE_LIMIT_SURFACE_PCT);
const modelName =
  parsed && parsed.model && typeof parsed.model.display_name === "string" && parsed.model.display_name.length > 0
    ? parsed.model.display_name
    : "";
const budget = Number.parseInt(process.env.COLUMNS ?? "", 10);

const renderLine =
  assembleStatusLine({
    identity,
    branch,
    dirty,
    pctInt: Math.trunc(currentPct),
    tokens: contextTokens,
    model: modelName,
    rateLimits,
    budget: Number.isFinite(budget) && budget > 0 ? budget : 120,
  }) + "\n";

try {
  writeFileSync(renderCacheFile, renderLine);
} catch {
  // cache is an optimization; replay falls back to "?" without it
}
releaseLock();
process.stdout.write(renderLine);
```

Note: the old `locParts`/`locPrefix` (`:89-105`) is still used for the `bail(locPrefix)` calls — leave it in place. The empty-identity guard in `assembleStatusLine` handles a missing `wsDir`.

- [ ] **Step 7: Update the existing render-format assertions in `status-and-flag.test.mjs`**

The redesign changes the success line from `[${bar}] ${pctInt}%` to `<identity> ⎇<branch> · <bar> <pct>% · <model>` (no brackets). Find assertions in `plugins/handoff/tests/status-and-flag.test.mjs` that check the old bracketed format and update them to assert on the ANSI-stripped new format (or relax them to check the bar/`pct%` substring). Nudge/flag/exit-code assertions are unaffected. Add one wiring test that pipes a payload with `model` + `rate_limits` and asserts the stripped stdout contains the model name and, when a window is ≥50, the `NN%` window.

```js
test("adaptive render: model name and surfaced rate-limit appear", async (t) => {
  const dir = mkTmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, "t.jsonl");
  writeFileSync(transcript, JSON.stringify({
    type: "assistant", isSidechain: false,
    message: { usage: { input_tokens: 100000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  }));
  const payload = JSON.stringify({
    session_id: "adaptive", transcript_path: transcript,
    workspace: { current_dir: dir },
    context_window: {},
    model: { display_name: "Opus 4.8" },
    rate_limits: { five_hour: { used_percentage: 84 }, seven_day: { used_percentage: 21 } },
  });
  const { stdout } = await run(payload, {
    CLAUDE_PLUGIN_DATA: dir, HANDOFF_EFFECTIVE_MAX_TOKENS: "400000",
  });
  const plain = stdout.replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(plain.includes("Opus 4.8"), `model missing: ${plain}`);
  assert.ok(plain.includes("5h 84%"), `surfaced rate-limit missing: ${plain}`);
});
```

(Confirm the data-dir env var the tests use for `resolveDataDir` — the existing tests write state files directly into the temp dir passed as `workspace.current_dir`/`CLAUDE_PLUGIN_DATA`; match whichever the existing `run(...)` tests use.)

- [ ] **Step 8: Run the full handoff suite**

Run: `node --test plugins/handoff/tests/lib.test.mjs plugins/handoff/tests/status-and-flag.test.mjs`
Expected: PASS — assembly units, wiring test, and updated existing assertions all green.

- [ ] **Step 9: Manual smoke test**

Run:
```bash
printf '%s' '{"session_id":"smoke","context_window":{"used_percentage":24},"workspace":{"current_dir":"'"$PWD"'"},"model":{"display_name":"Opus 4.8"}}' | node plugins/handoff/scripts/status-and-flag.mjs
```
Expected: a single line resembling `claude-skills ⎇<branch> · ███░░░░░░░ 24% · Opus 4.8` (branch/dirty reflect the real repo; colors present).

- [ ] **Step 10: Commit**

```bash
git add plugins/handoff/scripts/lib.mjs plugins/handoff/scripts/status-and-flag.mjs plugins/handoff/tests/lib.test.mjs plugins/handoff/tests/status-and-flag.test.mjs
git commit -m "feat(handoff): adaptive status-line render with width fitting"
```

---

### Task 5: Version bump 0.8.0 + docs

**Files:**
- Modify: `plugins/handoff/.claude-plugin/plugin.json` (`version`)
- Modify: `.claude-plugin/marketplace.json` (handoff entry `version`)
- Modify: `plugins/handoff/README.md`, `plugins/handoff/CLAUDE.md` (document the new segments + env note)
- Test: `scripts/repo-consistency.test.mjs` (already asserts the two versions match — no new test, just must stay green)

**Interfaces:** none (release + docs).

- [ ] **Step 1: Bump `plugin.json`**

In `plugins/handoff/.claude-plugin/plugin.json`, change `"version": "0.7.0"` → `"version": "0.8.0"`.

- [ ] **Step 2: Bump the marketplace entry**

In `.claude-plugin/marketplace.json`, the handoff entry (`"name": "handoff"`), change `"version": "0.7.0"` → `"version": "0.8.0"`.

- [ ] **Step 3: Run the consistency + full plugin suite to verify green**

Run: `node --test scripts/repo-consistency.test.mjs plugins/handoff/tests/lib.test.mjs plugins/handoff/tests/status-and-flag.test.mjs`
Expected: PASS — `marketplace version matches each plugin.json version` green at 0.8.0.

- [ ] **Step 4: Document the new display in README + CLAUDE.md**

In `plugins/handoff/README.md` and `plugins/handoff/CLAUDE.md`, update the statusLine description to note: transcript-primary context reading (stable), the four adaptive segments (context bar, model, rate-limits, git branch/dirty), calm-by-default surfacing, `COLUMNS`-aware best-effort width, and that git status is a `spawnSync` shell-out that degrades to nothing on failure. Keep edits surgical — match the existing doc voice.

- [ ] **Step 5: Run the whole handoff test set once more**

Run: `node --test $(find plugins/handoff/tests -name '*.test.mjs') scripts/repo-consistency.test.mjs`
Expected: PASS (all green).

- [ ] **Step 6: Commit**

```bash
git add plugins/handoff/.claude-plugin/plugin.json .claude-plugin/marketplace.json plugins/handoff/README.md plugins/handoff/CLAUDE.md
git commit -m "chore(handoff): release 0.8.0 — adaptive statusline + stability fix"
```

---

## Self-Review

**Spec coverage:**
- Stability: transcript-primary (§Design 1) → Task 1. Decrease-based reset / no `compact_boundary` (§Design 2) → Task 1. Denominator unchanged (§Design 3) → preserved in Task 1 (legacy `used_percentage` path untouched, `contextTokens` only set under `hasEffectiveMax`).
- Adaptive core `<identity> ⎇<branch> · <bar> <pct>% · <model>` → Task 4 (calm test asserts it verbatim).
- Conditional dirty / rate-limits / tokens-when-red → Task 4 (busy + green tests).
- Git source/failure contract → Task 2 (helper) + Task 4 (fast-path/wiring).
- Rate-limit absence handling → Task 3 (`selectRateLimits`).
- Colors (bar thresholds, Fable amber, rate-limit red) → Task 4 assembly + Task 3 `modelColor`.
- Width best-effort + final budget-aware clamp + core floor → Task 4.
- Tunable constants → Global Constraints + used in Tasks 1/2/3/4.
- Version bump + docs → Task 5.

**Placeholder scan:** none — every code step carries complete code; Task 4 Step 7 flags the one place existing assertions must be updated with a concrete replacement test.

**Type consistency:** `pickContextTokens`/`shouldResetBands` (Task 1) → used in Task 1 wiring. `gitBranchDirty` returns `{label, dirty}` (Task 2) → consumed in Task 4 as `git.label`/`git.dirty`. `selectRateLimits` output shape `{label,pct,red}` (Task 3) → consumed by `assembleStatusLine.rateLimits` (Task 4) and its tests. `modelColor`/`tokensSuffix` (Task 3) → called inside `assembleStatusLine` (Task 4). `contextTokens` (Task 1) → passed as `tokens` to `assembleStatusLine` (Task 4). Names are consistent across tasks.
