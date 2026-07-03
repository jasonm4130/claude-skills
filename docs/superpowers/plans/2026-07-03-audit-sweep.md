# Audit Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development:subagent-driven-development` (this repo's SDD workflow — the superpowers post-plan skills are denied in this environment). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix everything actionable from the 2026-07-03 four-agent usage audit: repo housekeeping and doc truth, CI consistency enforcement, and two new/upgraded workflow gates (ship-gate, ambient retro batching, escalating context nudge) that convert dead user-directed nudges into agent-directed action.

**Architecture:** Repo tasks follow the established plugin conventions (self-contained ESM plugins, flag-file Stop→UserPromptSubmit nudge pattern pioneered by session-retro). A new repo-consistency test makes marketplace/plugin/README drift a CI failure. Config changes to `~/.claude` are **not** workflow tasks — they are chezmoi-managed and executed by the controller in-session (see Appendix).

**Tech Stack:** Node 18+ stdlib-only `.mjs`, `node --test`, bash CI runner, jq.

## Global Constraints

Copied from plugin `CLAUDE.md` conventions — every task inherits these:

- **ESM only.** Every script is `.mjs`. No CommonJS, no `package.json`, no `require`.
- **Stdlib only.** Allowed imports: `node:fs`, `node:fs/promises`, `node:path`, `node:os`, `node:process`, `node:child_process`, `node:url`, `node:test`, `node:assert/strict`.
- **`// @ts-check` at the top of every script**, JSDoc `@typedef` for stdin payload shapes.
- **Graceful degradation:** any JSON parse error, missing payload, or missing file → `process.exit(0)` silently. Hooks never crash the session.
- `path.join` always; `os.tmpdir()` never `/tmp`; flag files are plain text, not JSON.
- `additionalContext` output uses the full `hookSpecificOutput` envelope via `lib.mjs`'s `emitAdditionalContext`.
- Hook registrations in `hooks/hooks.json` use `"${CLAUDE_PLUGIN_ROOT}/scripts/<name>.mjs"` with `"timeout": 5`.
- Plugin manifests: `plugins/<name>/.claude-plugin/plugin.json` with `"engines": { "claude-code": ">=2.1.110" }`.
- **Version sync:** any `plugin.json` version bump must be mirrored in `.claude-plugin/marketplace.json` (Task 3's test enforces this).
- Verify with `bash scripts/run-node-tests.sh` (runs every `*.test.mjs`); it must be green before every commit.
- Commit messages: lowercase scope prefixes matching repo history (`docs:`, `ci:`, `plugins:`, `retro:`, `handoff:`, `chore:`).
- **Never touch `~/.claude` or dotfiles from workflow tasks** — controller-only (Appendix).

---

## Task 1: Housekeeping commit

**Files:**
- Delete: `.playwright-mcp/` (untracked debug logs from 2026-05-30)
- Commit: `.gitignore` (already-modified: adds `/.claude/handoffs/`)
- Commit: `RESEARCH_what_gives_best_deep_research.md`, `RESEARCH_issue_driven_development.md` (as design provenance, matching the already-tracked `RESEARCH_subagent_driven_workflow.md`)

**Interfaces:** none — pure git ops.

- [ ] **Step 1: Remove debris**

```bash
rm -rf .playwright-mcp
```

- [ ] **Step 2: Stage and commit**

```bash
git add .gitignore RESEARCH_what_gives_best_deep_research.md RESEARCH_issue_driven_development.md
git commit -m "chore: commit research provenance + gitignore handoffs dir, drop playwright debris"
```

- [ ] **Step 3: Verify clean**

Run: `git status --porcelain`
Expected: no `.gitignore`, `RESEARCH_*`, or `.playwright-mcp` entries remain.

## Task 2: README rewrite

**Files:**
- Modify: `README.md` (full replacement)

**Interfaces:**
- Produces: README containing one backticked name per marketplace plugin (Task 3's test asserts `` `<name>` `` appears for every entry).

Current README lists 4 of 8 plugins, has two conflicting Install sections, a `skills/` repo-layout that no longer exists, and a hardcoded `handoff/0.2.0` path. Replace the entire file with:

- [ ] **Step 1: Replace README.md with exactly this content**

````markdown
# claude-skills

A Claude Code plugin **marketplace** hosting multiple independent plugins.
Add the marketplace once, then install the plugins you want.

## Install

```
/plugin marketplace add jasonm4130/claude-skills
```

| Plugin | Description | Install command |
|---|---|---|
| `adr` | Intent → grounded, cited, build-ready ADR, handed to the SDD loop | `/plugin install adr@jasonm4130-claude-skills` |
| `adversarial-agents` | Configurable adversarial panel review for any artefact | `/plugin install adversarial-agents@jasonm4130-claude-skills` |
| `deep-dive` | Model-tiered, adversarially-verified multi-source research | `/plugin install deep-dive@jasonm4130-claude-skills` |
| `handoff` | Context-fill-triggered handoff doc, auto-loaded next session | `/plugin install handoff@jasonm4130-claude-skills` |
| `session-retro` | Session retrospectives that capture learnings to memory | `/plugin install session-retro@jasonm4130-claude-skills` |
| `subagent-driven-development` | Deterministic workflow-driven implement/review/fix loop | `/plugin install subagent-driven-development@jasonm4130-claude-skills` |
| `visual-plan` | Markdown-canonical ADR/plan, optional rich HTML companion | `/plugin install visual-plan@jasonm4130-claude-skills` |
| `workflow-model-guard` | PreToolUse guard nudging model tiering in high-fan-out Workflows | `/plugin install workflow-model-guard@jasonm4130-claude-skills` |

Full details per plugin: see `plugins/<name>/README.md`.

> **Node.js note:** `handoff`, `session-retro`, and `subagent-driven-development`
> require **Node.js 18+** on `PATH`. The handoff plugin also needs a one-time
> `statusLine` wire-up:
> `node "$(ls -d ~/.claude/plugins/cache/jasonm4130-claude-skills/handoff/*/scripts/setup.mjs | sort -V | tail -1)"`
> (the setup script installs a version-agnostic wrapper, so upgrades don't break it).

## Repo layout

```
.claude-plugin/marketplace.json   # marketplace manifest (all plugins registered here)
plugins/<name>/
  .claude-plugin/plugin.json      # per-plugin manifest
  skills/<skill>/SKILL.md         # skill definition + frontmatter
  hooks/hooks.json                # hook registrations (where applicable)
  scripts/ tests/                 # stdlib-only .mjs + node:test suites
docs/superpowers/{specs,plans}/   # design specs and implementation plans
scripts/run-node-tests.sh         # CI test runner
```

## Development

```bash
bash scripts/run-node-tests.sh    # run every *.test.mjs in one process
```

CI (`.github/workflows/ci.yml`) validates all JSON manifests, runs the node
test suite on ubuntu+macos (Node 24), and runs the SDD bash smoke tests.

## License

MIT — see `LICENSE`.

## Acknowledgements

`adversarial-agents` was prompted by Matt Pocock's [`grill-me`](https://github.com/mattpocock/skills/tree/main/skills/productivity/grill-me) skill. The panel-of-personas + severity-promotion pattern draws on Alireza Rezvani's [adversarial-reviewer](https://github.com/alirezarezvani/claude-skills) and zscole's [adversarial-spec](https://github.com/zscole/adversarial-spec). The full research synthesis behind the original design decisions lives in the originating dotfiles plan (`docs/plans/2026-05-16-skills-overhaul-research.md`).
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README — all 8 plugins, single install path, real repo layout"
```

## Task 3: Repo-consistency test + CI wiring

**Files:**
- Create: `scripts/repo-consistency.test.mjs`
- Modify: `scripts/run-node-tests.sh` (line 16: `find plugins` → `find plugins scripts`)
- Modify: `.claude-plugin/marketplace.json` (fix version drift the new test exposes)

**Interfaces:**
- Consumes: Task 2's README (plugin-name assertions).
- Produces: a green test that later tasks (5, 6, 7) must keep green when adding/bumping plugins.

Known drift this test must catch red-first: marketplace says `handoff 0.2.1` but `plugins/handoff/.claude-plugin/plugin.json` says `0.3.0`; check `workflow-model-guard` the same way (marketplace says `0.1.0`).

- [ ] **Step 1: Write the failing test**

```js
// scripts/repo-consistency.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const marketplace = JSON.parse(
  readFileSync(join(root, ".claude-plugin", "marketplace.json"), "utf8"),
);
const entries = marketplace.plugins;
const dirs = readdirSync(join(root, "plugins"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

test("every plugins/ dir is registered in marketplace.json and vice versa", () => {
  assert.deepEqual(entries.map((e) => e.name).sort(), [...dirs].sort());
});

test("every marketplace source points at ./plugins/<name>", () => {
  for (const e of entries) assert.equal(e.source, `./plugins/${e.name}`);
});

test("marketplace version matches each plugin.json version", () => {
  for (const e of entries) {
    const pj = JSON.parse(
      readFileSync(join(root, "plugins", e.name, ".claude-plugin", "plugin.json"), "utf8"),
    );
    assert.equal(
      e.version,
      pj.version,
      `${e.name}: marketplace ${e.version} != plugin.json ${pj.version}`,
    );
  }
});

test("README documents every plugin", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  for (const e of entries) {
    assert.ok(readme.includes("`" + e.name + "`"), `README missing ${e.name}`);
  }
});
```

- [ ] **Step 2: Run it — expect RED on version drift**

Run: `node --test scripts/repo-consistency.test.mjs`
Expected: FAIL — at minimum `handoff: marketplace 0.2.1 != plugin.json 0.3.0`.

- [ ] **Step 3: Fix the drift in marketplace.json**

Update each mismatched `version` field in `.claude-plugin/marketplace.json` to match its `plugin.json` (do NOT downgrade plugin.json).

- [ ] **Step 4: Run again — expect GREEN**

Run: `node --test scripts/repo-consistency.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire into CI runner**

In `scripts/run-node-tests.sh`, change the find line to:

```bash
while IFS= read -r f; do files+=("$f"); done < <(find plugins scripts -name '*.test.mjs' | sort)
```

- [ ] **Step 6: Full suite green, commit**

Run: `bash scripts/run-node-tests.sh`
Expected: all tests pass, file count increases by 1.

```bash
git add scripts/repo-consistency.test.mjs scripts/run-node-tests.sh .claude-plugin/marketplace.json
git commit -m "ci: repo-consistency test — marketplace/plugin/README sync (fixes handoff version drift)"
```

## Task 4: Structural skill tests for adversarial-agents + visual-plan

**Files:**
- Create: `plugins/adversarial-agents/skills/adversarial-agents/skill.test.mjs`
- Create: `plugins/visual-plan/skills/visual-plan/skill.test.mjs`

**Interfaces:** none — mirrors the pattern in `plugins/adr/skills/adr/skill.test.mjs`.

These are prose-only plugins with zero tests. Add cheap structural guards. **Before finalizing regexes, read each SKILL.md and confirm every assertion matches real text — adjust the regex, never the intent.** Anchors below were verified against the current files' frontmatter and opening sections.

- [ ] **Step 1: Write both tests**

```js
// plugins/adversarial-agents/skills/adversarial-agents/skill.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const s = readFileSync(join(here, "SKILL.md"), "utf8");

test("frontmatter: name, user-invoked only, trigger-rich description", () => {
  assert.match(s, /^---\nname: adversarial-agents\n/);
  assert.match(s, /disable-model-invocation: true/);
  assert.match(s, /description:.*grill me/i);
});

test("core mechanics are documented", () => {
  assert.match(s, /panel/i);
  assert.match(s, /persona/i);
  assert.match(s, /pre-commit|pre-commitment/i);
  assert.match(s, /artefact|artifact/i);
});
```

```js
// plugins/visual-plan/skills/visual-plan/skill.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const s = readFileSync(join(here, "SKILL.md"), "utf8");

test("frontmatter: name and trigger-rich description", () => {
  assert.match(s, /^---\nname: visual-plan\n/);
  assert.match(s, /description:.*ADR/);
  assert.match(s, /Triggers:/);
});

test("markdown-canonical contract is documented", () => {
  assert.match(s, /Markdown canonical/i);
  assert.match(s, /plan\.html/);
  assert.match(s, /mermaid/i);
});
```

- [ ] **Step 2: Run both — adjust regexes against the real files if any assertion misses**

Run: `node --test plugins/adversarial-agents/skills/adversarial-agents/skill.test.mjs plugins/visual-plan/skills/visual-plan/skill.test.mjs`
Expected: PASS. If an anchor is genuinely absent from a SKILL.md, that's a doc bug — fix the regex to a phrase that IS present and equally load-bearing.

- [ ] **Step 3: Full suite, commit**

Run: `bash scripts/run-node-tests.sh`

```bash
git add plugins/adversarial-agents/skills/adversarial-agents/skill.test.mjs plugins/visual-plan/skills/visual-plan/skill.test.mjs
git commit -m "plugins: structural skill tests for adversarial-agents + visual-plan"
```

## Task 5: New plugin — ship-gate v0.1.0

**Files:**
- Create: `plugins/ship-gate/.claude-plugin/plugin.json`
- Create: `plugins/ship-gate/hooks/hooks.json`
- Create: `plugins/ship-gate/scripts/lib.mjs` (verbatim copy: `cp plugins/session-retro/scripts/lib.mjs plugins/ship-gate/scripts/lib.mjs`)
- Create: `plugins/ship-gate/scripts/stop-check-unshipped.mjs`
- Create: `plugins/ship-gate/scripts/check-shipgate-flag.mjs`
- Create: `plugins/ship-gate/tests/stop-check-unshipped.test.mjs`
- Create: `plugins/ship-gate/tests/check-shipgate-flag.test.mjs`
- Create: `plugins/ship-gate/README.md` (short: what/why/hooks table, mirroring session-retro's README structure)
- Modify: `.claude-plugin/marketplace.json` (add entry), `README.md` (add table row) — Task 3's test enforces both.

**Interfaces:**
- Consumes: `lib.mjs` helpers `readStdin`, `safeJsonParse`, `resolveSessionId`, `resolveDataDir`, `emitAdditionalContext` (same signatures as session-retro's).
- Produces: flag files `shipgate-nudge-{sid}.flag`, `shipgate-last-sha-{sid}.txt` in `resolveDataDir("ship-gate-data")`.

**Design (audit rationale):** 28% of sessions commit work then trail off unpushed. Trigger = commits ahead of upstream, or a non-main branch with no upstream. Deliberately NOT dirty-working-tree (too noisy mid-feature). Throttle = once per HEAD SHA per session; new commits re-arm the nudge. The nudge is **agent-directed** so Claude acts instead of waiting for the user.

- [ ] **Step 1: Manifest + hooks**

```json
// plugins/ship-gate/.claude-plugin/plugin.json
{
  "name": "ship-gate",
  "description": "Stop-hook gate against trail-off: detects unpushed commits at turn end and injects an agent-directed nudge to review and finish the branch.",
  "version": "0.1.0",
  "author": { "name": "Jason Matthew" },
  "license": "MIT",
  "engines": { "claude-code": ">=2.1.110" }
}
```

```json
// plugins/ship-gate/hooks/hooks.json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/stop-check-unshipped.mjs\"", "timeout": 5 } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/check-shipgate-flag.mjs\"", "timeout": 5 } ] }
    ]
  }
}
```

- [ ] **Step 2: Write the failing tests**

```js
// plugins/ship-gate/tests/stop-check-unshipped.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "scripts", "stop-check-unshipped.mjs");

/** Run the hook with a synthetic payload; returns the data dir used. */
function runHook(cwd, sid) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "shipgate-"));
  execSync(`echo '${JSON.stringify({ session_id: sid, cwd })}' | node "${script}"`, {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
  });
  return dataDir;
}

/** Fresh repo with one commit on the given branch. */
function mkRepo(branch) {
  const dir = mkdtempSync(path.join(tmpdir(), "repo-"));
  const g = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  g(["init", "-q", "-b", branch]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  g(["commit", "--allow-empty", "-q", "-m", "init"]);
  return dir;
}

test("non-main branch with no upstream → nudge flag written", () => {
  const repo = mkRepo("feature-x");
  const dataDir = runHook(repo, "s1");
  const flag = path.join(dataDir, "shipgate-nudge-s1.flag");
  assert.ok(existsSync(flag));
  assert.match(readFileSync(flag, "utf8"), /feature-x/);
  rmSync(repo, { recursive: true, force: true });
});

test("main with no upstream → silent", () => {
  const repo = mkRepo("main");
  const dataDir = runHook(repo, "s2");
  assert.ok(!existsSync(path.join(dataDir, "shipgate-nudge-s2.flag")));
  rmSync(repo, { recursive: true, force: true });
});

test("same HEAD nudges once; new commit re-arms", () => {
  const repo = mkRepo("feature-y");
  const dataDir = mkdtempSync(path.join(tmpdir(), "shipgate-"));
  const run = () =>
    execSync(`echo '${JSON.stringify({ session_id: "s3", cwd: repo })}' | node "${script}"`, {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    });
  const flag = path.join(dataDir, "shipgate-nudge-s3.flag");
  run();
  assert.ok(existsSync(flag));
  rmSync(flag);
  run(); // same HEAD → throttled
  assert.ok(!existsSync(flag));
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "more"], { cwd: repo });
  run(); // new HEAD → re-armed
  assert.ok(existsSync(flag));
  rmSync(repo, { recursive: true, force: true });
});

test("non-git cwd → silent exit 0", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "notgit-"));
  const dataDir = runHook(dir, "s4");
  assert.ok(!existsSync(path.join(dataDir, "shipgate-nudge-s4.flag")));
});
```

```js
// plugins/ship-gate/tests/check-shipgate-flag.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "scripts", "check-shipgate-flag.mjs");

test("consumes flag and emits agent-directed additionalContext", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "shipgate-"));
  const flag = path.join(dataDir, "shipgate-nudge-dev.flag");
  writeFileSync(flag, "2 commit(s) on 'feature-x' not pushed to upstream");
  const out = execSync(`echo '{"session_id":"dev"}' | node "${script}"`, {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    encoding: "utf8",
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(parsed.hookSpecificOutput.additionalContext, /\[ship-gate\]/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /code-review/);
  assert.ok(!existsSync(flag), "flag consumed");
});

test("no flag → no output", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "shipgate-"));
  const out = execSync(`echo '{"session_id":"dev"}' | node "${script}"`, {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    encoding: "utf8",
  });
  assert.equal(out.trim(), "");
});
```

- [ ] **Step 3: Run tests — expect FAIL (scripts don't exist)**

Run: `node --test plugins/ship-gate/tests/`
Expected: FAIL with module-not-found on both scripts.

- [ ] **Step 4: Implement the two scripts**

```js
// plugins/ship-gate/scripts/stop-check-unshipped.mjs
#!/usr/bin/env node
// @ts-check
// Stop hook: detect unshipped work (commits ahead of upstream, or a non-main
// branch with no upstream) and write a nudge flag keyed to HEAD. Consumed by
// check-shipgate-flag.mjs on UserPromptSubmit. Working-tree dirtiness is
// deliberately ignored — mid-feature dirt is normal; unpushed commits are the
// trail-off signal.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { readStdin, safeJsonParse, resolveSessionId, resolveDataDir } from "./lib.mjs";

/**
 * @typedef {object} StopInput
 * @property {string} [session_id]
 * @property {string} [cwd]
 */

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string | null}
 */
function git(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const raw = await readStdin();
const payload = /** @type {StopInput | null} */ (safeJsonParse(raw));
const cwd =
  payload && typeof payload.cwd === "string" && payload.cwd.length > 0
    ? payload.cwd
    : process.cwd();
const sessionId = resolveSessionId(payload);
const dataDir = resolveDataDir("ship-gate-data");

if (git(["rev-parse", "--is-inside-work-tree"], cwd) !== "true") process.exit(0);

const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
if (!branch || branch === "HEAD") process.exit(0); // detached — stay silent

const head = git(["rev-parse", "HEAD"], cwd);
if (!head) process.exit(0);

/** @type {string | null} */
let detail = null;
const aheadRaw = git(["rev-list", "--count", "@{upstream}..HEAD"], cwd);
if (aheadRaw !== null) {
  const ahead = Number.parseInt(aheadRaw, 10);
  if (Number.isFinite(ahead) && ahead > 0) {
    detail = `${ahead} commit(s) on '${branch}' not pushed to upstream`;
  }
} else if (branch !== "main" && branch !== "master") {
  detail = `branch '${branch}' has no upstream — nothing is pushed`;
}

if (detail === null) process.exit(0);

// Throttle: once per HEAD per session — only new commits re-arm the nudge.
const lastShaFile = path.join(dataDir, `shipgate-last-sha-${sessionId}.txt`);
if (existsSync(lastShaFile)) {
  try {
    if (readFileSync(lastShaFile, "utf8").trim() === head) process.exit(0);
  } catch {
    // best-effort throttle — fall through
  }
}

try {
  writeFileSync(path.join(dataDir, `shipgate-nudge-${sessionId}.flag`), detail);
  writeFileSync(lastShaFile, head);
} catch {
  // best-effort
}
process.exit(0);
```

```js
// plugins/ship-gate/scripts/check-shipgate-flag.mjs
#!/usr/bin/env node
// @ts-check
// UserPromptSubmit hook: consume the shipgate flag → agent-directed
// additionalContext. Fire-once per flag set.

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  readStdin,
  safeJsonParse,
  resolveSessionId,
  resolveDataDir,
  emitAdditionalContext,
} from "./lib.mjs";

const raw = await readStdin();
const payload = safeJsonParse(raw);
const sessionId = resolveSessionId(payload);
const dataDir = resolveDataDir("ship-gate-data");
const flag = path.join(dataDir, `shipgate-nudge-${sessionId}.flag`);

if (!existsSync(flag)) process.exit(0);

/** @type {string} */
let detail;
try {
  detail = readFileSync(flag, "utf8");
} catch {
  process.exit(0);
}
try {
  unlinkSync(flag);
} catch {
  // best-effort — fire-once is desirable but a failed unlink shouldn't block emission
}

emitAdditionalContext(
  "UserPromptSubmit",
  `[ship-gate] Unshipped work: ${detail}. Before this session winds down, run /code-review on the branch diff, then finish the branch (push + PR — e.g. commit-commands:commit-push-pr) or state explicitly to the user what remains unshipped and why.`,
);
process.exit(0);
```

- [ ] **Step 5: Run tests — expect GREEN**

Run: `node --test plugins/ship-gate/tests/`
Expected: 6 tests pass.

- [ ] **Step 6: Register + document**

Add to `.claude-plugin/marketplace.json` `plugins` array (alphabetical position is not required; match existing style):

```json
{
  "name": "ship-gate",
  "source": "./plugins/ship-gate",
  "description": "Stop-hook gate against trail-off: detects unpushed commits at turn end and injects an agent-directed nudge to review and finish the branch.",
  "version": "0.1.0",
  "author": { "name": "Jason Matthew" },
  "license": "MIT",
  "keywords": ["ship", "stop-hook", "code-review", "finishing"],
  "category": "productivity"
}
```

Add a README table row: `` | `ship-gate` | Turn-end nudge to review + push unshipped commits | `/plugin install ship-gate@jasonm4130-claude-skills` | ``

Write `plugins/ship-gate/README.md` (~30 lines: purpose, trigger conditions, throttle semantics, the two hooks, env/data-dir notes — follow `plugins/session-retro/README.md` structure).

- [ ] **Step 7: Full suite green (repo-consistency now covers ship-gate), commit**

Run: `bash scripts/run-node-tests.sh`
Expected: PASS including `repo-consistency` and both new ship-gate test files.

```bash
git add plugins/ship-gate .claude-plugin/marketplace.json README.md
git commit -m "plugins: ship-gate v0.1.0 — turn-end unshipped-work gate (audit: 28% trail-off sessions)"
```

## Task 6: session-retro 0.6.0 — ambient batched retro

**Files:**
- Modify: `plugins/session-retro/scripts/stop-write-retro-flag.mjs` (append cross-session worthy log)
- Modify: `plugins/session-retro/scripts/check-retro-flag.mjs` (batch condition + agent-directed wording)
- Create: `plugins/session-retro/scripts/mark-retro-done.mjs`
- Modify: `plugins/session-retro/skills/retro/SKILL.md` (fired-flag step → mark-retro-done)
- Modify: `plugins/session-retro/tests/stop-write-retro-flag.test.mjs`, `tests/check-retro-flag.test.mjs`; Create: `tests/mark-retro-done.test.mjs`
- Modify: `plugins/session-retro/.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json` → `0.6.0`
- Modify: `plugins/session-retro/README.md` + `CLAUDE.md` (document the new behavior)

**Interfaces:**
- Produces: `retro-worthy.jsonl` (one line per retro-worthy session: `{"ts":"<iso>","sid":"<id>","reasons":"<text>"}`), `last-retro.txt` (ISO timestamp), `last-batch-nudge.txt` (ISO timestamp) — all in `resolveDataDir("session-retro-data")`.

**Design (audit rationale):** 60 per-session nudges → 3 retros in 21 days; the per-session "Consider running /retro" is dead UX while auto-memory already captures ambient facts. Replace with: per-session flags are consumed **silently** into a cross-session worthy-log; a nudge fires only when ≥3 worthy sessions AND ≥7 days since last retro (env-overridable `RETRO_BATCH_MIN_SESSIONS`, `RETRO_BATCH_MIN_DAYS`), at most once per 24h, and its wording instructs the **agent** to run the retro skill now unless the user objects. **Exception:** the PreCompact flag (`compact imminent`) keeps its immediate per-session emission — context loss is a hard event.

- [ ] **Step 1: Update tests first (RED)**

In `tests/check-retro-flag.test.mjs`:
- Flip the existing "emits nudge when flag present" assertion for **Stop-origin flags**: a flag whose content is not `compact imminent` must produce **no output** but must append one line to `retro-worthy.jsonl` (dedup: a second consume for the same sid must not append twice).
- Keep/add: flag content `compact imminent` still emits `[session-retro]` context immediately.
- Add batch cases: with `retro-worthy.jsonl` holding 3 entries newer than `last-retro.txt` (or no `last-retro.txt`) and `last-batch-nudge.txt` absent/stale >24h → output matches `/\[session-retro\] 3 retro-worthy sessions .* Run the retro skill now/`; with `last-batch-nudge.txt` fresh (<24h) → silent; with only 2 worthy entries → silent; with `last-retro.txt` 3 days old → silent. Use env overrides in tests where deterministic clocks are needed (write timestamps explicitly; never sleep).

New `tests/mark-retro-done.test.mjs`: running `echo '{"session_id":"dev"}' | node scripts/mark-retro-done.mjs` with `CLAUDE_PLUGIN_DATA` set writes `retro-fired-dev.flag` AND `last-retro.txt` containing a parseable ISO timestamp; also accepts the sid as `argv[2]` when stdin payload is empty.

Run: `node --test plugins/session-retro/tests/` — Expected: FAIL on the new/changed assertions.

- [ ] **Step 2: Implement mark-retro-done.mjs**

```js
#!/usr/bin/env node
// @ts-check
// Invoked by the /retro skill after a successful interview: records the
// per-session fired flag plus the cross-session last-retro timestamp.
// Session id comes from stdin payload or argv[2].

import { writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { readStdin, safeJsonParse, resolveSessionId, resolveDataDir, nowIso } from "./lib.mjs";

const raw = await readStdin();
const payload = safeJsonParse(raw);
const argSid = typeof process.argv[2] === "string" && process.argv[2].length > 0 ? process.argv[2] : null;
const sessionId = argSid ?? resolveSessionId(payload);
const dataDir = resolveDataDir("session-retro-data");

try {
  writeFileSync(path.join(dataDir, `retro-fired-${sessionId}.flag`), nowIso());
  writeFileSync(path.join(dataDir, "last-retro.txt"), nowIso());
} catch {
  // best-effort
}
process.exit(0);
```

- [ ] **Step 3: Rework check-retro-flag.mjs**

Keep the existing imports/payload handling. Replace the emission block with:

```js
const nudgeFlag = path.join(dataDir, `retro-nudge-${sessionId}.flag`);
const worthyLog = path.join(dataDir, "retro-worthy.jsonl");
const lastRetroFile = path.join(dataDir, "last-retro.txt");
const lastBatchFile = path.join(dataDir, "last-batch-nudge.txt");

// 1. Consume any per-session flag. PreCompact keeps immediate emission;
//    Stop-origin reasons are absorbed silently into the worthy log.
if (existsSync(nudgeFlag)) {
  let reasons = "";
  try {
    reasons = readFileSync(nudgeFlag, "utf8");
  } catch {
    process.exit(0);
  }
  try {
    unlinkSync(nudgeFlag);
  } catch {
    // best-effort
  }
  if (reasons.includes("compact imminent")) {
    emitAdditionalContext(
      "UserPromptSubmit",
      `[session-retro] This session: ${reasons}. Run the retro skill now to capture decisions/learnings before compaction, unless the user objects.`,
    );
    process.exit(0);
  }
  // Dedup: one worthy line per session.
  let seen = false;
  if (existsSync(worthyLog)) {
    try {
      seen = readFileSync(worthyLog, "utf8").includes(`"sid":"${sessionId}"`);
    } catch {
      seen = false;
    }
  }
  if (!seen) {
    try {
      appendFileSync(worthyLog, JSON.stringify({ ts: nowIso(), sid: sessionId, reasons }) + "\n");
    } catch {
      // best-effort
    }
  }
}

// 2. Batch decision.
const minSessions = Number.parseInt(process.env.RETRO_BATCH_MIN_SESSIONS ?? "3", 10);
const minDays = Number.parseInt(process.env.RETRO_BATCH_MIN_DAYS ?? "7", 10);

let lastRetroMs = 0;
if (existsSync(lastRetroFile)) {
  try {
    const t = Date.parse(readFileSync(lastRetroFile, "utf8").trim());
    if (Number.isFinite(t)) lastRetroMs = t;
  } catch {
    lastRetroMs = 0;
  }
}
const daysSince = (Date.now() - lastRetroMs) / 86400000;

let worthyCount = 0;
if (existsSync(worthyLog)) {
  try {
    for (const line of readFileSync(worthyLog, "utf8").split("\n")) {
      if (line.length === 0) continue;
      try {
        const e = JSON.parse(line);
        const t = Date.parse(typeof e.ts === "string" ? e.ts : "");
        if (Number.isFinite(t) && t > lastRetroMs) worthyCount += 1;
      } catch {
        continue;
      }
    }
  } catch {
    worthyCount = 0;
  }
}

let batchNudgedRecently = false;
if (existsSync(lastBatchFile)) {
  try {
    const t = Date.parse(readFileSync(lastBatchFile, "utf8").trim());
    batchNudgedRecently = Number.isFinite(t) && Date.now() - t < 86400000;
  } catch {
    batchNudgedRecently = false;
  }
}

if (worthyCount >= minSessions && daysSince >= minDays && !batchNudgedRecently) {
  try {
    writeFileSync(lastBatchFile, nowIso());
  } catch {
    // best-effort
  }
  emitAdditionalContext(
    "UserPromptSubmit",
    `[session-retro] ${worthyCount} retro-worthy sessions since the last retro (${Math.floor(daysSince)}+ days). Run the retro skill now to batch-capture learnings, unless the user objects.`,
  );
}
process.exit(0);
```

(Adjust imports: add `appendFileSync`, `writeFileSync`, `nowIso`. `stop-write-retro-flag.mjs` needs **no** change — the worthy-log append lives in the consumer, keeping one writer per file.)

- [ ] **Step 4: Update SKILL.md**

Find the step that writes `retro-fired-{sid}.flag` and replace it with: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/mark-retro-done.mjs" <session_id>` after the interview completes. Document that this also resets the batch clock.

- [ ] **Step 5: GREEN + docs + version**

Run: `node --test plugins/session-retro/tests/` — Expected: PASS.
Bump `plugin.json` and marketplace entry to `0.6.0`; update README/CLAUDE.md "How it works" for the batch design.

- [ ] **Step 6: Full suite, commit**

Run: `bash scripts/run-node-tests.sh`

```bash
git add plugins/session-retro .claude-plugin/marketplace.json
git commit -m "retro: 0.6.0 ambient batching — silent worthy-log, agent-directed weekly nudge (audit: 60 nudges -> 3 retros)"
```

## Task 7: handoff 0.4.0 — escalating context nudge

**Files:**
- Modify: `plugins/handoff/scripts/status-and-flag.mjs` (first-crossing → decade-crossing)
- Modify: `plugins/handoff/scripts/check-handoff-flag.mjs` (agent-directed, severity-tiered wording)
- Modify: `plugins/handoff/tests/status-and-flag.test.mjs`, `tests/check-handoff-flag.test.mjs`
- Modify: `plugins/handoff/.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json` → `0.4.0`
- Modify: `plugins/handoff/README.md` + `CLAUDE.md`

**Interfaces:**
- Consumes: existing flag file `handoff-nudge-{sid}.flag`, `last-context-pct-{sid}.txt` in `resolveDataDir("handoff-data")`; flag content format `context at <pct>% (threshold <t>%)` is preserved.

**Design (audit rationale):** the 70% nudge already exists but fires **once** per session and passively — marathon sessions (2,874 min; peak error counts) sail past it. Fire on every 10%-band crossing at/above threshold (70→80→90), and word the injection as an agent instruction with severity tiers.

- [ ] **Step 1: Update tests first (RED)**

In `tests/status-and-flag.test.mjs` add band-crossing cases (drive via sequential invocations with the same session id and `CLAUDE_PLUGIN_DATA`, feeding `used_percentage` without `HANDOFF_EFFECTIVE_MAX_TOKENS` for simplicity):
- 68 → 72: flag written (crossed 70-band at/above threshold)
- 72 → 75: no new flag (same band)
- 75 → 81: flag written
- 81 → 92: flag written
- 40 → 55: no flag (below threshold)

In `tests/check-handoff-flag.test.mjs`: flag content `context at 72% (threshold 70%)` → output matches `/\[handoff\].*run the handoff skill/i` and `/wrap the current step/i`; flag content `context at 91% (threshold 70%)` → output matches `/NOW/` and `/\/clear/`.

Run: `node --test plugins/handoff/tests/` — Expected: FAIL on the new cases.

- [ ] **Step 2: Implement the crossing change in status-and-flag.mjs**

Replace the first-crossing block (currently `if (currentPct >= threshold && lastPct < threshold)`) with:

```js
// Escalating nudges: fire on every 10%-band entry at/above the threshold
// (70 → 80 → 90), not just the first threshold crossing.
const band = Math.floor(currentPct / 10);
const lastBand = Math.floor(lastPct / 10);
if (currentPct >= threshold && band > lastBand) {
  const flagFile = path.join(dataDir, `handoff-nudge-${sid}.flag`);
  writeFileSync(flagFile, `context at ${Math.trunc(currentPct)}% (threshold ${threshold}%)`);
}
```

- [ ] **Step 3: Severity-tiered wording in check-handoff-flag.mjs**

Parse the pct from the consumed flag content (`/context at (\d+)%/`). Emit:
- pct ≥ 85: `[handoff] Context at <pct>% — run the handoff skill NOW, then tell the user to /clear and resume from the handoff. Do not start new work.`
- else: `[handoff] Context at <pct>% (past threshold). Wrap the current step, then run the handoff skill before starting anything new; suggest /clear to the user.`

Preserve the existing envelope/consume/fire-once semantics.

- [ ] **Step 4: GREEN + version + docs**

Run: `node --test plugins/handoff/tests/` — Expected: PASS.
Bump `plugin.json` + marketplace to `0.4.0`; update README/CLAUDE.md (band-crossing semantics, wording tiers).

- [ ] **Step 5: Full suite, commit**

Run: `bash scripts/run-node-tests.sh`

```bash
git add plugins/handoff .claude-plugin/marketplace.json
git commit -m "handoff: 0.4.0 escalating context nudges at 70/80/90 with agent-directed wording"
```

---

## Appendix: Controller-executed config changes (NOT workflow tasks)

These touch chezmoi-managed files (`chezmoi managed` confirms `~/.claude/settings.json` and all `~/.claude/hooks/*` are rendered copies) and `~/.claude` state. The controller performs them in-session after the workflow completes, with the user's standing approval from the plan gate. Sequence:

1. `chezmoi source-path ~/.claude/settings.json` → edit the source: remove `"Bash(ssh:*)"` and `"Bash(scp:*)"` from `permissions.allow`; remove the `graphify-nudge.sh` PreToolUse registration from `hooks`.
2. `chezmoi source-path ~/.claude/hooks/session-start.sh` → edit the source: `ls -1` → `ls -1t` in the plans-primer block.
3. `chezmoi apply` and diff-verify the rendered copies.
4. Archive stale plans (13 of 15; keep `encapsulated-roaming-perlis.md` and `giggly-plotting-pnueli.md`, both from 2026-07-02): `mv` the rest into `~/.claude/plans/archive/` (mv, not rm).
5. Prune 10 stale remote branches on `jasonm4130/claude-skills` (all merged via PRs #7–#16): `adr-doc-fix`, `adr-driven-development`, `ci-node24-plugin-demotions`, `feat/sdd-workflow-skill`, `visual-plan-skill`, `feat/deep-research-hybrid`, `feat/workflow-model-guard`, `fix/workflow-model-guard-reason-wording`, `feat/deep-dive-rename-guard-0.2.0`, `worktree-fix-handoff-context-bar-issue-6` — via `git push origin --delete <branch>` after confirming each tip is reachable from `main` (for squash-merged branches confirm via the merged PR, not `--merged`).
6. Deferred (needs user input, not part of this sweep): disabling vault-scoped plugins (`frontend-design`, `pyright-lsp`, `rust-analyzer-lsp`, `playwright`) and the orphaned `plugins/cache/ponytail` cleanup — both require explicit per-item user approval per memory policy.

No action needed on the superpowers SDD "name collision": all nine superpowers post-plan skills are already in `permissions.deny`; the listing is cosmetic.
