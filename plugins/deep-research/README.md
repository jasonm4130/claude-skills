# deep-research

Multi-angle research via parallel sub-agents and synthesis with citations. Follows the lead-researcher → parallel sub-agents → critic/judge pattern from Anthropic's [multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system).

## Install

```
/plugin marketplace add jasonm4130/claude-skills
/plugin install deep-research@claude-skills
```

## Use

Trigger phrases: "deep research", "research X", "what's the state of Y", "compare approaches for Z".

For one-shot factual questions ("what does this return", "syntax for X"), the skill triages out and answers directly — it won't burn 4 parallel agents on a single lookup.

## How it works

1. **Plan angles as a DAG.** Root angles run in parallel; dependent angles run in a second wave only if a root's output makes them worth asking. Shown to you for go-ahead before dispatch.
2. **Dispatch in parallel.** One sub-agent per angle, all in a single message. Recall-style angles default to Haiku for cost; synthesis-heavy angles use Sonnet. Each agent reads 2–4 sources deeply, not 10 shallowly.
3. **Critic → citation-judge → final-judge passes.** Distinct roles, in order. Critic finds holes; citation-judge verifies every URL resolves and supports the claim; final-judge ships or sends back.
4. **Cite explicitly.** Every claim has a URL + title + date. Single-domain runs get a "single-perspective" warning.

## Tools

Prefers Exa MCP, then Tavily MCP, then WebSearch, then WebFetch. Uses Exa *and* Tavily — different rankings catch different sources.

## Optional debate mode

For factual disagreements between sub-agent reports that are load-bearing for the synthesis, the skill can dispatch a 2-round structured debate. Capped at 2 rounds (Khan et al. ICLR 2025 shows that captures most of the gain).
