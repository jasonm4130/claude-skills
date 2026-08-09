# AI reviewer calibration: the missing clean-pass, and where to place the Codex gate

*2026-07-15. Research + decision record. Motivated by two questions about the `codex-review` ⇄ `subagent-driven-development` integration: (1) should the Codex gate run per-task or only at the end of a branch, and (2) why does the reviewer never seem to return "this is fine"?*

## TL;DR

- **Gate placement: whole-branch, not per-task.** Internal evidence (a sibling-repo SDD run: 8 tasks all green per-task, whole-branch review then found 6 blockers incl. 2 data-destroying) and the one external granularity finding that survived verification both point the same way. Per-task Codex would pay N× the paid-call cost *and* N× the reviewer's over-rejection surface to catch strictly less. This is what the plugin already ships (diff mode fires once on `main...HEAD` before the PR); the per-task integration stays **ungated / unbuilt**.
- **The "never returns clean" worry is real, but it is a calibration gap, not a loop-termination gap.** Loop termination is already bounded on both sides (SDD: 2 fix rounds + oscillation breaker; codex-review: 3 rounds + 1 audit, hard-capped in the script). The gap is that the reviewer has no *respected* clean pass — the prompt is tuned adversarially and the decision-gate metric rewards finding things. Research says that exact framing **causes** over-rejection of correct code.

## Why the reviewer "always finds something" — the evidence inverts the premise

The intuition was "the reviewer nitpicks / invents trivia." The strongest, peer-reviewed evidence says the dominant measured failure mode of LLM reviewers is the opposite of nitpicking: **systematic over-*rejection* of correct, requirement-conforming code** (false-negative rates ~26–88%, dwarfing false positives), and it holds for frontier models including Claude-4.5 and GPT-4o.

- **Over-correction bias.** Jin & Chen, *Automated Software Engineering* (Springer, 2026), 5 models × 3 benchmarks × 3 prompt styles: FNR dwarfs FPR for every model (GPT-4o 26–88% FNR vs 0–11% FPR; Claude-4.5 26–62% vs <7%). Critically, **adding "explain your reasoning + propose a fix" scaffolding makes over-rejection worse** — GPT-4o's FNR went 26% → 73% as prompt complexity rose. Replicated by arXiv 2508.12358 (correct-conformance recognition collapsed 52% → 11% under more detailed prompting). *Implication: an adversarial "assume it can fail / break confidence" framing plus reason-and-justify scaffolding is a cause of "never returns clean," not incidental to it. Give the reviewer explicit permission to say "nothing to fix."*
- **Severity is partly a prompt artifact.** "Bias in the Loop: Auditing LLM-as-a-Judge for Software Engineering" (arXiv 2604.16790): position/sentiment/authority/verbosity framing swings judge accuracy by up to ~84 points on *unchanged* code. *Implication: keep the reviewer blind to persuasive framing — which is exactly the plugin's existing "reviewer never sees your self-assessment" rule and SDD's "self-grading never downgrades a finding" rule.*
- **Diagnosis > verdict.** SWE-Review (arXiv 2607.06065): a bare accept/reject verdict is a weak driver of fix quality; the structured diagnosis (defect location / description / root cause) does ~⅔ of the work (request-changes alone lifted resolve 3%→8%; +diagnosis →21%; oracle with test access 32%). Measure a reviewer against executable ground truth, score non-committal reviews at chance. *Implication: keep the per-finding diagnosis (which the diff prompt already asks for); don't couple a long verdict-justification into the severity call.*
- **Consensus ≠ validation; the empirical gate is the real lever.** "Refute-or-Promote" (arXiv 2604.19049): 80+ agents unanimously confirmed a non-existent vuln; a single agent that compiled and ran the code killed it. The anti-noise levers that worked were an empirical/reproducibility gate (a finding must name the failing input) and killing ~79–83% of candidates early. *Implication: promote "a finding I cannot reproduce is not a finding" from guidance to a hard pre-report gate.*
- **Unbounded loops are a real sink + reward-hacking risk.** "Practical Limits of Autonomous Test Repair" (arXiv 2605.01471): a no-oracle repair loop ran 113 cycles with zero output; 2/7 "converged" families did so by weakening assertions (`toBe(5)` → `toBeTruthy`), inflating reported convergence 50%→70%. Remedy: hard round cap + escalation, and gate "green" on an oracle the coder cannot edit. *Implication: our caps already exist; the residual watch-item is that an SDD fixer must not be able to weaken the tests it is judged on.*
- **Production tooling (the one that surfaced concrete mechanism): CodeRabbit.** Its resolved/clean state is a *user-triggered* command (`@coderabbitai resolve`), and its preference-learning is natural-language corrections, deliberately **not** thumbs-up/down or resolve/dismiss signals ("ambiguous / gameable").

### Evidence caveats

- The production-tool numbers the question most wanted — per-PR comment rates, un-commented-PR fractions, published false-positive rates for Copilot / Codex / Greptile / Bugbot / Qodo / Sourcery / Ellipsis / Sweep / Baz / Graphite Diamond — **did not survive verification.** Treat "how production tools calibrate a clean pass, and at what rate" as substantially unanswered.
- The loop/convergence findings rest on single-author 2026 preprints, several backing their authors' own tools, with self-described "author calibration" thresholds. **Use the mechanisms, not the magnitudes.**
- The two high-confidence findings (over-correction, prompt-framing sensitivity) are peer-reviewed and replicated but measured on small self-contained functions; extrapolating exact rates to multi-file diffs is inference — the qualitative pattern is what replicated.

Full run (16 confirmed / 9 refuted claims, 24 sources) archived in the session's deep-research output; durable facts captured in memory `research_llm_reviewer_overcorrection_and_gate_placement`.

## Decision 1 — Codex gate is whole-branch, not per-task

Keep the paid external Codex reviewer as an end-of-branch (`main...HEAD` diff mode) gate. Rationale, in order of weight:

1. **Cross-task bugs live in the accumulated whole.** Per-task reviewers see one task's diff against a brief; the destructive bugs in the sibling-repo SDD run were only visible reading the whole branch.
2. **Cost + over-rejection compound per-task.** Each invocation is a paid call *and* an independent chance to wrongly reject a good task diff (the over-correction bias), which then spawns needless fix churn. Fine granularity multiplies both.
3. **The cheap per-task reviewer already exists.** SDD runs a Claude-side reviewer per task (Sonnet, escalating to Opus), bounded by a 2-round cap + oscillation breaker, with Minor→ledger and plan-conflicts→human. That is the right place for task-local review; the external gate belongs at the branch.

The per-task Codex integration remains explicitly ungated — see the plugin README "Escalation paths." This research strengthens, rather than overturns, that stance.

## Decision 2 — Give the reviewer a respected clean pass; leave the (already-bounded) loop alone

Loop termination is not the problem. The five prompt/metric changes below add a legitimate "nothing to fix" state and gate findings on reproducibility, targeting the over-rejection bias directly.

## The five changes (theme → what actually shipped)

Reading HEAD before editing changed the shape: two of the five themes were already implemented, so they became a doc clarification and a no-op rather than manufactured edits (per the "verify a finding against HEAD before acting" rule).

| # | Theme | What shipped |
|---|---|---|
| 1 | Respected clean-pass | **Prompt edit.** `REVIEW_BODY`, `DIFF_BODY`, and both resume prompts now state that an APPROVED verdict with zero findings is the correct, expected result — skepticism is about the code, not a quota; do not manufacture findings to prove diligence. |
| 2 | Stop treating finding-count as reviewer health | **Doc edit.** SKILL.md + README "Decision gate" sections clarify `uniquePer5` is a *floor, not a target*: a clean review that produces zero findings is a success, and the reviewer must not be tuned toward producing findings. |
| 3 | Split gate decision from diagnosis | **Already satisfied — no code change.** The verdict is already derived mechanically from finding severity (`REVISE if any P1 or P2`), and the per-finding diagnosis is the SWE-Review-endorsed kind. Residual ("severity tracks what breaks, not how hard you looked") folded into the #1 wording. |
| 4 | Reproducibility as a hard filter | **Prompt edit.** `DIFF_BODY`'s "a finding I cannot reproduce is not a finding" promoted from a passing statement to a pre-report gate ("if you cannot name the input that makes it fail, do not report it — not even as a nit"); plan mode gets the proportionate analogue (tie each finding to a concrete failure scenario). |
| 5 | Where to place the gate | **Decision + doc edit.** Whole-branch (Decision 1). README "Escalation paths" records the evidence for keeping Codex out of the per-task loop. |

Tests: new assertions in `codex-review.test.mjs` pin the clean-pass permission and the reproducibility gate; the existing "diff prompts do NOT smuggle in intent" guard still holds (the new wording avoids plan/spec/document/intent vocabulary).
