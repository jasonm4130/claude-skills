# Offline evaluation harness

Operator guide for the reviewer-stage benchmark. Full design and rationale
live in the spec: `docs/superpowers/specs/2026-07-18-eval-harness-design.md` —
read that first if you're changing behavior, not just running it.

## What it measures

The harness scores the owned review stack (SDD `reviewer.md`, `/code-review`,
and Codex diff mode) against a corpus of paired diffs: a **clean** arm (a real
or synthetic merged diff, presumed but not certified bug-free) and a
**seeded** arm (the same diff with exactly one taxonomy bug planted). Each
adapter reviews both arms under identical context. From that it reports, per
adapter: **catch rate** (did the reviewer flag the planted bug, judged by
mechanism, not just location), **over-rejection rate** (severity-weighted
findings — or a bare reject — raised against the clean arm, where nothing
planted exists to find), and **mechanism accuracy** (of everything flagged in
the right place, how much names the actual planted mechanism vs. a
near-miss). This is a regression detector against health floors set from a
real run, not a target to tune toward — see "Baseline workflow" below.

## Quickstart

```bash
node benchmarks/harness/run.mjs
```

With no flags this validates every configured corpus dir, runs every
registered adapter (`code-review`, `sdd-reviewer`, `codex`) over both arms,
and writes `benchmarks/results/runs/<timestamp>/{records.jsonl,scorecard.json,scorecard.md}`.
The scorecard markdown also prints to stdout. Flags (`run.mjs`'s `parseRunArgs`):

| flag | default | meaning |
|---|---|---|
| `--adapters a,b,c` | all registered | which adapters to run (duplicates rejected) |
| `--arms a,b` | `clean,seeded` | which arms to run (duplicates rejected) |
| `--trials N` | `3` | trials per cell for Claude adapters (≥ 1 — zero is rejected, it would score as a green run) |
| `--codex-trials N` | `1` | trials per cell for the codex adapter (quota-bounded; ≥ 1) |
| `--seed N` | `42` | RNG seed for `--sample`'s selection |
| `--model NAME` | `sonnet` | model passed to Claude adapters (never codex) |
| `--effort LEVEL` | `medium` | reasoning effort passed to the codex adapter |
| `--sample N` | off (all items) | run a random-but-seeded subset of items (≥ 1) |
| `--no-cache` | off | bypass the cell cache; adapter cells re-run (mechanism-judge verdicts are still reused — they are content-addressed pure functions of finding+truth text, so re-judging identical text buys nothing) |
| `--allow-missing` | off | downgrade a missing corpus repo or pruned baseSha to a warning |
| `--results DIR` | `benchmarks/results` | where to write cache + run output |
| `--baselines PATH` | `benchmarks/baselines.json` | which baselines file to bind against |

A real run costs real API calls (Claude adapters + the mechanism judge, and
Codex quota). There is no dry-run mode; use `--sample` or `--adapters` to
scope a first run down.

## Corpus item anatomy

Each item lives at `benchmarks/corpus/reviewer/<item-id>/` and is JSON
throughout — never YAML, since the harness has zero runtime dependencies and
Node has no built-in YAML parser. Six files/entries per item:

- `item.json` — id, tranche (`mined` | `synthetic`), repo, remote URL
  (public-mined items only), language.
- `clean.patch` — the real (or synthetic) merged diff; the clean arm.
- `seeded.patch` — the same diff plus exactly one planted taxonomy bug (see
  `benchmarks/taxonomy.md`); the seeded arm.
- `brief.md` — a neutral task brief describing the change's intent, written
  from the clean diff before seeding so it can't hint at the planted bug.
  Identical across both arms.
- `truth.json` — bug class, file, line span, mechanism description,
  severity, and any adjudicated `knownIssues` on the clean arm (see
  "Adjudication workflow").
- `base/` — present **only** on synthetic items (`tranche: "synthetic"`,
  `repo: "self"`): a minimal self-contained snapshot of the files the patches
  apply against, since a synthetic item has no real external repo + SHA to
  materialize from. Mined items instead resolve `item.json`'s `repo`/`remote`
  and `baseSha` against a real clone.

## Public/private corpus split

`claude-skills` is public, so this repo's corpus holds only synthetic items
and items mined from public repos. Diffs mined from private repos live in a
separate corpus repo at `~/Work/Git/claude-skills-bench-corpus`; `run.mjs`
includes it automatically whenever that path exists on disk, with no flag
needed. **Never commit a privately-mined diff into this repo's
`benchmarks/corpus/`** — if an item's source repo isn't public, it belongs in
the private corpus repo instead. Item ids must be unique across every
configured corpus dir: a collision aborts the run (colliding truths would
score against the wrong oracle), so prefix private items distinctly.

## Cost and quota notes

The Claude adapters (`code-review`, `sdd-reviewer`) default to 3 trials per
cell; the `codex` adapter defaults to 1 (`--codex-trials`), because Codex
quota is the scarcer resource. Every cell is cached by a content-derived key
(item content + arm + adapter + adapter version + model/effort + trial
index) under `--results/cache`, so **re-running an unchanged corpus against
an unchanged adapter costs nothing** — only a changed prompt, a changed item,
or `--no-cache` triggers a re-spend. `--sample N` runs a seeded random subset
of items, useful for a cheap first pass or a Codex-bounded smoke run; a
sampled run is stamped `INFORMATIONAL` and never evaluated against floors
(see below), so it's safe to run often.

## Baseline workflow

`benchmarks/baselines.json` starts empty (`{"baselines": []}`) and is never
written by the harness itself — it's a checked-in file you edit by hand.
Because it's hand-edited, the runner validates it before spending anything: a
baselines file that exists but doesn't parse (or lacks a `baselines` array)
aborts the run rather than being silently treated as "no baselines", which
would skip the health floors.
After the first real full run you trust, open its
`scorecard.json` and copy two things into a new entry: the top-level
`populationId` (which pins the exact corpus manifest + arm/trial policy +
adapter versions + matcher/judge config this baseline is valid for) and, per
adapter, `catchRate` and `overRejection` from `scorecard.json`'s `adapters`
object:

```json
{
  "baselines": [
    {
      "label": "first-freeze",
      "frozenAt": "2026-07-20",
      "populationId": "<scorecard.json's populationId>",
      "adapters": {
        "<adapter-id>": { "catchRate": 0.0, "overRejection": 0.0 }
      }
    }
  ]
}
```

A future run only evaluates floors against an entry whose `populationId`
matches exactly — a changed corpus, config, or oracle produces a run stamped
`INFORMATIONAL` instead of `OK`/breach, never a silent comparison against
stale identity. Floors are **health floors, not targets**: catch rate must
not drop more than 10 points below baseline, over-rejection must not exceed
1.5x baseline, and they ratchet only by an explicit decision to add a new
`baselines.json` entry — never automatically by the harness.

## Adjudication workflow

The clean arm is *presumed* clean, not *certified* clean — a real merged diff
can carry a genuine latent defect the harness would otherwise punish a
reviewer for correctly flagging. When a clean-arm finding persists (raised by
two or more adapters, or by one adapter across a majority of its trials),
it's a candidate for human adjudication. If you confirm it's a real issue,
add it to that item's `truth.json` under `knownIssues` (same shape as a
finding's location: file + line span) — from then on the matcher excludes
findings that location-match a known issue from the over-rejection count.
Editing `knownIssues` changes the item's content hash, which changes every
cell's cache key for that item **and** the corpus manifest hash, which
changes `populationId` — so an adjudication invalidates cached cells for that
item and detaches any baseline frozen before it. This is deliberate, never
silent: never edit `knownIssues` casually.

## Judge calibration

The mechanism judge (a single `claude -p --json-schema` yes/no call on
sonnet) is regression-tested by a fixture micro-eval:

```bash
node benchmarks/harness/matcher.mjs --self-eval
```

This is manual and makes real API calls (it is not part of `node --test` or
CI) — run it after touching the judge prompt to check the judge still agrees
with `benchmarks/harness/fixtures/judge-cases.json`'s labeled
(finding, truth, expected-verdict) triples before trusting a scorecard that
depends on it.

## Authoring new corpus items

New items follow the pipeline in the spec's "Authoring pipeline" section:
miner subagents shortlist small, self-contained merged diffs from candidate
repos (forks excluded); a human culls the shortlist; seeder agents plant
exactly one taxonomy bug per item and write `seeded.patch` + `truth.json`,
with `brief.md` written before seeding so it can't leak the bug. Synthetic
items skip the mining/cull steps and are authored directly. Whichever path an
item takes, validate it structurally before committing:

```bash
node benchmarks/harness/validate.mjs
```

This checks, per item: both patches apply cleanly at `baseSha`, the seeded
patch actually differs from the clean one, the truth schema is complete, the
seeded bug's span is covered by a hunk in `seeded.patch`, and `brief.md` is
present and non-empty. It exits non-zero on any error — never commit an item
that fails it.
