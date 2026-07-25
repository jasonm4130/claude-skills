---
name: docs-consolidate
description: >
  Audit a repo's documentation for internal contradictions, stale claims, orphans
  and bloat after it has accumulated commits, then report findings for the user to
  disposition. Use when the docs-sync-guard nudge fires, or when the user asks to
  consolidate, audit, or spring-clean the docs.
  Triggers: "/docs-consolidate", "consolidate the docs", "docs audit",
  "have the docs drifted", "check the docs against each other".
  Do NOT use for updating one doc alongside a code change — that is the commit
  gate's job, and a single doc edit needs no audit.
---

# Documentation consolidation

An **audit**, not a rewrite. It reports; you decide; only then does anything change.

Google's opendocs defines the audit archetype as inventory + analysis +
recommendations, "explicitly excluding the writing or editing of docs based on those
results". That separation is the point: LLM inconsistency detection is nowhere near
reliable enough to edit unsupervised, and an autonomous rewrite would be confidently
wrong at exactly the rate that matters.

This never blocks anything. If the user is mid-task, say what you found and let them
come back to it.

## `--init`

Adopt the trigger in this repo.

**`--init` starts the clock; it does not audit.** The `audited=` SHA it writes means
"drift is measured from here", not "these docs were verified at this commit". Say that
to the user when you run it, because the trigger will then stay silent for
`threshold − 1` commits over docs nobody has checked. If the repo's docs are of
unknown quality, offer to run a full pass immediately after adopting.

1. **Refuse if the record would be ignored.** `git check-ignore .docs-sync` matching
   means the file would never reach a teammate's clone — stop and say so rather than
   creating a record that silently does nothing. (This is what ruled out putting it
   under `.claude/`: transcoder gitignores that directory.)
2. Write `.docs-sync` at the repo root:

   ```
   docs-sync: audited=<git rev-parse HEAD>
   Recorded: <ISO-8601 UTC>
   Run /docs-consolidate — do not hand-edit the audited= line.
   ```

   The second line says **Recorded**, not "Last consolidation", and both `--init` and
   a re-stamp use the same wording. At adoption no consolidation has happened, so a
   line claiming one would be false in the file whose entire job is to not make false
   claims.

3. Commit it. Then assert `audited == git rev-parse HEAD~1` — the record names the
   commit whose tree was audited, which is the *parent* of the commit containing the
   record, because a file cannot carry the SHA of the commit that contains it.

Removing `.docs-sync` is the documented **opt-out**, and it takes effect immediately:
the hooks check the working tree for existence, so a deleted record goes silent
before the deletion is even committed.

## `--defer`

Run the shipped script. Resolve it **relative to this skill's own base directory** —
the absolute path stated when this skill was loaded — as `../../scripts/defer-consolidation.mjs`:

```bash
D="<this skill's base directory>/../../scripts/defer-consolidation.mjs"
node "$D"            # defer here
node "$D" . --clear  # undo
```

Do **not** use `${CLAUDE_PLUGIN_ROOT}`. Like `CLAUDE_PLUGIN_DATA`, it is set for
hooks and is **unset in session shells**, so it silently expands to nothing and the
command becomes `node "/scripts/defer-consolidation.mjs"` → `MODULE_NOT_FOUND`. The
skill's base directory is the only plugin path available here.

The marker lives in `.git/docs-sync-defer`, deliberately *not* in the plugin data
directory: `CLAUDE_PLUGIN_DATA` is not exported to session shells, so anything derived
from it here would be written where the hook never looks and deferral would silently
never work. `.git/` is per-clone — exactly the scope of "not now" — and never
committed.

**Never touch `.docs-sync` to silence a nudge.** Recording a consolidation that did
not happen is the one lie this whole mechanism exists to prevent.

## The pass

### 1. Inventory the corpus

- every `README.md` / `CLAUDE.md` / `AGENTS.md` anywhere in the repo, **plus**
- all Markdown under `docs/`.

Record line count and last-touching commit for each.

**Exclude dated, point-in-time records** — any specs/plans/ADR directory:
`docs/superpowers/specs/`, `docs/superpowers/plans/`, `docs/plans/`, `docs/adr/`,
and their equivalents wherever this repo keeps them. These are archival by
convention (ADRs are never deleted; a superseded one is *supposed* to disagree with
current state), so auditing them generates permanent, unfixable "stale" findings.
That is the fastest route to a not-useful rate that gets the whole tool switched off.

Match on **what the directory holds, not on the four names above** — a repo that
keeps dated records somewhere else still needs them excluded, and a `docs/plans/`
that this list happened to miss is how a pass ends up auditing an archive. Dated
filenames (`YYYY-MM-DD-*`) are the reliable tell. Say which directories you
excluded when you report.

**Exclude generated sections.** transcoder's CONFIG-MATRIX in `docs/STATUS.md` is
generated from `crates/host/src/http/config_matrix.rs::MATRIX` and CI-linted by
`crates/host/tests/config_matrix_drift_test.rs`. A CI-enforced doc is ground truth,
not an audit target.

### 2. Read the diff

`git diff <audited>..HEAD` — **actual hunks**, never `--stat`. A commit that inverts
an authorization check inside an existing file appears in `--stat` as a pathname and
two line counts, which tells you nothing about whether a doc still describes it
correctly.

### 3. Read the whole corpus

Every file from step 1, in full — not a selection. Inventory metadata is not
evidence, and *which* doc contradicts a diff is not knowable before reading it.

An ancestor-chain walk from each changed path is **not sufficient**: in transcoder a
change under `crates/host/` is contracted in `docs/STATUS.md` and `docs/BEHAVIOUR.md`,
neither of which is on that path's chain. Reading only the diff plus an ancestor walk
lets a pass report zero findings and re-stamp over a live contradiction.

**Partial coverage never re-stamps.** If the corpus is too large to read in full, do
not silently sample: read the ancestor chains plus everything under `docs/` plus the
root entry docs, **name the files that went unread**, and do not re-stamp. A partial
pass is a useful report and an unfinished audit.

### 4. Audit against four failure modes

| mode | what it looks like |
|---|---|
| **contradiction** | two docs, or two sections, assert incompatible things |
| **stale claim** | a claim the diff falsified |
| **orphan** | documents code or behaviour that no longer exists |
| **bloat** | accreted lines no longer earning their context cost |

Every finding carries `file:line`, the claim, the contradicting evidence, and a
proposed disposition (keep / update / remove).

**Deletion is a first-class outcome.** Across 2,303 agent context files in 1,925
repos, growth is monotonic — median 57 words added per commit versus under 15
deleted. A controlled eval found LLM-generated context files *reduce* SWE-bench task
success ~3% while raising cost >20%. Anthropic's own guidance is to review
"periodically to remove outdated or conflicting instructions" and keep files under
200 lines because "longer files consume more context and reduce adherence". So a pass
that finds nothing to remove deserves scrutiny, not relief.

### 5. Report — do not edit

Present findings. The user dispositions each one. Apply only what they accept.

### 6. Re-stamp last

Set `audited=` to the HEAD that was actually audited, refresh the timestamp, commit —
in the same commit as the applied edits, or immediately after.

If the diff or the corpus was too large to read in full, **say so and do not
re-stamp**. Re-stamping on unread evidence re-blesses false claims and silences the
trigger for another N commits.

### 7. A clean pass is a success

Zero findings is a real outcome, not a miss. Re-stamp, change nothing, say so plainly.

Before committing, verify the record actually changed (`git diff --quiet -- .docs-sync`
exits non-zero). If it did not, this pass audited the same HEAD as the last one and
there is nothing to record — say so and skip the commit rather than making an empty
one. Do not rely on the timestamp to force a byte change: it is second-resolution, and
two passes within the same second render identically.

## Intentional contradictions get a rationale, not a suppression entry

If a finding is deliberate, the fix is to write *why* into the doc ("this differs from
X because…"). That silences future passes by giving them the reason to read, and is
better documentation than a suppression list.

There is deliberately **no dismissal registry**. Stable finding identity across moving
line numbers is its own rabbit hole, and a suppression list that grows is how a tool's
not-useful rate climbs while it still looks like it is working.

## Common mistakes

| Mistake | Why it's wrong |
|---|---|
| Re-stamping without reading the diff | The record then asserts an audit that never happened |
| Re-stamping without reading the docs that could contradict it | The contradicting contract is routinely a sibling under `docs/`, not an ancestor |
| Reading `--stat` instead of hunks | A pathname and two line counts cannot falsify a claim |
| Treating the inventory as evidence about content | Line counts say nothing about what a doc asserts |
| Editing docs before the user dispositions findings | This is an audit; the separation is the whole design |
| Treating the nudge as blocking | It never blocks — the user can always carry on |
| Touching `.docs-sync` to silence a nudge | Use `--defer`; the record must only ever record real audits |
| Auditing ADRs, specs or dated plans | Archival by convention — they are *meant* to disagree with current state |
