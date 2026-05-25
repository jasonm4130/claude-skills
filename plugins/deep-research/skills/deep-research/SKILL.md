---
name: deep-research
description: Use when the user asks for multi-source research, investigation, or a "deep dive" on a topic — phrases like "research X", "deep research on X", "investigate X", "look into X", "what's the state of X", or "compare options for X". Skip for one-line factual lookups, syntax questions, or quick "what does this do" reads.
---

# Deep Research

Multi-angle research via parallel sub-agents and multiple web sources, then synthesis with citations. Follows the lead-researcher → parallel sub-agents → synthesis pattern from Anthropic's [multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system).

## Triage First

Before spawning agents, decide: deep research or quick lookup?

| Signal | Action |
|--------|--------|
| Multiple angles, comparisons, "state of X", trade-offs, "what are people doing" | Run the full process |
| One-shot factual question, syntax lookup, "what does this return" | Answer directly with one search; do NOT use this skill |
| Ambiguous | Ask: "Quick lookup or a multi-angle deep dive?" |

When in doubt, ask. Burning 4 parallel agents on a question that needed one search wastes tokens and time.

## Process

### 1. Plan the angles as a DAG, then ASK

Don't decompose once and fan out once. Real research questions have dependencies — one angle's answer shapes whether a second angle is even worth running.

1. List 3–5 distinct research angles. Default to 3; go to 5 only if the topic genuinely splits that many ways.
2. For each angle, name its **dependencies** — does it need another angle's output to be well-posed? Most angles are independent (root nodes). Some are conditional ("only worth researching if angle 2 returns X").
3. Render the plan as a small DAG: root angles first (run in parallel), dependent angles in a second wave.

**Always show the DAG to the user and wait for explicit go-ahead before dispatching.** Even when the user said "do deep research" — that's permission for the topic, not for the dispatch. A reply like "looks good, go" or "yes" is the gate.

The only exception: the user explicitly said "skip the confirmation, just run it" or equivalent.

### 2. Dispatch root angles in parallel (wave 1)

Spawn one `Agent` per root angle, **all in a single message**, so they run concurrently.

**Cost-aware defaults:**
- `subagent_type=general-purpose`
- `model="haiku"` for recall-style angles (recall, list-gathering, source enumeration). Haiku is ~5–10× cheaper than Sonnet/Opus for this role and matches quality for pattern-recognition work.
- `model="sonnet"` (default) for synthesis-heavy angles (cross-source reasoning, contradictions).
- Reserve `model="opus"` for the orchestrator (this session), not sub-agents — research shows asymmetric models (frontier orchestrator + cheap subs) is the cost-effective configuration. Same-model panels lose the Data Processing Inequality argument.

Each agent's prompt must include:
- The specific angle/question.
- The broader research topic for context.
- "Use both Exa and Tavily MCP tools (any `mcp__exa__*` and `mcp__tavily__*` tools). Fall back to WebSearch for breadth and WebFetch for specific URLs."
- "Read 2–4 sources deeply, not 10 shallowly."
- "Cite every claim: URL + title + date."
- "Report under 400 words."

### 3. Dispatch dependent angles (wave 2, optional)

If any wave-1 result triggers a dependent angle on the DAG, dispatch wave 2 now — again, all in one message. Stop at wave 2 unless an answer is materially blocked; deeper recursion is rarely worth the cost.

### 4. Synthesize (critic + citation-judge + final-judge passes)

Three roles, distinct system prompts, in order. Conflating roles causes deadlocks where nothing ever ships.

**Critic pass (≤2 iterations) — runs in this orchestrator session, not as a sub-agent:**
- Read all sub-agent reports.
- Produce a draft synthesis: key findings, details, contradictions, open questions.
- Internally critique it — what's missing, what's hand-waved, what's a single-source claim. Revise once.
- Hard cap at 2 critic passes; a 3rd produces churn, not improvement.

**Citation-quality judge (1 pass):**
- For each cited claim, verify: does the URL still resolve, does the cited source actually support the claim, is the source date present and reasonable?
- Flag (don't silently drop) any claim where the source is weak, missing, or where the cited text doesn't actually support the claim.
- Single-domain runs ≥3 findings get a "single-perspective" warning.

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
