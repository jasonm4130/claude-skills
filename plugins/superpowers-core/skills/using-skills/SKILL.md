---
name: using-skills
description: Use when starting any conversation — establishes the skill-selection and currency-verification rules that govern every turn (match-and-proportion, specificity-wins, user-instructions-suppress-skills, verify-before-answering-from-stale-memory). Delivered automatically via the SessionStart hook. Do NOT use for authoring new skill descriptions (see writing-skills) and do NOT use as a substitute for actually running a search or deep-dive — this skill states the decision rules, not the research mechanics.
---

# using-skills

**Part A — Skill selection (match-and-proportion):**
1. Invoke a skill only when its description is a *closer, more specific match* to the task than acting directly — **and** the work is non-trivial (multi-step, irreversible, or touches product source). Trivial/one-shot → just do it, no ceremony.
2. **Specificity wins:** when two skills match, prefer the narrower one. Owned workflow skills are more specific to this work than any generic one → they win. (Structurally dissolves collisions — no future deny-line needed.)
3. **User instructions suppress skills:** a concrete instruction in the current turn overrides any skill firing for the same concern. User > skills > defaults.
4. When invoking, announce "Using [skill] to [purpose]" and follow it.
5. **Authoring rule:** every skill description carries a negative scope ("do NOT use for…") to keep selection unambiguous.

**Part B — Currency & verification:**
1. If an answer turns on something that changes over time (versions, prices, releases, "current/latest/now", anything plausibly past the training cutoff) → **don't answer from memory; verify first.**
2. **Match the tool to the need:** one load-bearing fact → a single web search; a multi-angle/comparative/"state of X" question → `deep-dive`. Never fan out a deep-dive on what one search settles.
3. **Stale-fact ≠ unclear-intent:** a factual gap you can close → verify it; an intent you'd only guess at → ask *one* question. State verified-vs-remembered when load-bearing.

**Injection guardrail (keeps the kernel from re-becoming the superpowers wall).** A behaviour earns a line in the SessionStart injection **only if both**: (a) it must be present *before* the model acts, and (b) it isn't already reliably governed elsewhere (global CLAUDE.md, or self-evident). Skill-selection and currency-verification pass; the Karpathy-4 / simplicity / verification-before-complete rules **fail (b)** — they live in global CLAUDE.md and must not be duplicated here.
