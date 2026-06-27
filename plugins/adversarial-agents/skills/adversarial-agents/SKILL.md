---
name: adversarial-agents
disable-model-invocation: true
description: Configurable adversarial panel review for any artefact — plans, code, design docs, prose, model outputs. Auto-selects a panel of personas by artefact type (plans get YAGNI/Premortem/Hidden Assumptions; code gets Saboteur/New Hire/Security Auditor; etc.). Captures a pre-commit defense from the user, dispatches the panel in parallel, then walks every critique one-at-a-time with verbatim quoting and convergence-prioritised ordering. Use when user wants adversarial review, red-team a plan, stress-test a design, find holes, devil's advocate, panel critique, or mentions "grill me" / "adversarial-agents".
---

# Adversarial Agents

Configurable adversarial panel review of any artefact. Generalises the panel-of-personas pattern from Matt Pocock's `grill-me` to arbitrary artefact types — plans, code, design docs, prose, model outputs.

Pure conversation. No file output. No "recommended answer" — the critique IS the question; the user's pre-commit defense is the user's answer.

## Triage first

Before dispatching, check the artefact is concrete enough to attack:

| Signal | Action |
|---|---|
| Artefact is <~100 words, or has no concrete decisions/values/file paths/named targets | **Refuse.** Reply: "This artefact is too thin to attack productively — flesh it out first, then come back." Do not dispatch. |
| User says "review my plan" / "grill this plan" with substantive content | Proceed; panel will be `plan` (YAGNI / Premortem / Hidden Assumptions). |
| User pastes code / points at a file | Proceed; panel will be `code` (Saboteur / New Hire / Security Auditor). |
| Other concrete artefact (design doc, spec, prose, model output) | Proceed; panel auto-selected per the table below. |

Adversarial-agents attacks fleshed-out artefacts. It does not flesh them out — that's `brainstorming`'s job for plans, or the user's drafting process for everything else.

## Pre-commitment gate (after triage, before dispatch)

After triage passes, ask the user for a 1-paragraph pre-commitment **before** dispatching the panel:

> Before I dispatch the adversaries: in one paragraph, state what you think this artefact is and the strongest reason it's right. The adversaries will attack both the artefact and this defense — pre-committing prevents the skill's questions from becoming leading cues that you sycophantically agree with.

Wait for the paragraph. If the user refuses or hand-waves ("just go", "no it's obvious"), counter once:

> The research on Socratic interview skills (Pocock, obra/superpowers, fullo) all build in this gate because skill-generated questions are documented sycophancy triggers without a pre-commit anchor. One paragraph — then we dispatch.

If user still refuses, dispatch anyway and note in the recap that no pre-commit was captured.

Include the pre-commit paragraph in each adversary's prompt so they can attack the defense, not just the artefact.

## Panel selection

Detect artefact type from input. Apply the default panel; user can override with `--panel <name>` or `--personas <comma-sep>`.

| Detected type | Default panel | Override flag |
|---|---|---|
| Plan / design / spec / process | YAGNI · Premortem · Hidden Assumptions | `--panel plan` |
| Code (diff, file, snippet) | Saboteur · New Hire · Security Auditor | `--panel code` |
| Product spec / PRD | Premortem · Hidden Assumptions · Security Auditor | `--panel spec` (uses plan + code personas) |
| Prose / writing | (not built-in; user must supply via `--personas`) | `--panel prose` |
| Model output | (not built-in; user must supply via `--personas`) | `--panel model-output` |
| Mixed / unclear | Ask user to pick a panel | `--panel custom` |

Personas live in `personas/<name>.md` in this skill's directory. Each persona file has frontmatter (`name`, `applies_to`, `severity_default`) and a body prompt. Built-in personas as of v0.1.0: `yagni`, `premortem`, `hidden_assumptions`, `saboteur`, `new_hire`, `security_auditor`.

If the user supplies `--personas custom_a,custom_b`, treat each as a one-off inline prompt string (no registry lookup).

## Dispatch the panel

Spawn N `Agent` sub-agents (subagent_type=general-purpose, model=haiku for cost) in a **single message** so they run concurrently. Each gets the same artefact text, the same pre-commit defense (if captured), the same tool guidance, and a different persona prompt.

For each persona, the dispatch prompt is:
1. The persona's body from `personas/<name>.md` (or the inline string for custom personas).
2. The shared adversary contract (below).
3. The artefact text.
4. The user's pre-commit defense paragraph (if captured).

### Shared adversary contract (include in every persona prompt)

Each persona prompt must end with this shared block:

> **You MUST surface at least one critique.** If you genuinely cannot find one after looking hard, return: `NO FINDINGS — and here are the three places I looked hardest and why they're solid: [3 specific places].` Do not return a rubber-stamp "looks good."
>
> **Avoid these failure modes** (lifted from Claude Code internal anti-rationalization guards): verification avoidance ("the artefact looks correct based on my reading" — not enough; check it), seduced by the first 80% (stopping at the obvious critiques and missing the structural ones), strawmanning (attacking a weaker version of the artefact than what's written).
>
> Use Read/Grep/Bash to check claims against the codebase or referenced files. Use Exa/Tavily/WebSearch sparingly (max 1–2 searches per specific claim) to verify external facts. You are NOT doing research — you are attacking.
>
> Report as a bullet list, one line per critique, max ~10 critiques. No prose preamble. Format each as: `- [topic]: [one-sentence critique].`

## Summarise the scope (and tag overlaps)

After all personas return, scan for **overlap** — critiques surfaced by 2+ personas, even if framed differently. Tag those `[CONVERGED]` and rank them first in the walk order; convergence across distinct personas is the highest-signal indicator of a real hole.

Post a one-line scope summary to the user:

> Panel returned: {persona-1} {n}, {persona-2} {m}, {persona-3} {k} — {n+m+k} critiques total, {c} converged across personas. Walking through converged first, then by adversary judgment of severity.

This gives the user budget visibility before the walk begins.

## Walk one critique at a time

Walk converged critiques first (the `[CONVERGED]` ones from the summary), then by adversary judgment of severity. Not per-persona blocks.

**Standing rule — verbatim substance:** When you pose a critique as a question, the *substance* (the claim, the named target, the severity) must come from the adversary's bullet verbatim — don't summarise, soften, or generalise. You add the question wrapper around the critic's substance; you don't rewrite it. Research (Wynn et al. ICML 2025) shows the parent (stronger model) tends to dilute weaker-model critique through paraphrase; verbatim preserves the critic's framing and resists capability-asymmetry drift.

For each critique:

1. Post it as a sharp Socratic question, wrapping the adversary's verbatim substance. Frame it as the adversary would, e.g.:
   > **Saboteur:** Your retry loop has no upper bound on attempts — under sustained downstream failure, this consumes the worker pool. Name the cap, or this is a production-outage primitive.

2. Wait for the user's response.

3. **Dog-with-bone evaluation:**
   - **Concrete defense** (user gives a specific reason, named consumer, named constraint) → mark resolved, move on.
   - **Amendment** (user revises the artefact) → mark resolved, move on.
   - **Explicit "park this"** (user says park / skip / move on / unresolved) → mark parked, move on.
   - **Wave-off** (user says "it's fine", "I think so", "probably ok", or any non-specific dismissal) → counter with the strongest version of the adversary's case, then re-ask. Do not move on.

4. **Deadlock cap:** if a single critique exceeds 3 counter-pushes without resolve / amend / explicit park, force a choice: "I'll park this unless you give a concrete defense or amend the artefact in the next response." Research (Khan et al. ICLR 2025; HAJailBench) shows 2–3 rounds captures most gain; 4+ is churn.

5. Only ask ONE critique at a time. Never batch.

## End-of-session recap

When every critique is resolved or parked, post a final in-conversation recap:

```
## Adversarial-agents recap

**Panel:** {persona-1} ({n}), {persona-2} ({m}), {persona-3} ({k}) — {converged} converged.
(If any persona returned NO FINDINGS, note here: e.g. "Saboteur: NO FINDINGS — three solid spots noted.")

**Pre-commit captured:** yes | no (note "no" if user refused the gate)

**Resolved ({n}):**
- [critique topic] — [one-line how it was resolved]
- ...

**Parked ({m}):**
- [critique topic] — still open
- ...
```

No file written. The conversation log is the record.

If the user makes major revisions during the walk and wants the revised artefact re-attacked, they re-invoke the skill — a single invocation does a single dispatch.

## Common mistakes

| Mistake | Fix |
|---|---|
| Dispatching adversaries sequentially | All persona `Agent` calls go in **one** message |
| Providing your own recommended answer per critique | The critique IS the question; the user's pre-commit defense is the user's answer; don't add yours |
| Accepting "it's fine" as a resolution | That's a wave-off — counter with strongest case and re-ask |
| Walking per-persona blocks (all Saboteur, then all New Hire, ...) | Walk `[CONVERGED]` first, then by severity — never per-persona blocks |
| Skipping the pre-commit gate when user says "just go" | Counter once with the Pocock/obra/fullo rationale; dispatch anyway if they still refuse, but record "no pre-commit" in the recap |
| Paraphrasing a critique when posing the Socratic question | Verbatim substance: claim + named target + severity come from the adversary's bullet unchanged — only the question wrapper is yours |
| Dropping `[CONVERGED]` critiques to the bottom of the walk | Convergence across personas is the highest-signal indicator of a real hole — walk them first |
| Skipping triage and dispatching on a one-line artefact | Refuse and ask the user to flesh out first |
| Letting adversaries rabbit-hole on web research | Cap them at 1–2 web searches per specific claim |
| Asking multiple critiques in one message | One critique at a time, always |
| Writing the recap to a file | Pure conversation; recap is in-message only |
| Loading a persona file but skipping the shared contract block | Persona body + shared contract are both required in the dispatch prompt; never just the body |
| Picking the wrong panel for the artefact (e.g. YAGNI on a security review) | Auto-detect by artefact type, or accept user's `--panel` / `--personas` override; don't default-pick blindly |
