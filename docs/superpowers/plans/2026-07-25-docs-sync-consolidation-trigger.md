# docs-sync-guard: activity-triggered consolidation pass

Adds a second, **non-blocking** mechanism to `docs-sync-guard`: when a repo accumulates N
commits since its docs were last checked *against each other*, an in-session nudge asks for
a consolidation audit. The existing `PreToolUse` commit gate is not touched.

Base branch: `feat/docs-sync-consolidation` (cut from `main`).

## Why this shape (research, 2026-07-25)

The obvious design — put contradiction detection on the commit gate — is ruled out by where
false positives are tolerable:

- Google sites its FP bar by pipeline position. Compiler-blocking checks must "produce no
  effective false positives (the analysis should never stop the build for correct code)";
  code-review-time checks must "produce less than 10% effective false positives", a figure
  they call a sweet spot. Tricorder enforces it: a per-analyzer not-useful rate ≥10% puts it
  on probation, >25% "may decide to turn the analyzer off immediately."
  ([CACM 61(4)](https://cacm.acm.org/research/lessons-from-building-static-analysis-tools-at-google/),
  [ICSE 2015](https://research.google/pubs/tricorder-building-a-program-analysis-ecosystem/))
- An *effective* false positive is any report "developers did not take positive action after
  seeing", regardless of technical correctness — and Google found its own developers have "a
  strong bias to ignore static analysis, and any false positives or poor reporting give them
  a justification for inaction."
- Measured cost of getting that wrong: a secret-detection commit gate saw one-time bypass on
  **44.2%** of warnings and permanent bypass on **7.2%** — 51.4% of blocked check-ins
  ultimately exposed — with developers classifying **50%** of warnings as false positives
  *whether or not the detection was accurate*.
  ([EMSE 27:59](https://pmc.ncbi.nlm.nih.gov/articles/PMC8928718/))

LLM contradiction detection is nowhere near a zero-FP bar, so on the blocking path it would
be bypassed about half the time **and** would spend the credibility the deterministic
path-comparison check currently has.

But an out-of-band report is worth roughly nothing either. Facebook: surfacing an issue as a
comment on the diff that introduced it, "the fix rate rocketed to over 70%" — a response the
authors call "striking". The same issues as an offline bug list: "we were greeted by near
silence… almost none of them were acted on."
([CACM 62(8)](https://cacm.acm.org/research/scaling-static-analyses-at-facebook/))

So the trigger must land **in the session**, and must not block. That is exactly `ship-gate`'s
proven `Stop` → session flag → `UserPromptSubmit` → `additionalContext` pattern. (This does not
contradict `plugins/docs-sync-guard/CLAUDE.md`'s "Stop-hook stdout is not injected into model
context" — that is *why* the Stop hook writes a flag instead of printing.)

What the pass must do, and must not do:

- **Audit, don't rewrite.** NN/g separates content inventory from content audit; Google's
  opendocs defines the audit archetype as inventory + analysis + recommendations, "explicitly
  excluding the writing or editing of docs based on those results". LLM judges miss a large
  share of real inconsistencies, so an autonomous rewrite would be confidently wrong at
  exactly the rate that matters.
- **Delete, not only add.** A study of 2,303 agent context files across 1,925 repos found
  growth is monotonic: median **57 words added** per commit for Claude Code files versus
  **under 15 deleted**, across all three tool families. A controlled eval found LLM-generated
  context files *reduce* SWE-bench success ~3% while raising cost >20%; developer-written ones
  help ~4% at up to 19% more cost. Anthropic's own guidance: review "periodically to remove
  outdated or conflicting instructions", keep under 200 lines because "longer files consume
  more context and reduce adherence."
  ([arXiv 2511.12884](https://arxiv.org/html/2511.12884v1),
  [arXiv 2602.11988](https://arxiv.org/abs/2602.11988),
  [Claude Code memory docs](https://code.claude.com/docs/en/memory.md))

**Evidence caveats to carry forward.** Two claims are partially verified: both CACM articles
403'd and were read through an `r.jina.ai` proxy of the same URLs; Facebook's offline arm is
qualitative ("near zero"), not a measured 0%. A "<5% build-time overhead" figure previously
attributed to the Google paper **does not appear in it** — full-text search returned zero hits;
only the FP thresholds are verbatim. And the consolidation-cadence literature is convention,
not measured causality — no source isolates a consolidation pass's downstream effect on defect
or task-success rates, and none compares count- vs time- vs event-triggered cadence.

## Design

**Record file: `.docs-sync` at the repo root.** One path, no precedence rule, no fallback:

```
docs-sync: audited=<full-40-char-sha>
Last documentation consolidation: <iso8601>
Run /docs-consolidate — do not hand-edit the audited= line.
```

**Opt in by committing it; opt out by deleting it.** Those two are read from different places,
deliberately:

- **Existence** is checked in the **working tree**. Deleted → silent immediately, without
  waiting for the deletion to be committed.
- **The `audited=` SHA** is read from **`HEAD:.docs-sync`**. An uncommitted record — `--init`
  ran but its commit failed or was abandoned, or someone hand-edited the line — cannot activate
  or reset the trigger. Without this, a stale repo would be silenced by a file nobody committed.

Either read coming back empty → **silent, always**. No config file, no per-repo settings.

**The stamp is the `audited=` SHA — the commit whose tree was audited — not the commit
containing the record.** A committed file cannot carry its own commit's SHA (its bytes are an
input to that hash), so the value is HEAD at audit time, i.e. the parent of the record commit.
Post-commit invariant: `audited == git rev-parse HEAD~1`.

**Count semantics, stated once and depended on everywhere:** `count = git rev-list --count
<audited>..HEAD`, which *includes the record commit itself*. A fresh record therefore reads
**1**, not 0, and `count >= threshold` fires after **`threshold − 1` further commits** — 49 at
the default. Do not "fix" the off-by-one with a `-- ':(exclude).docs-sync'` pathspec: that
triggers history simplification and the count stops meaning what it appears to mean. The
cadence table below is unaffected at this precision.

**Threat model for `audited=`.** It defends against *incidental* touches of the record — merge
conflict resolution, a prose fix, a `git mv` — which are likely and would otherwise reset drift
to zero without an audit. It does **not** defend against someone deliberately writing
`audited=$(git rev-parse HEAD)` and committing without auditing. Nothing local can: the record
lives in the repo, and whoever can commit can write it. For a non-blocking nudge that is the
right place to stop — a signature scheme whose signer is the same agent that fills in the value
proves nothing. `audited=` is trusted by convention, and the convention is stated in the file.

**Every anomaly is silent, never stale.** This is the whole reason the engine stays small:

| condition | result |
|---|---|
| `.docs-sync` absent from the working tree | silent (unadopted, or deliberately removed) |
| present in the working tree but not in `HEAD` | silent (never committed — cannot activate) |
| in `HEAD`, no parseable `audited=` line | silent |
| `audited` object not present in the repo | silent |
| `audited` not an ancestor of HEAD (rebase, force-push) | silent |
| shallow clone truncating either of the above | silent — falls out of the two rows above |
| `rev-list` fails or returns junk | silent |

A nudge toward optional work must never fire on "I cannot tell" — that is exactly the effective
false positive that gets a tool turned off. Warning-on-ambiguity is what forced the predecessor
design's two-variant shallow-clone special-casing; silence needs none, and
`--is-shallow-repository` is never consulted.

**Accepted limitation:** a history rewrite that drops the audited commit silences the trigger
until someone re-runs `/docs-consolidate` or `--init`. Silence is a degradation; a false
"audited" is a lie. Take the degradation.

*Rejected: deriving the stamp from `git log -1 --format=%H -- .docs-sync`.* Genuinely elegant —
the SHA comes from git so it always exists and is always an ancestor, deleting the
unknown-commit and diverged cases outright. But **any** commit touching the file then records a
completed audit, and touching it without auditing is a likely event, not a contrived one:
resolving a merge conflict on the record, or fixing its prose, would silently reset drift to
zero. That is the silent-false-blessing this plugin exists to prevent, and it is the same
failure that cost graphify its credibility. With an explicit `audited=` SHA, a conflict
resolution picks one side's *real* audit SHA and a prose fix touches nothing load-bearing.

*Rejected: a commit trailer counted via `git log`.* Squash-merge collapses per-commit messages
and discards trailers unless re-injected, so a count of `docs-sync:consolidated` commits would
silently undercount. A tracked file survives squash, survives clone, and shows in PR diffs.

*Rejected: `.claude/docs-sync.json`.* transcoder gitignores `/.claude/` (`.gitignore:62`), so
the record would be silently untracked in the most active adopter — counter resets on every
clone, with no visible failure. brok-stacks, endurebyte and claude-skills all track `.claude/`;
transcoder alone kills it.

*Rejected: an HTML comment in the root `CLAUDE.md`/`AGENTS.md`/`README.md`.* Three reasons.
(1) The stamp is a fact about the repo's whole doc *set*, not about one doc; transcoder has
`docs/DESIGN.md`, `STATUS.md`, `BEHAVIOUR.md` plus per-crate docs, and a reader would fairly
misread a stamp in `CLAUDE.md` as "CLAUDE.md was audited". (2) The pass audits and may rewrite
the very file holding its own marker — an implementation hazard and a merge-conflict magnet on
the marker line. (3) It puts machine state in the file whose context cost is the plugin's
entire point.

**Counter: `git rev-list --count <stamp>..HEAD`, with no pathspec.** Two reasons:

1. *Semantics.* Because the commit gate already forces most code commits to touch their
   covering doc, "commits since consolidation" is not measuring undocumented drift — it is
   measuring accumulated churn where **each commit updated its doc in isolation and nobody
   checked those docs against each other**. Doc-only commits are part of that, not noise.
2. *Correctness.* `rev-list --count A..HEAD -- ':(exclude)path'` triggers history
   simplification, so the result is **not** `total − excluded commits`. Having no pathspec
   removes a trap rather than working around it; the cost is that a fresh pass reads 1 (the
   record commit), which is noise at any sane threshold.

**Threshold: default 50, override `DOCS_SYNC_CONSOLIDATE_THRESHOLD`.** Parsed strictly — only
a plain positive integer is honoured; `0`, negatives, decimals and junk all fall back to 50.
An unvalidated parse is the difference between nudging every turn and never nudging.

This number is **the one part of this design with no evidence behind it.** No source compares
trigger axes; every primary source picks one by convention (Kubernetes = per-release Docs
Freeze; Rust's rustc-dev-guide = a bot opening "Date Reference Triage for YYYY-MM" monthly;
MDN = per-PR via CODEOWNERS). Only gray literature argues the axis: one practitioner skill
argues count-over-wall-clock at ~15 commits ("repos with week-old mtimes hid 100+ commits of
drift"), another AND-gates ≥24h with ≥5 sessions. 50 is chosen against measured local cadence:

| repo | commits/45d | 50 commits ≈ |
|---|---|---|
| brok-stacks | 345 | every 6.5 days |
| transcoder | 251 | every 9.0 days |
| endurebyte | 244 | every 9.2 days |
| form-abandonment, session-retro, formrecap-lora-classifier | 0 | never |

25 would fire every 2–4 days on the active repos, which is the Dependabot failure mode: a
large study found developers "tend to configure Dependabot toward reducing the number of
notifications" rather than acting, with 11.3% of projects deprecating it outright. **Revisit
the number after a month of real firing** — it is a guess, and the fire-once throttle plus the
defer path are the actual defenses.

*Rejected: a count+time AND-gate.* A burst of 50 commits in one afternoon genuinely is drift;
adding a 24h floor only delays a warranted nudge. Pure count, per the count-over-wall-clock
argument.

**Trigger (Job 1).** `Stop` re-measures drift at turn end; at or past threshold it writes a
flag. `UserPromptSubmit` consumes it fire-once and injects a nudge to run `/docs-consolidate`.
Throttled per `ship-gate`: at most once per session, re-armed only when HEAD moves.

**Flag and throttle files are keyed by session *and* repo** — `<sid>-<repoHash>`, where
`repoHash` is `sha1(repoRoot).slice(0,12)`. Session alone is not enough: a session that ends a
turn in stale repo A and then changes directory to repo B would have `UserPromptSubmit` consume
A's flag and tell the agent to consolidate B. With repo-keyed names the consumer computes the
hash from its own cwd, finds nothing in B, and stays silent; A's flag waits until the session
returns to A, which is the correct behaviour. Orphaned flags are a few bytes in the data dir
and age out with the session.

**Defer (Job 2).** "Not now" must not re-fire every session or the nudge becomes wallpaper.
`/docs-consolidate --defer` writes `consolidate-defer-<repoHash>.txt` in the plugin data dir
holding the current HEAD SHA; the Stop hook stays silent until HEAD is a further `threshold`
commits past that SHA. Deferral is a per-user decision, not a repo fact, so it lives in local
state and **never** by touching `.docs-sync` — recording a consolidation that did not happen is
the exact lie this plugin exists to prevent.

The deferred SHA gets the **same ancestry validation as the stamp**, and for the same reason:
after a rebase or force-push it is still resolvable locally but no longer an ancestor, and
`rev-list --count <deferred>..HEAD` would then count the whole rewritten branch and re-arm the
nudge immediately. On a **verified** missing-or-non-ancestor SHA, delete the defer file and let
the ordinary drift check decide — that re-arms at most once, and re-deferring is one command,
which beats inventing a decision the user did not make by silently re-deferring from HEAD.

On **"cannot tell"** — `isAncestor` returning `null` from a spawn failure or git exit 128 —
keep the defer file and exit silently. Deleting it there would let one transient git error
erase a decision the user made deliberately. Same rule as everywhere else in this design:
ambiguity is silence, and silence must not have side effects.

**Fail open, everywhere.** Non-repo cwd, git errors and malformed payloads exit 0 silently,
alongside every row of the anomaly table above. There is exactly one code path for "cannot
tell", and it is silence.

**The pass itself** (`/docs-consolidate`), as an audit with human dispositions:

1. **Inventory the corpus**, with line count and last-touching commit for each. The corpus is:
   - every `README.md` / `CLAUDE.md` / `AGENTS.md` anywhere in the repo, **plus**
   - all Markdown under `docs/`.

   The second half is not optional — it is where the contracts actually live. transcoder's
   `docs/STATUS.md` and `docs/BEHAVIOUR.md` are the exact documents a `crates/host/` change can
   contradict, and neither is an entry doc.

   **Excluded: dated, point-in-time records** — `docs/superpowers/specs/`,
   `docs/superpowers/plans/`, `docs/adr/`. These are archival by convention (ADRs are never
   deleted; a superseded one is *supposed* to disagree with current state), so auditing them
   would generate permanent, unfixable "stale" findings — the fastest route to the not-useful
   rate that gets a tool switched off. **Also excluded: generated sections**, such as
   transcoder's CI-linted CONFIG-MATRIX; treat a CI-enforced doc as ground truth, not as an
   audit target.
2. **Read `git diff <stamp>..HEAD`** — actual hunks for changed paths, *not* `--stat`. A commit
   that inverts an authorization check inside an existing file shows up in `--stat` as a
   pathname and two line counts.
3. **Read the whole corpus in full** — every file inventoried in step 1, not a selection.
   Inventory metadata is not evidence, and *which* doc contradicts a diff is not knowable
   before reading it. An ancestor-chain walk from each changed path is **not sufficient**, for
   the reason given in step 1: the contradicting contract is routinely a sibling under `docs/`,
   not an ancestor. Reading only the diff plus an ancestor walk would report zero findings and
   re-stamp over a live contradiction — the silent-false-blessing this whole design exists to
   prevent.

   **Partial coverage never re-stamps.** If the corpus exceeds what can be read in full, do not
   silently sample: read the ancestor chains plus everything under `docs/` plus the root entry
   docs, **name the files that went unread**, and **do not re-stamp**. A pass that covered part
   of the repo is a useful report and an unfinished audit; the record must keep saying so until
   one completes.
4. **Audit against four named failure modes**, each finding carrying `file:line`, the claim,
   the contradicting evidence, and a proposed disposition:
   - **contradiction** — two docs (or two sections) assert incompatible things
   - **stale claim** — a claim the diff falsified
   - **orphan** — documents code or behaviour that no longer exists
   - **bloat** — accreted lines no longer earning their context cost
5. **Report; do not edit.** The user dispositions each finding; the agent applies only accepted
   ones.
6. **Re-stamp last** — set `audited=` to the HEAD that was actually audited, refresh the
   timestamp, and commit, in the same commit as the applied edits or immediately after. If the
   diff or the doc set was too large to read in full, say so and **do not re-stamp**:
   re-stamping on unread evidence re-blesses false claims and silences the trigger for another
   N commits.
7. **A zero-finding pass is a success**, not a miss: re-stamp, no edits, say so plainly.
   Before committing, **verify `.docs-sync` actually changed** (`git diff --quiet -- .docs-sync`
   → non-zero). If it did not, the pass audited the same HEAD it had already audited and there
   is nothing to record — say so and skip the commit rather than producing an empty one. Do not
   rely on the timestamp to force a byte change; `nowIso()` is second-resolution and two passes
   within one second would render identically.

**Intentional contradictions get a rationale in the doc, not a suppression entry.** If the pass
reports "X and Y disagree" and the answer is "deliberately", the fix is to write *why* into the
doc ("this differs from X because…"). That silences future passes by giving them the reason to
read, and is better documentation. There is deliberately **no dismissal registry**: stable
finding identity across moving line numbers is its own rabbit hole, and a suppression list that
grows is how a tool's not-useful rate climbs to Tricorder's turn-it-off threshold while looking
like it is working. Persistent state stays at exactly one file.

## Global constraints

- Extends the existing plugin — no new plugin. The user's framing ("keep our docs updates hook
  with a consolidate flag every X updates") and the plugin's own concern (docs stay in sync
  with code) both hold; the gate handles per-commit, the trigger handles accumulated drift.
- ESM `.mjs`, stdlib only, `// @ts-check` with JSDoc typedefs, own `lib.mjs` copy (plugins
  cannot share files across plugin boundaries). No new runtime dependencies.
- **Hook commands stay in shell form.** `scripts/hook-runtime-guard.test.mjs` enforces it and
  its header explains why — exec form silently disables hooks on hosts older than Claude Code
  2.1.139 and `engines` cannot prevent the install.
- Every task writes its failing test first, confirms it fails for the right reason, then makes
  it pass. Quote the red→green transition in the task report.
- Run `bash scripts/run-node-tests.sh` before declaring a task done.
- **Versions:** do NOT bump `plugin.json` / `marketplace.json` inside Tasks 1–4.
  `scripts/check-version-bumps.mjs` requires an increase for every changed plugin file, so the
  branch is genuinely unmergeable without bumps — **Task 5 does them in one place**, because
  `marketplace.json` is a single shared file parallel tasks cannot safely co-edit.
  Intermediate commits failing `version-bump-check` is expected; the final branch state must
  pass.
- **Tasks 1–3 must commit with `docs-sync:ack`** (reason: docs land in Task 4) — this plugin's
  own gate denies staged plugin code without that plugin's README/CLAUDE.md. Two related
  traps, both hit this session: the guard denies the **entire** Bash call, so never write
  `git add … && git commit …` (the `add` silently never runs); and never `git checkout -b … &&
  git commit …` (the commit lands on the previous branch).
- Touch only the files your task owns. Tasks run in parallel worktrees.

---

# Task 1

**Owns:** `plugins/docs-sync-guard/scripts/lib.mjs` and a NEW
`plugins/docs-sync-guard/tests/consolidation-drift.test.mjs`.

Add the drift engine to `lib.mjs`. The reverted `repo-state` engine at
**`82823ae:plugins/repo-state/scripts/lib.mjs`** (`git show` it) is the right starting point —
same written-stamp shape, three Codex rounds already paid into it — with **one systematic
change: every branch that returned `{stale: true}` on an anomaly now returns `null`.** That
single change deletes the shallow-clone special-casing entirely, because the two false
positives it defended against (`--depth 1` failing `cat-file`; `--depth 1 --no-single-branch`
failing `--is-ancestor`) now land on the same silent path as everything else. Do not port
`--is-shallow-repository`; do not port the `reason` enum beyond what is listed below.

Exports to add:

- `DEFAULT_CONSOLIDATE_THRESHOLD = 50`
- `RECORD_REL = ".docs-sync"`
- `gitRun(args, cwd)` / `git(args, cwd)` / `gitRepoRoot(cwd)` — salvage verbatim. `gitRun`
  exposes exit status separately because `merge-base --is-ancestor` answers via exit code
  (0 yes / 1 no / 128 broken) and `git()` collapsing failure to `null` loses that.
- `resolveConsolidateThreshold(env)` — salvage verbatim, renaming the env var to
  `DOCS_SYNC_CONSOLIDATE_THRESHOLD`. Strict `/^\d+$/` and `> 0`, else default. An unvalidated
  parse is the difference between nudging every turn and never nudging.
- `readConsolidationStamp(repoRoot)` → `string | null`. **Two reads, two purposes.** First,
  `existsSync(<root>/.docs-sync)` — false → `null` (working-tree deletion is the opt-out, and
  it takes effect before it is committed). Then `git show HEAD:.docs-sync`, matching
  `/^docs-sync:\s*audited=([0-9a-fA-F]{7,40})\b/m`, returning the SHA lowercased; non-zero exit
  or unparseable → `null` (an uncommitted or hand-mangled record cannot activate or reset the
  trigger). Do not collapse these into one read — each direction has a distinct failure the
  other does not catch.
- `isAncestor(repoRoot, sha)` → `boolean | null` — `cat-file -e <sha>^{commit}` then
  `merge-base --is-ancestor <sha> HEAD`. Missing object → `false`. Exit 128 or spawn failure →
  `null`. Used by both the stamp and the defer file.
- `computeConsolidationDrift(repoRoot, stampCommit, threshold)` → `{stale, count} | null`.
  `null` unless `isAncestor` is `true`; then `git rev-list --count <stamp>..HEAD`, **no
  pathspec**; unparseable → `null`. No `reason` field — `behind` is the only stale case left.

Do **not** touch `emitPermissionDecision` or anything the existing `PreToolUse` guard uses.
`readStdin` / `safeJsonParse` are already present; add `resolveSessionId`, `resolveDataDir`,
`emitAdditionalContext`, `nowIso` from `ship-gate/scripts/lib.mjs`, plus a `repoHash(repoRoot)`
helper (`sha1` from `node:crypto`, first 12 hex chars).

## Tests (real throwaway git repos, as `tests/pretooluse-guard-docs-sync.test.mjs` does)

Every one of these asserts **silence**, not a warning, on the anomaly paths — that is the
property under test.

- `.docs-sync` absent → `readConsolidationStamp` → `null`
- committed but with no `audited=` line / malformed SHA → `null`
- **adopted, then deleted from the working tree but not yet committed** → `null`, silent. The
  opt-out must not wait for a commit.
- **written to the working tree but never committed** → `null`, silent. An abandoned `--init`
  must not silence a stale repo.
- **committed, then the working-tree copy hand-edited to a different SHA** → returns the
  **committed** SHA, not the edited one
- committed and valid → returns the lowercased SHA
- fresh record → `{stale:false, count:1}` — the record commit itself. **Assert 1, not 0**, so
  nobody later "corrects" it with a pathspec exclusion.
- **48 further commits (count 49) with threshold 50 → not stale; 49 further (count 50) → stale.**
  The boundary is on `count`, and `count` includes the record commit — assert both the count
  and the verdict at each step so the off-by-one cannot drift back in.
- `audited` object absent from the repo → `null`, silent
- **`audited` present but not an ancestor** (simulated rebase/force-push) → `null`, silent
- **shallow `--depth 1`** with the audited commit unfetched → `null`, silent
- **shallow `--depth 1 --no-single-branch`** where the object survives via another branch but
  the path to HEAD is cut → `null`, silent. Assert this separately from the row above: under
  the predecessor design it was a distinct bug that hid behind the fix for the first, and only
  a separate test proves the anomaly→silence rule actually covers both.
- non-git cwd → `null`
- `DOCS_SYNC_CONSOLIDATE_THRESHOLD` of `"0"`, `"-5"`, `"foo"`, `""`, `"3.5"` → each 50;
  `"  12  "` → 12

---

# Task 2

**Owns:** `plugins/docs-sync-guard/hooks/hooks.json`,
`plugins/docs-sync-guard/scripts/stop-check-consolidation-drift.mjs`,
`plugins/docs-sync-guard/scripts/check-consolidation-flag.mjs`, a NEW
`plugins/docs-sync-guard/tests/consolidation-hooks.test.mjs`, **and** the existing
`plugins/docs-sync-guard/scripts/pretooluse-guard-docs-sync.mjs` +
`plugins/docs-sync-guard/tests/pretooluse-guard-docs-sync.test.mjs`.

**Depends on Task 1** (imports its `lib.mjs` exports).

## 2a. Exempt `.docs-sync` from the gate — do this first

The gate would otherwise block its own record file. `SKIP_RE`
(`pretooluse-guard-docs-sync.mjs:135`) exempts markdown, lockfiles, `LICENSE`, `.gitignore`,
`.gitattributes`, `.editorconfig` and `.claude-plugin/`. `.docs-sync` matches none of them, so
rule 2 treats it as code, walks up for its nearest covering doc, finds the root `README.md`
unstaged, and **denies**. Every adopting repo has a root README, so `--init` and every routine
re-stamp would be refused — adoption fails at step one.

Add `.docs-sync` to `SKIP_RE`, alongside the other tooling-state entries it belongs with. Do
**not** solve this by requiring `docs-sync:ack` on re-stamp commits: this plugin's own
`CLAUDE.md` records that noise makes ack reflexive and kills the gate, and a marker firing on
every routine re-stamp is precisely that noise.

Tests, added to the existing gate suite:

- commit staging only `.docs-sync`, in a repo **with** a root `README.md` → **allowed**
- commit staging `.docs-sync` plus markdown edits → allowed
- commit staging `.docs-sync` plus a real code file whose covering doc is unstaged → **still
  denied**, naming the code file only. The exemption must not become a bypass.

## 2b. The trigger hooks

`hooks.json` gains `Stop` and `UserPromptSubmit` alongside the untouched `PreToolUse` entry —
shell form, `timeout: 5`, mirroring `plugins/ship-gate/hooks/hooks.json`.

**Data-dir file keying — the defer file is a deliberate exception:**

| file | keyed by | why |
|---|---|---|
| `consolidate-nudge-<sid>-<repoHash>.flag` | session + repo | fire-once per session; must not leak across repos |
| `consolidate-last-sha-<sid>-<repoHash>.txt` | session + repo | the throttle is per-session by design |
| `consolidate-defer-<repoHash>.txt` | **repo only** | "not now" must outlive the session that said it |

Keying the defer by session would make it re-fire next session — the single behaviour defer
exists to prevent. It is repo-scoped state about a user decision, not session state.

`stop-check-consolidation-drift.mjs`:

1. `gitRepoRoot(cwd)` → null exits 0. `readConsolidationStamp` → null exits 0 (unadopted, or
   the record was deleted as an opt-out).
2. `computeConsolidationDrift` → null or `!stale` exits 0.
3. Defer check: read `consolidate-defer-<repoHash>.txt`. If present, run `isAncestor` on the
   deferred SHA — `false` → **delete the defer file** and continue; `null` (cannot tell) →
   **keep it and exit 0**; `true` → `rev-list --count <deferredSha>..HEAD < threshold` → exit 0.
4. Throttle: `consolidate-last-sha-<sid>-<repoHash>.txt` equal to current HEAD → exit 0.
5. Write `consolidate-nudge-<sid>-<repoHash>.flag` (holding the drift description) and the
   last-SHA file.

`check-consolidation-flag.mjs` (`UserPromptSubmit`): resolve the repo root from **its own**
cwd, compute `repoHash`, read that flag, **delete it**, emit `additionalContext` naming the
drift count and `/docs-consolidate`. No flag → exit 0 silently. Delete before emitting so a
crash cannot leave it re-firing.

Both fail open on every error path.

## Tests (hooks run as child processes with synthetic JSON payloads)

- no `.docs-sync` → `Stop` exits 0, writes no flag
- adopted, then `.docs-sync` deleted → exits 0, writes no flag
- `count` 49 / threshold 50 → no flag; `count` 50 → flag written
- second `Stop` with unchanged HEAD → no re-arm
- one more commit → re-arms
- defer file present, HEAD 10 commits past deferred SHA (threshold 50) → silent
- defer file present, HEAD 50 commits past deferred SHA → arms
- **defer file holds a SHA that is no longer an ancestor** (simulated force-push) → defer file
  deleted, and the nudge decision comes from ordinary drift — *not* an immediate re-arm caused
  by counting the whole rewritten branch
- **defer validation cannot run** (git unavailable / exit 128) → defer file **still on disk**
  afterwards and no flag written. One transient git error must not erase a deliberate defer.
- **defer survives a new session**: defer, then run `Stop` with a *fresh* `session_id` → still
  silent. (Keying the defer by session would silently reduce it to "not this session".)
- `UserPromptSubmit` with flag → emits `additionalContext`, flag file gone afterwards
- `UserPromptSubmit` again → silent (fire-once)
- **`Stop` in repo A arms a flag; `UserPromptSubmit` runs with cwd in repo B → silent, and A's
  flag is still on disk.** Then `UserPromptSubmit` back in A → fires. (Cross-repo leakage: the
  same session ending a turn in A and prompting from B must not be told to consolidate B.)
- malformed payload, non-repo cwd, broken git, unreadable data dir → exit 0, no stdout
- **the existing `PreToolUse` guard still passes all 15 of its original tests** — the `SKIP_RE`
  change in 2a must not alter any existing verdict

---

# Task 3

**Owns:** `plugins/docs-sync-guard/skills/docs-consolidate/SKILL.md`.

New skill, invoked as `/docs-consolidate`. Frontmatter needs a **quoted, non-empty**
`description` (enforced by `scripts/skill-frontmatter.test.mjs`); the description must carry a
negative scope ("do NOT use for…") per the session skill-authoring rule — specifically, do NOT
use it for a single doc update, which is the commit gate's job.

Body must specify, in this order:

- **`--init`** — create `.docs-sync` at the repo root with the body from Design, setting
  `audited=$(git rev-parse HEAD)`, and commit it. **Refuse to init if `git check-ignore
  .docs-sync` matches** — a gitignored record is untracked, so it never reaches a teammate's
  clone (this is what ruled out `.claude/`, where transcoder would have hit it). After
  committing, assert `audited == git rev-parse HEAD~1`.
- **removing `.docs-sync` is the documented opt-out** — the hooks read the working tree, so a
  deleted record goes silent immediately rather than nudging forever off a historical commit.
- **the corpus definition and its two exclusions** (dated/archival records, generated sections)
  — a reader who gets the corpus wrong gets the whole pass wrong in both directions.
- **the pass** — the seven numbered steps from Design, verbatim in intent: inventory → read real
  hunks (never `--stat`) → audit against the four named failure modes → **report, do not edit**
  → apply only accepted dispositions → re-stamp last.
- **the four failure modes** (contradiction, stale claim, orphan, bloat) with the finding shape
  `file:line` + claim + contradicting evidence + proposed disposition.
- **deletion is a first-class outcome** — cite the monotonic-growth finding so a future reader
  knows why "nothing to remove" deserves scrutiny rather than relief.
- **intentional contradictions get a rationale written into the doc**, never a suppression
  entry. State that there is no dismissal registry and why (see Design).
- **the too-large-to-read escape** — applies to the diff *and* to the doc inventory; name what
  went unread and do not re-stamp on partial evidence.
- **a zero-finding pass is a success** — re-stamp, no edits, say so. Verify `.docs-sync`
  actually changed before committing; if not, skip the commit.
- **`--defer`** — write the defer file, silent until `threshold` further commits.
- **Never re-stamp without having read the diff *and* the docs that could contradict it.** Put
  this in a "Common mistakes" table alongside: re-stamping on `--stat`; treating the file
  inventory as evidence about content; editing docs before the user dispositions; treating the
  nudge as blocking.

---

# Task 4

**Owns:** `plugins/docs-sync-guard/README.md`, `plugins/docs-sync-guard/CLAUDE.md`,
`plugins/docs-sync-guard/.claude-plugin/plugin.json` (**description only** — no version),
and the root `README.md` plugin-table row.

- `plugin.json` `description`: extend to name both mechanisms — the blocking commit gate and
  the non-blocking consolidation trigger — since it currently describes only the gate.
- Plugin `README.md`: user-facing contract for the trigger — the `.docs-sync` record and its
  `audited=` line, opt-in by committing it and opt-out by deleting it, threshold + env
  override, what the nudge looks like, `--init` / `--defer`, and that it never blocks.
- Plugin `CLAUDE.md`: add a "Design decisions" entry recording *why* contradiction detection
  is off the blocking path (the Google FP thresholds and the 44.2%/7.2% bypass figures), why
  the record is a tracked file rather than a commit trailer (squash-merge) and rather than
  `.claude/` (transcoder gitignores it), why the stamp is an explicit `audited=` SHA rather
  than the record's last-touched commit (any incidental touch would otherwise record an audit
  that never happened), **why every anomaly is silent rather than stale** (it is what removes
  the shallow-clone special-casing, and warning-on-ambiguity is what gets guards ignored), why
  there is no pathspec on the count (history simplification), that fresh drift is 1 rather than
  0 by design, and that `.docs-sync` is in `SKIP_RE` because the gate would otherwise deny its
  own record file. Also
  reconcile the existing "Commit gate, not turn-end nudge" bullet with the new `Stop` hook —
  the bullet's claim (Stop stdout is not injected) is *why* Stop writes a flag rather than
  printing; make that explicit so a future reader does not read it as a contradiction.
- Root `README.md`: the `docs-sync-guard` row currently reads "Git-commit gate against docs
  drift in plugins/ monorepos" — update to cover both mechanisms.

---

# Task 5

**Owns:** `plugins/docs-sync-guard/.claude-plugin/plugin.json` (**version only**) and
`.claude-plugin/marketplace.json`.

Bump `docs-sync-guard` `0.2.1` → `0.3.0` (minor — new feature, no breaking change) via
`node scripts/bump-plugin.mjs docs-sync-guard minor`, which updates both files together.
Verify with `node scripts/check-version-bumps.mjs main` (expect no violations).

---

## Verification

Plugin suite, then the repo-level suites the change must not break:

```bash
node --test plugins/docs-sync-guard/tests/
node --test scripts/repo-consistency.test.mjs scripts/skill-frontmatter.test.mjs \
            scripts/check-version-bumps.test.mjs scripts/hook-runtime-guard.test.mjs
bash scripts/run-node-tests.sh
claude plugin validate plugins/docs-sync-guard
```

Quote the red→green transition for the **threshold boundary** (`count` 49 vs 50), the
**deleted-record** opt-out, both **shallow-clone** cases, the **cross-repo flag leakage** case,
and the **`.docs-sync` gate exemption** (2a). Those decide whether this nudges usefully, and
whether it can be adopted at all.

End-to-end, in this repo:

1. `/docs-consolidate --init` → `.docs-sync` committed at root. **The commit must not be denied
   by the gate** — this repo has a root `README.md`, so it exercises 2a for real. Confirm
   `audited==HEAD~1` after the commit, and that a drift measurement immediately afterwards
   reads **1**, not 0.
2. Run `stop-check-consolidation-drift.mjs` by hand with `DOCS_SYNC_CONSOLIDATE_THRESHOLD=2`,
   two commits past the record → flag armed. Feed a `UserPromptSubmit` payload → nudge emitted,
   flag gone. Repeat → silent.
3. `--defer`, then one more commit → silent. Confirm it re-arms only after the threshold.
4. Run the real pass against this repo's own docs; confirm findings carry `file:line` and
   evidence, that the inventory was actually read (spot-check one claim quoted from a doc the
   diff never touched and not on any changed path's ancestor chain), that nothing was edited
   before disposition, and that `audited=` advanced only after the applied edits were
   committed.
5. Against `form-abandonment` (0 commits/45d, no `.docs-sync`) → silent.
6. `rm .docs-sync` here, run the Stop hook → silent. Restore it.

## Rollout

1. Land and merge here first; dogfood on `claude-skills` for a full threshold cycle before
   going wider.
2. Then `--init` on **transcoder, brok-stacks, endurebyte** — the three active repos. All three
   have a `docs/` dir and none gitignores the repo root, so `.docs-sync` lands tracked; confirm
   with `git ls-files .docs-sync` after each init rather than assuming. Note that
   transcoder already has a stronger guarantee for one doc: `docs/STATUS.md`'s CONFIG-MATRIX is
   generated from `crates/host/src/http/config_matrix.rs::MATRIX` and CI-linted by
   `crates/host/tests/config_matrix_drift_test.rs`. The consolidation pass must **not** propose
   edits to generated sections; treat a CI-enforced doc as ground truth, not as an audit target.
3. Revisit the threshold after a month of real firing. If it has fired and been deferred more
   than acted on, that is the Dependabot signal — raise it or narrow the pass, do not lower it.

## Out of scope (deliberate)

- **Deterministic AST-anchored doc checks.** `fiberplane/drift` fingerprints documented symbols
  via tree-sitter so "changes elsewhere in the file don't trigger staleness"; that *is* the
  commit-gate-safe class of check, and it is a genuinely better long-term answer than a commit
  counter. It is also a much larger build (even `lychee`, a mature link checker, needed
  multi-year false-positive hardening), and it answers a different question — "is this specific
  documented symbol stale", not "have these docs drifted apart". Separate pass.
- **Automatic rewriting of accepted findings without disposition.** Deliberately never.
