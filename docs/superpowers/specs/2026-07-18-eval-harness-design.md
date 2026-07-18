# Offline Evaluation Harness — Design

**Date:** 2026-07-18 · **Status:** approved in brainstorm, pending spec review
**Source:** Gap #1 in `docs/plans/2026-07-17-benchmark-gaps-backlog.md` (rank #1;
both benchmark reviewers converged). Design settled interactively with the user;
decisions below record the choice **and** the why.

## Problem

There is no systematic way to measure whether the owned workflow (brainstorm →
plan → SDD → review, with the Codex cross-provider gate) actually produces
better outcomes than alternatives. Every improvement so far is justified by
reasoning and cross-review, not measured against a repeatable benchmark. Without
a harness we cannot tell a real improvement from a plausible-sounding one, and
we cannot detect regressions in the workflow itself.

## Decisions (settled with the user)

1. **Unit under test: per-stage, composable.** The harness scores workflow
   stages independently rather than end-to-end chains. End-to-end trials
   (~500k+ tokens each, high variance) can compose later on the same corpus and
   scorecard infrastructure. *(Chosen over end-to-end-only and per-skill
   trigger evals.)*
2. **First vertical slice: the reviewer stage.** Seeded-bug diffs + known-clean
   diffs → catch rate and over-rejection rate. Deterministic-leaning oracle,
   cheapest per trial, and directly validates the Gap #3 reviewer-calibration
   changes already shipped in `reviewer.md` / `final-reviewer.md`.
3. **Corpus: three tranches, mined cross-repo.** (a) *Paired* items — real
   merged diffs from the user's own repos (clean arm) with a bug seeded into a
   copy (buggy arm); same-diff pairing controls for difficulty. (b) *Synthetic*
   items covering taxonomy classes real history doesn't yield (weakened-test,
   races). (c) Mining is subagent work across sibling repos (forks like
   `openwrt`/`auto-gpt` excluded); reviewer-stage oracles need only diffs +
   ground truth, so mined repos' test runners never need to work.
4. **Systems under test: Claude reviewers AND Codex, day one.** SDD
   `reviewer.md`, `/code-review`, and Codex diff mode share one
   adapter interface. Codex quota burn is bounded by caching (below), 1-trial
   default, and a subsample flag.
5. **Public/private corpus split.** `claude-skills` is public. The in-repo
   corpus holds only synthetic items and items mined from public repos.
   Privately-mined items live in a separate private corpus repo
   (`~/Work/Git/claude-skills-bench-corpus`); the harness accepts a list of
   corpus dirs, defaulting to the in-repo one plus the private one when
   present.
6. **Health floors, not targets.** Baselines come from the first real run and
   ratchet only by explicit decision, so the harness stays a regression
   detector and never becomes something we tune toward (the Codex-gate `stats`
   philosophy).

## Layout

```
benchmarks/
  taxonomy.md               # versioned bug-class list
  corpus/reviewer/
    <item-id>/              # e.g. brok-stacks-0042
      item.json             # repo path, baseSha, language, tranche (mined|synthetic)
                            #  (JSON, not YAML: the repo is zero-dependency and
                            #   Node has no built-in YAML parser)
      clean.patch           # real merged diff — clean arm
      seeded.patch          # same diff + exactly one planted bug — buggy arm
      brief.md              # neutral task brief: the change's intent, written
                            #  from the CLEAN diff and identical across arms
                            #  (must not hint at the seeded bug)
      truth.json            # bug class, file, line span, mechanism, severity;
                            #  plus adjudicated knownIssues on the clean arm
  harness/
    run.mjs                 # CLI entry
    adapters/               # sdd-reviewer.mjs, code-review.mjs, codex.mjs
    matcher.mjs             # two-stage catch decision
    scorecard.mjs           # rates, floors, markdown+JSON output
    cache.mjs
    *.test.mjs
  results/                  # gitignored — run JSONL, scorecards, cache
  baselines.json            # checked-in health floors
```

Corpus items reference a **repo + base SHA**. Public-mined items additionally
record the **public remote URL** in `item.json`, so the corpus is acquirable
from a fresh clone; private-tranche items may reference local paths only. The
runner materializes a throwaway worktree at `baseSha`, applies the arm's
patch, and **commits it** (fixed identity author/date, so the commit is
byte-stable for caching) — every adapter then uniformly consumes the commit
range `baseSha..armSha`. This matters because the reviewer interfaces are
range-based (`review-package` requires `BASE HEAD`; Codex diff mode resolves
commit ranges): an uncommitted patched worktree would present an **empty
diff** and be silently scored on it.

**Missing corpus is a run failure, not a shrunken sample.** The runner builds
an expected manifest from the configured corpus dirs; an unresolvable repo or
pruned SHA fails the run (non-zero) listing the missing items, rather than
silently skipping them — otherwise a fresh machine "passes" on synthetic items
alone. `--allow-missing` downgrades this to a warning, but the scorecard then
reports coverage against the expected manifest explicitly.

## Authoring pipeline (per corpus expansion; agents author, code validates)

1. **Miner subagents** fan out over candidate repos and shortlist small,
   self-contained merged diffs.
2. **Human cull** of the shortlist.
3. **Seeder agents** plant exactly one taxonomy bug per item; write
   `seeded.patch` + `truth.json`. `brief.md` is written at mining time from
   the real commit/PR message (synthetic items author it with the item),
   before seeding, so it can't leak the bug.
4. **`validate.mjs`** — deterministic, part of the test suite — checks every
   committed item: both patches apply cleanly at `baseSha`, seeded differs from
   clean, truth schema complete, seeded span exists in the patch, `brief.md`
   present and non-empty.

Synthetic items skip steps 1–2.

## Runner and data flow

`node benchmarks/harness/run.mjs --adapters sdd,code-review,codex --arms
clean,seeded --trials 3 --items all` (`--items` also takes a glob or an
explicit list; `--sample N` runs a random-but-seeded subset — the
quota-bounding path for Codex passes)

The run expands into **cells** — (item × arm × adapter × trial). Per cell:
cache check → materialize worktree at `baseSha` → apply + commit arm patch →
invoke adapter with `baseSha..armSha` → normalize → append JSONL record. Cells
are independent; one failure never aborts the run.

**Adapter interface:** `{worktree, diffRange, brief, effort, model}` →
`{verdict: pass|reject, findings: [{file, line, severity, summary, mechanism}],
tokens, wallMs, raw}`.

**One canonical gate-outcome model.** Reviewers can reject without an
actionable finding (the SDD reviewer's `spec: "fail"` is exactly that), so
findings alone under-count rejections. Every adapter maps its native verdict
into `verdict`: SDD → reject iff `spec: "fail"` or any Critical;
code-review/codex → reject iff any finding at or above the configured
severity threshold. The mapping is part of the adapter's version. A clean-arm
**reject with zero findings still counts as an over-rejection event** —
verdict-level, weighted as Critical.

**Equal context across adapters.** All three receive `brief.md` as
change-intent context — otherwise results conflate reviewer capability with
access to intent. Adapter-specific extras (SDD's neutral implementer report)
are deliberate, documented, and recorded in the adapter version.

- *sdd-reviewer*: must reproduce the reviewer's real operating inputs, not
  just its prompt — `reviewer.md` reads a `review-package` diff file, judges
  spec compliance against a task brief, and expects an implementer report. The
  adapter therefore (a) generates the package with the actual
  `review-package` script over `baseSha..armSha` — **after hardening that
  script's `git diff` calls with `--no-textconv --no-ext-diff`** (matching
  `codex-review.mjs`): without them, a mined repo's configured textconv/diff
  driver — or a patch touching `.gitattributes` — executes host-side while
  assembling the package over seeded content; the hardening lands in the SDD
  plugin so its own reviews get the same protection — (b) passes the item's
  `brief.md`, and (c) supplies a **fixed neutral implementer report** —
  identical boilerplate for every cell, so it can neither leak hints nor vary
  between arms. The prompt file, the neutral report, and the package-assembly
  code all hash into the adapter version (and hence the cache key).
- *code-review*: `claude -p` with `--output-format json --json-schema`
  (verified available in the installed CLI), a read-only tool allowlist,
  cwd = worktree, reviewing `baseSha..armSha`; prompt content hash is the
  adapter's version.
- *codex*: imports `runCodex()` and diff construction from the codex-review
  plugin's `codex-review.mjs` (verified: `codex exec --json --sandbox
  read-only … --skip-git-repo-check`), inheriting `--no-textconv
  --no-ext-diff` — which matter more than usual here, since the harness
  deliberately materializes bug-seeded content.

**Cache = the quota story.** Key: hash of (item content, arm, adapter id,
prompt version, model, effort, trial index). Editing one reviewer prompt
re-runs only that adapter's cells; Codex cells never re-burn quota unless a
dependency changed. `--no-cache` forces.

## Matcher (the oracle)

Two stages; both must pass for a **catch**:

1. **Deterministic location prefilter:** finding file == `truth.file` and line
   within the seeded span ± 5 lines.
2. **Mechanism judge** (`claude -p --json-schema` on **sonnet** — judgment
   work, so not haiku per the delegation-tier rule; yes/no): does the finding
   describe the planted mechanism?

Near-misses (right location, wrong mechanism) are recorded separately as
diagnostics. Clean-arm findings need no matcher — each is an over-rejection
event, weighted by claimed severity. The judge prompt is versioned into the
cache key and regression-tested by a fixture micro-eval of
(finding, truth, expected-verdict) triples.

**The clean arm is presumed clean, not certified clean** — a real merged diff
can carry a genuine latent defect, and penalizing a reviewer for correctly
flagging one would corrupt the over-rejection metric. Mitigation:
**adjudication.** A clean-arm finding that persists (raised by ≥2 adapters, or
by one adapter across a majority of trials) is queued for human adjudication;
if confirmed real it is recorded under `knownIssues` in `truth.json` and
excluded from over-rejection counts from then on. Adjudications are corpus
changes (they alter item content, hence cache keys and baseline identity) —
never silent.

## Scorecard, floors, repeatability

Per adapter: catch rate (overall, by bug class, by severity); over-rejection
rate (severity-weighted findings per clean diff; weights Critical=3,
Important=2, Minor=1); mechanism accuracy; median tokens and wall-clock.
Output: markdown + JSON per run.

`baselines.json` holds health floors (e.g. catch rate ≥ baseline − 10 pts,
over-rejection ≤ baseline + 50%); a broken floor exits non-zero. Floors are set
from the first baseline run and ratchet only by explicit decision.

**Floors bind only to a matching population.** Each baseline records its
corpus-manifest hash, arm/trial policy, adapter config (prompt version,
model, effort), **and the full matcher/oracle config** — stage-1 span
tolerance, judge prompt hash, judge model, and the verdict-mapping policy.
The oracle determines what counts as a catch; changing it silently would move
scores while runs still looked floor-comparable. Floor enforcement runs only when the current run matches;
otherwise — notably any `--sample` run — the scorecard is stamped
**INFORMATIONAL** and floors are not evaluated (a lucky subsample must not be
able to "pass" a full-suite floor). A sampled population can get its own
baseline by explicit decision.

Trials: default 3 for Claude adapters, 1 for Codex. Medians everywhere;
per-item **flip rate** (verdict variance across trials) is reported — high
flip rate is itself a finding about the reviewer.

## Error handling

Per-cell isolation. Spawn failure, timeout, or schema-invalid output →
`status: error` in JSONL — surfaced in an errors column, never silently
dropped. Rates are always reported **alongside coverage** (scored cells ÷
attempted cells, per adapter × arm), because error exclusion alone can inflate
scores — an adapter that schema-fails on the hard 19% of seeded diffs would
otherwise clear floors on the easy rest. Coverage is enforced **per stratum —
adapter × arm × bug class — not just in aggregate**, because 95% overall can
coexist with 0% on one bug class. A stratum below 95% coverage is marked
**NOT-SCORED**: its rates are withheld, aggregates that would include it are
flagged, and if a baseline covers that stratum the run is stamped
**UNRELIABLE and exits non-zero** (same exit class as a broken floor; >20%
errors overall also triggers it). Missing repos/SHAs are a manifest failure
(see Layout), not a per-cell skip.

## Testing

`node --test` throughout: corpus validator, matcher stage 1, cache-key
derivation, scorecard math, adapter argument-construction as pure functions.
One end-to-end smoke test drives a single synthetic item through a **stub
adapter** (no API, no cost) in CI. Real-API runs are manual and deliberate.

**`scripts/run-node-tests.sh` must be extended** — its `find plugins scripts`
discovery would silently never run anything under `benchmarks/`; add
`benchmarks` to the find roots so the validator and smoke test actually gate
CI.

## Out of scope (this slice)

- Implementer- and plan-stage evals (same corpus/scorecard shape, later).
- End-to-end chain runs (compose later; also the evidence path for the
  deferred Gap #5 slim-plans question).
- CI-scheduled real-API runs, snapshot bundles, cross-repo test-runner setup.
