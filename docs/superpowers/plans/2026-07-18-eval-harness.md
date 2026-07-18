# Offline Evaluation Harness (Reviewer Stage) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the reviewer-stage vertical slice of the offline evaluation harness: a hermetic corpus format + validator, arm materializer, three reviewer adapters (SDD reviewer, generic Claude code-review, Codex), a two-stage catch matcher, a floored scorecard, and a cached runner CLI.

**Architecture:** Plain zero-dependency Node (`.mjs`, `node --test`) under `benchmarks/`. Corpus items are (base tree or repo ref) + `clean.patch`/`seeded.patch` + ground truth; the runner materializes each arm as a *committed* throwaway worktree and every adapter consumes the commit range `baseSha..armSha`. Results cache by content-derived keys so re-runs (especially Codex) never re-spend on unchanged inputs. Spec: `docs/superpowers/specs/2026-07-18-eval-harness-design.md` — the plan implements it; the why lives there.

**Tech Stack:** Node ≥20 built-ins only (`node:test`, `node:child_process`, `node:crypto`, `node:fs`). External binaries: `git`, `claude`, `codex` (the latter two only in real runs — never in CI tests).

## Global Constraints

- Zero runtime dependencies; corpus metadata is JSON (no YAML parser in Node).
- Every child process uses `execFileSync`/`spawn` with argv arrays — never a shell string.
- Every harness `git diff` carries `--no-textconv --no-ext-diff`; every harness `git commit` carries `--no-verify` plus `-c core.hooksPath=<empty dir>` (mined repos may configure hooks/drivers).
- Determinism: fixed git identity/dates (`FIXED_GIT_ENV`), seeded RNG only (`mulberry32`), no wall-clock in cache keys.
- CI tests must be hermetic: no `claude`/`codex` invocation, no network, no sibling-repo dependence.
- macOS bash 3.2 compatibility for any shell (no `mapfile`).
- SDD plugin behavior change (Task 1) bumps its `plugin.json` version (0.5.0 → 0.5.1).
- Commits: stage explicit paths only; end commit messages with the session trailer used by this session.

## File Structure

```
plugins/subagent-driven-development/scripts/review-package   MODIFY (Task 1: harden diffs)
plugins/subagent-driven-development/scripts/scripts.test.sh  MODIFY (Task 1: textconv test)
plugins/subagent-driven-development/.claude-plugin/plugin.json MODIFY (Task 1: 0.5.1)
scripts/run-node-tests.sh          MODIFY (Task 2: add benchmarks root)
benchmarks/taxonomy.md             CREATE (Task 2)
benchmarks/corpus/reviewer/synthetic-0001/{item.json,truth.json,brief.md,clean.patch,seeded.patch,base/src/parse-duration.mjs}  CREATE (Task 2)
benchmarks/harness/schema.mjs      CREATE (Task 2)  — pure schema/patch-inspection helpers
benchmarks/harness/schema.test.mjs CREATE (Task 2)
benchmarks/harness/materialize.mjs CREATE (Task 3)  — arm → committed worktree
benchmarks/harness/materialize.test.mjs CREATE (Task 3)
benchmarks/harness/validate.mjs    CREATE (Task 4)  — corpus validator CLI (uses materialize)
benchmarks/harness/validate.test.mjs CREATE (Task 4)
benchmarks/harness/cache.mjs       CREATE (Task 5)
benchmarks/harness/cache.test.mjs  CREATE (Task 5)
benchmarks/harness/model.mjs       CREATE (Task 6)  — schemas, severity, verdict policy, records
benchmarks/harness/claude-cli.mjs  CREATE (Task 6)  — claude -p arg builder + runner + parser
benchmarks/harness/model.test.mjs  CREATE (Task 6)
benchmarks/harness/claude-cli.test.mjs CREATE (Task 6)
benchmarks/harness/adapters/code-review.mjs      CREATE (Task 7)
benchmarks/harness/adapters/code-review.test.mjs CREATE (Task 7)
benchmarks/harness/adapters/sdd-reviewer.mjs     CREATE (Task 8)
benchmarks/harness/adapters/sdd-reviewer.test.mjs CREATE (Task 8)
benchmarks/harness/adapters/codex.mjs            CREATE (Task 9)
benchmarks/harness/adapters/codex.test.mjs       CREATE (Task 9)
benchmarks/harness/matcher.mjs           CREATE (Task 10)
benchmarks/harness/matcher.test.mjs      CREATE (Task 10)
benchmarks/harness/fixtures/judge-cases.json CREATE (Task 10)
benchmarks/harness/scorecard.mjs         CREATE (Task 11)
benchmarks/harness/scorecard.test.mjs    CREATE (Task 11)
benchmarks/harness/run.mjs               CREATE (Task 12)
benchmarks/harness/run.test.mjs          CREATE (Task 12)  — includes hermetic smoke
.gitignore                               CREATE-OR-MODIFY (Task 12: benchmarks/results/)
benchmarks/baselines.json                CREATE (Task 13)
benchmarks/README.md                     CREATE (Task 13)
README.md                                MODIFY (Task 13: one benchmarks line)
```

Task dependencies: 2→3→4; 6→{7,8,9,10}; {4,5,6,10,11}→12→13. Tasks 1 and 5 are independent of everything before them.

---

### Task 1: Harden `review-package` against diff drivers

**Files:**
- Modify: `plugins/subagent-driven-development/scripts/review-package`
- Modify: `plugins/subagent-driven-development/scripts/scripts.test.sh`
- Modify: `plugins/subagent-driven-development/.claude-plugin/plugin.json`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: a `review-package` whose `git diff` calls never execute configured textconv/external-diff drivers. Task 8's adapter relies on this.

- [ ] **Step 1: Write the failing test**

Append to `plugins/subagent-driven-development/scripts/scripts.test.sh`, immediately after the existing `review-package builds a 2-commit range package` block (before the `sdd-worktree` section):

```bash
# review-package must not execute textconv/external-diff drivers (host-side code
# execution risk when packaging untrusted trees — e.g. harness-seeded corpus arms).
cat > "$tmp/evil.sh" <<EOF
#!/bin/sh
touch "$tmp/pwned"
cat "\$1"
EOF
chmod +x "$tmp/evil.sh"
echo "f diff=evil" > .gitattributes
git config diff.evil.textconv "$tmp/evil.sh"
echo d >> f && git commit -qam d
head2=$(git rev-parse HEAD)
pkg2=$("$dir/review-package" "$head" "$head2" | sed 's/^wrote //; s/:.*//')
[ ! -e "$tmp/pwned" ] || { echo "FAIL: textconv driver executed during packaging"; exit 1; }
grep -q "^+d" "$pkg2" || { echo "FAIL: package missing raw diff content"; exit 1; }
git config --unset diff.evil.textconv && rm .gitattributes
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `plugins/subagent-driven-development/scripts/scripts.test.sh`
Expected: `FAIL: textconv driver executed during packaging` (exit 1) — the driver runs because `review-package`'s diff calls carry no suppression flags.

- [ ] **Step 3: Add the suppression flags**

In `plugins/subagent-driven-development/scripts/review-package`, change the two diff lines inside the package heredoc-block:

```bash
  echo "## Files changed"; g diff --no-textconv --no-ext-diff --stat "${base}..${head}"; echo
  echo "## Diff"; g diff --no-textconv --no-ext-diff -U10 "${base}..${head}"
```

(Only these two `g diff` invocations change; `--stat` does not run textconv but gets the flags anyway so the two calls stay visibly identical in policy.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `plugins/subagent-driven-development/scripts/scripts.test.sh`
Expected: script completes with no `FAIL:` lines, exit 0.

- [ ] **Step 5: Bump the plugin version**

In `plugins/subagent-driven-development/.claude-plugin/plugin.json`: `"version": "0.5.0"` → `"version": "0.5.1"`.

- [ ] **Step 6: Commit**

```bash
git add plugins/subagent-driven-development/scripts/review-package \
        plugins/subagent-driven-development/scripts/scripts.test.sh \
        plugins/subagent-driven-development/.claude-plugin/plugin.json
git commit -m "fix(sdd): suppress textconv/ext-diff drivers in review-package"
```

---

### Task 2: Corpus schema helpers, taxonomy, first synthetic item, test-runner extension

**Files:**
- Create: `benchmarks/taxonomy.md`
- Create: `benchmarks/harness/schema.mjs`
- Create: `benchmarks/harness/schema.test.mjs`
- Create: `benchmarks/corpus/reviewer/synthetic-0001/` (all six files)
- Modify: `scripts/run-node-tests.sh:16`

**Interfaces:**
- Consumes: nothing.
- Produces: `TAXONOMY: string[]`, `SEVERITIES: string[]`, `validateItemMeta(meta) → string[]`, `validateTruth(truth) → string[]`, `newSideRanges(patchText, file) → [start,end][]`, `spanCovered(patchText, file, span) → boolean` (all from `schema.mjs`). The `synthetic-0001` item with valid, git-generated patches.

- [ ] **Step 1: Extend the test runner first (so every later test actually gates CI)**

In `scripts/run-node-tests.sh`, change line 16:

```bash
while IFS= read -r f; do files+=("$f"); done < <(find plugins scripts benchmarks -name '*.test.mjs' 2>/dev/null | sort)
```

(`2>/dev/null` keeps the script working before `benchmarks/` exists in other checkouts; `set -euo pipefail` stays satisfied because `find` still exits 0 overall with existing roots. Verify by running `scripts/run-node-tests.sh` — same test count as before, exit 0.)

- [ ] **Step 2: Write the failing schema tests**

`benchmarks/harness/schema.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TAXONOMY, SEVERITIES, validateItemMeta, validateTruth, newSideRanges, spanCovered,
} from "./schema.mjs";

const goodMeta = { id: "synthetic-0001", tranche: "synthetic", repo: "self", remote: null, language: "js" };
const goodTruth = {
  class: "wrong-constant", file: "src/parse-duration.mjs", span: [2, 2], severity: "Critical",
  mechanism: "The hours multiplier added to UNITS is 600000 instead of 3600000, so hour durations parse to one-sixth of their value.",
  knownIssues: [],
};

test("valid synthetic meta and truth pass", () => {
  assert.deepEqual(validateItemMeta(goodMeta), []);
  assert.deepEqual(validateTruth(goodTruth), []);
});

test("mined meta requires baseSha and remote (unless private)", () => {
  const m = { id: "x-1", tranche: "mined", repo: "~/Work/Git/x", language: "ts" };
  const errs = validateItemMeta(m);
  assert.ok(errs.some((e) => e.includes("baseSha")));
  assert.ok(errs.some((e) => e.includes("remote")));
  assert.deepEqual(
    validateItemMeta({ ...m, baseSha: "a".repeat(40), private: true }), []);
});

test("truth rejects unknown class, bad span, thin mechanism", () => {
  assert.ok(validateTruth({ ...goodTruth, class: "vibes" }).length === 1);
  assert.ok(validateTruth({ ...goodTruth, span: [5, 2] }).length === 1);
  assert.ok(validateTruth({ ...goodTruth, mechanism: "bad" }).length === 1);
});

test("knownIssues entries need a file and a valid span", () => {
  assert.equal(validateTruth({ ...goodTruth, knownIssues: [{}] }).length, 1);
  assert.deepEqual(validateTruth({ ...goodTruth, knownIssues: [{ file: "f.js", span: [1, 2] }] }), []);
});

test("taxonomy and severities are closed lists", () => {
  assert.ok(TAXONOMY.includes("weakened-test"));
  assert.deepEqual(SEVERITIES, ["Critical", "Important", "Minor"]);
});

const patch = [
  "diff --git a/src/parse-duration.mjs b/src/parse-duration.mjs",
  "index 111..222 100644",
  "--- a/src/parse-duration.mjs",
  "+++ b/src/parse-duration.mjs",
  "@@ -1,8 +1,8 @@",
  " line1",
  "-old",
  "+new",
  " line3",
  "",
].join("\n");

test("newSideRanges and spanCovered read the new side of the target file", () => {
  assert.deepEqual(newSideRanges(patch, "src/parse-duration.mjs"), [[1, 8]]);
  assert.equal(spanCovered(patch, "src/parse-duration.mjs", [2, 2]), true);
  assert.equal(spanCovered(patch, "src/parse-duration.mjs", [9, 12]), false);
  assert.equal(spanCovered(patch, "other.mjs", [2, 2]), false);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test benchmarks/harness/schema.test.mjs`
Expected: FAIL — `Cannot find module ... schema.mjs`.

- [ ] **Step 4: Implement `benchmarks/harness/schema.mjs`**

```js
// Corpus metadata schemas + patch inspection. Pure — no I/O (validate.mjs owns I/O).
export const TAXONOMY = [
  "logic-inversion", "off-by-one", "wrong-constant", "swallowed-error",
  "null-path", "weakened-test", "missing-await", "resource-leak",
  "unsafe-input", "api-misuse",
];
export const SEVERITIES = ["Critical", "Important", "Minor"];
const SHA_RE = /^[0-9a-f]{40}$/;

export function validateItemMeta(meta) {
  if (!meta || typeof meta !== "object") return ["item.json: not an object"];
  const errors = [];
  if (typeof meta.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(meta.id)) errors.push("item.json: bad id");
  if (!["mined", "synthetic"].includes(meta.tranche)) errors.push("item.json: tranche must be mined|synthetic");
  if (meta.tranche === "synthetic") {
    if (meta.repo !== "self") errors.push('item.json: synthetic items must use repo "self"');
  } else if (meta.tranche === "mined") {
    if (typeof meta.repo !== "string" || !meta.repo || meta.repo === "self") errors.push("item.json: mined items need a repo path");
    if (!SHA_RE.test(meta.baseSha ?? "")) errors.push("item.json: mined items need a 40-hex baseSha");
    if (!meta.private && !/^https?:\/\//.test(meta.remote ?? "")) {
      errors.push('item.json: mined items need a public remote URL (or "private": true)');
    }
  }
  if (typeof meta.language !== "string" || !meta.language) errors.push("item.json: language required");
  return errors;
}

export function validateTruth(truth) {
  if (!truth || typeof truth !== "object") return ["truth.json: not an object"];
  const errors = [];
  if (!TAXONOMY.includes(truth.class)) errors.push(`truth.json: class must be one of ${TAXONOMY.join(", ")}`);
  if (typeof truth.file !== "string" || !truth.file) errors.push("truth.json: file required");
  if (!Array.isArray(truth.span) || truth.span.length !== 2
      || !truth.span.every((n) => Number.isInteger(n) && n > 0) || truth.span[0] > truth.span[1]) {
    errors.push("truth.json: span must be [start, end] positive ints, start <= end");
  }
  if (!SEVERITIES.includes(truth.severity)) errors.push(`truth.json: severity must be one of ${SEVERITIES.join(", ")}`);
  if (typeof truth.mechanism !== "string" || truth.mechanism.trim().length < 20) {
    errors.push("truth.json: mechanism must describe the defect (>=20 chars)");
  }
  if (!Array.isArray(truth.knownIssues ?? [])) errors.push("truth.json: knownIssues must be an array");
  else for (const [i, k] of (truth.knownIssues ?? []).entries()) {
    if (!k || typeof k.file !== "string" || !k.file || !Array.isArray(k.span) || k.span.length !== 2
        || !k.span.every((n) => Number.isInteger(n) && n > 0) || k.span[0] > k.span[1]) {
      errors.push(`truth.json: knownIssues[${i}] needs a file and a valid [start, end] span`);
    }
  }
  return errors;
}

// New-side hunk ranges of a unified diff, for one target file.
export function newSideRanges(patchText, file) {
  const ranges = [];
  let inFile = false;
  for (const line of patchText.split("\n")) {
    if (line.startsWith("+++ ")) inFile = line === `+++ b/${file}`;
    else if (line.startsWith("--- ")) continue;
    else if (inFile && line.startsWith("@@")) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(line);
      if (m) {
        const start = Number(m[1]);
        const len = m[2] === undefined ? 1 : Number(m[2]);
        ranges.push([start, start + Math.max(len, 1) - 1]);
      }
    }
  }
  return ranges;
}

export function spanCovered(patchText, file, span) {
  return newSideRanges(patchText, file).some(([a, b]) => span[0] <= b && span[1] >= a);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test benchmarks/harness/schema.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 6: Write `benchmarks/taxonomy.md`**

```markdown
# Bug taxonomy (v1)

The closed list of plantable bug classes. `schema.mjs#TAXONOMY` is the source of
truth; this file documents each class. Adding a class = edit both + bump this
header's version.

| class | planted defect |
|---|---|
| logic-inversion | a condition or comparison flipped (`<` vs `>=`, `!` added/dropped) |
| off-by-one | boundary index/loop/slice off by one |
| wrong-constant | a magic value subtly wrong (unit multiplier, limit, default) |
| swallowed-error | a failure path silently absorbed (empty catch, default return) |
| null-path | missing null/undefined guard on a reachable path |
| weakened-test | a test changed so it passes trivially (assertion loosened/removed) |
| missing-await | an async result used without awaiting; race or lost rejection |
| resource-leak | handle/listener/timer acquired but not released on a path |
| unsafe-input | untrusted input reaches a sink unvalidated (path, query, exec) |
| api-misuse | a real API used against its contract (wrong arg order, ignored return) |
```

- [ ] **Step 7: Author `synthetic-0001` (base file, metadata, generated patches)**

`benchmarks/corpus/reviewer/synthetic-0001/base/src/parse-duration.mjs`:

```js
// Parse duration strings like "90s", "5m" into milliseconds.
const UNITS = { ms: 1, s: 1000, m: 60_000 };

export function parseDuration(input) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(String(input).trim());
  if (!m) throw new Error(`unparseable duration: ${input}`);
  return Number(m[1]) * UNITS[m[2]];
}
```

`item.json`:

```json
{
  "id": "synthetic-0001",
  "tranche": "synthetic",
  "repo": "self",
  "remote": null,
  "language": "js"
}
```

`truth.json`:

```json
{
  "class": "wrong-constant",
  "file": "src/parse-duration.mjs",
  "span": [2, 2],
  "severity": "Critical",
  "mechanism": "The hours multiplier added to UNITS is 600000 (ten minutes in ms) instead of 3600000, so every hour-denominated duration parses to one-sixth of its correct value.",
  "knownIssues": []
}
```

`brief.md`:

```markdown
Add hours support to `parseDuration`. `"2h"` must parse to 7200000 ms. Extend
the unit table and the accepted-unit pattern; existing units stay unchanged.
```

Generate the two patches with git (never hand-write hunks). From the repo root:

```bash
root=$(pwd)   # repo root — capture BEFORE any cd ($OLDPWD moves with each cd)
tmp=$(mktemp -d) && cd "$tmp" && git init -q work && cd work
mkdir -p src
cp "$root/benchmarks/corpus/reviewer/synthetic-0001/base/src/parse-duration.mjs" src/
git add -A && git -c user.email=b@l -c user.name=b commit -qm base
# clean arm: correct hours support
cat > src/parse-duration.mjs <<'EOF'
// Parse duration strings like "90s", "5m", "2h" into milliseconds.
const UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

export function parseDuration(input) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(String(input).trim());
  if (!m) throw new Error(`unparseable duration: ${input}`);
  return Number(m[1]) * UNITS[m[2]];
}
EOF
git diff --no-textconv --no-ext-diff > "$root/benchmarks/corpus/reviewer/synthetic-0001/clean.patch"
git checkout -q -- .
# seeded arm: same feature, wrong-constant bug
cat > src/parse-duration.mjs <<'EOF'
// Parse duration strings like "90s", "5m", "2h" into milliseconds.
const UNITS = { ms: 1, s: 1000, m: 60_000, h: 600_000 };

export function parseDuration(input) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(String(input).trim());
  if (!m) throw new Error(`unparseable duration: ${input}`);
  return Number(m[1]) * UNITS[m[2]];
}
EOF
git diff --no-textconv --no-ext-diff > "$root/benchmarks/corpus/reviewer/synthetic-0001/seeded.patch"
cd "$root" && rm -rf "$tmp"
```

Verify: `grep -c "h: 600_000" benchmarks/corpus/reviewer/synthetic-0001/seeded.patch` → `1`, and `grep -c "h: 3_600_000" benchmarks/corpus/reviewer/synthetic-0001/clean.patch` → `1`.

- [ ] **Step 8: Run the full suite**

Run: `scripts/run-node-tests.sh`
Expected: previous count + 5 new tests, all pass.

- [ ] **Step 9: Commit**

```bash
git add scripts/run-node-tests.sh benchmarks/taxonomy.md benchmarks/harness/schema.mjs \
        benchmarks/harness/schema.test.mjs benchmarks/corpus/reviewer/synthetic-0001
git commit -m "feat(benchmarks): corpus schema, taxonomy, first synthetic item"
```

---

### Task 3: Arm materializer

**Files:**
- Create: `benchmarks/harness/materialize.mjs`
- Test: `benchmarks/harness/materialize.test.mjs`

**Interfaces:**
- Consumes: item dirs shaped as in Task 2 (`meta` = parsed `item.json`).
- Produces: `FIXED_GIT_ENV` (object), `materializeArm({itemDir, meta, arm, scratchRoot}) → {worktree, baseSha, armSha, cleanup}` where `arm` ∈ `"clean" | "seeded"` and `cleanup()` removes everything. Tasks 4 and 12 rely on these exact names.

- [ ] **Step 1: Write the failing tests**

`benchmarks/harness/materialize.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { materializeArm, FIXED_GIT_ENV } from "./materialize.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ITEM = join(HERE, "..", "corpus", "reviewer", "synthetic-0001");
const meta = { id: "synthetic-0001", tranche: "synthetic", repo: "self", language: "js" };

test("self mode: deterministic shas, committed arm, non-empty range", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bench-test-"));
  const a = materializeArm({ itemDir: ITEM, meta, arm: "seeded", scratchRoot: scratch });
  const b = materializeArm({ itemDir: ITEM, meta, arm: "seeded", scratchRoot: scratch });
  assert.equal(a.baseSha, b.baseSha);
  assert.equal(a.armSha, b.armSha);
  assert.notEqual(a.baseSha, a.armSha);
  const diff = execFileSync("git", ["-C", a.worktree, "diff", "--no-textconv", "--no-ext-diff", `${a.baseSha}..${a.armSha}`, "--"], { encoding: "utf8" });
  assert.ok(diff.includes("h: 600_000"));
  a.cleanup(); b.cleanup();
  assert.ok(!existsSync(a.worktree));
  rmSync(scratch, { recursive: true, force: true });
});

test("repo mode: clone at baseSha, arm committed, source repo untouched", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bench-test-"));
  const repo = join(scratch, "mined");
  mkdirSync(repo);
  const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, ...FIXED_GIT_ENV } }).trim();
  git(["init", "-q"]);
  writeFileSync(join(repo, "f.txt"), "one\n");
  git(["add", "-A"]); git(["commit", "-q", "--no-verify", "-m", "c1"]);
  const baseSha = git(["rev-parse", "HEAD"]);
  const itemDir = join(scratch, "item");
  mkdirSync(itemDir);
  cpSync(join(ITEM, "clean.patch"), join(itemDir, "clean.patch")); // any valid patch target? no — write our own
  writeFileSync(join(itemDir, "clean.patch"), [
    "diff --git a/f.txt b/f.txt", "index 43dd47e..2bdf67a 100644",
    "--- a/f.txt", "+++ b/f.txt", "@@ -1 +1 @@", "-one", "+two", "",
  ].join("\n"));
  const minedMeta = { id: "mined-x", tranche: "mined", repo, baseSha, language: "txt", private: true };
  const m = materializeArm({ itemDir, meta: minedMeta, arm: "clean", scratchRoot: scratch });
  assert.equal(m.baseSha, baseSha);
  assert.notEqual(m.armSha, baseSha);
  m.cleanup();
  assert.equal(git(["worktree", "list"]).split("\n").length, 1); // nothing registered in source
  // failure path: a non-applying patch throws and still leaves the source repo untouched
  writeFileSync(join(itemDir, "seeded.patch"), [
    "diff --git a/f.txt b/f.txt", "index 0000000..1111111 100644",
    "--- a/f.txt", "+++ b/f.txt", "@@ -1 +1 @@", "-NOT-THE-CONTENT", "+nope", "",
  ].join("\n"));
  assert.throws(() => materializeArm({ itemDir, meta: minedMeta, arm: "seeded", scratchRoot: scratch }));
  assert.equal(git(["worktree", "list"]).split("\n").length, 1);
  assert.equal(git(["status", "--porcelain"]), "");
  rmSync(scratch, { recursive: true, force: true });
});

test("hooks AND clean/smudge filters in the source repo never fire during materialization", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bench-test-"));
  const repo = join(scratch, "hooked");
  mkdirSync(repo);
  const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, ...FIXED_GIT_ENV } }).trim();
  git(["init", "-q"]);
  const marker = join(scratch, "evil-ran");
  // In-tree .gitattributes wires f.txt to a filter defined in the SOURCE
  // repo's config — checkout would smudge, `git add` would clean. The clone
  // has fresh config, so the filter name resolves to nothing (pass-through).
  writeFileSync(join(scratch, "evil.sh"), `#!/bin/sh\ntouch ${marker}\ncat\n`, { mode: 0o755 });
  writeFileSync(join(repo, ".gitattributes"), "f.txt filter=evil\n");
  git(["config", "filter.evil.clean", join(scratch, "evil.sh")]);
  git(["config", "filter.evil.smudge", join(scratch, "evil.sh")]);
  const hookDir = join(repo, "hooks");
  mkdirSync(hookDir);
  for (const hook of ["pre-commit", "post-checkout"]) {
    writeFileSync(join(hookDir, hook), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  }
  git(["config", "core.hooksPath", hookDir]);
  writeFileSync(join(repo, "f.txt"), "one\n");
  git(["add", "-A"]); git(["commit", "-q", "--no-verify", "-m", "c1"]);
  rmSync(marker, { force: true }); // source-repo staging may have run it; the harness must not
  const baseSha = git(["rev-parse", "HEAD"]);
  const itemDir = join(scratch, "item");
  mkdirSync(itemDir);
  writeFileSync(join(itemDir, "seeded.patch"), [
    "diff --git a/f.txt b/f.txt", "index 43dd47e..2bdf67a 100644",
    "--- a/f.txt", "+++ b/f.txt", "@@ -1 +1 @@", "-one", "+two", "",
  ].join("\n"));
  const minedMeta = { id: "mined-h", tranche: "mined", repo, baseSha, language: "txt", private: true };
  const m = materializeArm({ itemDir, meta: minedMeta, arm: "seeded", scratchRoot: scratch });
  assert.ok(!existsSync(marker), "source-repo hooks and filters must not run in the clone");
  m.cleanup();
  rmSync(scratch, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test benchmarks/harness/materialize.test.mjs`
Expected: FAIL — `Cannot find module ... materialize.mjs`.

- [ ] **Step 3: Implement `benchmarks/harness/materialize.mjs`**

```js
// Materialize one corpus arm as a committed throwaway worktree.
// Self mode inits a repo from the item's base/ tree; repo mode adds a detached
// worktree to the mined repo at baseSha. Both then apply + commit the arm patch
// with hooks and diff drivers suppressed, and fixed identity/dates so shas are
// byte-stable (they feed cache keys).
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

export const FIXED_GIT_ENV = {
  GIT_AUTHOR_NAME: "bench", GIT_AUTHOR_EMAIL: "bench@local",
  GIT_COMMITTER_NAME: "bench", GIT_COMMITTER_EMAIL: "bench@local",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", env: { ...process.env, ...FIXED_GIT_ENV },
  }).trim();
}

export function materializeArm({ itemDir, meta, arm, scratchRoot }) {
  if (!["clean", "seeded"].includes(arm)) throw new Error(`bad arm: ${arm}`);
  const scratch = mkdtempSync(join(scratchRoot, `bench-${meta.id}-${arm}-`));
  const nohooks = join(scratch, "nohooks");
  mkdirSync(nohooks);
  const noHook = ["-c", `core.hooksPath=${nohooks}`];
  let worktree, baseSha, cleanup;

  if (meta.repo === "self") {
    worktree = join(scratch, "repo");
    mkdirSync(worktree);
    cpSync(join(itemDir, "base"), worktree, { recursive: true });
    git(["init", "-q"], worktree);
    git(["add", "-A"], worktree);
    git([...noHook, "commit", "-q", "--no-verify", "-m", "base"], worktree);
    baseSha = git(["rev-parse", "HEAD"], worktree);
    cleanup = () => rmSync(scratch, { recursive: true, force: true });
  } else {
    const repo = meta.repo.replace(/^~(?=\/)/, process.env.HOME ?? "~");
    worktree = join(scratch, "repo");
    // LOCAL CLONE, not `worktree add`: a fresh clone has fresh config, so the
    // mined repo's hooks, clean/smudge filters, and textconv drivers simply do
    // not exist here (in-tree .gitattributes referencing an undefined filter is
    // pass-through). It also makes cleanup a plain directory delete — nothing
    // is ever registered in the source repo, even when a patch fails to apply.
    git(["clone", "-q", "--no-checkout", repo, worktree]);
    git(["rev-parse", "--verify", `${meta.baseSha}^{commit}`], worktree); // throws if pruned
    git([...noHook, "checkout", "-q", "--detach", meta.baseSha], worktree);
    baseSha = meta.baseSha;
    cleanup = () => rmSync(scratch, { recursive: true, force: true });
  }

  const patch = join(itemDir, `${arm}.patch`);
  git([...noHook, "apply", "--whitespace=nowarn", patch], worktree);
  git(["add", "-A"], worktree);
  git([...noHook, "commit", "-q", "--no-verify", "-m", `arm:${arm}`], worktree);
  const armSha = git(["rev-parse", "HEAD"], worktree);
  return { worktree, baseSha, armSha, cleanup };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test benchmarks/harness/materialize.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add benchmarks/harness/materialize.mjs benchmarks/harness/materialize.test.mjs
git commit -m "feat(benchmarks): deterministic arm materializer (self + repo modes)"
```

---

### Task 4: Corpus validator

**Files:**
- Create: `benchmarks/harness/validate.mjs`
- Test: `benchmarks/harness/validate.test.mjs`

**Interfaces:**
- Consumes: `validateItemMeta`, `validateTruth`, `spanCovered` (Task 2); `materializeArm` (Task 3).
- Produces: `validateItemDir(itemDir, {requireRepos}) → {errors: string[], warnings: string[]}`, `validateCorpusDirs(dirs, opts) → [{item, itemDir, errors, warnings}]`, `DEFAULT_CORPUS` (absolute path of `benchmarks/corpus/reviewer`). Task 12 aborts a run on any validator error.

- [ ] **Step 1: Write the failing tests**

`benchmarks/harness/validate.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, cpSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateItemDir, validateCorpusDirs, DEFAULT_CORPUS } from "./validate.mjs";

const GOOD = join(DEFAULT_CORPUS, "synthetic-0001");

function corruptedCopy(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "bench-item-"));
  cpSync(GOOD, dir, { recursive: true });
  mutate(dir);
  return dir;
}

test("the committed corpus is valid — this test gates CI", () => {
  const results = validateCorpusDirs([DEFAULT_CORPUS]);
  assert.ok(results.length >= 1);
  for (const r of results) assert.deepEqual(r.errors, [], `${r.item}: ${r.errors.join("; ")}`);
});

test("missing brief is an error", () => {
  const dir = corruptedCopy((d) => unlinkSync(join(d, "brief.md")));
  assert.ok(validateItemDir(dir).errors.some((e) => e.includes("brief.md")));
  rmSync(dir, { recursive: true, force: true });
});

test("span outside the seeded hunks is an error", () => {
  const dir = corruptedCopy((d) => {
    const t = JSON.parse(require("node:fs").readFileSync(join(d, "truth.json"), "utf8"));
    writeFileSync(join(d, "truth.json"), JSON.stringify({ ...t, span: [500, 501] }));
  });
  assert.ok(validateItemDir(dir).errors.some((e) => e.includes("covers truth span")));
  rmSync(dir, { recursive: true, force: true });
});

test("a patch that does not apply at base is an error", () => {
  const dir = corruptedCopy((d) =>
    writeFileSync(join(d, "base", "src", "parse-duration.mjs"), "export const totally = 'different';\n"));
  assert.ok(validateItemDir(dir).errors.some((e) => e.includes("does not apply")));
  rmSync(dir, { recursive: true, force: true });
});

test("unresolvable mined repo: warning by default, error with requireRepos", () => {
  const dir = corruptedCopy((d) => {
    writeFileSync(join(d, "item.json"), JSON.stringify({
      id: "mined-gone", tranche: "mined", repo: "/nonexistent/repo",
      baseSha: "a".repeat(40), private: true, language: "js",
    }));
    rmSync(join(d, "base"), { recursive: true, force: true });
  });
  const dflt = validateItemDir(dir);
  assert.deepEqual(dflt.errors, []);
  assert.ok(dflt.warnings.some((w) => w.includes("unresolvable")));
  assert.ok(validateItemDir(dir, { requireRepos: true }).errors.some((e) => e.includes("unresolvable")));
  rmSync(dir, { recursive: true, force: true });
});
```

Note: the `span [500,501]` test mutates via `require` inside an ESM test — replace with a top-level `import { readFileSync } from "node:fs"` and use `readFileSync` directly (the snippet above shows intent; the implementer writes the clean import form).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test benchmarks/harness/validate.test.mjs`
Expected: FAIL — `Cannot find module ... validate.mjs`.

- [ ] **Step 3: Implement `benchmarks/harness/validate.mjs`**

```js
#!/usr/bin/env node
// Corpus validator. Structural checks always; materialization (apply) checks
// for synthetic items (hermetic) and for mined items whose repo resolves.
// Mined items with unresolvable repos are warnings by default so CI on a fresh
// clone can still validate structure; runs (run.mjs) treat them as failures.
// Usage: node benchmarks/harness/validate.mjs [corpusDir...] [--require-repos]
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { validateItemMeta, validateTruth, spanCovered } from "./schema.mjs";
import { materializeArm } from "./materialize.mjs";

const REQUIRED = ["item.json", "truth.json", "brief.md", "clean.patch", "seeded.patch"];

function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }

export function validateItemDir(itemDir, { requireRepos = false } = {}) {
  const errors = [], warnings = [];
  for (const f of REQUIRED) if (!existsSync(join(itemDir, f))) errors.push(`${f}: missing`);
  if (errors.length) return { errors, warnings };

  let meta = null, truth = null;
  try { meta = readJson(join(itemDir, "item.json")); } catch (e) { errors.push(`item.json: ${e.message}`); }
  try { truth = readJson(join(itemDir, "truth.json")); } catch (e) { errors.push(`truth.json: ${e.message}`); }
  if (errors.length) return { errors, warnings };

  errors.push(...validateItemMeta(meta), ...validateTruth(truth));

  const clean = readFileSync(join(itemDir, "clean.patch"), "utf8");
  const seeded = readFileSync(join(itemDir, "seeded.patch"), "utf8");
  if (clean === seeded) errors.push("seeded.patch: identical to clean.patch");
  if (!readFileSync(join(itemDir, "brief.md"), "utf8").trim()) errors.push("brief.md: empty");
  if (truth?.file) {
    if (!seeded.includes(`+++ b/${truth.file}`)) errors.push(`seeded.patch: does not touch truth file ${truth.file}`);
    else if (Array.isArray(truth.span) && truth.span.length === 2 && !spanCovered(seeded, truth.file, truth.span)) {
      errors.push("seeded.patch: no hunk covers truth span");
    }
  }
  if (errors.length) return { errors, warnings }; // don't materialize structurally broken items

  if (meta.tranche === "synthetic" && !existsSync(join(itemDir, "base"))) {
    errors.push("base/: missing for synthetic item");
    return { errors, warnings };
  }
  const resolvable = meta.tranche === "synthetic"
    || existsSync(join(meta.repo.replace(/^~(?=\/)/, process.env.HOME ?? "~"), ".git"));
  if (!resolvable) {
    (requireRepos ? errors : warnings).push(`repo unresolvable, structural checks only: ${meta.repo}`);
    return { errors, warnings };
  }

  const scratch = mkdtempSync(join(tmpdir(), "bench-validate-"));
  try {
    for (const arm of ["clean", "seeded"]) {
      try { materializeArm({ itemDir, meta, arm, scratchRoot: scratch }).cleanup(); }
      catch (e) { errors.push(`${arm}.patch: does not apply at base (${String(e.message).split("\n")[0]})`); }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  return { errors, warnings };
}

export function validateCorpusDirs(dirs, opts = {}) {
  const results = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) { results.push({ item: dir, itemDir: dir, errors: [`corpus dir missing: ${dir}`], warnings: [] }); continue; }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const itemDir = join(dir, entry.name);
      results.push({ item: entry.name, itemDir, ...validateItemDir(itemDir, opts) });
    }
  }
  return results;
}

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const DEFAULT_CORPUS = join(HERE, "..", "corpus", "reviewer");

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const requireRepos = args.includes("--require-repos");
  const dirs = args.filter((a) => !a.startsWith("--"));
  const results = validateCorpusDirs(dirs.length ? dirs : [DEFAULT_CORPUS], { requireRepos });
  let bad = 0;
  for (const r of results) {
    for (const w of r.warnings) console.error(`WARN  ${r.item}: ${w}`);
    for (const e of r.errors) { console.error(`ERROR ${r.item}: ${e}`); bad++; }
  }
  console.log(`${results.length} item(s), ${bad} error(s)`);
  process.exit(bad ? 1 : 0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test benchmarks/harness/validate.test.mjs`
Expected: PASS (5 tests). Also run `node benchmarks/harness/validate.mjs` → `1 item(s), 0 error(s)`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/harness/validate.mjs benchmarks/harness/validate.test.mjs
git commit -m "feat(benchmarks): corpus validator (structural + apply checks)"
```

---

### Task 5: Cell cache

**Files:**
- Create: `benchmarks/harness/cache.mjs`
- Test: `benchmarks/harness/cache.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `canonicalJson(value) → string`, `cacheKey(parts) → hex sha256`, `class CellCache { constructor(root); get(key) → object|null; put(key, value) }`. Tasks 10 and 12 rely on these exact names.

- [ ] **Step 1: Write the failing tests**

`benchmarks/harness/cache.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJson, cacheKey, CellCache } from "./cache.mjs";

test("canonicalJson is key-order independent, arrays ordered", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test("cacheKey changes when any part changes", () => {
  const base = { item: "abc", arm: "seeded", adapter: "sdd", version: "v1", trial: 0 };
  assert.equal(cacheKey(base), cacheKey({ ...base }));
  assert.notEqual(cacheKey(base), cacheKey({ ...base, trial: 1 }));
  assert.notEqual(cacheKey(base), cacheKey({ ...base, version: "v2" }));
});

test("CellCache round-trips, shards, and returns null for corrupt entries", () => {
  const root = mkdtempSync(join(tmpdir(), "bench-cache-"));
  const cache = new CellCache(root);
  const key = cacheKey({ x: 1 });
  assert.equal(cache.get(key), null);
  cache.put(key, { hello: "world" });
  assert.deepEqual(cache.get(key), { hello: "world" });
  assert.deepEqual(readdirSync(root), [key.slice(0, 2)]);
  writeFileSync(join(root, key.slice(0, 2), `${key}.json`), "{corrupt");
  assert.equal(cache.get(key), null);
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test benchmarks/harness/cache.test.mjs`
Expected: FAIL — `Cannot find module ... cache.mjs`.

- [ ] **Step 3: Implement `benchmarks/harness/cache.mjs`**

```js
// Content-addressed result cache. The key is a sha256 of canonical JSON, so
// any change to an input (item content, adapter version, model, trial) misses
// cleanly, and unchanged Codex cells never re-spend quota.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function cacheKey(parts) {
  return createHash("sha256").update(canonicalJson(parts)).digest("hex");
}

export class CellCache {
  constructor(root) { this.root = root; }
  #path(key) { return join(this.root, key.slice(0, 2), `${key}.json`); }
  get(key) {
    try { return JSON.parse(readFileSync(this.#path(key), "utf8")); } catch { return null; }
  }
  put(key, value) {
    const p = this.#path(key);
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, p);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test benchmarks/harness/cache.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add benchmarks/harness/cache.mjs benchmarks/harness/cache.test.mjs
git commit -m "feat(benchmarks): content-addressed cell cache"
```

---

### Task 6: Result model + claude CLI wrapper

**Files:**
- Create: `benchmarks/harness/model.mjs`
- Create: `benchmarks/harness/claude-cli.mjs`
- Test: `benchmarks/harness/model.test.mjs`
- Test: `benchmarks/harness/claude-cli.test.mjs`

**Interfaces:**
- Consumes: `SEVERITIES` from `schema.mjs` (consistency assertion only).
- Produces (model): `SEVERITY_WEIGHT = {Critical:3, Important:2, Minor:1}`, `FINDINGS_SCHEMA` (JSON Schema), `normalizeSeverity(raw) → "Critical"|"Important"|"Minor"`, `applyVerdictPolicy({explicitReject?, findings, threshold="Critical"}) → "pass"|"reject"`, `makeCellRecord({...}) → record`.
- Produces (claude-cli): `buildClaudeArgs({prompt, model, schema, allowedTools}) → string[]`, `parseClaudeResult(stdoutText) → {ok, structured?, tokens?, costUsd?, wallMs?, error?}`, `runClaude(args, {cwd, timeoutMs}) → Promise<same>`.
- Tasks 7, 8, 10 consume both modules by these exact names.

- [ ] **Step 1: Write the failing tests**

`benchmarks/harness/model.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { SEVERITIES } from "./schema.mjs";
import { SEVERITY_WEIGHT, FINDINGS_SCHEMA, normalizeSeverity, applyVerdictPolicy, makeCellRecord } from "./model.mjs";

test("severity weights align with the corpus severity list", () => {
  assert.deepEqual(Object.keys(SEVERITY_WEIGHT), SEVERITIES);
  assert.deepEqual(Object.values(SEVERITY_WEIGHT), [3, 2, 1]);
});

test("normalizeSeverity maps common variants; unknown → Minor", () => {
  assert.equal(normalizeSeverity("critical"), "Critical");
  assert.equal(normalizeSeverity("P1"), "Critical");
  assert.equal(normalizeSeverity("importANT"), "Important");
  assert.equal(normalizeSeverity("medium"), "Important");
  assert.equal(normalizeSeverity("nit"), "Minor");
  assert.equal(normalizeSeverity(undefined), "Minor");
});

test("verdict policy: explicit reject OR any finding at/above threshold", () => {
  const minor = [{ severity: "Minor" }];
  const critical = [{ severity: "Critical" }];
  assert.equal(applyVerdictPolicy({ findings: minor }), "pass");
  assert.equal(applyVerdictPolicy({ findings: critical }), "reject");
  assert.equal(applyVerdictPolicy({ explicitReject: true, findings: [] }), "reject");
  assert.equal(applyVerdictPolicy({ findings: minor, threshold: "Minor" }), "reject");
});

test("FINDINGS_SCHEMA requires the five finding fields", () => {
  assert.deepEqual(FINDINGS_SCHEMA.properties.findings.items.required,
    ["file", "line", "severity", "summary", "mechanism"]);
});

test("makeCellRecord fills defaults", () => {
  const r = makeCellRecord({ item: "i", arm: "clean", adapter: "a", adapterVersion: "v", trial: 0, status: "ok" });
  assert.equal(r.verdict, null);
  assert.deepEqual(r.findings, []);
  assert.equal(r.cacheHit, false);
  assert.equal(r.error, null);
});
```

`benchmarks/harness/claude-cli.test.mjs` (the fixture string is a trimmed capture of a real `claude -p --output-format json --json-schema` result):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeArgs, parseClaudeResult } from "./claude-cli.mjs";

test("buildClaudeArgs: schema inline, allowed tools last and only when present", () => {
  const args = buildClaudeArgs({ prompt: "P", model: "sonnet", schema: { type: "object" }, allowedTools: ["Read", "Grep"] });
  assert.deepEqual(args.slice(0, 2), ["-p", "P"]);
  assert.ok(args.includes("--output-format") && args[args.indexOf("--output-format") + 1] === "json");
  assert.equal(args[args.indexOf("--json-schema") + 1], '{"type":"object"}');
  assert.deepEqual(args.slice(-3), ["--allowed-tools", "Read", "Grep"]);
  const noTools = buildClaudeArgs({ prompt: "P", model: "sonnet", schema: {}, allowedTools: [] });
  assert.ok(!noTools.includes("--allowed-tools"));
});

const FIXTURE = JSON.stringify({
  type: "result", subtype: "success", is_error: false, duration_ms: 6372,
  result: '{"answer":"ok"}', total_cost_usd: 0.066,
  usage: { input_tokens: 20, output_tokens: 255 },
  structured_output: { answer: "ok" },
});

test("parseClaudeResult: success extracts structured output, tokens, wall time", () => {
  const r = parseClaudeResult(FIXTURE);
  assert.equal(r.ok, true);
  assert.deepEqual(r.structured, { answer: "ok" });
  assert.deepEqual(r.tokens, { input: 20, output: 255 });
  assert.equal(r.wallMs, 6372);
});

test("parseClaudeResult: error and malformed cases", () => {
  assert.equal(parseClaudeResult("not json").ok, false);
  assert.equal(parseClaudeResult(JSON.stringify({ is_error: true, subtype: "error_during_execution" })).ok, false);
  assert.equal(parseClaudeResult(JSON.stringify({ is_error: false })).ok, false); // no structured_output
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test benchmarks/harness/model.test.mjs benchmarks/harness/claude-cli.test.mjs`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `benchmarks/harness/model.mjs`**

```js
// Canonical normalized result model shared by all adapters, plus the one
// gate-outcome policy (spec: reviewers can reject without an actionable
// finding, so verdict is first-class, not derived only from findings).
export const SEVERITY_WEIGHT = { Critical: 3, Important: 2, Minor: 1 };

export const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string", description: "repo-relative path" },
          line: { type: "integer", description: "new-side line number" },
          severity: { enum: ["Critical", "Important", "Minor"] },
          summary: { type: "string", description: "one-sentence defect statement" },
          mechanism: { type: "string", description: "what concretely goes wrong at runtime, and why" },
        },
        required: ["file", "line", "severity", "summary", "mechanism"],
      },
    },
  },
  required: ["findings"],
};

export function normalizeSeverity(raw) {
  const s = String(raw ?? "").toLowerCase();
  if (s.startsWith("crit") || s === "p1" || s === "high" || s === "blocker") return "Critical";
  if (s.startsWith("import") || s === "p2" || s === "medium" || s === "major") return "Important";
  return "Minor";
}

export function applyVerdictPolicy({ explicitReject = false, findings, threshold = "Critical" }) {
  const t = SEVERITY_WEIGHT[threshold];
  return explicitReject || findings.some((f) => (SEVERITY_WEIGHT[f.severity] ?? 0) >= t)
    ? "reject" : "pass";
}

export function makeCellRecord({
  item, arm, adapter, adapterVersion, trial, status,
  verdict = null, findings = [], tokens = null, wallMs = null, cacheHit = false, error = null,
}) {
  return { item, arm, adapter, adapterVersion, trial, status, verdict, findings, tokens, wallMs, cacheHit, error };
}
```

- [ ] **Step 4: Implement `benchmarks/harness/claude-cli.mjs`**

```js
// claude -p invocation: argv builder, spawn wrapper, result parser.
// Structured output arrives pre-parsed in `structured_output` (verified against
// the installed CLI); --json-schema takes INLINE JSON, not a file path.
import { spawn } from "node:child_process";

export function buildClaudeArgs({ prompt, model, schema, allowedTools = [] }) {
  const args = [
    "-p", prompt,
    "--output-format", "json",
    "--json-schema", JSON.stringify(schema),
    "--model", model,
  ];
  if (allowedTools.length) args.push("--allowed-tools", ...allowedTools); // variadic: keep last
  return args;
}

export function parseClaudeResult(stdoutText) {
  let obj;
  try { obj = JSON.parse(stdoutText); } catch { return { ok: false, error: "unparseable claude output" }; }
  if (obj.is_error) return { ok: false, error: `claude error: ${obj.subtype ?? "unknown"}` };
  if (!obj.structured_output) return { ok: false, error: "missing structured_output" };
  return {
    ok: true,
    structured: obj.structured_output,
    tokens: { input: obj.usage?.input_tokens ?? 0, output: obj.usage?.output_tokens ?? 0 },
    costUsd: obj.total_cost_usd ?? null,
    wallMs: obj.duration_ms ?? null,
  };
}

export function runClaude(args, { cwd, timeoutMs = 600_000 } = {}) {
  return new Promise((resolveP) => {
    let child;
    try { child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { return resolveP({ ok: false, error: String(e.message) }); }
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => { clearTimeout(timer); resolveP({ ok: false, error: String(e.message) }); });
    child.on("close", () => {
      clearTimeout(timer);
      if (timedOut) return resolveP({ ok: false, error: `claude timed out after ${timeoutMs}ms` });
      const parsed = parseClaudeResult(stdout);
      resolveP(parsed.ok ? parsed : { ...parsed, error: `${parsed.error}; stderr: ${stderr.slice(0, 400)}` });
    });
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test benchmarks/harness/model.test.mjs benchmarks/harness/claude-cli.test.mjs`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add benchmarks/harness/model.mjs benchmarks/harness/claude-cli.mjs \
        benchmarks/harness/model.test.mjs benchmarks/harness/claude-cli.test.mjs
git commit -m "feat(benchmarks): normalized result model + claude -p wrapper"
```

---

### Task 7: code-review adapter

**Files:**
- Create: `benchmarks/harness/adapters/code-review.mjs`
- Test: `benchmarks/harness/adapters/code-review.test.mjs`

**Interfaces:**
- Consumes: `FINDINGS_SCHEMA`, `normalizeSeverity`, `applyVerdictPolicy` (Task 6); `buildClaudeArgs`, `runClaude` (Task 6).
- Produces: `ADAPTER_ID` (`"code-review"` or `"claude-review"` — the probe below decides), `buildPrompt({brief, diffRange}) → string`, `version() → 12-hex string`, `review({worktree, diffRange, brief, model?, scratchDir?}, deps?) → Promise<{status:"ok", verdict, findings, tokens, wallMs, raw} | {status:"error", error}>`. Task 12 registers adapters by `{ADAPTER_ID, version, review}` — all three adapters share this exact surface, and Task 12 imports ids rather than hardcoding strings.

- [ ] **Step 1: Probe whether `/code-review` runs headless with a forced schema**

One cheap real call from the repo root (this decides what the adapter honestly measures):

```bash
claude -p "/code-review low" --model sonnet --output-format json \
  --json-schema '{"type":"object","properties":{"findings":{"type":"array"}},"required":["findings"]}' \
  --allowed-tools "Read" "Grep" "Glob" "Bash(git diff:*)"
```

Judge the result: did the code-review *skill* actually load and review the working diff (a grounded `structured_output.findings`), or did the model just answer the literal text? Record the probe output and the chosen path in the task report.

- **SKILL PATH** (probe succeeded): keep `ADAPTER_ID = "code-review"`; `buildPrompt` returns `"/code-review low\n\n## Change intent (task brief)\n" + brief.trim() + "\n\nReview the committed change \`" + diffRange + "\`."` — everything else below unchanged.
- **DIRECT PATH** (probe failed): implement exactly the code below but with `ADAPTER_ID = "claude-review"` — the honest name; a baseline must never claim to measure the `/code-review` skill via a prompt that isn't it.

- [ ] **Step 2: Write the failing tests**

`benchmarks/harness/adapters/code-review.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADAPTER_ID, buildPrompt, version, review } from "./code-review.mjs";

test("prompt carries range, brief, introduced-only scope, and clean-pass license", () => {
  const p = buildPrompt({ brief: "Add hours support.", diffRange: "abc..def" });
  assert.ok(p.includes("abc..def"));
  assert.ok(p.includes("Add hours support."));
  assert.ok(p.includes("only defects introduced by this change"));
  assert.ok(p.includes("Zero findings is a valid"));
});

test("version is stable and 12 hex chars", () => {
  assert.match(version(), /^[0-9a-f]{12}$/);
  assert.equal(version(), version());
});

test("review normalizes severities and applies the verdict policy", async () => {
  const fake = async () => ({
    ok: true,
    structured: { findings: [{ file: "f.js", line: 3, severity: "p1", summary: "s", mechanism: "m" }] },
    tokens: { input: 1, output: 2 }, wallMs: 5,
  });
  const r = await review({ worktree: "/tmp", diffRange: "a..b", brief: "B" }, { runClaude: fake });
  assert.equal(r.status, "ok");
  assert.equal(r.findings[0].severity, "Critical");
  assert.equal(r.verdict, "reject");
});

test("review passes through wrapper errors as status error", async () => {
  const fake = async () => ({ ok: false, error: "boom" });
  const r = await review({ worktree: "/tmp", diffRange: "a..b", brief: "B" }, { runClaude: fake });
  assert.deepEqual(r, { status: "error", error: "boom" });
});

test("adapter id reflects the probed path", () =>
  assert.ok(["code-review", "claude-review"].includes(ADAPTER_ID)));
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test benchmarks/harness/adapters/code-review.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `benchmarks/harness/adapters/code-review.mjs`**

```js
// Generic Claude code reviewer over a committed range. Deliberately a direct
// review prompt (not the /code-review skill headless — see the plan's Open
// Questions); the clean-pass license line mirrors the Gap #3 calibration.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { FINDINGS_SCHEMA, normalizeSeverity, applyVerdictPolicy } from "../model.mjs";
import { buildClaudeArgs, runClaude } from "../claude-cli.mjs";

export const ADAPTER_ID = "code-review"; // or "claude-review" — per the Step 1 probe
const HERE = fileURLToPath(new URL(".", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const ALLOWED_TOOLS = ["Read", "Grep", "Glob", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)"];

export function buildPrompt({ brief, diffRange }) {
  return [
    `Review the committed change \`${diffRange}\` in this repository for defects.`,
    "",
    "## Change intent (task brief)",
    brief.trim(),
    "",
    `Inspect the diff with \`git diff --no-textconv --no-ext-diff ${diffRange} --\` and read surrounding code as needed.`,
    "Report only defects introduced by this change — not pre-existing issues, style preferences, or hypotheticals.",
    "Each finding needs: the file, the new-side line, a severity (Critical | Important | Minor),",
    "a one-sentence summary, and the mechanism — what concretely goes wrong at runtime and why.",
    "Zero findings is a valid and respected result: if the change is correct, return an empty list.",
  ].join("\n");
}

export function version() {
  // Hash the COMPLETE behavior: this module (prompt template, tools,
  // normalization) plus the shared model + CLI wrapper code it depends on —
  // a change to any of them must invalidate cached cells.
  return createHash("sha256")
    .update(readFileSync(SELF))
    .update(readFileSync(join(HERE, "..", "model.mjs")))
    .update(readFileSync(join(HERE, "..", "claude-cli.mjs")))
    .digest("hex").slice(0, 12);
}

export async function review({ worktree, diffRange, brief, model = "sonnet" }, deps = { runClaude }) {
  const args = buildClaudeArgs({
    prompt: buildPrompt({ brief, diffRange }), model,
    schema: FINDINGS_SCHEMA, allowedTools: ALLOWED_TOOLS,
  });
  const res = await deps.runClaude(args, { cwd: worktree });
  if (!res.ok) return { status: "error", error: res.error };
  const findings = (res.structured.findings ?? []).map((f) => ({ ...f, severity: normalizeSeverity(f.severity) }));
  return {
    status: "ok",
    verdict: applyVerdictPolicy({ findings, threshold: "Critical" }),
    findings, tokens: res.tokens, wallMs: res.wallMs, raw: res.structured,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test benchmarks/harness/adapters/code-review.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add benchmarks/harness/adapters/code-review.mjs benchmarks/harness/adapters/code-review.test.mjs
git commit -m "feat(benchmarks): claude review adapter (path per headless probe)"
```

---

### Task 8: sdd-reviewer adapter

**Files:**
- Create: `benchmarks/harness/adapters/sdd-reviewer.mjs`
- Test: `benchmarks/harness/adapters/sdd-reviewer.test.mjs`

**Interfaces:**
- Consumes: Task 6 modules; the real `plugins/subagent-driven-development/prompts/reviewer.md` and `scripts/review-package` (hardened in Task 1).
- Produces: same adapter surface as Task 7 (`ADAPTER_ID = "sdd-reviewer"`, `version()`, `review(...)`), plus `NEUTRAL_REPORT`, `SDD_SCHEMA`, `generatePackage({worktree, base, head, outFile})`, `buildPrompt({reviewerMd, brief, packagePath})`. `review` REQUIRES `scratchDir` (for the package file).

- [ ] **Step 1: Write the failing tests**

`benchmarks/harness/adapters/sdd-reviewer.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  ADAPTER_ID, NEUTRAL_REPORT, SDD_SCHEMA, buildPrompt, generatePackage, version, review,
} from "./sdd-reviewer.mjs";

test("schema mirrors the reviewer's NATIVE return contract (reviewer.md 'Return')", () => {
  assert.deepEqual(SDD_SCHEMA.required, ["spec", "findings", "cannotVerify", "quality", "ponytail"]);
  assert.deepEqual(SDD_SCHEMA.properties.spec, { enum: ["pass", "fail"] });
  assert.deepEqual(SDD_SCHEMA.properties.findings.items.required,
    ["severity", "class", "file", "line", "what", "planMandated"]);
});

test("prompt: reviewer.md first, then brief, neutral report, package path — no arm hints", () => {
  const p = buildPrompt({ reviewerMd: "REVIEWER-OPERATING-INSTRUCTIONS", brief: "THE-BRIEF", packagePath: "/x/pkg.diff" });
  assert.ok(p.startsWith("REVIEWER-OPERATING-INSTRUCTIONS"));
  assert.ok(p.indexOf("THE-BRIEF") < p.indexOf(NEUTRAL_REPORT));
  assert.ok(p.includes("/x/pkg.diff"));
  for (const leak of ["seeded", "planted", "harness", "benchmark"]) assert.ok(!p.toLowerCase().includes(leak));
});

test("generatePackage drives the real hardened script against a fixture repo", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bench-sddadapter-"));
  const repo = join(scratch, "r");
  execFileSync("git", ["init", "-q", repo]);
  const git = (args) => execFileSync("git", ["-C", repo, "-c", "user.email=b@l", "-c", "user.name=b", ...args], { encoding: "utf8" }).trim();
  writeFileSync(join(repo, "f.txt"), "one\n");
  git(["add", "-A"]); git(["commit", "-qm", "c1"]);
  const base = git(["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "f.txt"), "two\n");
  git(["add", "-A"]); git(["commit", "-qm", "c2"]);
  const head = git(["rev-parse", "HEAD"]);
  const out = join(scratch, "pkg.diff");
  generatePackage({ worktree: repo, base, head, outFile: out });
  assert.ok(existsSync(out));
  const pkg = readFileSync(out, "utf8");
  assert.ok(pkg.includes("## Diff") && pkg.includes("+two"));
  rmSync(scratch, { recursive: true, force: true });
});

const native = (over = {}) => ({
  spec: "pass", findings: [], cannotVerify: [], quality: "solid",
  ponytail: { net: 0, items: [] }, ...over,
});

test("verdict: spec fail rejects even with zero findings; spec pass + minor passes", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bench-sddadapter-"));
  const fakeRun = (structured) => async () => ({ ok: true, structured, tokens: { input: 1, output: 1 }, wallMs: 1 });
  const fakePkg = () => {}; // review() must accept a generatePackage override in deps for this test
  const rFail = await review(
    { worktree: "/tmp", diffRange: "a..b", brief: "B", scratchDir: scratch },
    { runClaude: fakeRun(native({ spec: "fail" })), generatePackage: fakePkg });
  assert.equal(rFail.verdict, "reject");
  const rPass = await review(
    { worktree: "/tmp", diffRange: "a..b", brief: "B", scratchDir: scratch },
    { runClaude: fakeRun(native({ findings: [{ severity: "Minor", class: "style", file: "f", line: 1, what: "w", planMandated: false }] })), generatePackage: fakePkg });
  assert.equal(rPass.verdict, "pass");
  rmSync(scratch, { recursive: true, force: true });
});

test("native findings normalize (what → summary+mechanism); ponytail items are not findings", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bench-sddadapter-"));
  const fakeRun = (structured) => async () => ({ ok: true, structured, tokens: { input: 1, output: 1 }, wallMs: 1 });
  const r = await review(
    { worktree: "/tmp", diffRange: "a..b", brief: "B", scratchDir: scratch },
    { runClaude: fakeRun(native({
        findings: [{ severity: "Critical", class: "logic", file: "f.js", line: 3, what: "retry counter resets every iteration so the loop never exits", planMandated: false }],
        ponytail: { net: -4, items: ["shrink: inline the helper"] },
      })), generatePackage: () => {} });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].summary, "retry counter resets every iteration so the loop never exits");
  assert.equal(r.findings[0].mechanism, r.findings[0].summary);
  assert.equal(r.verdict, "reject");
  assert.equal(r.raw.ponytail.net, -4); // preserved raw, never scored
  rmSync(scratch, { recursive: true, force: true });
});

test("version is stable 12-hex and changes with reviewer.md content", () => {
  assert.match(version(), /^[0-9a-f]{12}$/);
});

test("adapter id", () => assert.equal(ADAPTER_ID, "sdd-reviewer"));
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test benchmarks/harness/adapters/sdd-reviewer.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `benchmarks/harness/adapters/sdd-reviewer.mjs`**

```js
// The SDD task reviewer, reproduced with its real operating inputs: the
// reviewer.md prompt, a review-package diff file (generated by the actual
// hardened script), the item's task brief, and a fixed neutral implementer
// report (identical for every cell — it can neither leak hints nor vary
// between arms).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { FINDINGS_SCHEMA, normalizeSeverity, applyVerdictPolicy } from "../model.mjs";
import { buildClaudeArgs, runClaude } from "../claude-cli.mjs";

export const ADAPTER_ID = "sdd-reviewer";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = join(HERE, "..", "..", "..");
const REVIEWER_PROMPT_PATH = join(REPO_ROOT, "plugins", "subagent-driven-development", "prompts", "reviewer.md");
const REVIEW_PACKAGE_BIN = join(REPO_ROOT, "plugins", "subagent-driven-development", "scripts", "review-package");

export const NEUTRAL_REPORT =
  "Implementation complete per the brief. Tests for the change were written and run. No further notes.";

// The reviewer's NATIVE return contract (reviewer.md "Return" section) —
// forcing the harness's generic findings shape would benchmark a hybrid
// prompt, not the real SDD reviewer. Normalization to the harness model
// happens in code, after the fact.
export const SDD_SCHEMA = {
  type: "object",
  properties: {
    spec: { enum: ["pass", "fail"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { enum: ["Critical", "Important", "Minor"] },
          class: { type: "string" },
          file: { type: "string" },
          line: { type: "integer" },
          what: { type: "string" },
          planMandated: { type: "boolean" },
        },
        required: ["severity", "class", "file", "line", "what", "planMandated"],
      },
    },
    cannotVerify: { type: "array", items: { type: "string" } },
    quality: { type: "string" },
    ponytail: {
      type: "object",
      properties: { net: { type: "integer" }, items: { type: "array", items: { type: "string" } } },
      required: ["net", "items"],
    },
  },
  required: ["spec", "findings", "cannotVerify", "quality", "ponytail"],
};

const ALLOWED_TOOLS = ["Read", "Grep", "Glob", "Bash(git diff:*)", "Bash(git log:*)"];

export function generatePackage({ worktree, base, head, outFile }) {
  execFileSync(REVIEW_PACKAGE_BIN, ["-C", worktree, base, head, outFile], { encoding: "utf8" });
  return outFile;
}

export function buildPrompt({ reviewerMd, brief, packagePath }) {
  return [
    reviewerMd.trim(),
    "",
    "## Task brief",
    brief.trim(),
    "",
    "## Implementer report",
    NEUTRAL_REPORT,
    "",
    "## Review package",
    `The diff package is at ${packagePath} — Read it once, as instructed above.`,
    "",
    "Emit your review via the structured output schema — your normal return",
    "contract: spec, findings (severity, class, file, new-side line, what,",
    "planMandated), cannotVerify, quality, ponytail.",
  ].join("\n");
}

export function version() {
  // Complete behavior hash: this module (prompt assembly, NEUTRAL_REPORT,
  // schema, tools, normalization), shared model + CLI wrapper code, the real
  // reviewer prompt, and the package-assembly script whose bytes shape what
  // gets reviewed.
  return createHash("sha256")
    .update(readFileSync(SELF))
    .update(readFileSync(join(HERE, "..", "model.mjs")))
    .update(readFileSync(join(HERE, "..", "claude-cli.mjs")))
    .update(readFileSync(REVIEWER_PROMPT_PATH))
    .update(readFileSync(REVIEW_PACKAGE_BIN))
    .digest("hex").slice(0, 12);
}

export async function review(
  { worktree, diffRange, brief, model = "sonnet", scratchDir },
  deps = {},
) {
  const { runClaude: run = runClaude, generatePackage: genPkg = generatePackage } = deps;
  const [base, head] = diffRange.split("..");
  const packagePath = join(scratchDir, "review-package.diff");
  try { genPkg({ worktree, base, head, outFile: packagePath }); }
  catch (e) { return { status: "error", error: `review-package failed: ${String(e.message).split("\n")[0]}` }; }
  const reviewerMd = readFileSync(REVIEWER_PROMPT_PATH, "utf8");
  const args = buildClaudeArgs({
    prompt: buildPrompt({ reviewerMd, brief, packagePath }), model,
    schema: SDD_SCHEMA, allowedTools: ALLOWED_TOOLS,
  });
  const res = await run(args, { cwd: worktree });
  if (!res.ok) return { status: "error", error: res.error };
  // Normalize native findings: `what` serves as both summary and mechanism for
  // the matcher. Ponytail items and quality prose are advisory in SDD's own
  // flow — kept in raw, never scored as findings.
  const findings = (res.structured.findings ?? []).map((f) => ({
    file: f.file, line: f.line, severity: normalizeSeverity(f.severity),
    summary: f.what, mechanism: f.what,
  }));
  return {
    status: "ok",
    verdict: applyVerdictPolicy({ explicitReject: res.structured.spec === "fail", findings, threshold: "Critical" }),
    findings, tokens: res.tokens, wallMs: res.wallMs,
    raw: res.structured,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test benchmarks/harness/adapters/sdd-reviewer.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add benchmarks/harness/adapters/sdd-reviewer.mjs benchmarks/harness/adapters/sdd-reviewer.test.mjs
git commit -m "feat(benchmarks): sdd-reviewer adapter with faithful operating inputs"
```

---

### Task 9: codex adapter

**Files:**
- Create: `benchmarks/harness/adapters/codex.mjs`
- Test: `benchmarks/harness/adapters/codex.test.mjs`

**Interfaces:**
- Consumes: Task 6 model helpers; `runCodex(args, {cwd, timeoutMs})` and `parseEventStream(stdoutText) → {sessionId, finalMessage, terminal, usage}` imported from `plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs` (verified: import-safe via main guard; `parseEventStream` returns exactly that shape).
- Produces: same adapter surface (`ADAPTER_ID = "codex"`, `version()`, `review(...)`), plus `buildPrompt({brief, diffText})`, `extractJson(text)`, `MAX_DIFF_BYTES = 400_000`.

- [ ] **Step 1: Write the failing tests**

`benchmarks/harness/adapters/codex.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { ADAPTER_ID, MAX_DIFF_BYTES, buildPrompt, extractJson, version, review } from "./codex.mjs";

function fixtureRepo() {
  const scratch = mkdtempSync(join(tmpdir(), "bench-codex-"));
  const repo = join(scratch, "r");
  execFileSync("git", ["init", "-q", repo]);
  const git = (args) => execFileSync("git", ["-C", repo, "-c", "user.email=b@l", "-c", "user.name=b", ...args], { encoding: "utf8" }).trim();
  writeFileSync(join(repo, "f.txt"), "one\n");
  git(["add", "-A"]); git(["commit", "-qm", "c1"]);
  const base = git(["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "f.txt"), "two\n");
  git(["add", "-A"]); git(["commit", "-qm", "c2"]);
  const head = git(["rev-parse", "HEAD"]);
  return { scratch, repo, base, head };
}

const EVENTS = (text) => [
  JSON.stringify({ type: "thread.started", thread_id: "t1" }),
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4 } }),
].join("\n");

test("extractJson pulls the object out of prose or fences", () => {
  assert.deepEqual(extractJson('noise {"findings": []} trailing'), { findings: [] });
  assert.equal(extractJson("no json here"), null);
});

test("prompt embeds brief and diff, demands JSON-only response, mandates safe diff flags", () => {
  const p = buildPrompt({ brief: "B", diffText: "DIFFTEXT" });
  assert.ok(p.includes("B") && p.includes("DIFFTEXT"));
  assert.ok(p.includes("ONLY a JSON object"));
  assert.ok(p.includes("--no-textconv --no-ext-diff"));
});

test("schema-invalid findings (missing file/line) → error, not a scored result", async () => {
  const { scratch, repo, base, head } = fixtureRepo();
  const fake = async () => ({
    stdout: EVENTS('{"findings":[{"severity":"Critical"}]}'),
    stderr: "", timedOut: false, spawnError: false,
  });
  const r = await review({ worktree: repo, diffRange: `${base}..${head}`, brief: "B" }, { runCodex: fake });
  assert.equal(r.status, "error");
  assert.ok(r.error.includes("schema validation"));
  rmSync(scratch, { recursive: true, force: true });
});

test("review: happy path normalizes findings and records usage", async () => {
  const { scratch, repo, base, head } = fixtureRepo();
  const fake = async () => ({
    stdout: EVENTS('{"findings":[{"file":"f.txt","line":1,"severity":"high","summary":"s","mechanism":"m"}]}'),
    stderr: "", timedOut: false, spawnError: false,
  });
  const r = await review({ worktree: repo, diffRange: `${base}..${head}`, brief: "B" }, { runCodex: fake });
  assert.equal(r.status, "ok");
  assert.equal(r.findings[0].severity, "Critical");
  assert.equal(r.verdict, "reject");
  assert.deepEqual(r.tokens, { input: 10, output: 4 });
  rmSync(scratch, { recursive: true, force: true });
});

test("review: failed terminal or unparseable message → error", async () => {
  const { scratch, repo, base, head } = fixtureRepo();
  const failed = async () => ({ stdout: JSON.stringify({ type: "turn.failed" }), stderr: "", timedOut: false, spawnError: false });
  const r1 = await review({ worktree: repo, diffRange: `${base}..${head}`, brief: "B" }, { runCodex: failed });
  assert.equal(r1.status, "error");
  const noJson = async () => ({ stdout: EVENTS("I think it looks fine."), stderr: "", timedOut: false, spawnError: false });
  const r2 = await review({ worktree: repo, diffRange: `${base}..${head}`, brief: "B" }, { runCodex: noJson });
  assert.equal(r2.status, "error");
  rmSync(scratch, { recursive: true, force: true });
});

test("oversized diff is refused, not truncated", async () => {
  const { scratch, repo, base } = fixtureRepo();
  const git = (args) => execFileSync("git", ["-C", repo, "-c", "user.email=b@l", "-c", "user.name=b", ...args], { encoding: "utf8" }).trim();
  writeFileSync(join(repo, "big.txt"), "x".repeat(MAX_DIFF_BYTES + 1024) + "\n");
  git(["add", "-A"]); git(["commit", "-qm", "big"]);
  const bigHead = git(["rev-parse", "HEAD"]);
  const fake = async () => { throw new Error("must not be called"); };
  const r = await review({ worktree: repo, diffRange: `${base}..${bigHead}`, brief: "B" }, { runCodex: fake });
  assert.equal(r.status, "error");
  assert.ok(r.error.includes("refusing"));
  rmSync(scratch, { recursive: true, force: true });
});

test("adapter id and stable version", () => {
  assert.equal(ADAPTER_ID, "codex");
  assert.match(version(), /^[0-9a-f]{12}$/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test benchmarks/harness/adapters/codex.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `benchmarks/harness/adapters/codex.mjs`**

```js
// Cross-provider reviewer via the codex CLI. Reuses runCodex + parseEventStream
// from the codex-review plugin (import-safe: that script main-guards its CLI).
// The diff is rendered here with --no-textconv --no-ext-diff and embedded in
// the prompt; codex runs read-only and never touches the worktree.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { normalizeSeverity, applyVerdictPolicy } from "../model.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const CODEX_MOD = join(HERE, "..", "..", "..", "plugins", "codex-review", "skills", "codex-plan-review", "scripts", "codex-review.mjs");
const { runCodex, parseEventStream } = await import(CODEX_MOD);

export const ADAPTER_ID = "codex";
export const MAX_DIFF_BYTES = 400_000;
const DEFAULT_MODEL = "gpt-5.6-terra";
const DEFAULT_EFFORT = "medium";

export function buildPrompt({ brief, diffText }) {
  return [
    "You are reviewing a committed code change for defects introduced by the change.",
    "",
    "## Change intent (task brief)",
    brief.trim(),
    "",
    "## Diff",
    "```diff",
    diffText,
    "```",
    "",
    "Report only defects introduced by this change — not pre-existing issues or style.",
    "Zero findings is a valid result if the change is correct.",
    "If you re-derive any diff yourself, use EXACTLY: git diff --no-textconv --no-ext-diff <range> --",
    "(textconv/external-diff drivers execute repo-configured programs; never run an unflagged git diff).",
    "Respond with ONLY a JSON object, no prose, in exactly this shape:",
    '{"findings": [{"file": "path", "line": 1, "severity": "Critical|Important|Minor", "summary": "one sentence", "mechanism": "what goes wrong at runtime and why"}]}',
  ].join("\n");
}

export function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

export function version() {
  // Complete behavior hash: this module (prompt, defaults, extraction,
  // normalization), the shared model code, and the imported codex-review
  // module — a parseEventStream/runCodex fix must invalidate cached cells.
  return createHash("sha256")
    .update(readFileSync(SELF))
    .update(readFileSync(join(HERE, "..", "model.mjs")))
    .update(readFileSync(CODEX_MOD))
    .digest("hex").slice(0, 12);
}

export async function review(
  { worktree, diffRange, brief, model = DEFAULT_MODEL, effort = DEFAULT_EFFORT },
  deps = { runCodex },
) {
  let diffText;
  try {
    diffText = execFileSync("git",
      ["-C", worktree, "diff", "--no-textconv", "--no-ext-diff", diffRange, "--"],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  } catch (e) { return { status: "error", error: `git diff failed: ${String(e.message).split("\n")[0]}` }; }
  if (Buffer.byteLength(diffText, "utf8") > MAX_DIFF_BYTES) {
    return { status: "error", error: `diff exceeds ${MAX_DIFF_BYTES} bytes — refusing, not truncating` };
  }
  const prompt = buildPrompt({ brief, diffText });
  const args = ["exec", "--json", "--sandbox", "read-only", "-m", model,
    "-c", `model_reasoning_effort=${effort}`, "--skip-git-repo-check", prompt];
  const t0 = process.hrtime.bigint();
  const res = await deps.runCodex(args, { cwd: worktree, timeoutMs: 600_000 });
  const wallMs = Number((process.hrtime.bigint() - t0) / 1_000_000n);
  if (res.spawnError) return { status: "error", error: `codex spawn failed: ${res.stderr.slice(0, 200)}` };
  if (res.timedOut) return { status: "error", error: "codex timed out" };
  const stream = parseEventStream(res.stdout);
  if (stream.terminal !== "completed" || !stream.finalMessage) {
    return { status: "error", error: `codex terminal=${stream.terminal}, no final message` };
  }
  const parsed = extractJson(stream.finalMessage);
  if (!parsed || !Array.isArray(parsed.findings)) {
    return { status: "error", error: "codex output had no parseable findings JSON" };
  }
  const validFinding = (f) => f && typeof f.file === "string" && Number.isInteger(f.line)
    && typeof f.summary === "string" && typeof f.mechanism === "string";
  if (!parsed.findings.every(validFinding)) {
    return { status: "error", error: "codex findings failed schema validation (need file, integer line, summary, mechanism)" };
  }
  const findings = parsed.findings.map((f) => ({ ...f, severity: normalizeSeverity(f.severity) }));
  return {
    status: "ok",
    verdict: applyVerdictPolicy({ findings, threshold: "Critical" }),
    findings,
    tokens: stream.usage
      ? { input: stream.usage.input_tokens ?? 0, output: stream.usage.output_tokens ?? 0 }
      : null,
    wallMs, raw: parsed,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test benchmarks/harness/adapters/codex.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add benchmarks/harness/adapters/codex.mjs benchmarks/harness/adapters/codex.test.mjs
git commit -m "feat(benchmarks): codex adapter reusing runCodex/parseEventStream"
```

---

### Task 10: Two-stage matcher + judge fixtures

**Files:**
- Create: `benchmarks/harness/matcher.mjs`
- Create: `benchmarks/harness/fixtures/judge-cases.json`
- Test: `benchmarks/harness/matcher.test.mjs`

**Interfaces:**
- Consumes: `buildClaudeArgs`, `runClaude` (Task 6); `cacheKey` (Task 5).
- Produces: `locationMatch(finding, truth, tolerance=5) → boolean`, `JUDGE_SCHEMA`, `buildJudgePrompt(finding, truth) → string`, `MATCHER_CONFIG = {tolerance, judgeModel, judgePromptVersion}`, `judgeMechanism(finding, truth, deps) → Promise<{ok, match?, reason?, error?}>`, `matchCell(record, truth, {cache, deps}) → Promise<{catch: boolean, matchedFinding: number|null, nearMisses: number[], errors: string[]}>`. Task 12 attaches the result as `record.match`; Task 11 consumes `record.match`.

- [ ] **Step 1: Write the failing tests**

`benchmarks/harness/matcher.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  locationMatch, buildJudgePrompt, MATCHER_CONFIG, matchCell, JUDGE_SCHEMA,
} from "./matcher.mjs";

const truth = { file: "src/x.mjs", span: [10, 12], mechanism: "the retry counter resets on every failure so it loops forever" };

test("locationMatch: path normalization and span tolerance", () => {
  assert.equal(locationMatch({ file: "src/x.mjs", line: 10 }, truth), true);
  assert.equal(locationMatch({ file: "./src/x.mjs", line: 17 }, truth), true);  // 12+5
  assert.equal(locationMatch({ file: "b/src/x.mjs", line: 5 }, truth), true);   // 10-5
  assert.equal(locationMatch({ file: "src/x.mjs", line: 18 }, truth), false);
  assert.equal(locationMatch({ file: "src/y.mjs", line: 11 }, truth), false);
});

test("judge prompt is blind: both mechanisms present, no harness vocabulary", () => {
  const p = buildJudgePrompt({ summary: "S", mechanism: "FM" }, truth);
  assert.ok(p.includes("FM") && p.includes(truth.mechanism));
  for (const leak of ["seeded", "harness", "benchmark", "corpus"]) {
    assert.ok(!p.toLowerCase().includes(leak), `prompt leaks "${leak}"`);
  }
});

test("MATCHER_CONFIG is stable and versions the judge prompt", () => {
  assert.equal(MATCHER_CONFIG.tolerance, 5);
  assert.equal(MATCHER_CONFIG.judgeModel, "sonnet");
  assert.match(MATCHER_CONFIG.judgePromptVersion, /^[0-9a-f]{12}$/);
});

const rec = (findings) => ({ findings, status: "ok" });
const yes = async () => ({ ok: true, structured: { match: true, reason: "same defect" } });
const no = async () => ({ ok: true, structured: { match: false, reason: "different complaint" } });

test("matchCell: judge-confirmed location hit is a catch", async () => {
  const r = await matchCell(rec([{ file: "src/x.mjs", line: 11, summary: "s", mechanism: "m" }]), truth, { deps: { runClaude: yes } });
  assert.equal(r.catch, true);
  assert.equal(r.matchedFinding, 0);
});

test("matchCell: right location, judge-rejected → near miss, no catch", async () => {
  const r = await matchCell(rec([{ file: "src/x.mjs", line: 11, summary: "s", mechanism: "m" }]), truth, { deps: { runClaude: no } });
  assert.equal(r.catch, false);
  assert.deepEqual(r.nearMisses, [0]);
});

test("matchCell: wrong location is never judged", async () => {
  const boom = async () => { throw new Error("judge must not run"); };
  const r = await matchCell(rec([{ file: "other.mjs", line: 1, summary: "s", mechanism: "m" }]), truth, { deps: { runClaude: boom } });
  assert.deepEqual(r, { catch: false, matchedFinding: null, nearMisses: [], errors: [] });
});

test("matchCell: judge verdicts are cached", async () => {
  const store = new Map();
  const cache = { get: (k) => store.get(k) ?? null, put: (k, v) => store.set(k, v) };
  let calls = 0;
  const counting = async () => { calls++; return { ok: true, structured: { match: true, reason: "r" } }; };
  const f = [{ file: "src/x.mjs", line: 11, summary: "s", mechanism: "m" }];
  await matchCell(rec(f), truth, { cache, deps: { runClaude: counting } });
  await matchCell(rec(f), truth, { cache, deps: { runClaude: counting } });
  assert.equal(calls, 1);
});

test("matchCell: judge error is recorded, not thrown", async () => {
  const err = async () => ({ ok: false, error: "api down" });
  const r = await matchCell(rec([{ file: "src/x.mjs", line: 11, summary: "s", mechanism: "m" }]), truth, { deps: { runClaude: err } });
  assert.equal(r.catch, false);
  assert.deepEqual(r.errors, ["api down"]);
});

test("judge schema demands match + reason", () => {
  assert.deepEqual(JUDGE_SCHEMA.required, ["match", "reason"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test benchmarks/harness/matcher.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `benchmarks/harness/matcher.mjs`**

```js
// Two-stage catch decision. Stage 1 is deterministic (file + line-in-span±5);
// stage 2 asks a sonnet judge whether the finding describes the planted
// MECHANISM (right line + wrong complaint is a near miss, not a catch).
// The judge prompt+schema are hashed into MATCHER_CONFIG — the oracle is part
// of baseline identity, and judge verdicts are cached by content.
import { createHash } from "node:crypto";
import { buildClaudeArgs, runClaude } from "./claude-cli.mjs";
import { cacheKey } from "./cache.mjs";

export const JUDGE_SCHEMA = {
  type: "object",
  properties: { match: { type: "boolean" }, reason: { type: "string" } },
  required: ["match", "reason"],
};

export function locationMatch(finding, truth, tolerance = 5) {
  const norm = (p) => String(p ?? "").replace(/^\.\//, "").replace(/^[ab]\//, "");
  if (norm(finding.file) !== norm(truth.file)) return false;
  return Number.isInteger(finding.line)
    && finding.line >= truth.span[0] - tolerance
    && finding.line <= truth.span[1] + tolerance;
}

export function buildJudgePrompt(finding, truth) {
  return [
    "A known code defect exists at a specific location. Its ground-truth description:",
    `MECHANISM: ${truth.mechanism}`,
    "",
    "A code reviewer reported this finding at the same location:",
    `SUMMARY: ${finding.summary}`,
    `MECHANISM: ${finding.mechanism}`,
    "",
    "Question: does the reviewer's finding describe the SAME defect — the same underlying",
    "mechanism of misbehavior — as the ground truth? The same location with a different",
    "complaint (style, a different bug, a vague \"this looks wrong\") is NOT a match.",
    "A paraphrase of the same runtime misbehavior IS a match. Answer via the schema.",
  ].join("\n");
}

export const MATCHER_CONFIG = {
  tolerance: 5,
  judgeModel: "sonnet",
  judgePromptVersion: createHash("sha256")
    .update(buildJudgePrompt({ summary: "V", mechanism: "V" }, { mechanism: "V", span: [1, 1], file: "V" }))
    .update(JSON.stringify(JUDGE_SCHEMA))
    .digest("hex").slice(0, 12),
};

export async function judgeMechanism(finding, truth, deps = { runClaude }) {
  const args = buildClaudeArgs({
    prompt: buildJudgePrompt(finding, truth),
    model: MATCHER_CONFIG.judgeModel,
    schema: JUDGE_SCHEMA,
    allowedTools: [],
  });
  const res = await deps.runClaude(args, { timeoutMs: 120_000 });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, match: res.structured.match === true, reason: res.structured.reason };
}

// First judge-confirmed hit wins (later location hits are left unjudged — they
// cannot change the catch verdict, and judging them would only spend tokens).
export async function matchCell(record, truth, { cache = null, deps = { runClaude } } = {}) {
  const out = { catch: false, matchedFinding: null, nearMisses: [], errors: [] };
  for (let i = 0; i < record.findings.length; i++) {
    const f = record.findings[i];
    if (!locationMatch(f, truth, MATCHER_CONFIG.tolerance)) continue;
    const key = cacheKey({
      kind: "judge",
      finding: { summary: f.summary, mechanism: f.mechanism },
      truthMechanism: truth.mechanism,
      cfg: MATCHER_CONFIG,
    });
    let verdict = cache?.get(key) ?? null;
    if (!verdict) {
      const j = await judgeMechanism(f, truth, deps);
      if (!j.ok) { out.errors.push(j.error); continue; }
      verdict = j;
      cache?.put(key, j);
    }
    if (verdict.match) { out.catch = true; out.matchedFinding = i; return out; }
    out.nearMisses.push(i);
  }
  return out;
}

// Manual judge calibration: node benchmarks/harness/matcher.mjs --self-eval
// (real API calls — never run in CI).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
    && process.argv.includes("--self-eval")) {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join } = await import("node:path");
  const here = fileURLToPath(new URL(".", import.meta.url));
  const cases = JSON.parse(readFileSync(join(here, "fixtures", "judge-cases.json"), "utf8"));
  let wrong = 0;
  for (const c of cases) {
    const j = await judgeMechanism(c.finding, c.truth);
    const got = j.ok ? j.match : "ERROR";
    const okMark = got === c.expected ? "ok " : (wrong++, "BAD");
    console.log(`${okMark} expected=${c.expected} got=${got} — ${c.name}`);
  }
  console.log(`${cases.length - wrong}/${cases.length} correct`);
  process.exit(wrong ? 1 : 0);
}
```

- [ ] **Step 4: Write `benchmarks/harness/fixtures/judge-cases.json`**

```json
[
  {
    "name": "exact same mechanism, different words",
    "truth": { "file": "src/parse-duration.mjs", "span": [2, 2], "mechanism": "The hours multiplier added to UNITS is 600000 (ten minutes in ms) instead of 3600000, so every hour-denominated duration parses to one-sixth of its correct value." },
    "finding": { "summary": "Hours constant is wrong", "mechanism": "h maps to 600000 ms which is 10 minutes, not one hour; '2h' returns 1200000 instead of 7200000." },
    "expected": true
  },
  {
    "name": "same line, style complaint",
    "truth": { "file": "src/parse-duration.mjs", "span": [2, 2], "mechanism": "The hours multiplier added to UNITS is 600000 instead of 3600000, so hour durations parse to one-sixth of their value." },
    "finding": { "summary": "Use named constants", "mechanism": "Magic numbers in the UNITS table hurt readability; extract MS_PER_HOUR." },
    "expected": false
  },
  {
    "name": "same line, different bug theory",
    "truth": { "file": "src/parse-duration.mjs", "span": [2, 2], "mechanism": "The hours multiplier added to UNITS is 600000 instead of 3600000, so hour durations parse to one-sixth of their value." },
    "finding": { "summary": "Regex misses uppercase units", "mechanism": "The pattern only accepts lowercase h so '2H' throws unexpectedly." },
    "expected": false
  },
  {
    "name": "vague this-looks-wrong",
    "truth": { "file": "src/retry.mjs", "span": [14, 16], "mechanism": "The retry counter is reset inside the catch block, so a persistently failing call retries forever instead of stopping after maxRetries." },
    "finding": { "summary": "Retry logic looks suspicious", "mechanism": "Something about the loop bounds here seems off and should be double-checked." },
    "expected": false
  },
  {
    "name": "same infinite-retry mechanism, consequence-first phrasing",
    "truth": { "file": "src/retry.mjs", "span": [14, 16], "mechanism": "The retry counter is reset inside the catch block, so a persistently failing call retries forever instead of stopping after maxRetries." },
    "finding": { "summary": "Infinite retry loop on persistent failure", "mechanism": "attempts is zeroed every iteration inside the error handler, so the maxRetries bound can never be reached and the loop never exits." },
    "expected": true
  },
  {
    "name": "correct mechanism class, wrong direction",
    "truth": { "file": "src/paginate.mjs", "span": [8, 8], "mechanism": "The slice end index omits the final element of each page (off by one short), so every page silently drops its last row." },
    "finding": { "summary": "Page overlap", "mechanism": "The slice bounds double-count the boundary element, so the last row of each page repeats as the first row of the next." },
    "expected": false
  }
]
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test benchmarks/harness/matcher.test.mjs`
Expected: PASS (9 tests). Do NOT run `--self-eval` here (real API; it is a manual calibration tool).

- [ ] **Step 6: Commit**

```bash
git add benchmarks/harness/matcher.mjs benchmarks/harness/matcher.test.mjs benchmarks/harness/fixtures/judge-cases.json
git commit -m "feat(benchmarks): two-stage matcher with cached sonnet mechanism judge"
```

---

### Task 11: Scorecard

**Files:**
- Create: `benchmarks/harness/scorecard.mjs`
- Test: `benchmarks/harness/scorecard.test.mjs`

**Interfaces:**
- Consumes: `SEVERITY_WEIGHT` (Task 6), `cacheKey` (Task 5), `locationMatch` (Task 10, for knownIssues exclusion). Input records carry `record.match` on seeded ok-cells (attached by Task 12).
- Produces: `COVERAGE_FLOOR = 0.95`, `ERROR_CEILING = 0.20`, `median(xs) → number|null`, `populationId({manifestHash, config}) → hex`, `computeScorecard({records, truthsById, manifestHash, config, baseline, baselinesExist}) → scorecard`, `renderMarkdown(scorecard) → string`. The scorecard object carries `{status: "OK"|"INFORMATIONAL"|"UNRELIABLE", exitCode, adapters, strata, floors}`.

**Scoring policy (implement exactly):**
- An item is *scored* for an adapter×arm when at least `ceil(trials/2)` of its cells are `status:"ok"`; its catch verdict is the majority of ok trials.
- Stratum = adapter × arm × bug class. Stratum coverage = scored items ÷ attempted items; `< COVERAGE_FLOOR` ⇒ stratum `notScored: true`, its rates withheld.
- Catch rate (seeded strata): majority-catch items ÷ scored items.
- Over-rejection (clean arm, per adapter): per item, mean over ok cells of (Σ `SEVERITY_WEIGHT[f.severity]` over findings not location-matching any `truth.knownIssues` entry, + 3 if `verdict === "reject"` with zero findings); adapter value = mean over scored items.
- Mechanism accuracy (per adapter): Σ catches ÷ (Σ catches + Σ near-misses) over seeded ok cells; null when denominator 0.
- Flip rate (per adapter, trials > 1): items whose ok-cell catch verdicts disagree ÷ scored seeded items.
- Error rate (per adapter): cells with any `status` ≠ `"ok"` (including `"oracle-error"`) ÷ attempted cells.
- `status`: `UNRELIABLE` (exit 2) if any adapter error rate > `ERROR_CEILING`, or if a baseline with matching `populationId` covers a stratum that is `notScored`. `INFORMATIONAL` (exit 0, floors skipped) if a baseline is provided but its `populationId` differs, OR if `baselinesExist` is true and no matching baseline was provided (a recorded baseline that can't bind must be visible, not silently ignored). Otherwise `OK`; floors evaluated only here.
- Floors: per adapter, `catchRate >= baseline.catchRate - 0.10` and `overRejection <= baseline.overRejection * 1.5`; any breach ⇒ exit 1.

- [ ] **Step 1: Write the failing tests** — build records with a helper; cover each policy line:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { median, populationId, computeScorecard, COVERAGE_FLOOR, ERROR_CEILING } from "./scorecard.mjs";

const TRUTHS = {
  "item-a": { class: "wrong-constant", file: "src/a.mjs", span: [2, 2], severity: "Critical", mechanism: "m", knownIssues: [] },
  "item-b": { class: "off-by-one", file: "src/b.mjs", span: [7, 7], severity: "Critical", mechanism: "m", knownIssues: [{ file: "src/b.mjs", span: [40, 44] }] },
};
const CONFIG = { arms: ["clean", "seeded"], trialsPolicy: { default: 3, codex: 1 }, adapters: { rev: { version: "v1", model: "sonnet" } }, matcher: { tolerance: 5, judgeModel: "sonnet", judgePromptVersion: "abc" } };

function cell(over = {}) {
  return { item: "item-a", arm: "seeded", adapter: "rev", adapterVersion: "v1", trial: 0,
    status: "ok", verdict: "pass", findings: [], tokens: { input: 1, output: 1 }, wallMs: 10,
    cacheHit: false, error: null, ...over };
}
const seededCatch = (item, trial) => cell({ item, trial, match: { catch: true, matchedFinding: 0, nearMisses: [], errors: [] }, verdict: "reject" });
const seededMiss = (item, trial) => cell({ item, trial, match: { catch: false, matchedFinding: null, nearMisses: [], errors: [] } });
const cleanCell = (item, trial, over = {}) => cell({ item, trial, arm: "clean", ...over });

function fullRun({ aCatches = 3 } = {}) {
  const records = [];
  for (let t = 0; t < 3; t++) {
    records.push(t < aCatches ? seededCatch("item-a", t) : seededMiss("item-a", t));
    records.push(seededCatch("item-b", t));
    records.push(cleanCell("item-a", t));
    records.push(cleanCell("item-b", t));
  }
  return records;
}

test("median", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

test("clean full run: OK, catch rate 1, over-rejection 0, exit 0", () => {
  const sc = computeScorecard({ records: fullRun(), truthsById: TRUTHS, manifestHash: "m1", config: CONFIG, baseline: null });
  assert.equal(sc.status, "OK");
  assert.equal(sc.exitCode, 0);
  assert.equal(sc.adapters.rev.catchRate, 1);
  assert.equal(sc.adapters.rev.overRejection, 0);
  assert.equal(sc.adapters.rev.flipRate, 0);
});

test("majority catch + flip rate: 2-of-3 catches counts, and flips", () => {
  const sc = computeScorecard({ records: fullRun({ aCatches: 2 }), truthsById: TRUTHS, manifestHash: "m1", config: CONFIG, baseline: null });
  assert.equal(sc.adapters.rev.catchRate, 1);
  assert.equal(sc.adapters.rev.flipRate, 0.5); // item-a flipped, item-b did not
});

test("verdict-only clean rejection weighs 3; knownIssue findings excluded", () => {
  const records = fullRun();
  records.push(cleanCell("item-a", 3, { verdict: "reject", findings: [] }));
  records.push(cleanCell("item-b", 3, {
    findings: [{ file: "src/b.mjs", line: 42, severity: "Critical", summary: "s", mechanism: "m" }],
  }));
  const cfg = { ...CONFIG, trialsPolicy: { default: 4, codex: 1 } };
  const sc = computeScorecard({ records, truthsById: TRUTHS, manifestHash: "m1", config: cfg, baseline: null });
  // item-a: trials [0,0,0,3] → mean 3/4 = 0.75; item-b known-issue finding excluded → 0. Adapter mean = 0.375.
  assert.equal(sc.adapters.rev.overRejection, 0.375);
});

test("error cells: stratum under coverage floor is notScored; >20% errors → UNRELIABLE exit 2", () => {
  const records = fullRun();
  // fullRun is 12 cells; 4 errors → 4/16 = 25% > ERROR_CEILING (3 would be
  // exactly 20%, which the policy's strict > does NOT trip).
  for (let t = 0; t < 4; t++) {
    records.push(cell({ item: "item-a", trial: t + 10, status: "error", error: "boom", verdict: null }));
  }
  const sc = computeScorecard({ records, truthsById: TRUTHS, manifestHash: "m1", config: CONFIG, baseline: null });
  assert.equal(sc.status, "UNRELIABLE");
  assert.equal(sc.exitCode, 2);
});

test("population mismatch → INFORMATIONAL, floors skipped, exit 0", () => {
  const baseline = { populationId: "different", adapters: { rev: { catchRate: 1, overRejection: 0 } } };
  const sc = computeScorecard({ records: fullRun({ aCatches: 0 }), truthsById: TRUTHS, manifestHash: "m1", config: CONFIG, baseline });
  assert.equal(sc.status, "INFORMATIONAL");
  assert.equal(sc.exitCode, 0);
  assert.deepEqual(sc.floors.breaches, []);
});

test("baselines exist but none match → INFORMATIONAL, floors skipped", () => {
  const sc = computeScorecard({ records: fullRun(), truthsById: TRUTHS, manifestHash: "m1", config: CONFIG, baseline: null, baselinesExist: true });
  assert.equal(sc.status, "INFORMATIONAL");
  assert.equal(sc.exitCode, 0);
});

test("matching population with breached catch floor → exit 1", () => {
  const pid = populationId({ manifestHash: "m1", config: CONFIG });
  const baseline = { populationId: pid, adapters: { rev: { catchRate: 1, overRejection: 0 } } };
  const sc = computeScorecard({ records: fullRun({ aCatches: 0 }), truthsById: TRUTHS, manifestHash: "m1", config: CONFIG, baseline });
  assert.equal(sc.status, "OK");
  assert.equal(sc.exitCode, 1);
  assert.ok(sc.floors.breaches.some((b) => b.includes("catchRate")));
});

test("constants exported for the runner", () => {
  assert.equal(COVERAGE_FLOOR, 0.95);
  assert.equal(ERROR_CEILING, 0.20);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test benchmarks/harness/scorecard.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `benchmarks/harness/scorecard.mjs`** — implement the scoring policy block above exactly, plus:

```js
import { SEVERITY_WEIGHT } from "./model.mjs";
import { cacheKey } from "./cache.mjs";
import { locationMatch } from "./matcher.mjs";

export const COVERAGE_FLOOR = 0.95;
export const ERROR_CEILING = 0.20;

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function populationId({ manifestHash, config }) {
  return cacheKey({ manifestHash, config });
}
```

`computeScorecard` structure (fill in the policy):

```js
export function computeScorecard({ records, truthsById, manifestHash, config, baseline = null }) {
  // 1. group records by adapter → arm → item; ok/error partition
  // 2. per adapter×arm×item: scored? (>= ceil(trials/2) ok), majority catch, flip
  //    (trials = config.trialsPolicy[adapterId] ?? config.trialsPolicy.default)
  // 3. strata: adapter×arm×class from truthsById[item].class; coverage; notScored
  // 4. adapter aggregates: catchRate, overRejection (knownIssues excluded via
  //    locationMatch(f, {file, span}, config.matcher.tolerance)), mechanismAccuracy,
  //    flipRate, errorRate, medianTokens, medianWallMs
  // 5. pid = populationId({manifestHash, config}); status + floors + exitCode per policy
  // 6. return { generatedFrom: manifestHash, populationId: pid, status, exitCode,
  //             adapters, strata, floors: { evaluated, breaches } }
}

export function renderMarkdown(scorecard) {
  // status banner, per-adapter table (catch rate, over-rejection, mech accuracy,
  // flip rate, error rate, coverage, median tokens/wall), strata table with
  // NOT-SCORED markers, floors section listing breaches or "no baseline".
}
```

The comment-only bodies above are structure hints — the implementer writes the full ~150-line implementation against the failing tests and the **Scoring policy** block, which is normative.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test benchmarks/harness/scorecard.test.mjs`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add benchmarks/harness/scorecard.mjs benchmarks/harness/scorecard.test.mjs
git commit -m "feat(benchmarks): stratified scorecard with floors and coverage gates"
```

---

### Task 12: Runner CLI + hermetic smoke

**Files:**
- Create: `benchmarks/harness/run.mjs`
- Test: `benchmarks/harness/run.test.mjs`
- Create-or-modify: `.gitignore` (add `benchmarks/results/`)

**Interfaces:**
- Consumes: everything above by the exact names each task's Interfaces block declares.
- Produces: `parseRunArgs(argv) → config`, `mulberry32(seed) → () => float`, `sampleItems(items, n, seed) → items`, `hashItemContent(itemDir) → hex`, `expandCells({items, arms, adapterIds, trialsFor}) → cells`, `loadBaseline(path, pid) → {baseline: object|null, baselinesExist: boolean}`, `runHarness(config, deps?) → Promise<{scorecard, resultsDir, exitCode}>`, CLI main guard.

**Runner policy (implement exactly):**
- Default corpus dirs: `benchmarks/corpus/reviewer` plus `~/Work/Git/claude-skills-bench-corpus/reviewer` when that directory exists.
- Abort (exit 2, listing problems) when the validator reports any error; `--allow-missing` maps to the validator's default (warnings for unresolvable repos), its absence maps to `requireRepos: true`.
- Defaults: `--adapters` unset → `null`, meaning *all registered adapters* (resolved against the registry inside `runHarness`, never hardcoded strings — Task 7's probe decides that adapter's final id); `--arms clean,seeded`, `--trials 3`, `--codex-trials 1`, `--seed 42`, `--model sonnet`, `--effort medium`; `--sample N` picks a seeded-random subset; `--no-cache` bypasses reads (still writes).
- **Model routing is per adapter:** Claude-family adapters (and the judge) receive `config.model`; the codex adapter always uses its own `DEFAULT_MODEL` with `config.effort`. The runner must never pass a Claude model name to codex. Each cell's cache key carries that cell's *effective* model/effort values.
- **Per-cell scratch:** the runner creates a `scratch/` dir beside each cell's worktree and passes it as `scratchDir` to `adapter.review` — the SDD package file can never race across the four-wide lane.
- Cache key per cell: `{itemContent: hashItemContent(itemDir), arm, adapter, adapterVersion, model, effort, trial}`. Only `status:"ok"` results are cached (errors are transient).
- Concurrency lanes: `codex` lane width 1; all other adapters share a lane of width 4.
- Every cell materializes fresh and `cleanup()`s in a `finally`.
- **Baselines are loaded by the runner** (`--baselines`, default `benchmarks/baselines.json`): compute `populationId({manifestHash, config})` first, then `loadBaseline(path, pid)` selects the entry whose `populationId` matches (`baseline: null` when none does; `baselinesExist` reflects whether the file has any entries). Both are passed to `computeScorecard` — a recorded baseline must never be silently bypassable.
- After cells: `matchCell` for every seeded ok-record (judge cache = same `CellCache`). A seeded record whose match returned `errors` and no catch is **reclassified `status: "oracle-error"`** — it drops out of scored cells and joins the error-rate/coverage gates; a judge outage must surface as harness unreliability, never as a reviewer miss. Then `computeScorecard`; write `records.jsonl`, `scorecard.json`, `scorecard.md` under `benchmarks/results/runs/<ISO-stamp>/`; print the markdown; return the scorecard's exit code.

- [ ] **Step 1: Write the failing tests**

`benchmarks/harness/run.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { parseRunArgs, sampleItems, hashItemContent, expandCells, runHarness } from "./run.mjs";
import { DEFAULT_CORPUS } from "./validate.mjs";

test("parseRunArgs defaults and overrides", () => {
  const d = parseRunArgs([]);
  assert.equal(d.adapters, null); // null = all registered adapters, resolved in runHarness
  assert.equal(d.trials, 3);
  assert.equal(d.codexTrials, 1);
  assert.equal(d.seed, 42);
  const o = parseRunArgs(["--adapters", "code-review", "--trials", "1", "--sample", "5", "--no-cache", "--allow-missing"]);
  assert.deepEqual(o.adapters, ["code-review"]);
  assert.equal(o.sample, 5);
  assert.equal(o.noCache, true);
  assert.equal(o.allowMissing, true);
});

test("sampleItems is deterministic for a seed and a strict subset", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: `i${i}` }));
  const a = sampleItems(items, 4, 42).map((x) => x.id);
  const b = sampleItems(items, 4, 42).map((x) => x.id);
  assert.deepEqual(a, b);
  assert.equal(a.length, 4);
  assert.notDeepEqual(sampleItems(items, 4, 43).map((x) => x.id), a);
});

test("hashItemContent changes when any item file changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-hash-"));
  execFileSync("cp", ["-R", join(DEFAULT_CORPUS, "synthetic-0001") + "/.", dir]);
  const h1 = hashItemContent(dir);
  assert.equal(h1, hashItemContent(dir));
  execFileSync("bash", ["-c", `echo tweak >> ${JSON.stringify(join(dir, "brief.md"))}`]);
  assert.notEqual(hashItemContent(dir), h1);
  rmSync(dir, { recursive: true, force: true });
});

test("expandCells honors per-adapter trial counts", () => {
  const cells = expandCells({
    items: [{ id: "a" }], arms: ["clean", "seeded"], adapterIds: ["code-review", "codex"],
    trialsFor: (id) => (id === "codex" ? 1 : 3),
  });
  assert.equal(cells.filter((c) => c.adapter === "code-review").length, 6);
  assert.equal(cells.filter((c) => c.adapter === "codex").length, 2);
});

test("loadBaseline selects by populationId; reports whether entries exist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-baseline-"));
  const path = join(dir, "baselines.json");
  const { writeFileSync } = await import("node:fs");
  const { loadBaseline } = await import("./run.mjs");
  writeFileSync(path, JSON.stringify({ baselines: [
    { label: "v1", populationId: "pid-a", adapters: { rev: { catchRate: 1, overRejection: 0 } } },
    { label: "v2", populationId: "pid-b", adapters: { rev: { catchRate: 0.9, overRejection: 1 } } },
  ] }));
  assert.equal(loadBaseline(path, "pid-b").baseline.label, "v2");
  assert.equal(loadBaseline(path, "pid-x").baseline, null);
  assert.equal(loadBaseline(path, "pid-x").baselinesExist, true);
  assert.deepEqual(loadBaseline(join(dir, "missing.json"), "pid-a"), { baseline: null, baselinesExist: false });
  rmSync(dir, { recursive: true, force: true });
});

test("hermetic smoke: stub adapter end-to-end, then full cache hit", async () => {
  const resultsDir = mkdtempSync(join(tmpdir(), "bench-run-"));
  const stub = {
    ADAPTER_ID: "stub",
    version: () => "stub-v1",
    review: async ({ worktree, diffRange }) => {
      const diff = execFileSync("git", ["-C", worktree, "diff", "--no-textconv", "--no-ext-diff", diffRange, "--"], { encoding: "utf8" });
      if (diff.includes("h: 600_000")) {
        return { status: "ok", verdict: "reject", findings: [{ file: "src/parse-duration.mjs", line: 2, severity: "Critical", summary: "wrong hours multiplier", mechanism: "hours multiplier is 600000 not 3600000, so hour durations are one-sixth of correct" }], tokens: { input: 0, output: 0 }, wallMs: 1, raw: {} };
      }
      return { status: "ok", verdict: "pass", findings: [], tokens: { input: 0, output: 0 }, wallMs: 1, raw: {} };
    },
  };
  const deps = {
    adapters: { stub },
    judgeRunClaude: async () => ({ ok: true, structured: { match: true, reason: "stub" } }),
  };
  const config = parseRunArgs(["--adapters", "stub", "--trials", "1", "--results", resultsDir]);
  config.corpusDirs = [DEFAULT_CORPUS];
  const r1 = await runHarness(config, deps);
  assert.equal(r1.exitCode, 0);
  assert.equal(r1.scorecard.adapters.stub.catchRate, 1);
  assert.equal(r1.scorecard.adapters.stub.overRejection, 0);
  const runDir = r1.resultsDir;
  assert.ok(existsSync(join(runDir, "records.jsonl")));
  assert.ok(existsSync(join(runDir, "scorecard.md")));
  const lines = readFileSync(join(runDir, "records.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2); // 1 item × 2 arms × 1 adapter × 1 trial
  const r2 = await runHarness(config, deps);
  const lines2 = readFileSync(join(r2.resultsDir, "records.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(lines2.every((rec) => rec.cacheHit === true));
  rmSync(resultsDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test benchmarks/harness/run.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `benchmarks/harness/run.mjs`** per the Runner policy. Key shapes:

```js
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleItems(items, n, seed) {
  const rand = mulberry32(seed);
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(n, pool.length)).sort((a, b) => a.id.localeCompare(b.id));
}

export function hashItemContent(itemDir) {
  // walk itemDir recursively, sort relative paths, sha256(relPath + "\0" + bytes) chained
}

export function expandCells({ items, arms, adapterIds, trialsFor }) {
  const cells = [];
  for (const item of items) for (const arm of arms) for (const adapter of adapterIds) {
    for (let trial = 0; trial < trialsFor(adapter); trial++) cells.push({ item, arm, adapter, trial });
  }
  return cells;
}
```

`runHarness(config, deps)`: validator gate → item load (parse `item.json`/`truth.json`/`brief.md` per dir) → optional sample → manifest hash (`cacheKey` over sorted `{id, hash}` pairs) → adapter registry (`deps.adapters` ?? dynamic import of the three real adapters, keyed by `ADAPTER_ID`) → lane pool (codex=1, default=4; a ~15-line promise pool, no dependency) → per-cell: cache check / materialize / `adapter.review` / `makeCellRecord` / cache put / `cleanup()` in `finally` → seeded matcher pass (judge deps: `deps.judgeRunClaude` ?? real `runClaude`) → `computeScorecard` → write artifacts → return. The CLI main guard runs `runHarness(parseRunArgs(process.argv.slice(2)))` and `process.exit`s with the returned code.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test benchmarks/harness/run.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Gitignore the results tree**

```bash
grep -qxF "benchmarks/results/" .gitignore 2>/dev/null || echo "benchmarks/results/" >> .gitignore
```

- [ ] **Step 6: Run the whole suite**

Run: `scripts/run-node-tests.sh`
Expected: all files pass, including every `benchmarks/**` test added so far.

- [ ] **Step 7: Commit**

```bash
git add benchmarks/harness/run.mjs benchmarks/harness/run.test.mjs .gitignore
git commit -m "feat(benchmarks): cached lane-pooled runner CLI with hermetic smoke"
```

---

### Task 13: Docs, baselines template, repo README line

**Files:**
- Create: `benchmarks/baselines.json`
- Create: `benchmarks/README.md`
- Modify: `README.md` (one line)

**Interfaces:**
- Consumes: the CLI surface from Task 12 (documented, not imported).
- Produces: operator documentation; the empty baselines file the scorecard reads.

- [ ] **Step 1: Write `benchmarks/baselines.json`**

```json
{
  "baselines": []
}
```

Entry schema (documented in the README, enforced by `loadBaseline`'s selection): each entry is
`{"label": "first-freeze", "frozenAt": "2026-07-20", "populationId": "<from scorecard.json>", "adapters": {"<adapter-id>": {"catchRate": 0.0, "overRejection": 0.0}}}` — copied by hand from a real run's `scorecard.json`, never written by the harness itself.

- [ ] **Step 2: Write `benchmarks/README.md`** covering, in this order (a paragraph or short list each — write real prose, not headings-only): what the harness measures (catch rate / over-rejection / mechanism accuracy on paired clean+seeded diffs — link the spec `docs/superpowers/specs/2026-07-18-eval-harness-design.md`); quickstart (`node benchmarks/harness/run.mjs` and the flag table from Task 12's policy); corpus item anatomy (the six files, JSON not YAML, `base/` for synthetic); the public/private corpus split (`~/Work/Git/claude-skills-bench-corpus` auto-included when present; never commit private diffs here); cost + quota notes (codex trials default 1, `--sample`, cache semantics — what re-runs are free); baseline workflow (first real full run → copy `scorecard.json`'s `populationId` + per-adapter `catchRate`/`overRejection` into a `baselines.json` entry by hand; floors are health floors, ratcheted only by explicit decision); adjudication workflow (persistent clean-arm findings → human review → `knownIssues` in the item's `truth.json`; note it changes cache keys and baseline identity); judge calibration (`node benchmarks/harness/matcher.mjs --self-eval`, manual, real API); authoring new corpus items (miner/seeder agent pipeline summary from the spec + `node benchmarks/harness/validate.mjs` before committing).

- [ ] **Step 3: Add one line to the repo `README.md`** in the repository-layout/overview section (match its existing list style):

```markdown
- `benchmarks/` — offline evaluation harness for the owned review stack (see `benchmarks/README.md`)
```

- [ ] **Step 4: Validate docs-adjacent invariants**

Run: `scripts/run-node-tests.sh` and `node benchmarks/harness/validate.mjs`
Expected: suite green; `1 item(s), 0 error(s)`.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/baselines.json benchmarks/README.md README.md
git commit -m "docs(benchmarks): operator guide, baselines template, README pointer"
```

---

## Open Questions / Unresolved Assumptions

- **Which path Task 7's probe lands on is unknown until it runs.** The probe (one real call) decides whether the adapter invokes the actual `/code-review` skill or ships an honestly-named `claude-review` direct prompt; either way the shipped id and probe output are recorded in the task report, and no baseline can claim to measure the skill it doesn't.
- **`--allowed-tools` in `-p` mode is assumed to pre-authorize exactly those tools without interactive prompting** (Tasks 7–8). The smoke test stubs `runClaude`, so the first real corpus run is the verification point.
- **Codex token usage may be null** when `turn.completed` carries no usage (Task 9); the scorecard must tolerate null token medians for an adapter.
- **The mechanism judge is a single yes/no call**, no self-consistency vote (Task 10). Revisit if judged-catch flip rates come back high.
- **Item-level scoring policy** — `ceil(trials/2)` ok-cells to score an item, majority-of-trials catch — is a policy choice (Tasks 11–12); freezing the first baseline may warrant `--trials 5`.
- **The private corpus repo (`~/Work/Git/claude-skills-bench-corpus`) does not exist yet**; the runner includes it only when present (Task 12). Creating and populating it is the first mining pass — operational work after this build, not a task here.
- **`synthetic-0001`'s truth span `[2,2]`** assumes the `UNITS` line lands on line 2 of the seeded file; the validator's hunk-coverage check plus the matcher's ±5 tolerance absorb small drift (Tasks 2, 10).


