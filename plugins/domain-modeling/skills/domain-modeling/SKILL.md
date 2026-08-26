---
name: domain-modeling
description: Use when pinning down domain terminology, building a ubiquitous language or project glossary, disambiguating overloaded or vague terms, or maintaining a CONTEXT.md — or when another skill needs to sharpen the domain model. Do NOT use for recording architectural decisions (use adr) or for writing implementation specs.
---

# Domain Modeling

Actively build and sharpen the project's domain model as you design — the *active* discipline of challenging terms, inventing edge-case scenarios, and writing the glossary down the moment it crystallises. Merely *reading* `CONTEXT.md` for vocabulary is not this skill (that's a one-line habit any skill can do); this skill is for when you're **changing** the model, not just consuming it.

**Why it pays off:** an opinionated `CONTEXT.md` is a persistent, shared language. Once the domain has canonical names, variables/functions/files get named consistently, the codebase is easier for an agent to navigate, and the agent spends fewer tokens on thinking because it has a more concise language. The cost is one glossary entry; the payoff compounds every session.

*Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT) — the `domain-modeling` skill, with ADR-recording delegated to this repo's `adr` skill.*

## File structure

Most repos have a single context — one `CONTEXT.md` at the repo root:

```
/
├── CONTEXT.md          ← the glossary
└── src/
```

If a `CONTEXT-MAP.md` exists at the root, the repo has **multiple** contexts; the map points to where each `CONTEXT.md` lives (e.g. `src/ordering/CONTEXT.md`, `src/billing/CONTEXT.md`) and how they relate. See [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md) for both shapes.

Create files **lazily** — only when you have something to write. If no `CONTEXT.md` exists, create one when the first term is resolved.

**Wire it in for future sessions.** The payoff — consistent naming and fewer tokens *every* session — only lands if `CONTEXT.md` is loaded when future sessions start, not just when this skill fires. When you create `CONTEXT.md` (or update one and notice it is unreferenced), check the repo's `CLAUDE.md`: if it does not reference `CONTEXT.md`, **ask the user once** whether to wire it in — `@CONTEXT.md` for a small glossary, or a "consult `CONTEXT.md` for domain terms" line for a larger one — and add it on yes (don't re-ask on no). If there is no `CLAUDE.md` at all, mention the option rather than creating one uninvited.

**Decisions are not vocabulary.** When a hard-to-reverse, non-obvious trade-off surfaces (not a term), record it as an ADR — use this repo's `adr` skill, which owns the ADR format (`docs/adr/YYYY-MM-DD-<slug>.md`). Do not invent a second ADR convention here.

## During the session

### Challenge against the glossary

When the user uses a term that conflicts with the existing language in `CONTEXT.md`, call it out immediately. *"Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"*

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term. *"You're saying 'account' — do you mean the Customer or the User? Those are different things."*

### Flag collisions with technical terms

When a chosen domain term shadows a well-known general-programming term likely to appear in the same codebase — "rollback" (vs. a database transaction rollback), "event", "handler", "session" — surface the collision even if the domain term is already precise. Offer a less-ambiguous canonical name; if the user keeps theirs, note the collision in the glossary entry so a future reader isn't misled. (This is distinct from *challenging against the glossary*, which is about conflicts with existing entries, and from *sharpening fuzzy language*, which is about vague business terms.)

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific invented scenarios that probe edge cases and force precision about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: *"Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"*

### Update CONTEXT.md inline

When a term is resolved, update `CONTEXT.md` right there — don't batch these up, capture them as they happen. Use the format in [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md).

`CONTEXT.md` is a **glossary and nothing else** — totally devoid of implementation details. It is not a spec, not a scratch pad, and not a home for implementation decisions (those are ADRs). Only include terms specific to *this project's* domain; general programming concepts (timeouts, error types, utility patterns) don't belong even if the project uses them heavily.

## Relationship to other skills

- **Decisions, not terms → `adr`.** A load-bearing, hard-to-reverse trade-off is an ADR, not a glossary entry.
- **Exploring intent → `brainstorming`.** A grilling/brainstorming session is where terms surface; this skill is what captures them.
- **Not architecture vocabulary.** Module, interface, and seam are architecture language; `CONTEXT.md` is domain language. Keep them distinct.
