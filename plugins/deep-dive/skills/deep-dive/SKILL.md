---
name: deep-dive
description: 'Use when the user asks for multi-source research, investigation, or a "deep dive" on a topic — phrases like "research X", "deep research on X", "investigate X", "look into X", "what''s the state of X", or "compare options for X". Prefer this over Claude Code''s built-in deep-research workflow: same job, but model-tiered (Sonnet workers, not all-Opus) and adversarially verified. Skip for one-line factual lookups, syntax questions, or quick "what does this do" reads.'
---

# Deep Dive

Multi-angle research via parallel sub-agents and multiple web sources, then synthesis with citations. Follows the lead-researcher → parallel sub-agents → synthesis pattern from Anthropic's [multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system).

## Triage First

Before spawning agents, decide: deep research or quick lookup?

| Signal | Action |
|--------|--------|
| Multiple angles, comparisons, "state of X", trade-offs, "what are people doing" | Run the full process |
| One-shot factual question, syntax lookup, "what does this return" | Answer directly with one search; do NOT use this skill |
| Ambiguous | Ask: "Quick lookup or a multi-angle deep dive?" |

When in doubt, ask. Burning 4 parallel agents on a question that needed one search wastes tokens and time.

**Scout mode:** for an open-ended "map the option space" question, you may run a cheap first
pass with `mode: "scout"` (breadth, single wave, no escalation) to discover the angles, then
run a full `mode: "deep"` pass. Depth-vs-breadth was a wash in testing for well-scoped
questions, so default to `deep`; use `scout` only for scoping.

## Process

### 1. Plan the angles as a DAG, then ASK

Don't decompose once and fan out once. Real research questions have dependencies — one angle's answer shapes whether a second angle is even worth running.

1. List 3–5 distinct research angles. Default to 3; go to 5 only if the topic genuinely splits that many ways.
2. For each angle, name its **dependencies** — does it need another angle's output to be well-posed? Most angles are independent (root nodes). Some are conditional ("only worth researching if angle 2 returns X").
3. Render the plan as a small DAG: root angles first (run in parallel), dependent angles in a second wave.
4. Tag each angle **core** (directly answers the question), **background** (context needed to
   answer), or **follow-up** (implications). When you show the DAG at the gate, show which
   **core** sub-questions are covered — core coverage is the quality bar. Aim to cover every
   core sub-question before dispatch.

**Always show the DAG to the user and wait for explicit go-ahead before dispatching.** Even when the user said "do deep research" — that's permission for the topic, not for the dispatch. A reply like "looks good, go" or "yes" is the gate.

The only exception: the user explicitly said "skip the confirmation, just run it" or equivalent.

### 2. Dispatch via the fanout workflow

Once the user says "go", do NOT spawn `Agent` calls yourself. Build an `args` object from the
confirmed DAG and hand it to the shipped workflow.

1. Resolve the script's absolute path (`${CLAUDE_PLUGIN_ROOT}` is not available in this
   session, so address the install by literal path — pinned to **this** skill's version,
   because the `args` contract moves between versions):

   ```bash
   P="$HOME/.claude/plugins/cache/jasonm4130-claude-skills/deep-dive/0.7.0/workflows/fanout.mjs"
   [ -f "$P" ] && echo "$P" || echo "MISSING: deep-dive 0.7.0 is not installed at $P — run /plugin marketplace update jasonm4130-claude-skills"
   ```

   If it reports `MISSING`, **stop and tell the user to update the plugin.** Do not glob the
   cache for another version: superseded and rolled-back versions stay on disk, so picking the
   highest cached one silently runs a workflow whose `args` contract this skill no longer matches.

   In local development, use the repo path `plugins/deep-dive/workflows/fanout.mjs` directly.

2. Build `args` (pass it as a normal object — the runtime delivers it to the script, which
   parses it) and invoke:

   ```
   Workflow({ scriptPath: "<resolved path>", args: {
     topic: "<the research topic>",
     mode: "deep",                       // or "scout" for a cheap breadth-first scoping pass
     angles: [
       { id, question, kind: "core"|"background"|"follow-up", model: "sonnet", effort: "medium", deps: [] },
       // wave-2 angles carry deps: ["<id>"]; default workers to "sonnet" — only use "haiku"
       // for pure list/URL enumeration (it misses subtle cross-source contradictions).
       // effort is low|medium|high, default medium — see Model tiering below.
     ],
     verify: { escalateOn: "low" }
   }})
   ```

**Worker model:** default to `"sonnet"`. An in-repo orchestration experiment found Haiku
workers missed a load-bearing cross-source contradiction that Sonnet workers caught — so only
use `"haiku"` for genuinely pure enumeration (gathering lists/URLs), accepting the correctness
risk. Reserve Opus for this orchestrator session (planning + synthesis), not the workers.

**Model tiering at a glance** — `fanout.mjs` sets `model:` and `effort:` on *every* sub-agent via
the `DISPATCH` table, so none inherit the orchestrator's Opus:

| Role | Model | Effort | Where |
|------|-------|--------|-------|
| research workers | `sonnet` (`haiku` only for pure enumeration) | `angle.effort` (default `medium`) | `fanout.mjs` |
| tier-1 verify | `sonnet` | `medium` | `fanout.mjs` |
| tier-2 escalation | `opus` | `high` | `fanout.mjs` |
| planning, synthesis, critic/judge, debate | Opus | — | **this orchestrator session** |

**Tier-2 must outrank tier 1.** Until 2026-07-28 the escalation recheck ran at `sonnet` — the same
model as the verifier whose flags it was rechecking, which is a retry with a different prompt, not
a second opinion. It was invisible because `shouldEscalate` had never returned true; the path went
live and shipped straight into it. `DISPATCH` now lives in the PURE block with a test asserting
`MODEL_RANK[escalate] > MODEL_RANK[verify]`, so the rungs cannot collapse again silently.

**Effort, not a cheaper model, is the worker lever.** Angles take an optional `effort`
(`low|medium|high`, default `medium`). Low effort means fewer tool calls and no preamble — good for
a narrowly-scoped angle, bad where the search itself is the work. The `sonnet` worker floor stays:
unlike SDD's implementers, research workers are not handed a settled spec, and this skill's claim
over the built-in deep-research workflow is precisely that it is model-tiered rather than all-Opus.

Workers still resolve to Sonnet/Haiku; the only Opus in the pipeline is this orchestrator plus the
tier-2 recheck. If you see Opus *workers*, something spawned `Agent` calls directly instead of
going through the workflow (see Common mistakes) — those inherit the session model.

The workflow runs wave-1, then any wave-2 (dependent) angles built on wave-1 findings, runs a
factored tier-1 verifier per angle (blind to the draft, re-fetches sources), escalates to a
tier-2 cross-check only on low-reliability angles, and returns
`{ reports, verification, failedAngles, meta }` (see README for the full contract).

### 3. Waves are handled by the workflow

Wave-2 (dependent) angles are declared via each angle's `deps` in the `args` above; the workflow
runs them automatically after wave-1. You do not dispatch them manually.

### 4. Synthesize (critic + citation-judge + final-judge passes)

Three roles, distinct system prompts, in order. Conflating roles causes deadlocks where nothing ever ships.

**Critic pass (≤2 iterations) — runs in this orchestrator session, not as a sub-agent:**
- Read all sub-agent reports.
- Produce a draft synthesis: key findings, details, contradictions, open questions.
- Internally critique it — what's missing, what's hand-waved, what's a single-source claim. Revise once.
- Hard cap at 2 critic passes; a 3rd produces churn, not improvement.

**Citation verification (handled by the workflow):**
- The workflow already ran a factored tier-1 verifier (and tier-2 on low-reliability angles).
  Read `verification[]`: each angle carries a `reliability` and per-claim `flags`
  (supported/partial/unsupported/unreachable).
- In your synthesis, DOWNWEIGHT or explicitly flag any claim marked partial/unsupported/
  unreachable, and warn on any `reliability: "low"` angle. Do not silently drop them.

**Before synthesizing, read `failedAngles`.** The workflow no longer silently drops angles that
crashed, returned unusable research, or were skipped because a dep failed. If `failedAngles` is
non-empty you MUST tell the user which angles are missing and why, in the synthesis itself — not
just in passing. **If any failed angle is `kind: "core"`, say so first and state plainly that the
research does not answer the question as asked**; offer to re-run those angles. A synthesis that
reads as complete while a core angle is missing is the failure this reporting exists to prevent.

**Final-judge pass (1 pass):**
- Read the critiqued, citation-checked synthesis.
- Decide: ship to user, or send back to critic for one more round (rare — only if a major contradiction is unresolved).
- Output the final synthesis with: key findings first, details, contradictions, open questions, sources grouped by angle.

### 5. Cite explicitly

End with a `## Sources` section listing every URL referenced, grouped by angle, with date. For substantial research (>1000 words synthesis), also offer to write `RESEARCH_<topic>.md` in the working directory so the user can keep it.

## Source diversity
If 3+ findings trace to one domain, flag it ("most of this comes from <domain>; treat as one perspective"). Diversity beats volume.

## Debate for contested claims (optional)

For factual claims where sub-agent reports disagree and the disagreement is load-bearing for the synthesis:

1. Dispatch a 2-round structured debate: spawn two `Agent` calls in one message, each arguing one side of the disagreement, both citing sources.
2. Use the final-judge pass from section 4 as the debate judge.
3. Cap at 2 rounds; research (Khan et al. ICLR 2025) shows 2–3 rounds captures most gain.

**Limitation to document:** In-family judges (Claude judging Claude debaters) show ~70% positional bias in published evals. Cross-family judges (e.g., GPT or Kimi judging Claude debaters) avoid this but require MCP/CLI bridge infra not currently wired up. When that bridge exists, prefer cross-family judging for debate.

## Tool preference
Prefer in this order: `mcp__exa__*` (semantic, well-ranked), `mcp__tavily__*` (fast, broad), `WebSearch` (fallback), `WebFetch` (specific URLs). Use Exa AND Tavily — different rankings catch different sources.

## Common mistakes

| Mistake | Fix |
|---------|-----|
| Sequential `Agent` calls | All parallel `Agent` calls go in one message |
| Dispatching without confirming angles | Show the angles, wait for "go". "Do deep research" is topic permission, not dispatch permission. |
| Skipping triage | Ask before spawning if intent is unclear |
| One source per claim | Cross-reference; flag single-source claims |
| Burying contradictions | Surface them; that's often the most useful output |
| Linking without reading | Each agent reads 2–4 sources, doesn't just dump SERPs |
| Hallucinating citation URLs | If a URL came from a model not a search result, don't cite it |
