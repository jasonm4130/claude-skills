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
      item.yaml             # repo path, baseSha, language, tranche (mined|synthetic)
      clean.patch           # real merged diff — clean arm
      seeded.patch          # same diff + exactly one planted bug — buggy arm
      truth.yaml            # bug class, file, line span, mechanism, severity
  harness/
    run.mjs                 # CLI entry
    adapters/               # sdd-reviewer.mjs, code-review.mjs, codex.mjs
    matcher.mjs             # two-stage catch decision
    scorecard.mjs           # rates, floors, markdown+JSON output
    cache.mjs
    *.test.mjs
  results/                  # gitignored — run JSONL, scorecards, cache
  baselines.yaml            # checked-in health floors
```

Corpus items reference a **local sibling repo + base SHA**; the runner
materializes a throwaway worktree and applies the arm's patch. No snapshot
tarballs — a pruned SHA degrades the item to skipped-with-reason (a `git
bundle` escape hatch is documented, not built).

## Authoring pipeline (per corpus expansion; agents author, code validates)

1. **Miner subagents** fan out over candidate repos and shortlist small,
   self-contained merged diffs.
2. **Human cull** of the shortlist.
3. **Seeder agents** plant exactly one taxonomy bug per item; write
   `seeded.patch` + `truth.yaml`.
4. **`validate.mjs`** — deterministic, part of the test suite — checks every
   committed item: both patches apply cleanly at `baseSha`, seeded differs from
   clean, truth schema complete, seeded span exists in the patch.

Synthetic items skip steps 1–2.

## Runner and data flow

`node benchmarks/harness/run.mjs --adapters sdd,code-review,codex --arms
clean,seeded --trials 3 --items all` (`--items` also takes a glob or an
explicit list; `--sample N` runs a random-but-seeded subset — the
quota-bounding path for Codex passes)

The run expands into **cells** — (item × arm × adapter × trial). Per cell:
cache check → materialize worktree at `baseSha` → apply arm patch → invoke
adapter → normalize → append JSONL record. Cells are independent; one failure
never aborts the run.

**Adapter interface:** `{worktree, diffRange, effort, model}` →
`{findings: [{file, line, severity, summary, mechanism}], tokens, wallMs, raw}`.

- *sdd-reviewer* / *code-review*: `claude -p` with `--output-format json
  --json-schema` (verified available in the installed CLI), a read-only tool
  allowlist, cwd = worktree, prompt = the reviewer prompt file (its content
  hash is the adapter's version).
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

## Scorecard, floors, repeatability

Per adapter: catch rate (overall, by bug class, by severity); over-rejection
rate (severity-weighted findings per clean diff; weights Critical=3,
Important=2, Minor=1); mechanism accuracy; median tokens and wall-clock.
Output: markdown + JSON per run.

`baselines.yaml` holds health floors (e.g. catch rate ≥ baseline − 10 pts,
over-rejection ≤ baseline + 50%); a broken floor exits non-zero. Floors are set
from the first baseline run and ratchet only by explicit decision.

Trials: default 3 for Claude adapters, 1 for Codex. Medians everywhere;
per-item **flip rate** (verdict variance across trials) is reported — high
flip rate is itself a finding about the reviewer.

## Error handling

Per-cell isolation. Spawn failure, timeout, or schema-invalid output →
`status: error` in JSONL — excluded from rates, surfaced in an errors column.
Missing SHA → item skipped-with-reason. If an adapter errors on >20% of its
cells, the scorecard is stamped **UNRELIABLE** rather than reporting rates from
a gutted sample.

## Testing

`node --test` throughout: corpus validator, matcher stage 1, cache-key
derivation, scorecard math, adapter argument-construction as pure functions.
One end-to-end smoke test drives a single synthetic item through a **stub
adapter** (no API, no cost) in CI. Real-API runs are manual and deliberate.

## Out of scope (this slice)

- Implementer- and plan-stage evals (same corpus/scorecard shape, later).
- End-to-end chain runs (compose later; also the evidence path for the
  deferred Gap #5 slim-plans question).
- CI-scheduled real-API runs, snapshot bundles, cross-repo test-runner setup.
