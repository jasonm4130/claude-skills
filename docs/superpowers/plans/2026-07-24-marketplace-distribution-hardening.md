# Marketplace distribution hardening

Fixes the distribution-layer defects found by a two-model audit (Fable + GPT-5.6-Sol,
2026-07-24) of this marketplace. All findings re-verified against `main` @ a06cc90 before
this plan was written.

Base branch: `fix/marketplace-distribution-hardening` (cut from `main`).

**Out of scope (deliberate):** the skill-evaluation finding (no invocation/outcome evals,
empty `benchmarks/baselines.json`). It is coupled to the unmerged `feat/eval-harness`
branch and gets its own pass.

## Global constraints

- Repo is a Claude Code plugin marketplace. Skills are Markdown; scripts are stdlib-only
  `.mjs` run under `node:test`. No new runtime dependencies, no new npm packages.
- Every task writes its failing test first, confirms it fails for the right reason, then
  makes it pass. Quote the red→green transition in the task report.
- Run `bash scripts/run-node-tests.sh` before declaring a task done.
- **Versions:** do NOT bump `plugin.json`/`marketplace.json` versions inside Tasks 1–4.
  `scripts/check-version-bumps.mjs` requires a version increase for every changed plugin
  file, so the branch is genuinely unmergeable without bumps — **Task 5 does them all in
  one place**, because `marketplace.json` is a single shared file that parallel tasks
  cannot safely co-edit. Intermediate commits failing `version-bump-check` is expected;
  the final branch state must pass.
- Touch only the files your task owns. Tasks run in parallel worktrees; editing another
  task's files causes merge conflicts.
- **The Workflow sandbox has no `fs`, no imports, no `Date.now`/`Math.random`**
  (`plugins/subagent-driven-development/workflows/sdd.mjs:3`). Anything a `workflows/*.mjs`
  is asked to do must be possible under that constraint.

---

# Task 1

**Owns:** `plugins/codex-review/skills/codex-plan-review/SKILL.md`,
`plugins/deep-dive/skills/deep-dive/SKILL.md`,
`plugins/visual-plan/skills/visual-plan/SKILL.md`,
`plugins/adversarial-agents/skills/adversarial-agents/SKILL.md`,
**`plugins/adversarial-agents/skills/adversarial-agents/skill.test.mjs`**,
`plugins/adr/skills/adr/SKILL.md`, and a NEW test file
`scripts/skill-frontmatter.test.mjs`.

## 1a. Invalid YAML frontmatter (3 skills)

`claude plugin validate plugins/<name>` fails on `codex-review`, `deep-dive`, and
`visual-plan` with:

```
frontmatter: YAML frontmatter failed to parse: YAML Parse error: Unexpected token.
At runtime this skill loads with empty metadata (all frontmatter fields silently dropped).
```

Cause: the `description:` value is an unquoted YAML plain scalar that contains a `": "`
sequence (e.g. codex-review's `...after any of: (1)...`), which terminates the scalar.
`plugins/frontend-design/.../SKILL.md` already single-quotes its description and passes —
match that style.

**Important nuance, do not "fix" beyond this:** Claude Code's *runtime loader* currently
tolerates these files (all three load with full descriptions today). The defect is that the
*official validator* rejects them, which blocks validator-based CI gating (Task 4) and
leaves the skills one loader change away from silently losing their metadata. Preserve each
description's text exactly — quote/escape only. Do not reword, shorten, or restructure any
description.

**Test first:** create `scripts/skill-frontmatter.test.mjs` that walks every
`plugins/*/skills/*/SKILL.md`, extracts the `---`-delimited frontmatter, and asserts it
parses AND that `description` is a non-empty string.

**Do not require `name`.** `plugins/handoff/skills/handoff/SKILL.md` and
`plugins/session-retro/skills/retro/SKILL.md` legitimately omit it (the skill name is taken
from the directory), and `claude plugin validate` passes both. Requiring `name` would flag
five files while the validator flags three, making the cross-check below impossible to
satisfy. Assert `name` only when present (non-empty if the key exists).

Node has no bundled YAML parser and no new dependency is allowed. Do **not** implement this
as a blocklist of bad patterns — a pattern check cannot catch a malformed *quoted* value
such as `description: "unterminated`, which `claude plugin validate` rejects, so the gate
Task 4 builds on it would be false. Instead write a small **fail-closed** parser for the
subset SKILL.md frontmatter actually uses: flat `key: value` pairs, single/double-quoted
scalars (scanning for a proper closing quote before end-of-line, honoring escapes), and
block scalars (`>`, `|`, with their indented continuations). Anything the parser cannot
confidently parse must **fail the test**, not pass by default. Keep it under ~60 lines.

Cross-check your parser against the real validator on all 17 plugins: it must flag exactly
the same files that `claude plugin validate plugins/<name>` flags — currently `codex-review`,
`deep-dive`, `visual-plan` and no others. Quote that comparison in the task report.

## 1b. `adversarial-agents` advertises triggers that can never fire

`plugins/adversarial-agents/skills/adversarial-agents/SKILL.md:3` sets
`disable-model-invocation: true`, but its description (line 4) ends with
`Use when user wants adversarial review, red-team a plan, stress-test a design, find holes,
devil's advocate, panel critique, or mentions "grill me"...`. Under that flag the skill is
absent from the model's skill listing, so none of those natural-language triggers can ever
fire; only `/adversarial-agents` works.

The identical defect was already fixed for `deep-dive` by making it model-invocable again
(commit 7c39408, v0.5.0). Check whether any other skill routes *into* this one
(`grep -rn "adversarial-agents" plugins/*/skills/*/SKILL.md`) before deciding.

**The existing test pins the current behavior:**
`plugins/adversarial-agents/skills/adversarial-agents/skill.test.mjs:12` asserts
`/disable-model-invocation: true/`. This task owns that test file precisely so the choice
below is implementable — whichever option you pick, the test must end up asserting the
behavior you chose, and you must say in the report that you changed it and why.

Pick ONE and state your reasoning in the task report:
- drop `disable-model-invocation: true` so the advertised triggers work (mirrors deep-dive),
  updating `skill.test.mjs:12` to assert its *absence*, or
- keep the flag and rewrite the description to state slash-only invocation, and document
  that in `plugins/adversarial-agents/README.md` (test unchanged).

Default to the first unless inbound routing exists that makes model-invocation harmful.

## 1c. "write an ADR" is ambiguous between two skills, with clashing output paths

Both skills claim the trigger and disagree on the artifact:
- `plugins/adr/skills/adr/SKILL.md:3` — trigger `"write an ADR for X"`, writes
  `docs/adr/YYYY-MM-DD-<slug>.md` (also at :43, :102).
- `plugins/visual-plan/skills/visual-plan/SKILL.md:3` — `Triggers: … "write an ADR"`, and
  at :135 writes `docs/adr/NNNN-<slug>.md`.

`adr` already disambiguates toward visual-plan; visual-plan does not disambiguate back. A
repo that uses both ends up with interleaved `0007-foo.md` and `2026-07-24-bar.md` in one
directory.

Fix: (i) unify on the **dated** scheme `docs/adr/YYYY-MM-DD-<slug>.md` — it is what `adr`
uses and what the user's own `~/Work/Git/CLAUDE.md` specifies — updating visual-plan:135 and
any other `NNNN` reference in that file; (ii) add one clause to visual-plan's description
pointing decide-and-build ADR work at `adr`, mirroring how `adr` points visual work at
visual-plan. Keep the added clause short; the description budget matters.

**Done when:** `scripts/skill-frontmatter.test.mjs` passes; `claude plugin validate
plugins/<name>` exits clean for codex-review, deep-dive, and visual-plan (quote the output);
all descriptions semantically unchanged apart from 1b/1c's deliberate edits;
`bash scripts/run-node-tests.sh` green.

---

# Task 2

**Owns:** `plugins/subagent-driven-development/workflows/sdd.mjs`,
`plugins/subagent-driven-development/skills/subagent-driven-development/SKILL.md` (only the
resume/ledger prose — NOT the workflow-path resolution block, Task 3 owns that),
`plugins/subagent-driven-development/README.md`, and SDD's existing workflow tests.

## The defect

SDD returns a path to a progress ledger it never creates, and has dead code for writing it:

- `workflows/sdd.mjs:152` defines `function ledgerLine(n, base7, head7, verdict)`. It has
  **zero call sites** (`grep -rn "ledgerLine" plugins/subagent-driven-development/` returns
  only the definition).
- `workflows/sdd.mjs:672` returns `ledgerPath: \`${cfg.workdir}/.sdd/progress.md\`` — nothing
  anywhere creates or appends to that file.
- `skills/.../SKILL.md` and `README.md` point users at `resumeFromRunId` for recovery, but
  Workflow resume is **session-scoped only**: per Claude Code's workflow docs, exiting the
  session starts the next run fresh.

So a controller crash or session restart loses replay state, and the advertised ledger
cannot support recovery — which matters most on exactly the long multi-wave runs SDD is for.

## What to do

**Writing the ledger from the workflow is impossible — do not attempt it.** `sdd.mjs:3`
documents the Workflow sandbox as "no imports, no fs, no `Date.now`/`Math.random`", so the
workflow cannot create or append `.sdd/progress.md`. The fix is therefore to **stop making
a claim the runtime cannot honor**:

1. Delete the dead `ledgerLine()` function (`sdd.mjs:152`).
2. Stop returning `ledgerPath` (`sdd.mjs:672`) — remove the key rather than pointing it at
   a file nothing writes.
3. Correct the prose in `skills/subagent-driven-development/SKILL.md` and `README.md`
   wherever it implies durable or cross-session recovery: state plainly that
   `resumeFromRunId` works **within the same Claude Code session only**, and that exiting
   the session starts the next run fresh.

**Test first.** Using the existing mocked-`agent()` harness (see
`workflows/sdd.orchestration.test.mjs` — do not run real agents), add a test asserting the
workflow's return value contains **no path-shaped key pointing at a file the run never
creates**. Assert specifically that `ledgerPath` is absent from the returned object.
Confirm it fails against current `main` (where `ledgerPath` is returned) before fixing.

Do NOT invent a replacement ledger mechanism in this task. If durable progress tracking is
wanted later it belongs in the *controller* (which is unsandboxed and can write files), not
the workflow — note that as a follow-up in your report, do not build it.

**Done when:** `ledgerLine` gone; no `ledgerPath` in the returned object; the new test
passes; SKILL.md and README state same-session-only resume; `bash scripts/run-node-tests.sh`
green.

---

# Task 3

**Owns:** the cached-path-resolution blocks in
`plugins/deep-dive/skills/deep-dive/SKILL.md`,
`plugins/subagent-driven-development/skills/subagent-driven-development/SKILL.md`,
`plugins/adr/skills/adr/SKILL.md`, `plugins/visual-plan/skills/visual-plan/SKILL.md`;
`plugins/handoff/scripts/setup.mjs`; `plugins/handoff/tests/setup.test.mjs`; and a NEW test
file `scripts/cached-path-pin.test.mjs`.

**Depends on Task 1** (same SKILL.md files, different regions) — do not start until Task 1
is merged.

## The defect

Both auditors found this independently. Every workflow-invoking skill resolves its `.mjs` by
globbing the plugin cache and taking the highest *cached* version:

```
ls -d "$HOME"/.claude/plugins/cache/jasonm4130-claude-skills/<plugin>/*/workflows/<script>.mjs | sort -V | tail -1
```

(`deep-dive/skills/deep-dive/SKILL.md:51-55`, `subagent-driven-development/.../SKILL.md:87-92`,
`adr/.../SKILL.md:97`, `visual-plan/.../SKILL.md:97`.) `plugins/handoff/scripts/setup.mjs`
does the same thing independently for the statusLine wrapper.

Cache presence is not activation state. Verified on this machine: the cache holds **4**
deep-dive versions (0.3.0, 0.4.0, 0.4.1, 0.5.0) and **6** SDD versions, including directories
carrying `.orphaned_at` markers the glob ignores. Consequences:

1. A rollback does not take effect — the newer cached workflow still runs.
2. A SKILL.md of version N can drive an `.mjs` of version M. The args contract changes across
   versions, so this degrades **semantically** rather than crashing.
3. The marketplace id `jasonm4130-claude-skills` is hardcoded, so a marketplace rename breaks
   resolution everywhere at once.

`${CLAUDE_PLUGIN_ROOT}` is unavailable in model scope (both SKILL.mds already say so), which
is why the glob exists — this is the "workflows are not a first-class plugin component" gap.

## What to do

**Pin against the TARGET plugin's version, never the owning skill's.** Resolvers cross
plugin boundaries: `plugins/adr/skills/adr/SKILL.md:97` is version `0.1.0` but resolves
`subagent-driven-development`, currently `0.5.0`. Pinning `adr`'s own version would produce
`…/subagent-driven-development/0.1.0/workflows/sdd.mjs`, a path that does not exist, and the
fallback would then silently restore exactly the arbitrary-version behavior being fixed.
Each pinned path must carry the version from the **resolved plugin's**
`.claude-plugin/plugin.json`.

**The snippets are not all workflows.** `plugins/visual-plan/skills/visual-plan/SKILL.md:97`
resolves a versioned cached **asset** (`assets/plan.css`), not a workflow. Scope this task to
*every* cached-path resolution snippet, and name the test for that scope (a name like
`scripts/cached-path-pin.test.mjs` is clearer than `workflow-version-pin`); otherwise a future
edit could restore highest-cache selection for visual-plan's CSS and pair newer assets with an
older skill undetected.

**Test first:** a test asserting that, for every SKILL.md containing a cached-path resolution
snippet, the version pinned in that snippet equals the `version` in the **resolved** plugin's
`.claude-plugin/plugin.json` (not the owning plugin's). Cover all four SKILL.md resolvers plus
any others you find by grepping for
`\.claude/plugins/cache/`. Confirm it fails now.

**The fallback must fail loud, not fall back to "newest".** A bare
`sort -V | tail -1` fallback reintroduces the primary bug in exactly the case that matters: if
the pinned directory is missing but a newer *orphaned* cache entry remains, the old behavior
runs the wrong version silently. Either drop the fallback entirely (error with a clear
"expected version X not installed; reinstall the plugin" message) or make it emit a visible
warning naming both the expected and the actually-selected version. Do not let a cache cleanup
or partial install silently defeat a rollback.

**The hardcoded marketplace id needs a regression check, not just a mention.** All four
snippets embed `jasonm4130-claude-skills`; a marketplace rename breaks every resolver at once,
silently and at runtime. Full de-hardcoding is out of scope (the snippets are shell executed
by an agent, with no variable to resolve), so instead assert it in the same test: every
cached-path snippet must use the marketplace id declared in `.claude-plugin/marketplace.json`
(`name`). A rename then fails CI loudly instead of failing users quietly.

Prefer the smallest change that makes the pin testable and keeps the snippets copy-pasteable
by a model mid-session. Do not build a shared resolver module that skills must import —
SKILL.md snippets are executed as shell by an agent, not imported.

**Handoff is in scope and is not deferrable.** `plugins/handoff/scripts/setup.mjs` generates
a wrapper that selects the highest cached version and hardcodes the marketplace id — the exact
defect this task exists to remove, in the one plugin whose wrapper executes on every session.
A plan that hardens the SKILL.md snippets while leaving this path untouched has not fixed the
bug.

There is a real tension to resolve rather than dodge: the wrapper's max-version selection is
*deliberate* — it exists so upgrading the plugin doesn't break a statusLine that
`~/.claude/settings.json` points at by absolute path, and `plugins/handoff/tests/setup.test.mjs`
pins that behavior. Read that test first. Then decide and **document** the upgrade/rollback
contract: the wrapper may keep resolving dynamically (so upgrades survive) provided it cannot
select an orphaned or rolled-back version — e.g. skip cache dirs carrying `.orphaned_at`, or
warn when the selected version differs from the installed manifest. Update
`setup.test.mjs` deliberately to assert whichever contract you choose, and state the reasoning
in your report.

Extend `scripts/cached-path-pin.test.mjs` (or add a sibling test) to cover the generated
wrapper's resolution logic, not just SKILL.md snippets — otherwise this path has no regression
gate. Task 4 also retains a `sort -V | tail -1` setup one-liner in the READMEs; flag it in your
report so Task 4 aligns its documented command with the contract you land on.

**Done when:** the new test passes; every cached-path snippet is version-exact against the
*resolved* plugin's manifest; the marketplace-id assertion is in place; no silent newest-wins
fallback remains; the handoff wrapper's upgrade/rollback contract is decided, tested, and
documented (not deferred); `bash scripts/run-node-tests.sh` green.

---

# Task 5

**Owns:** every `plugins/*/.claude-plugin/plugin.json` version field,
`.claude-plugin/marketplace.json`, and — because bumping a version invalidates the literal
pins Task 3 wrote — the cached-path pin strings in the four SKILL.md resolvers Task 3 edited.
(Sequential ownership transfer, not a conflict: Task 3 is long merged by the time this runs.)

**Depends on Tasks 1–4** — run last, after all content changes are merged. This task exists
because `marketplace.json` is a single shared file that parallel tasks cannot co-edit, and
because `scripts/check-version-bumps.mjs` requires a version increase for every plugin whose
files changed. Without this task the branch fails `version-bump-check` and cannot merge.

## What to do

Determine which plugins have changed on this branch relative to `main`:

```
git diff --name-only main...HEAD
```

For each plugin with a changed file outside the tool's dev-only exempt set (read
`scripts/check-version-bumps.mjs` — it documents the exemptions; tests and docs may not
require a bump), bump its `plugin.json` `version` and the matching entry in
`marketplace.json`. **Both must move together** —
`scripts/repo-consistency.test.mjs` enforces equality between them.

Semver guidance:
- **patch** — quoting/escaping fixes, doc corrections, README changes, internal test changes
  with no behavior change.
- **minor** — a change to what the model can do or when a skill fires: dropping
  `disable-model-invocation` on `adversarial-agents`, removing the returned `ledgerPath` from
  SDD's workflow contract, version-exact resolution changing how a skill loads its script.

**Then re-pin.** Bumping a version breaks Task 3's invariant by construction: if SDD moves
`0.5.0` → `0.5.1`, the pins in *both* SDD's and ADR's SKILL.md still name `0.5.0` and
`cached-path-pin.test.mjs` fails. After bumping, update every cached-path pin that names a
bumped plugin — including cross-plugin resolvers (ADR resolves SDD) — and re-run the pin
test. Treat a red `cached-path-pin.test.mjs` as this task's own failure, not Task 3's.

**Done when:** `node scripts/check-version-bumps.mjs <mergeBase>` passes;
`cached-path-pin.test.mjs` passes against the *bumped* versions;
`bash scripts/run-node-tests.sh` green (this includes the marketplace↔plugin.json equality
assertion); no plugin with substantive changes left unbumped.

---

# Task 4

**Owns:** `.github/workflows/ci.yml`, `README.md`,
`plugins/handoff/scripts/load-pending-handoff.mjs`,
**`plugins/handoff/tests/load-pending-handoff.test.mjs`**, `plugins/handoff/README.md`,
`plugins/codex-review/README.md`.

**Depends on Tasks 1 and 3** — the validator gate will fail CI until Task 1's YAML fix has
landed. Do not start until both are merged. Task 5 runs after this one.

## 4a. CI cannot catch what it never checks

`.github/workflows/ci.yml` validates JSON with `jq` (:14-18), runs node tests (:31-33),
`plugins/subagent-driven-development/scripts/scripts.test.sh` (:43), and
`scripts/check-version-bumps.mjs` (:69). It never runs Claude Code's own plugin validator —
which is why three skills sat in a green CI while failing `claude plugin validate`.

Add a gate. **Do not assume the `claude` CLI is installable in GitHub Actions** — verify it
(auth requirements, network, licensing) before depending on it. Order of preference:

1. Run `claude plugin validate` per `plugins/*` directory in CI, if the CLI can be installed
   and run non-interactively without credentials.
2. Otherwise, gate on the failure mode directly: extend the repo's own node tests so the
   frontmatter check from Task 1 runs in CI across every plugin, and state in a comment why
   the CLI route was rejected.

Whichever you pick, the gate must fail CI on a reintroduced unparseable frontmatter. Prove it:
temporarily break one description, show CI logic rejecting it, restore it, show it passing.

## 4b. handoff is silently inert when its statusLine wire-up is skipped

`README.md:34-38` requires a one-time `node …/handoff/scripts/setup.mjs` after install. The
context-fill nudge only runs as a statusLine, and nothing detects the missing wiring — a user
who installs and skips the step gets a plugin that looks installed and never nudges.

Fix: `plugins/handoff/scripts/load-pending-handoff.mjs` already runs on SessionStart. Have it
check whether `~/.claude/settings.json` configures a handoff statusLine and, if not, emit a
one-time hint to run `setup.mjs`. Must fail open — never block or error a session if
settings.json is absent, unreadable, or unparseable. Do not write to settings.json.

Three constraints this must satisfy — all three are why this task owns the test file:

1. **It breaks the existing empty-output contract.** `tests/load-pending-handoff.test.mjs`
   asserts empty stdout for a missing marker (:100), a stale marker (:122), and a refused
   traversal/poisoned marker (:139). A hint emitted before the missing-marker early-exit
   fails those. Update the benign cases (missing/stale) deliberately, and **keep the
   refused/poisoned path silent** — that silence is a security property (a refused marker
   must never cause output), so gate the hint on the clean no-marker path only.
2. **"One-time" needs a persistence contract.** A naive fail-open implementation re-emits the
   hint every session. Specify where the "already hinted" marker lives (a dotfile under
   `~/.claude/`, not settings.json), when it is cleared, and what happens if it is
   unwritable — then test first-session-emits and second-session-silent explicitly.
3. **Detect any valid statusLine, not just the stable wrapper.** `setup.mjs` writes
   `~/.claude/handoff-statusline.mjs`, but a statusLine pointing directly at a versioned
   `…/handoff/<version>/scripts/status-and-flag.mjs` is a working pre-wrapper configuration
   that `setup.mjs` explicitly handles as migration input. Treat either form as configured;
   hinting at a user whose handoff already works is a false alarm.

Also: root `README.md` and `plugins/handoff/README.md` give two different setup one-liners
(`ls -d … | sort -V | tail -1` vs `echo … | tr ' ' '\n' | sort -V | tail -n1`). Keep one.

## 4c. Node dependence is understated

`README.md:34-35` names only `handoff`, `session-retro`, and SDD as needing Node. But hooks
invoke `node` in `design-gate-guard`, `docs-sync-guard`, `ship-gate`,
`workflow-model-guard` (`hooks/hooks.json`), and **`superpowers-core`**
(`hooks/session-start:10` runs `node -e`), and `codex-review`'s skill runs a node script
while `plugins/codex-review/README.md:14` lists only the Codex CLI. Re-derive the full list
yourself (`grep -rn "node" plugins/*/hooks/`) rather than trusting this enumeration — it has
already been wrong once.

Fix: add a Requirements column (or equivalent) to the README install table covering Node and
any external CLI, and add Node to codex-review's README requirements.

Note: `claude plugin validate .` warns that `engines` fields in 8 plugin manifests are unknown
and ignored by Claude Code. Do not delete them in this task — just make sure the README does
not imply they enforce anything.

**Done when:** CI gate demonstrably rejects a broken frontmatter (quote the proof);
handoff hint works and fails open; README requirements accurate;
`bash scripts/run-node-tests.sh` green.
