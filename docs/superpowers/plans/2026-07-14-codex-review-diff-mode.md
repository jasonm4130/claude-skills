# codex-review v0.2 — Diff Mode Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `codex-review` review a **code diff**, not just a plan/design artifact — the first
escalation unlocked by the decision gate.

**Why now.** The gate (≥1 confirmed unique finding per ~5 auto reviews by 2026-07-28) passed at
**15 unique findings across 2 eligible chains — 37.5 per 5**, two weeks early. But read the evidence
precisely: *every P1 Codex has found was in a plan, not in code.* Plan review is proven; **code review
by Codex is an untested claim.** This plan builds the smallest thing that tests it, and the skill's
docs must say so rather than implying diff mode is as proven as plan mode.

**Architecture.** Codex already runs read-only-sandboxed with `cwd` at the repo root, so it can run
`git diff` itself. Diff mode therefore materializes **no file**:

- The chain machinery keys on `(repoKey, artifact, contentHash)`, and it never cared that an artifact
  was a *file* — only that it was a **stable identity** paired with a **per-round content hash**.

**Get this distinction right or the whole protocol breaks.** A chain spans up to 3 review rounds, and
between rounds *the code changes* — that is the entire point. So:

| | stable across rounds (the chain's identity) | changes each round |
|---|---|---|
| plan mode | the file path, `docs/plans/x.md` | hash of the file's bytes |
| diff mode | the **symbolic** range, `diff:main...HEAD` | hash of the diff text |

`runRound` validates a resumed chain with `st.open.artifact !== relPath` — an **exact** match. So if
the artifact were the SHA-pinned range (`diff:abc..def`), the first fix commit would change `<head>`,
the artifact would no longer match, and **`--resume` would be rejected before Codex ever ran.** The
3-round protocol could not happen. The artifact must therefore be the symbolic range.

**Therefore the range must be one that stays meaningful as commits land.** This is a real usage
constraint, not a detail — document it and test it:

- ✅ `main...HEAD`, `origin/main...HEAD`, `<immutable-base-sha>...HEAD` — a **fixed base against a
  moving tip**. Still names "the changes on this branch" after every fix commit. **This is the
  convention diff mode is designed around.**
- ❌ `HEAD~1..HEAD` — means something *different* after each commit. Usable for a one-shot review, but
  a chain opened on it cannot be resumed, because round 2's range is a different string and therefore
  a different artifact.

**Immutable SHAs still matter — just not as the chain key.** Within a single round the range is
resolved **once** to `<base>..<head>` commit SHAs, and *that* is what we hash, record in the round's
log line, and tell Codex to render. So the diff we hashed is the diff it reads, even if `HEAD` moves
mid-round.

**Be precise about the limit of that guarantee.** It covers the *diff*. It does **not** cover the
surrounding files the reviewer reads for context — those are working-tree reads, deliberately, because
that is what a reviewer needs to judge a change. Do not claim the reviewer sees a frozen snapshot of
the repo; claim only that the rendered diff matches the recorded hash.

`reserveChain` and `stats` need no changes. **`appendNote` does** — its lifecycle check hard-codes
`mode: "review"` / `mode: "audit"` and would reject every diff chain (Task 2).

**Tech Stack:** Node 18+ ESM, stdlib only, `// @ts-check`. Tests: `node --test`.

## Global Constraints

- Plugin version becomes `0.2.0` in BOTH `plugins/codex-review/.claude-plugin/plugin.json` AND the
  `codex-review` entry in `.claude-plugin/marketplace.json` (repo-consistency test enforces the match).
- **ESM only, stdlib only**, `// @ts-check`. No new dependencies.
- **The test file is `plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs`.**
  It sits beside the script. There is no `plugins/codex-review/tests/` directory — do not create one.
- **Never `--output-schema`.** The verdict-line protocol is the contract.
- **Codex exit codes are never trusted** — success requires a clean terminal event AND a final message.
- **Never feed the reviewer the implementer's self-assessment**, the plan, or the change's intent.
  Framing degraded findings 3–4× in testing. The diff stands on its own.
- Run the full suite with `bash scripts/run-node-tests.sh`, never `node --test <dir>`.
- Branch `feat/codex-review-diff-mode`. Every commit message ends with:
  `Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw`

---

## Task 1: Safe range resolution and diff extraction

**Files:**
- Modify: `plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs`
- Test: `plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs`

**Interfaces — produced, consumed by Task 2:**
- `repoRootOfDir(dir)` → `string`
- `isSafeGitRange(range)` → `boolean`
- `parseMaxLines(raw)` → `number` (throws on junk)
- `resolveDiff(repoRoot, range, limits)` → `{ text, pinnedRange, base, head, lines, bytes, files }`

**Background — four separate hazards, each of which a naive implementation walks into.**

1. **`resolveRepoRoot` cannot be reused here.** It calls `dirname()` on its argument first
   (`codex-review.mjs`, `resolveRepoRoot`), because it is designed for a *file* path. Passing
   `process.cwd()` would resolve the repo of the **parent directory** — in this checkout, `~/Work/Git`
   rather than `~/Work/Git/claude-skills`. Every git command would then run against the wrong repo.
   Add a separate directory-taking helper; do not "fix" `resolveRepoRoot`, whose file semantics its
   existing callers depend on.

2. **A leading `-` is a flag, not a ref.** We spawn git with an argv array, so shell metacharacters
   cannot inject — but argv is not safety by itself. `git diff --output=/tmp/pwned` **writes a file**,
   inside a tool whose entire safety story is a read-only sandbox. Reject any range starting with `-`,
   and pass `--` as an option terminator anyway.

3. **`git diff` can execute code.** Git honors `textconv` and external-diff drivers, which run
   configured programs. That is code execution on the *host*, outside Codex's read-only sandbox. Pass
   **`--no-textconv --no-ext-diff`** on every diff invocation.

4. **The size guard is easy to write wrong.** `Number("NaN")` is `NaN`, and **`NaN <= 0` is `false`** —
   so the obvious "reject non-positive" check *lets `NaN` through* and silently disables the limit.
   `Infinity` passes too. Require a finite positive **integer**. And a line count alone does not bound
   context: a single-line multi-megabyte diff (a minified bundle) has 1 line. Cap **bytes** as well.

5. **Some changes are invisible in a diff, and silence looks like a pass.** `git diff` emits only
   `Binary files a/x and b/x differ` for a binary file — nonempty text, within every limit, and
   completely unreviewable. Worse, **`.gitattributes` can mark a *text* file `-diff`**, so a repo can
   hide real source code from the reviewer while the diff still looks healthy. Detect undiffable paths
   with `git diff --numstat` (they show as `-\t-\t<path>`), and **name them explicitly in the prompt as
   NOT SHOWN**. Never let a file vanish silently. If *every* changed file is undiffable, refuse.

An oversized, empty, or wholly-unreviewable diff is **refused, never truncated** — a review that
reports `VERDICT: APPROVED` because it saw nothing is worse than no review at all.

- [ ] **Step 1: Write the failing tests**

Append to `plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs`. Merge new
names into the existing import from `./codex-review.mjs`, and add `execFileSync`, `mkdtempSync`,
`writeFileSync`, `rmSync`, `os`, `path` to the existing `node:` imports as needed.

```js
/** A throwaway git repo with two commits on main. Returns its root. */
function fixtureRepo(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-diff-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: ["ignore", "pipe", "ignore"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
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
  assert.equal(repoRootOfDir(repo), repo);
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
  writeFileSync(path.join(repo, "blob.bin"), " binary ");
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
```

- [ ] **Step 2: Run them and verify they fail**

Run: `node --test plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs`
Expected: FAIL — none of the four helpers are exported.

- [ ] **Step 3: Implement**

Add to `codex-review.mjs`, near the other exported pure helpers (above `runRound`):

```js
/**
 * The repo root containing a DIRECTORY.
 *
 * resolveRepoRoot() takes a FILE path and dirname()s it first, so reusing it here would resolve the
 * PARENT directory's repo — silently running every git command in the wrong place. Its file semantics
 * have existing callers; leave it alone and use this for directories.
 *
 * @param {string} dir
 * @returns {string}
 */
export function repoRootOfDir(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return dir;
  }
}

/**
 * Is this string safe to hand to `git diff` as a range?
 *
 * We spawn git with an argv array, so shell metacharacters cannot inject. But argv is not safety by
 * itself: git parses a leading `-` as a FLAG, and `git diff --output=/tmp/x` WRITES A FILE — inside a
 * tool whose whole safety story is a read-only sandbox.
 *
 * An explicit `..`/`...` range is REQUIRED. A bare ref means "diff the working tree against it", which
 * folds uncommitted changes into the review and makes it unreproducible from the chain record.
 *
 * @param {unknown} range
 * @returns {boolean}
 */
export function isSafeGitRange(range) {
  if (typeof range !== "string" || range.length === 0 || range.length > 200) return false;
  if (range.startsWith("-")) return false; // git would read it as a flag
  const REF = "[A-Za-z0-9][A-Za-z0-9._/~^-]*";
  return new RegExp(`^${REF}\\.{2,3}${REF}$`).test(range);
}

/**
 * Coerce a --max-lines value. Throws on anything that is not a finite positive integer.
 *
 * Written carefully on purpose: `Number("NaN")` is `NaN`, and **`NaN <= 0` is `false`** — so the
 * obvious "reject non-positive" check lets NaN straight through and silently disables the cap.
 * `Infinity` slips past it too.
 *
 * @param {unknown} raw
 * @returns {number}
 */
export function parseMaxLines(raw) {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw err("BAD_MAX_LINES", `--max-lines must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

const MAX_DIFF_BYTES = 400_000;

/**
 * Resolve a git range to its diff, pinned to immutable commit SHAs.
 *
 * Pinning is not a nicety: we hash the diff for the chain record, then tell Codex to run `git diff`
 * itself. If we handed it a symbolic range, a HEAD that moved in between would make the reviewer read
 * different content than the chain recorded — the audit trail would be a lie.
 *
 * Throws a tagged error rather than returning junk: an empty or truncated review that reports
 * VERDICT: APPROVED is worse than no review at all.
 *
 * @param {string} repoRoot
 * @param {string} range
 * @param {{maxLines: number, maxBytes: number}} limits
 * @returns {{text: string, pinnedRange: string, base: string, head: string, lines: number,
 *            bytes: number, files: string[], undiffable: string[]}}
 */
export function resolveDiff(repoRoot, range, limits) {
  if (!isSafeGitRange(range)) {
    throw err("BAD_RANGE", `unsafe or malformed git range: ${JSON.stringify(range)}`);
  }

  // core.quotePath=false: without it git C-quotes any path with a space or non-ASCII character
  // (`"src/\303\251.mjs"`), and we would name a mangled path in the prompt.
  /** @param {string[]} args */
  const git = (args) =>
    execFileSync("git", ["-C", repoRoot, "-c", "core.quotePath=false", ...args], {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });

  const threeDot = range.includes("...");
  const [left, right] = range.split(threeDot ? "..." : "..");

  let base, head;
  try {
    head = git(["rev-parse", "--verify", `${right}^{commit}`]).trim();
    base = threeDot
      ? git(["merge-base", left, right]).trim()          // A...B = changes on B since it left A
      : git(["rev-parse", "--verify", `${left}^{commit}`]).trim();
  } catch (e) {
    throw err("BAD_RANGE", `git could not resolve ${JSON.stringify(range)}: ${String(e.message).split("\n")[0]}`);
  }

  const pinnedRange = `${base}..${head}`;
  // --no-textconv / --no-ext-diff: git's textconv and external-diff drivers EXECUTE configured
  // programs — host-side code execution, outside Codex's read-only sandbox. These flags must appear
  // on EVERY diff invocation, including the one we tell Codex to run (see DIFF_CMD in Task 2).
  const NO_EXEC = ["--no-textconv", "--no-ext-diff"];

  let text, numstat;
  try {
    text = git(["diff", ...NO_EXEC, pinnedRange, "--"]);
    numstat = git(["diff", ...NO_EXEC, "--numstat", pinnedRange, "--"]);
  } catch (e) {
    throw err("BAD_RANGE", `git diff failed for ${pinnedRange}: ${String(e.message).split("\n")[0]}`);
  }

  // numstat prints "added\tdeleted\tpath", with "-\t-" for anything git will not diff: binaries, and
  // — the nasty one — any file a .gitattributes marks `-diff`. Such a file is INVISIBLE in the diff
  // text while still looking like a healthy change. A repo could hide real source from the reviewer.
  /** @type {string[]} */ const files = [];
  /** @type {string[]} */ const undiffable = [];
  for (const row of numstat.split("\n")) {
    if (!row.trim()) continue;
    const [add, del, ...rest] = row.split("\t");
    const p = rest.join("\t").trim();
    if (!p) continue;
    (add === "-" && del === "-" ? undiffable : files).push(p);
  }

  if (files.length === 0) {
    throw err(
      "EMPTY_DIFF",
      undiffable.length > 0
        ? `range ${range} (${pinnedRange}) changes only files git will not diff (${undiffable.join(", ")}) — nothing reviewable`
        : `range ${range} (${pinnedRange}) is empty — nothing to review`,
    );
  }
  if (text.trim().length === 0) {
    throw err("EMPTY_DIFF", `range ${range} (${pinnedRange}) produced no diff text — nothing to review`);
  }

  const lines = text.split("\n").length;
  const bytes = Buffer.byteLength(text, "utf8");
  // Lines alone do not bound context: a minified bundle is one line and many megabytes.
  if (lines > limits.maxLines || bytes > limits.maxBytes) {
    throw err(
      "DIFF_TOO_LARGE",
      `diff is ${lines} lines / ${bytes} bytes (limits ${limits.maxLines} / ${limits.maxBytes}) across ` +
        `${files.length} files — narrow the range or raise --max-lines. Refusing rather than ` +
        `truncating: a truncated review that returns APPROVED is worse than no review.`,
    );
  }
  return { text, pinnedRange, base, head, lines, bytes, files, undiffable };
}
```

`err(code, message)` is the existing tagged-error helper (used by `reserveChain`) — reuse it. Ensure
`execFileSync` and `existsSync` are imported.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `node --test plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs`
Expected: PASS — all new tests plus every pre-existing one.

- [ ] **Step 5: Commit**

```bash
git add plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs \
        plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs
git commit -m "feat(codex-review): safe, SHA-pinned git-range resolution

Four hazards, each of which the naive version walks into:

- resolveRepoRoot() dirname()s its argument (it takes a FILE path), so reusing it for a directory
  resolves the PARENT's repo. Added repoRootOfDir().
- git parses a leading '-' as a FLAG: 'git diff --output=/tmp/x' WRITES A FILE, inside a tool whose
  safety story is a read-only sandbox. An argv array stops shell injection, not flag injection.
- git textconv / external-diff drivers EXECUTE configured programs — host-side code execution outside
  the sandbox. --no-textconv --no-ext-diff.
- 'NaN <= 0' is FALSE, so the obvious non-positive check lets NaN through and disables the size cap.
  Require a finite positive integer, and cap bytes too: a minified bundle is one line and megabytes.

Ranges are pinned to immutable SHAs: we hash the diff, then tell Codex to re-run git diff. A symbolic
range would let HEAD move in between, and the reviewer would read different content than the chain
recorded.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Task 2: The `diff` and `diff-audit` modes

**Files:**
- Modify: `plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs`
- Test: `plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs`

**Interfaces:**
- Produces: `buildDiffPrompt(pinnedRange, files)`, `buildDiffResumePrompt(pinnedRange)`,
  `buildDiffAuditPrompt(pinnedRange)`, `isAuditMode(mode)`, `isDiffMode(mode)`
- New CLI: `codex-review.mjs diff <range> [--auto|--force] [--max-lines N]` and
  `codex-review.mjs diff-audit <range> --chain <id>`

**Background — why a separate `diff-audit` mode.** The protocol is *3 review rounds + 1 fresh-session
audit*, and a diff chain needs its audit too. But `audit` today validates its positional argument as a
regular file (`statSync(...).isFile()`), so `audit main...HEAD --chain X` dies before it ever reaches
the chain logic. And the existing `buildAuditPrompt` / `buildResumePrompt` describe *"the design/plan
document at `<path>`"* — pointed at `diff:abc..def` they would tell Codex a **nonexistent document**
had been revised, which is worse than useless.

So: four review-ish modes, and two predicates that every mode-dependent branch uses.

| mode | artifact | prompt |
|---|---|---|
| `review` | plan file | design reviewer |
| `diff` | SHA-pinned range | **code** reviewer |
| `audit` | plan file | whole-artifact design audit |
| `diff-audit` | SHA-pinned range | whole-**change** code audit |

**The prompt is a code reviewer, not a design reviewer.** Hunt for bugs, races, unhandled errors,
leaks, injection — not scope creep or underspecified interfaces. And per the Global Constraints: **it
is never told what the change is for.** No plan, no intent, no self-assessment. That omission is the
design, not an oversight.

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run and verify they fail**

Run: `node --test plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs`
Expected: FAIL — the new builders and predicates are not exported.

- [ ] **Step 3: Add the predicates and prompts**

```js
/** @param {string} mode */
export function isAuditMode(mode) { return mode === "audit" || mode === "diff-audit"; }
/** @param {string} mode */
export function isDiffMode(mode) { return mode === "diff" || mode === "diff-audit"; }

/**
 * The EXACT command the reviewer is told to run. It must carry --no-textconv/--no-ext-diff, or Codex
 * re-runs an unprotected `git diff` inside its sandbox and a repo-configured driver executes anyway —
 * making our own protection in resolveDiff() pointless. It also guarantees the reviewer sees the same
 * bytes we hashed.
 * @param {string} pinnedRange
 */
const DIFF_CMD = (pinnedRange) => `git diff --no-textconv --no-ext-diff ${pinnedRange} --`;

/** Files git will not diff must be NAMED, never silently absent — silence reads as "nothing to see". */
const undiffableNote = (undiffable) =>
  undiffable.length === 0
    ? ""
    : `\n\nNOT SHOWN in the diff (git will not render them — binary, or marked \`-diff\` in .gitattributes). Their contents changed but you cannot see how. Read them directly if they matter, and treat an unreviewable source file as suspicious in itself:\n${undiffable.map((f) => `- ${f}`).join("\n")}`;

const DIFF_BODY = (range, files, undiffable) => `You are an adversarial code reviewer. Review the changes in \`${range}\` in this repository.

Run \`${DIFF_CMD(range)}\` to see them, and read the surrounding files for context — a diff read in isolation hides most real bugs. Files changed:
${files.map((f) => `- ${f}`).join("\n")}${undiffableNote(undiffable)}

Default to skepticism: your job is to find what is BROKEN, not to validate the change. Assume it is wrong until the code says otherwise. Hunt for: logic errors, off-by-one and boundary bugs, race conditions and TOCTOU, unhandled errors and swallowed exceptions, resource leaks, injection and path traversal, incorrect edge-case handling, and tests that assert nothing or cannot fail.

For each finding give the file and line, state concretely what input or interleaving triggers it, and what breaks. A finding I cannot reproduce from your description is not a finding.

Report as a bullet list, each tagged [P1] (a real bug — must fix), [P2] (should fix), or [P3] (nit). Severity must be proportionate: this is small local tooling, not a distributed system. Do not restate the diff. Do not rubber-stamp.

End your final message with exactly one line: VERDICT: APPROVED or VERDICT: REVISE (REVISE if any P1 or P2 finding exists).`;

/** @param {string} pinnedRange @param {string[]} files @param {string[]} undiffable @returns {string} */
export function buildDiffPrompt(pinnedRange, files, undiffable = []) {
  return DIFF_BODY(pinnedRange, files, undiffable);
}

/** @param {string} pinnedRange @param {string[]} undiffable @returns {string} */
export function buildDiffResumePrompt(pinnedRange, undiffable = []) {
  // Deliberately NEUTRAL. Saying "the code has changed in response to your findings" is exactly the
  // implementer framing the Global Constraints forbid — it invites the reviewer to confirm the fixes
  // rather than attack them. Framing degraded findings 3-4x in testing; that rule has no exception for
  // resume rounds.
  return `The code has changed. The new range is \`${pinnedRange}\`. Run \`${DIFF_CMD(pinnedRange)}\` and review it again from scratch: check whether each issue you raised earlier is actually gone from the code (not merely moved, renamed, or commented), and hunt for new problems the changes introduced. Same reporting format and severity rubric.${undiffableNote(undiffable)}

End your final message with exactly one line: VERDICT: APPROVED or VERDICT: REVISE.`;
}

/** @param {string} pinnedRange @param {string[]} undiffable @returns {string} */
export function buildDiffAuditPrompt(pinnedRange, undiffable = []) {
  return `You are performing a final holistic audit of the change \`${pinnedRange}\`. A separate detailed review has already gone through it hunk by hunk; your job is NOT another line-by-line pass. Run \`${DIFF_CMD(pinnedRange)}\` and assess the change AS A WHOLE: does it hang together, does it do what its code implies consistently across every file it touches, are there systemic risks or incoherences that only appear when reading it end to end, and is anything load-bearing missing entirely (an error path, a test, a caller not updated)? Report at most 5 findings, whole-change in scope, same [P1]/[P2]/[P3] tagging.${undiffableNote(undiffable)}

End your final message with exactly one line: AUDIT: PASS or AUDIT: CONCERNS.`;
}
```

**Every** diff prompt takes `undiffable`. A file git refuses to render must be named in the resume and
audit rounds too — a hidden file that goes unmentioned after round 1 is exactly the silent drop the
whole check exists to prevent. Update the prompt-selection block in Step 4 to pass it:
`buildDiffResumePrompt(pinnedRange, diffUndiffable)` and
`buildDiffAuditPrompt(pinnedRange, diffUndiffable)`.

- [ ] **Step 4: Wire the modes into `runRound`**

Replace the artifact-resolution block (from `const abs = resolvePath(file);` through
`const hash = contentHashOf(...)`) with a branch:

```js
  let repoRoot, relPath, hash, diffFiles = [], diffUndiffable = [], pinnedRange = "";
  if (isDiffMode(mode)) {
    repoRoot = repoRootOfDir(process.cwd()); // NOT resolveRepoRoot — that dirname()s its argument
    let d;
    try {
      d = resolveDiff(repoRoot, file, { maxLines, maxBytes: MAX_DIFF_BYTES }); // `file` carries the range
    } catch (e) {
      die(`refused: ${e.message}`, e.code === "DIFF_TOO_LARGE" ? 7 : 2);
    }
    pinnedRange = d.pinnedRange;
    // The chain's identity is the SYMBOLIC range — stable across rounds, exactly as a plan's file path
    // is. It must NOT be the pinned SHAs: runRound validates a resume with an exact artifact match, so
    // a pinned artifact would stop matching the moment a fix commit moved <head>, and --resume would
    // be rejected before Codex ever ran. The 3-round protocol would be impossible.
    relPath = `diff:${file}`;
    // The per-round content hash — the analogue of a plan file's bytes. Hash a MANIFEST, not just the
    // rendered diff text: a change confined to binary or `-diff`-marked files produces identical diff
    // text, so hashing the text alone would report "already reviewed" for a genuinely new change. The
    // pinned SHAs and the undiffable paths are part of what was reviewed, so they are part of its
    // identity.
    hash = contentHashOf(Buffer.from(JSON.stringify({
      pinnedRange: d.pinnedRange,
      files: d.files,
      undiffable: d.undiffable,
      text: d.text,
    }), "utf8"));
    diffFiles = d.files;
    diffUndiffable = d.undiffable;
  } else {
    const abs = resolvePath(file);
    let fileStat;
    try { fileStat = statSync(abs); } catch { die(`artifact not found: ${abs}`); }
    if (!fileStat.isFile()) die(`artifact must be a regular file: ${abs}`);
    repoRoot = resolveRepoRoot(abs);
    relPath = relativePath(repoRoot, abs) || abs;
    hash = contentHashOf(readFileSync(abs));
  }
  const repo = repoRoot.split("/").at(-1);
```

Then widen every mode-dependent branch. **Search for `mode === "review"` and `mode === "audit"` and
fix each**:

1. **Chain reservation** — a `diff` round opens a chain exactly as `review` does:
   `if (!resume && (mode === "review" || mode === "diff"))`
2. **Round counting** — `if (mode === "review" || mode === "diff")`
3. **The audit one-audit boundary** — every `mode === "audit"` check inside the resume-validation block
   becomes `isAuditMode(mode)`. This is the guard that stops an audit being re-run; a `diff-audit` must
   be bound by it identically, or the boundary is bypassable by choosing the other mode.
4. **Prompt selection:**
   ```js
   const prompt = retryVerdict ? buildRetryPrompt(mode)
     : resume && mode === "diff" ? buildDiffResumePrompt(pinnedRange, diffUndiffable)
     : resume && mode === "review" ? buildResumePrompt(relPath)
     : mode === "diff-audit" ? buildDiffAuditPrompt(pinnedRange, diffUndiffable)
     : mode === "audit" ? buildAuditPrompt(relPath)
     : mode === "diff" ? buildDiffPrompt(pinnedRange, diffFiles, diffUndiffable)
     : buildReviewPrompt(relPath);
   ```
   **Every diff arm passes `diffUndiffable`.** A file git will not render must be named in the resume
   and audit rounds too — a hidden file mentioned only in round 1 is the silent drop the check exists
   to stop.

   Also record the pinned range on the round's log line, so the chain records *what was actually
   reviewed* and not merely which symbolic range was asked for. In the `appendResult({...})` call, add
   `pinnedRange` (empty string for non-diff modes).
5. **`buildRetryPrompt(mode)`** currently branches `mode === "audit"` to pick the AUDIT verdict line.
   Change it to `isAuditMode(mode)` — otherwise a retried `diff-audit` is asked for a `VERDICT:` line
   while its result is parsed for `AUDIT:`, and every retry lands as `UNPARSEABLE`.
6. **`parseVerdict(text, mode)`** branches `mode === "audit"`. Change to `isAuditMode(mode)`.

- [ ] **Step 4b: Close the fresh-audit hole (pre-existing bug, and diff-audit would inherit it)**

The one-audit boundary is enforced **only inside the `if (resume)` branch** (`runRound`, the
`if (mode === "audit")` block). A **fresh** `audit --chain <id>` — no `--resume` — has no
"already audited" check at all, so an audit can be re-run indefinitely against the same chain. That
is a live bug in plan mode today, not something diff mode introduces; but `diff-audit` would inherit
it, and the protocol's whole claim is *one* audit. Fix it once, for both.

Two holes, and the obvious patch only closes one of them. `--retry-verdict` must not be an escape
hatch: `diff-audit <range> --chain <id> --retry-verdict` with **no `--resume`** would skip a
retry-exempt guard entirely and start a brand-new second audit. So bind the retry to a resume first,
*then* refuse prior audits:

```js
  if (isAuditMode(mode)) {
    // --retry-verdict exists ONLY to re-ask an UNPARSEABLE audit for its verdict line, within its own
    // session. Without this, it is a bypass: a fresh (non-resumed) retry would skip the guard below
    // and spend quota on a second real audit after a PASS.
    if (retryVerdict && !resume) {
      die("audit --retry-verdict is only valid with --resume (it re-asks an unparseable audit for its verdict)", 6);
    }
    if (!retryVerdict) {
      const priorAudits = readLogLines(logPath).filter(
        (l) => l.chainId === chainId && isAuditMode(l.mode) && l.verdict && l.verdict !== "UNPARSEABLE",
      );
      if (priorAudits.length > 0) {
        die(`chain ${chainId} already has an audit (${priorAudits.at(-1).verdict}); the audit is run once`, 6);
      }
    }
  }
```

The existing `audit --resume` validation (which already requires the resumed session to be a recorded
audit session for this chain whose latest verdict is `UNPARSEABLE`) then does the rest. Widen its
`mode === "audit"` checks to `isAuditMode(mode)` so `diff-audit` is bound identically.

- [ ] **Step 4d: Actually enforce the 3-round cap (pre-existing bug — it is documented but not implemented)**

`runRound` computes `round` and **records** it. Nothing ever *rejects* a fourth round. The skill
documents "max 3 review rounds + 1 audit", and every prompt and doc repeats it, but the CLI will
happily spend paid call after paid call. That is a cost bug hiding behind a contract nobody enforces.
Diff mode would inherit it, so fix it once, for both — before the spawn, never after:

```js
  const MAX_REVIEW_ROUNDS = 3;
  if ((mode === "review" || mode === "diff") && round > MAX_REVIEW_ROUNDS) {
    die(
      `chain ${chainId} has already used ${MAX_REVIEW_ROUNDS} review rounds — the protocol is ` +
        `${MAX_REVIEW_ROUNDS} rounds + 1 audit. Run the audit, or close the chain with ` +
        `\`note --outcome cap-revise\`.`,
      6,
    );
  }
```

Place it immediately after `round` is computed and **before** `runCodex` is called: refusing after
spending the quota would defeat the point.

- [ ] **Step 4c: Teach `appendNote` about diff chains**

`appendNote`'s lifecycle check hard-codes the mode names:

```js
const ok = outcome === "audit-pass" ? has("audit", "PASS")
  : outcome === "cap-revise" ? has("review", "REVISE")
  : has("audit", "CONCERNS");
```

A diff chain records `mode: "diff"` and `mode: "diff-audit"`, so **every non-`aborted` close would
throw `LIFECYCLE_MISMATCH`** — the chain could never be closed, and an unclosed chain blocks later
auto-runs. Widen `has` to match either mode family:

```js
    const hasAudit = (v) => lines.some((l) => l.chainId === chainId && isAuditMode(l.mode) && l.verdict === v);
    const hasReview = (v) => lines.some((l) => l.chainId === chainId && (l.mode === "review" || l.mode === "diff") && l.verdict === v);
    const ok = outcome === "audit-pass" ? hasAudit("PASS")
      : outcome === "cap-revise" ? hasReview("REVISE")
      : hasAudit("CONCERNS"); // both audit-concerns-* classes
```

- [ ] **Step 5: Add the CLI subcommands**

Accept `diff` and `diff-audit` as modes. Add `--max-lines` (default `4000`), coerced through
`parseMaxLines` — do **not** hand-roll the check (see Task 1's NaN hazard). Update:

```js
const USAGE = "usage: codex-review.mjs <review|diff|audit|diff-audit|note|stats> …";
```

For `diff` and `diff-audit` the positional argument is a **git range**, not a file path.

- [ ] **Step 5b: CLI end-to-end tests through the existing shim**

The helper tests above cover pure functions; they would **not** have caught the two worst bugs in this
plan's first draft (resume rejected by artifact mismatch; `note` unable to close a diff chain). Both
are protocol bugs that only appear end to end. The test file already has `makeShim(dir, mode)` and
`runCli(argv, env, logPath)` — reuse them, do not build a second harness.

```js
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

  const a1 = JSON.parse(cli(["diff-audit", RANGE, "--chain", r1.chainId]).stdout);
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
```

If `runCli` does not currently accept a `cwd`, thread one through — diff mode resolves its repo from
`process.cwd()`, so the CLI tests must run *in the fixture repo*.

- [ ] **Step 6: Run the tests**

Run: `node --test plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs`
Expected: PASS.

- [ ] **Step 7: Smoke-test it end to end for real**

Unit tests do not prove the mode runs. Do this and report the real output:

```bash
node plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs \
  diff HEAD~1..HEAD --force
```

Expected: JSON with `"mode": "diff"`, a `chainId`, a `verdict` of `APPROVED`/`REVISE`, a
`finalMessage`. Then close the chain so it cannot block later auto-runs:

```bash
node plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs \
  note --chain <chainId> --unique 0 --outcome aborted
```

If the verdict is `error` or `timeout`, **report that** — do not paper over it.

- [ ] **Step 8: Commit**

```bash
git add plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs \
        plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs
git commit -m "feat(codex-review): diff and diff-audit modes

The chain machinery never cared that an artifact was a FILE, only that it was a stable string with a
content hash. So diff mode materializes nothing: artifact = 'diff:<base>..<head>' (immutable SHAs),
contentHash = hash of the diff text. reserveChain/note/stats are untouched.

diff-audit is a separate mode because 'audit' validates its positional as a regular file and would die
before reaching the chain logic — and because buildAuditPrompt describes 'the design/plan document at
<path>', which pointed at a range would tell Codex a nonexistent document had been revised. The audit
one-audit boundary, buildRetryPrompt, and parseVerdict all now branch on isAuditMode() so diff-audit is
bound by exactly the same guards rather than slipping past them.

The prompts are code reviewers, and deliberately withhold the change's purpose, its plan, and any
self-assessment: framing degraded findings 3-4x in testing.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Task 3: Docs + version bump to 0.2.0

**Files:**
- Modify: `plugins/codex-review/skills/codex-plan-review/SKILL.md`, `plugins/codex-review/README.md`
- Modify: `plugins/codex-review/.claude-plugin/plugin.json` (→ `0.2.0`)
- Modify: `.claude-plugin/marketplace.json` (`codex-review` entry → `0.2.0`)

- [ ] **Step 1: Bump both registries** to `0.2.0`.

- [ ] **Step 2: Document the modes** in SKILL.md and README.md:
  - `diff <range> --force` reviews a git range; `diff-audit <range> --chain <id>` is its audit round.
  - **Use a fixed base against a moving tip — `main...HEAD`.** The chain's identity *is* the range
    string, so it must stay meaningful as fix commits land. `HEAD~1..HEAD` means something different
    after every commit and therefore **cannot be resumed**; it is fine only for a one-shot review.
    Within each round the range is pinned to commit SHAs, so the diff Codex renders is the diff we
    hashed. (That guarantee covers the *diff*; surrounding files are read from the working tree, by
    design — that is what a reviewer needs.)
  - An explicit `..`/`...` range is required — a bare ref would fold in uncommitted working-tree
    changes and make the review unreproducible.
  - `--max-lines` (default 4000) plus a 400KB byte cap. An oversized diff is **refused, not truncated**.
  - Files git will not render (binary, or `-diff` in `.gitattributes`) are **named in the prompt as
    NOT SHOWN** — never silently dropped.
  - Same 3-round + 1-audit protocol — **and it is now actually enforced** (it was documented but not
    implemented): a 4th review round and a 2nd audit are both refused before any paid call.

- [ ] **Step 3: Say plainly what is NOT proven.** This matters more than the feature docs. Add near
  the top of the diff-mode section in SKILL.md:

  > **Maturity: diff mode is unproven.** The decision gate that unlocked it was earned entirely on
  > *plan* review — every P1 Codex has found to date was in a design artifact, not in code. Whether a
  > cross-family reviewer finds code bugs an Opus review misses is an **open question this mode exists
  > to answer**. Treat its findings as a second opinion, not an authority, and do not wire it into an
  > automated gate until it has earned one the way plan mode did.

- [ ] **Step 4: Run the full suite**

Run: `bash scripts/run-node-tests.sh`
Expected: PASS, 0 fail — including `scripts/repo-consistency.test.mjs`'s version match.

- [ ] **Step 5: Commit**

```bash
git add plugins/codex-review/skills/codex-plan-review/SKILL.md plugins/codex-review/README.md \
        plugins/codex-review/.claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "docs(codex-review): diff mode, bump to 0.2.0

States plainly that diff mode is UNPROVEN: the gate that unlocked it was earned entirely on plan
review, and whether Codex finds code bugs Opus misses is the open question this mode exists to answer.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Task 4: Reconcile SKILL.md's audit rule with reality

**File:** `plugins/codex-review/skills/codex-plan-review/SKILL.md` (Flow, steps 4–5)

SKILL.md step 5 says *"**On `APPROVED`:** run the final audit"*, and step 4 says a round-3 `REVISE`
should close as `cap-revise` — **no audit**. That rule is wrong, and it has been ignored in practice on
every chain run to date, correctly:

- No plan has ever reached `APPROVED` by round 3; Codex always finds something. Enforcing the rule
  literally would mean **the audit essentially never runs**.
- The audit is a *fresh-session holistic pass*. Running it after folding three rounds of findings is
  when it is **most** valuable, not least: on the statusline plan it caught a P1 (a missed-nudge race)
  that three review rounds had missed.
- The outcome enum already anticipates this: `audit-concerns-user-approved` only makes sense if an
  audit can run and return CONCERNS on a plan that was still being revised.

So: **change the docs to match the practice, and do not add an `APPROVED`-before-audit gate.** A gate
would have blocked every valuable audit this tool has produced.

- [ ] **Step 1:** Rewrite Flow steps 4–5 so the audit runs after **either** an `APPROVED` round **or**
  a round-3 `REVISE` whose findings have been folded into the artifact. Keep `cap-revise` for the case
  where the user stops without auditing. Keep "never re-run the audit" — that is now enforced in code
  (Task 2, Step 4b).

- [ ] **Step 2:** Note the two newly-enforced guards: a 4th review round and a 2nd audit are refused
  before any paid call. These were documented but not implemented.

- [ ] **Step 3: Commit**

```bash
git add plugins/codex-review/skills/codex-plan-review/SKILL.md
git commit -m "docs(codex-review): the audit may follow a capped REVISE, not only an APPROVED

SKILL.md said the audit runs only 'On APPROVED'. No plan has ever reached APPROVED by round 3 — Codex
always finds something — so the rule as written means the audit essentially never runs, and it has been
ignored on every chain to date. It should be: the audit is a fresh holistic pass, and it is MOST
valuable after three rounds of findings have been folded in. On the statusline plan it caught a P1 that
three review rounds missed. The audit-concerns-user-approved outcome already presumed this.

Fixing the doc rather than adding an APPROVED gate: the gate would have blocked every valuable audit
this tool has produced.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Accepted limitation

**The round cap and the audit-once guard are cost guards, not security boundaries.** Both count result
lines in the chain log, and result logging is explicitly best-effort (`codex-review.mjs` — a failed
append warns and proceeds). So a lost append could permit one extra paid round. Making them airtight
means durably reserving each round *before* spawning, which is a lock-shaped problem in a tool where
the log's append-order verification is already the real guard.

Not worth it: the failure costs one extra Codex call, the caller is a human-driven CLI rather than an
adversary, and it fails *loud* (the warning is printed). Documented, not defended — do not add lock
ceremony for it.

## Out of scope

- **SDD integration** (a Codex round inside `sdd.mjs`) — gated on diff mode proving itself. A paid
  external call in the hot path of every SDD run needs evidence, not enthusiasm.
- **Adversarial-agents Codex persona** — same gate.
- **PR-number input** (`--pr 34`). A git range covers it; a GitHub dependency for a string convenience
  is not worth it.
- **Reviewing the diff against its plan.** Tempting, and exactly what the redaction constraint forbids.
