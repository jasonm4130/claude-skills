# Productivity Roadmap — making the agent measurably better

*2026-07-19. A prioritized roadmap for what to build next to make the coding
agent more productive, higher-quality, and more trustworthy. This sits **above**
[`2026-07-17-benchmark-gaps-backlog.md`](2026-07-17-benchmark-gaps-backlog.md),
which is the itemized TODO — this file is the strategic framing, the ranking, and
the division of labour (what's the agent's to build vs. what's the human's to
decide).*

## The one idea everything hangs on

The ecosystem is ahead of the pack on rigor (15 plugins, brainstorm→spec→plan→SDD,
cross-provider Codex review, deep-dive orchestration, guards, memory, retro,
handoff). But **every improvement to date is justified by reasoning and
cross-review, not by measurement.** We cannot currently tell a real improvement
from a plausible-sounding one, and we cannot detect when the workflow *regresses*.

That makes the eval harness the meta-lever: it converts the whole ecosystem from
*argued* to *measured*, and it's the prerequisite for resolving the decisions
we've deliberately deferred (e.g. slim-plans, Gap #5) with evidence instead of
argument. **Rank everything below by how much it depends on this.** The harness is
already in flight on `feat/eval-harness`; the hard part is not the code — it's the
judgment calls, which are the human's (see "How the human can help").

## Ranked roadmap

### 1. Finish the eval harness — the meta-lever

*Backlog: Gap #1 (rank #1; both frontier reviewers converged here).* Unlocks
everything else, including the deferred decisions. Blocked not on code but on a
design conversation to settle corpus + rubric + repeatability + scope. **Do not
finish building before that conversation.**

Discipline to preserve: score against a **health floor, not a target** (reuse the
Codex-gate `stats` idea) so the harness never becomes something we tune toward
(Goodhart). Keep a held-out slice the loop never sees.

### 2. Independent RED→GREEN verification in SDD — kill the last verification theater

*Backlog: Gap #4.* The one place the workflow still **takes the agent's word**: the
SDD implementer *claims* a TDD red→green cycle, but nothing confirms the covering
test failed-before and passed-after. A cached, deleted, or already-passing test
sails through. This is the exact failure mode the workflow exists to eliminate,
and it's what should worry us most — an agent asserting "done, tests pass" when it
isn't. Buildable now, self-contained: distinct `redSha`/`greenSha` + a
test-impact map + a cheap-tier verifier that checks RED-for-the-right-reason then
GREEN.

### 3. Test-impact map + tight "run and see it" loop — the productivity lever

Two-for-one with #2: the test-impact map that Gap #4 needs is the *same*
infrastructure that lets the agent run only the covering test instead of the whole
suite, and it pairs with the `/run` skill so a change's effect can be observed
cheaply. The biggest quality lever for any agent is a fast, cheap feedback loop.
Verification-before-complete is already mandated in CLAUDE.md; the reason it
sometimes gets cut short is that the loop is expensive. Make it cheap and it always
gets closed.

### 4. Skill-selection canary — drift detection for the ecosystem itself

As plugin count grows, skills silently stop triggering past ~1% of the context
budget, with **no warning** (documented in `RESEARCH_ecosystem_benchmark.md`).
Guards can silently break too. Build a fixed set of representative prompts with
known-correct skill choices, run periodically, and alarm when a skill stops firing
or the wrong one wins. A small, routing-layer version of #1.

## Given free rein — the ambitious one

Turn the harness into a **self-improving loop**: it scores the workflow, a
meta-agent proposes candidate skill/prompt changes, tests each against the corpus,
and keeps *only* measured wins. The ecosystem stops being reasoning-tuned and
becomes empirically self-tuning.

**The honest caveat is Goodhart** — the moment the harness is a target, the agent
optimizes the metric instead of the outcome. This only works with the guardrails
already in our design vocabulary: a health *floor* (not a maximized score), a
held-out corpus the meta-loop never sees, and the human as final judge on every
kept change. Do not pursue until #1 exists and has proven stable.

## How the human can help

Three inputs only the human can provide:

1. **The harness brainstorm.** The load-bearing calls are all judgment: *which
   corpus* (real past tasks with known-good outcomes vs. synthetic seeded-bug tasks
   vs. a mix), *what to score and how to weight it* (correctness / seeded-bug
   catch-rate / over-rejection / token cost / wall-clock / intervention count),
   *repeatability* (trials + acceptable variance under model nondeterminism), and
   *scope* (end-to-end vs. per-stage). One hour that de-risks months.
2. **Curate the corpus of real past tasks with known-good outcomes.** The one input
   that can't be credibly synthesized — real work with real oracles beats any
   number of seeded toy bugs.
3. **Name where the friction actually is.** Correction-memory captures some of it,
   but the felt sense — where the agent gets redone, re-explained, or caught
   claiming done too early — is ground truth that should *drive* what the harness
   scores. Metrics should mirror real pain, not a textbook rubric.

## Open question that reorders this list

Where is the most friction with the agent today?
- **Trust** — "done" isn't believed until the human has checked it → pushes #2 first.
- **Consistency** — quality varies run-to-run → pushes #1 first (measure the variance).
- **Speed** — the loop is just slower than wanted → pushes #3 first.

## Sequencing recommendation

**#1 next — specifically the brainstorm**, since the build is underway and blocked
on judgment, not code. Then **#2**, buildable immediately and self-contained. #3
rides on #2's test-impact map. #4 and the self-improving loop follow once the
harness is stable.
