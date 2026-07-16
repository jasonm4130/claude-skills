# deep-dive

Multi-angle research via parallel sub-agents and synthesis with citations. Follows the lead-researcher → parallel sub-agents → critic/judge pattern from Anthropic's [multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system).

> **Why not the built-in `/deep-research`?** Claude Code ships an all-Opus `deep-research`
> workflow that runs *every* worker on your session model — expensive on Opus. This skill
> does the same job but **model-tiers** the workers (Sonnet, not Opus) and adds adversarial
> verification. It's deliberately named `deep-dive` so it never collides with the built-in.
> A same-named shadow doesn't work (the built-in always wins name resolution — tested), so a
> distinct name is the clean handle. The `workflow-model-guard` plugin still guards accidental
> built-in invocations.

## Install

```
/plugin marketplace add jasonm4130/claude-skills
/plugin install deep-dive@jasonm4130-claude-skills
```

## Use

Trigger phrases: "deep research", "research X", "what's the state of Y", "compare approaches for Z" — or invoke it directly as `/deep-dive`.

For one-shot factual questions ("what does this return", "syntax for X"), the skill triages out and answers directly — it won't burn 4 parallel agents on a single lookup.

## How it works

1. **Plan angles as a DAG.** Root angles run in parallel; dependent angles run in a second wave only if a root's output makes them worth asking. Shown to you for go-ahead before dispatch.
2. **Dispatch in parallel.** One sub-agent per angle, all in a single message. **Workers default to Sonnet** — deliberately, not for lack of trying to save money: an in-repo orchestration experiment found Haiku workers missed a load-bearing cross-source contradiction that Sonnet caught. Reserve Haiku for pure enumeration (gathering lists or URLs), where that risk is acceptable. Each agent reads 2–4 sources deeply, not 10 shallowly.
3. **Critic → citation-judge → final-judge passes.** Distinct roles, in order. Critic finds holes; citation-judge verifies every URL resolves and supports the claim; final-judge ships or sends back.
4. **Cite explicitly.** Every claim has a URL + title + date. Single-domain runs get a "single-perspective" warning.

## Workflow return shape

`fanout.mjs` returns `{ reports, verification, failedAngles, meta }`:

- `reports[]` — usable research only: `{ angleId, kind, summary, findings }`.
- `verification[]` — tier-1 (or, if escalated, tier-2) verdicts: `{ angleId, reliability, flags }`.
- `failedAngles[]` — **the authoritative list** of every angle that did not produce usable research:
  crashed, returned schema-valid junk (placeholder URLs, empty findings, an unusable summary), or was
  skipped because a declared dep failed. Each entry is `{ angleId, kind, question, reason }`. The
  orchestrator MUST surface this to the user in the synthesis — see the skill's process step 4.
- `meta` — **counts only** (`anglesCompleted`, `anglesFailed`, `failedCore`, `escalations`), never a
  second copy of `failedAngles`.

An angle's research is validated semantically, not just against a JSON schema. A finding is rejected —
failing the angle, which is retried once and then reported in `failedAngles` rather than silently passed
through as evidence — when any of these hold:

| Rejected | Why |
|---|---|
| Zero findings, or an unusable/placeholder summary | The wave-2 digest is built entirely from the summary; a blank one briefs a dependent angle on nothing. |
| A non-`http(s)` source URL | It was never fetched. |
| A **bare IP address** (v4 or v6) | Research cites named websites. The tier-1 verifier is *instructed to fetch* these URLs — `169.254.169.254` is the cloud instance-metadata endpoint. |
| A **reserved TLD** — `.invalid`, `.test`, `.example`, `.local`, `.localhost` | RFC 2606/6761 guarantee these can never resolve, so the citation is fabricated by construction. |
| A placeholder host (`example.com` and friends), including subdomains and FQDN forms | `sub.example.com` and `example.com.` are the same fabricated citation with a label bolted on. |
| An **alternate host encoding** — percent-escaped (`%31%36%39.254.169.254`), a non-ASCII homograph (`example。com`), or a hex/octal/decimal IP literal (`0xA9FEA9FE`) | The sandbox parser (no `URL` constructor) can't canonicalize these, but a real fetcher would — straight back to a bare IP or placeholder host. A legitimate citation is plain ASCII DNS. |
| A placeholder claim — `placeholder`, `lorem ipsum`, `example claim` anywhere; `TODO`/`TBD`/`n/a` as a prefix | The short tokens are prefix-only on purpose: "pricing is TBD as of 2025" is a real finding. |
| An empty `sourceTitle` or `sourceDate` | Every claim is contracted to carry a URL *and* a title *and* a date; the synthesis renders all three. |

**This is a placeholder/junk filter, not provenance verification.** It cannot prove a URL was actually
fetched: a live, non-placeholder URL paired with a long-enough invented claim still passes. It ends the
class of failure that actually happened; it does not make results verified.

## DAG rules (exactly two waves)

The runner has exactly two waves: **root angles (no `deps`) run in wave 1; angles with `deps` run in
wave 2, and may only depend on root angles.** A dep chain like `a → b → c` needs a third wave that does
not exist — `c` would be checked against wave-1 successes only and reported `dep-failed: b` even when
`b` succeeded. `validateArgs` rejects this (and duplicate ids, self-deps, and deps on angles that don't
exist) before wave 1 runs, rather than let the workflow report a confident lie at synthesis.

`verify.escalateOn` (`"low"` | `"medium"` | `"high"`) now actually works: an angle whose tier-1 verifier
reports reliability at or below that threshold gets a tier-2 re-check.

## Tools

Prefers Exa MCP, then Tavily MCP, then WebSearch, then WebFetch. Uses Exa *and* Tavily — different rankings catch different sources.

## Optional debate mode

For factual disagreements between sub-agent reports that are load-bearing for the synthesis, the skill can dispatch a 2-round structured debate. Capped at 2 rounds (Khan et al. ICLR 2025 shows that captures most of the gain).
