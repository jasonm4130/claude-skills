# Retire dead skills, fix broken plumbing, move the artefact trigger to end-of-work

**Status:** Accepted   **Date:** 2026-08-03

## Context

A usage audit over 574 session transcripts (2026-07-13 → 08-02, 195 skill calls)
plus `~/.claude/codex-review-log.jsonl` (141 chains) found the problem is not skill
quality. Two things are true at once:

**Three mechanisms were wired to nothing.** `handoff`'s context-fill nudge had never
fired since install on 2026-05-25 — `status-and-flag.mjs` runs as a top-level
`statusLine` command, so it never gets `CLAUDE_PLUGIN_DATA` and writes to
`os.tmpdir()`, while `check-handoff-flag.mjs` is a real hook and reads the plugin
data dir. Verified: 7 orphaned `handoff-nudge-*.flag` files in tmpdir, 0 files in
the reader's directory. `session-retro`'s nudge said "Run the retro skill", the
model called `Skill(retro)`, got `Unknown skill: retro` 4 times and never once
recovered. Both are the same bug class — a hook that fires correctly and emits an
instruction the agent cannot execute — and it hit 4 of 8 audited skills.

**Five skills had never been invoked, ever.** `visual-plan` (6.5 weeks),
`adversarial-agents` (10 weeks), `codebase-design` and `domain-modeling` (2 weeks).
Every skill that does fire has a mechanical inbound trigger — a named CLAUDE.md
gate, a hook nudge, an unambiguous user phrase, or a hand-off from a skill that
already fires. The dead ones form a closed reference cluster pointing only at each
other. `adr` (2 calls all-time) collides with `visual-plan` on the literal string
"write an ADR", each naming the other as the escape hatch.

Separately, `codex-plan-review` wrote `audit-concerns-user-approved` on 86 of 141
chains, including every sampled background run where no user was ever asked —
`SKILL.md` has no unattended path at all. And the 2026-07-15 clean-pass fix landed
in the review and diff prompts but never in the two audit builders; plan-mode
audits have returned PASS 0 times in 50 against diff mode's 28%.

## Decisions

1. **Delete `adversarial-agents`, `visual-plan`, `domain-modeling`.** Zero
   invocations; `codex-review` occupies the adversarial niche cross-family, and the
   one controlled ablation of context files found no measurable correctness gain.
2. **Fix the plumbing, then guard it.** Readers check every candidate data dir; all
   hook-emitted skill names are plugin-qualified; a repo-consistency test now fails
   the build on an unqualified name.
3. **`audit-concerns-unattended`** — a background run may amend, but may not claim a
   human signed off. Audit prompts get the clean-pass grant and a P1-or-two-P2 floor.
4. **Move the artefact trigger to the end.** SDD step 7a offers a decision record
   once, only for load-bearing irreversible outcomes, at the only moment the full
   picture exists. ADR prose is budgeted to one page.
5. **Keep `codebase-design`, rewritten** around observable states with one imperative
   hand-off from `brainstorming`. Review 2026-08-24; delete if still at zero.

## Consequences

Fewer skills, each with exactly one unambiguous inbound edge. The `handoff` nudge
starts firing for the first time, which will be noisy before it is useful — the
threshold may need tuning. Deleting `domain-modeling` orphans an unattributed local
branch that added hooks to it (see below).

Two bets that could be wrong. The audit severity floor is modelled, not observed: it
flips 17/91 CONCERNS to PASS on historical data, but the live effect is unmeasured.
And the acceptance rate that justified keeping the gate broadly as-is (83–84%) is
self-scored from a log that also carried the false `user-approved` labels — so it is
weaker evidence than it looks until the new outcome class has run for a while.

Not addressed: a controlled study (arXiv 2607.21656) found Codex-reviewing-Claude
net-negative (−8.6pp, 3 fixes / 13 regressions) while the reverse gained +18.1pp.
Our gate is structurally the harmful direction. Untested here; worth measuring
revert rates on folded-in findings before trusting the gate further.

## Grounding sources

- `~/.claude/codex-review-log.jsonl` — 141 chains, verdict/outcome distributions,
  12 review-mode APPROVED (9 at round 3, first 2026-07-16), falsifying the
  "no plan has ever reached APPROVED by round 3" claim deleted from `SKILL.md:18`.
- `$TMPDIR/handoff-data/` vs `~/.claude/plugins/data/handoff-jasonm4130-claude-skills/`
  — 7 flags vs 0 files, empty since 2026-05-25.
- Artefact counts across `~/Work/Git/*`: specs 89 (6 touched in 14d), plans 135 (16),
  ADRs 37 (22 — 21 of them `transcoder`, hand-written without the `adr` skill).
- `transcoder/docs/adr/` — 20 ADRs, mean 1,674 words, max 5,283.
- Thoughtworks Technology Radar: spec-driven development held at Assess, never Adopt.
