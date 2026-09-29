# Cross-family review replay (2026-09-29)

Why `codex-review` 0.6.0 pairs round 1 with a blind Opus reviewer. Firsthand measurement on the owner's own review history; the full write-up with per-defect data lives in the owner's private research notes.

## Method

- 19 past artifacts (15 diffs, 4 plans) where Codex round 1 raised P1/P2 findings and the exact prompt and artifact could be recovered. Diffs pinned to their commit range; plans read only at the pre-review commit.
- Three blind reviews per artifact with the verbatim Codex prompt: Codex (`gpt-5.6-terra`, high effort) and two independent Opus 5.5 runs (session default effort).
- All P1/P2 findings deduped by root cause into 93 defects (partial match = 0.5).

## Results

| Pair | Jaccard |
|---|---|
| Opus run 1 vs Opus run 2 | 69% |
| Codex vs Opus run 1 | 25% |
| Codex vs Opus run 2 | 24% |

| Reviewers | Share of the 93 defects |
|---|---|
| Codex alone | 52% |
| One Opus run | 61–66% |
| Two Opus runs | 75% |
| Codex + one Opus run | 91–94% |

- Of historical Codex findings an Opus classifier labelled "a same-model re-read would catch it", two blind Opus runs found 11 of 27.
- Codex was stronger on narrow boundary and state bugs; Opus on whole-system and tool-behaviour bugs (a reading of the lists, not measured).

## Confounds

Effort mismatch (Codex high, Opus medium); n=19 with one Codex sample; all matching by Opus-family models; round 1 only, so rounds 2–3 and the audit are unmeasured.
