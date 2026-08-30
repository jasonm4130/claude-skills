---
name: writing-artifacts
description: Use when writing or revising a durable written artifact — README, ADR, design doc, PR description, release notes, runbook, error message, user-facing docs. Gives a positive writing system (reader model, sentence positions, document jobs), not a ban-list. Do NOT use for conversational replies to the user (global instructions govern those), code or identifiers, commit messages under ~5 lines, or marketing/creative copy that needs a distinct voice. For an ADR specifically, the adr skill owns the format and workflow; this skill owns the prose.
---

# writing-artifacts

A durable artifact has readers you will never meet, arriving with zero conversation context, often skimming, sometimes another agent. Write for that reader. This skill is a system to write toward, not a list of things to avoid: supply the right structure and the slop has nowhere to live.

## Stance (adopt before writing)

You are a competent colleague showing the reader something you have both, in principle, access to. The prose is a window onto the thing — the code, the decision, the procedure — not a performance about it. The reader is your equal; they can verify what you say, so say only what they could verify (evidence in the same breath: numbers, paths, quoted output) and mark anything you haven't verified. Assume they lack your context, never your intelligence: spell out the intermediate steps and the jargon, not the obvious.

## Document layer — give it one job

Before writing, answer in one line: **who arrives at this document, and what did they come for?** Then give the document that one job (Diátaxis):

- Learning a skill by doing → **tutorial** (a lesson; you drive, they follow, it must work).
- Getting a task done now → **how-to** (steps to a goal; they're at work, respect that).
- Looking something up while working → **reference** (facts, structured for lookup, no digressions).
- Understanding why, away from the keyboard → **explanation** (discursive, context, trade-offs).

When one document must serve two jobs (a README usually must), separate the jobs into sections rather than blending sentence-by-sentence — mixed types bleed and serve neither reader. Use the types as a compass, not a filing system; don't scaffold empty sections.

Order the whole document bottom-line-first: purpose and outcome in the first paragraph, general before exceptions, background last. A good README's first paragraph lets most readers stop reading, satisfied.

## Paragraph layer

One point per paragraph, stated in the first sentence; the rest is support. In procedures: one action per step, condition before command ("If the build is red, do not deploy" — never the reverse).

## Sentence layer (reader-expectation method, Gopen & Swan)

Readers extract meaning from *position*. Put information where they expect it:

1. Start the sentence with its topic — the actor whose story it tells, or the old information that links back to the previous sentence.
2. End the sentence with the new information you want to land. The end of a sentence is its stress position; whatever sits there is what the reader carries forward.
3. Keep subject and verb close together; put the action in the verb ("the parser reads the file", not "reading of the file is performed"). Uncover hidden verbs: "makes an assumption" → "assumes".
4. Provide context before asking the reader to consider anything new — within the sentence, the paragraph, and the document alike.
5. One name for one thing, everywhere in the artifact. If you must switch terms, say you are doing so.

Prefer the concrete and specific over the abstract; prefer the short common word where it says the same thing. Sentence length: vary it, and when a sentence passes ~25 words, check whether it is making two points.

## Strict mode — procedures, runbooks, error messages

When the reader executes rather than reads (runbook steps, error messages, safety-relevant text), tighten to controlled-language discipline: one instruction per sentence, max ~20 words, imperative form, numbered steps, no synonyms at all, no pronouns with ambiguous referents. An error message states what happened, the likely cause, and the next action — in that order.

## Self-check (before returning the artifact)

Read the first sentence of the document and of each paragraph in sequence — that skeleton alone should tell the whole story. Then spot-check sentences: does the stress position hold the point? Is the action in the verb? Same name for the same thing throughout? Finally, delete anything the imagined reader did not come for.

For a deterministic second opinion, lint the draft (e.g. `agent-style review --audit-only <file>` if installed). Treat the lint as a check, like tests — the system above is what you write with.

This skill fixes structure and prose. It cannot make a hollow document true — evidence and accuracy are governed by global instructions and are not negotiable here either.
