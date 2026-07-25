# AI builds faster but erodes understanding — is it real, and what do I do about it?

**Date:** 2026-07-25 · **Method:** 5-angle adversarial deep-dive (`wf_8d538611-478`), tier-1/tier-2 verification, 0 failed angles
**Question:** I can't follow my own plans / what's been done. Is the "AI makes us build faster but not understand better" discourse real, and what concretely fixes it?

---

## Verdict

**Real — but the cause is not "AI," it's *delegation mode*.** The comprehension loss tracks *how* you interact with the model, not *whether* you use one. The "faster" half of the slogan is genuinely contested; the "doesn't help understanding" half now has a direct randomised trial behind it.

---

## 1. Is it real?

### The comprehension half: yes, with an RCT

**Anthropic (Shen & Tamkin, Jan 2026)** — 52 engineers learning an unfamiliar library.

| | Comprehension quiz |
|---|---|
| AI-assisted | **50%** |
| Control | **67%** |

Cohen's *d* = 0.738 (large; ~two letter grades). Worst sub-score: debugging. **No significant time saving** in this task.

The load-bearing detail is the breakdown by interaction pattern. Six patterns were observed; they split cleanly:

- **Preserve learning (65%+):** conceptual inquiry ("explain how X works"), hybrid (code + explanation), generate-then-comprehend (accept output, then actively work through it).
- **Erode learning (<40%):** pure delegation ("write this for me"), progressive reliance (starts engaged, drifts to delegation), iterative debugging (paste error → paste fix → repeat, never forming a model).

> Understanding didn't erode because AI was present. It eroded when the human stopped generating.

### The speed half: contested — don't lean on it in either direction

- **For:** the GitHub Copilot RCT (~55.8% faster on a scoped task); Microsoft's 4,867-developer field trial (+26% tasks completed).
- **Against:** **METR (2025)** found experienced OSS devs ~**19% slower** with AI while *believing* they were ~20% faster.
- **Caveat the discourse gets wrong both ways:** METR's 2026 follow-up still measures a slowdown for *returning* participants, but METR itself has said "speedups now seem likely" — the picture is a selection/population issue, **not a reversal**. Treat "AI makes you slower" as unproven.

**The robust cross-study finding is narrower and sharper than either camp:** *your felt sense of speed is not evidence of speed, and it is not evidence of understanding.* Both METR and the Anthropic RCT show self-assessment diverging from measurement.

### Supporting signals (weaker, directional)

- **GitClear** (~211M changed lines): code duplication up, refactoring/moved-lines down — a maintainability trend consistent with less comprehension, though correlational.
- **DORA** is mixed: 2024 reported AI adoption *hurt* delivery stability; 2025 partially reversed to an "amplifier" framing (AI magnifies existing org strengths/weaknesses). Don't cite DORA as settled either way.
- **AI-PR review study (11,429 real reviews, 2026):** approval rate rose to ~42% while inline comments *fell 22%* among the same reviewers — automation complacency, measured in the wild.
- **~61% of AI-authored PRs receive zero human review comments.**

### What's hype

- **"The 70% problem"** (Osmani) — a useful *frame*, not a measured statistic.
- **"Comprehension debt"** — real and useful; Osmani **popularised** it, didn't coin it.
- **Single-source claims to discount:** the Orosz "Meta/Instagram outage" anecdote (single-source); a "1/3 success rate on an Anthropic RL team" figure that appeared with no citation (**unsupported**); particula.tech's numbers (single-source, conflict of interest); Gerlich 2025 (carries a formal Correction, 2025-09-10).
- **AI-provenance tooling** (e.g. a tool cited as `provenant`) — the category is immature, single-maintainer, and at least one cited tool appears partly fabricated in its source. **Don't build on it yet.**

---

## 2. Why reviewing *feels* like understanding but isn't

Four mechanisms, all pre-AI, all well-established — and they stack specifically against an orchestrator.

1. **Generation effect** (Slamecka & Graf, 1978). You retain what you produce far better than what you read — and the benefit accrues *only if you actually attempt the generation*. When the agent generates, you forfeit it entirely.
2. **Illusion of explanatory depth** (Rozenblit & Keil, 2002). People massively overestimate their grasp of systems they didn't build, and the illusion is *strongest* for things with visible, real-time mechanism. Watching an agent work and reading its clean diff is close to the maximally illusion-inducing experience.
3. **Automation complacency** (Parasuraman & Manzey). Measured in **both novices and experts**; explicitly "cannot be overcome with practice." Expertise is not a defence.
4. **Comprehension can't be offloaded.** Cognitive offloading works for storage and computation. Judging what's worth building, and why, is the residue that delegation cannot produce.

Related: **desirable difficulties** (Bjork) — the effortful conditions that slow performance *during* learning are the ones that produce durable retention. Frictionless generation removes exactly those.

---

## 3. Diagnosis of *this* workflow

The pipeline — deep-dive → written plan → cross-model plan review → SDD → cross-model diff review → PR — is **structurally strong**. Anthropic's analysis of ~400k Claude Code sessions found users make ~70% of *planning* decisions but only ~20% of *execution* decisions; that split is the successful pattern, and this pipeline institutionalises it with explicit specs and review gates most people skip.

But the same structure has a comprehension hole the literature names precisely:

1. **"The plan is a faithful proxy for execution"** — a documented risk heuristic (FAccT'26, 17-developer study): reviewing the *plan* substitutes for understanding the *code*. Directly observed here — the SDD run deviated from the approved plan in ways only the diff reviews caught, so plan-approval demonstrably was not code-understanding.
2. **Cognitive distance** (same study): *"because the code is not created by me, my understanding of it is surface level."* The diffs came from subagents in worktrees never opened.
3. **Evidence sprawl.** One feature produced: a plan doc, 15 Codex findings across 3 rounds, an SDD run log, two diff reviews, a PR body. That's *evidence* spread thin, which feels like understanding spread thin — but adding artifacts did not add comprehension. A raw transcript **transfers noise, not understanding.**

---

## 4. What to do — ordered by leverage

The through-line across every evidence-backed practice: **add one step where *you* generate, instead of approve.**

### 4.1 Write the intent and acceptance criteria yourself (highest leverage)
Before the model expands a plan, the *why* and the *success criteria* should be your words; let AI expand the *how*. Even partial self-generation restores the generation effect. This is a small edit to an existing habit, not a new ritual.

### 4.2 Replace "approve the plan" with a 60-second explain-back
After a plan or an SDD run, reconstruct "what changed and why" **in your own words first**, then check yourself against the summary. Scaffolded self-explanation (Chi et al., 1989/1994) roughly doubles comprehension gain over passive review.

Support it with a **linear walkthrough** (Willison): have a *fresh* agent build a narrative walkthrough **from real `git`/file reads**, never from retyped snippets — so it can't hallucinate — then actively verify it rather than read it.

### 4.3 Make one distilled record the anchor, not the pile
Keep it to **one screen, in-repo, immutable + superseded** (never edited in place). The part code can never recover, and therefore the part worth writing: **the rejected alternative, and the constraint that forced the choice.** For a shipped change, the durable artifact is the "what we actually fixed and why" summary — not the plan doc and not the PR body.

### 4.4 Curate the handoff; never replay the transcript
Make handoff/retro artifacts **decision-focused**: the decisions made, each with its reason. *A decision without its reason gets re-litigated on contact.* A short retro you read beats a long transcript you skim.

### 4.5 Triage review depth by risk
Böckeler's **on-call test**: "would you deploy this 1,000-line change if you were on call tonight?" Weight by **impact × probability × detectability**. Skim the docs fix; **re-derive by hand** the resolver that silently picks a stale version. Reading every diff at equal depth is how rubber-stamping creeps in — and AI code defeats the old "looks clean, probably fine" heuristic, because it is *uniformly* clean.

Related rules of thumb from practitioners: Osmani's **new-hire rule** (would you accept this from a new hire you're responsible for?); Orosz's **read all AI-generated code before merge**.

---

## 5. The honest tension

Heavy orchestration **helps** — it forces explicit specs and review gates, which is rare and genuinely good — and **hurts** — it lets plan-approval stand in for code-understanding and scatters the "why" across artifacts.

The fix is not less orchestration. It's the one checkpoint the pipeline lacks: **a step where the human reconstructs the reasoning instead of approving someone else's**, plus collapsing N skimmable artifacts into one distilled record that actually gets engaged with.

---

## Limitations of this research

- The strongest single study (Anthropic RCT) is **n=52, skewed junior, learning an unfamiliar library**. Generalising to expert production work is a stretch — though the underlying cognitive mechanisms are decades-deep and robust.
- Speed evidence is genuinely contested (see §1); no claim here rests on "AI makes you slower."
- Several popular figures in the discourse are opinion, single-source, or uncited — flagged inline above rather than filtered out, so they can be re-checked.
- Practice recommendations (§4) are the highest-reliability part of the research; the tooling/artifact angle was medium reliability, and the provenance-tool category specifically is not yet trustworthy.

## Sources (primary)

- Shen & Tamkin (Anthropic), Jan 2026 — RCT, AI assistance and comprehension.
- METR, 2025 + 2026 follow-up — experienced OSS developer speed study.
- Peng et al. — GitHub Copilot RCT. · Microsoft/Accenture 4,867-developer field trial.
- Slamecka & Graf (1978) — generation effect. · Rozenblit & Keil (2002) — illusion of explanatory depth.
- Parasuraman & Manzey — automation complacency. · Bjork — desirable difficulties.
- Chi et al. (1989, 1994) — self-explanation.
- FAccT'26 — 17-developer study on cognitive distance and agentic-coding risk heuristics.
- Anthropic Claude Code telemetry (~400k sessions) — planning vs execution decision split.
- GitClear code-quality report. · DORA 2024 & 2025. · AI-PR review study (11,429 reviews, 2026).
- Practitioner: Willison (linear walkthroughs), Osmani (70% problem, new-hire rule), Böckeler (on-call test), Orosz (read all AI code).
