# Benchmark Gaps — Backlog

**Source:** the 2026-07-16 best-in-class AI-dev-workflow benchmark. The owned
workflow (brainstorm→spec → writing-plans→plan → subagent-driven-development, with
a cross-provider Codex review gate) was scored across 8 dimensions by two
frontier reviewers — **Fable** (same-family) and **Sol** (cross-family, Codex/GPT)
— against field practice (Karpathy, Boris/Anthropic, AWS Kiro, GitHub spec-kit,
Amazon working-backwards). Each dimension was rated MATCH / PARTIAL / GAP /
OVER-BUILT. This file is the durable TODO for the gaps that remain; each is sized
for its own proper treatment (spec → plan → SDD, or a design conversation first),
**not** to be rushed inline.

> Do these properly. Every item below is a real piece of work with open design
> questions — none is a quick patch. Give each the ceremony it warrants.

## Done

- **Gap #2 — Design-gate enforcement** (dimension 4). The brainstorming HARD-GATE
  was prose-only. Shipped `design-gate-guard` (PR #45, merged): a stateless
  PreToolUse hook that `ask`s before new-project scaffold commands. Deliberately
  scoped to design-before-*scaffolding*, not design-before-*editing* (a hook can't
  see approval state; a stateful flag risks blocking all editing). A stronger
  Write/Edit gate remains a possible follow-up — see "Deferred / contested".
- **Gap #3 — Reviewer clean-pass calibration** (dimensions 2/3). The in-family SDD
  reviewers had no clean-pass license or test-diff scrutiny (AI reviewers
  over-reject; they run every task/branch). Shipped in `reviewer.md` /
  `final-reviewer.md` (PR #44, merged): zero findings is a respected result; a
  test weakened to pass trivially is a `Critical`, never a `Minor`.

## To do — properly

### Gap #1 — Offline evaluation harness *(rank #1; both reviewers converged here)*

**The gap.** There is no systematic way to measure whether the owned workflow
actually produces better outcomes than alternatives. Best-in-class shops run eval
suites over their agent workflows; here, every improvement (including #2 and #3
above) is justified by reasoning and cross-review, not measured against a
repeatable benchmark. Without a harness, we can't tell a real improvement from a
plausible-sounding one, and we can't detect regressions in the workflow itself.

**Why it needs a design conversation first (before any build).** The load-bearing
choices are all judgment calls that must be settled with the user:
- **Task corpus:** which repos / which representative tasks? (Real past tasks with
  known-good outcomes? Synthetic seeded-bug tasks? A mix?)
- **What to score:** correctness (tests pass), review-catch rate (seeded bugs
  caught), over-rejection rate (clean code wrongly flagged), token cost,
  wall-clock, human-intervention count. Which of these, weighted how?
- **Repeatability:** model nondeterminism means runs vary; how many trials, what
  variance is acceptable, how is a pass/fail declared?
- **Scope:** eval the whole chain end-to-end, or per-stage (plan quality vs
  execution quality vs review quality)?

**Proposed shape (subject to that conversation):** a small fixed corpus of
tasks with oracles → run the workflow headless → score against the rubric →
report a scorecard. Reuse the Codex-gate `stats` idea (a health floor, not a
target) so the harness never becomes something we tune toward.

**Next action:** a brainstorming pass with the user to settle corpus + rubric +
repeatability, then spec → plan → build. **Do not start building before that
conversation.**

### Gap #4 — Independent RED→GREEN verification in SDD *(verification theater)*

**The gap.** The SDD implementer *claims* a TDD red→green cycle, but the workflow
never independently confirms the covering test actually **failed before** the
implementation and **passed after**. A cached, deleted, or already-passing test
would sail through. This is exactly the "verification theater" the workflow exists
to remove — currently unclosed for the TDD claim itself.

**Proposed approach:**
- Implementer returns **distinct `redSha` / `greenSha`** (the failing-test commit
  and the passing-implementation commit) plus the covering test id(s).
- A `verify-tdd-cycle` step (independent, cheap tier): check out `redSha`, run the
  named covering test, confirm **RED for the right reason** (fails on the asserted
  behavior, not a syntax/collection error); check out `greenSha`, confirm
  **GREEN**. Advance only if both hold.
- A **test-impact map** so the verifier knows which test covers which task (needed
  to run just the covering test, not the whole suite, at each sha).

**Open questions:** cost of two extra checkouts + targeted test runs per task;
how to name the covering test robustly across languages; interaction with the
existing head-verifier (fold in, or separate stage?).

**Next action:** spec → plan → SDD. Self-contained enough to not need a prior
design conversation, but write the spec first — the red-for-the-right-reason
check has real subtlety.

### Gap #5 — Slim plan steps: signatures + intent, not full code *(deferred / contested — see below)*

## Deferred / contested

- **Gap #5 — Slim plan steps.** The benchmark suggested `writing-plans` should
  carry **signatures + intent** per step rather than full implementation code, to
  avoid over-constraining the implementer and reduce plan↔implementation
  divergence. **This is contested and deliberately deferred**, because the current
  design mandates "complete code in every step" *on purpose*: full code makes
  tasks unambiguous for cheap-tier implementers and is what lets the SDD loop run
  sonnet/haiku workers reliably. Slimming plans trades that determinism for
  flexibility. This is a genuine judgment call, not a clear win — resolve it with
  **evidence** (does the harness from Gap #1 show slim plans doing as well or
  better?), not by argument. Revisit only after Gap #1 exists.

- **Stronger design-gate (Write/Edit before design).** `design-gate-guard`
  enforces design-before-*scaffolding* only. A hook gating *editing* before an
  approved design would need session state the stateless design deliberately
  avoids (a never-clearing flag would block all editing). Only pursue if the
  scaffold-only gate proves insufficient in practice.

## Notes

- The two remaining active gaps (#1, #4) are **independent** — either can go
  first. #1 is higher-rank but needs the design conversation; #4 is buildable now.
- Keep the whole-branch, not per-task, discipline for the Codex gate throughout
  (per repo convention) — a reviewed plan is not a reviewed diff.
