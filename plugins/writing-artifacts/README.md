# writing-artifacts

A positive writing system for **durable written artifacts** — READMEs, ADRs, design
docs, PR descriptions, release notes, runbooks, error messages. It supplies a model
of the reader and structural principles to write toward, rather than a ban-list of
slop words to avoid.

Complementary to the reply-style rules in global `CLAUDE.md`/`AGENTS.md`: those
govern *selection* (what an ephemeral reply includes); this skill governs
*structure* (where information sits in a document that outlives the conversation).

## The system

- **Stance** (classic style, Thomas & Turner / Pinker): competent colleague showing
  the thing through a window of prose; evidence in the same breath; assume the
  reader lacks your context, never your intelligence.
- **Document layer** (Diátaxis + plain language): one job per document — tutorial,
  how-to, reference, or explanation; bottom-line first, general before exceptions.
- **Paragraph layer:** one point, stated first. Condition before command in steps.
- **Sentence layer** (Gopen & Swan reader-expectation): topic position for the
  actor/old information, stress position (sentence end) for the new information,
  action in the verb, subject near verb, one name for one thing.
- **Strict mode** for procedures/runbooks/error messages: one instruction per
  sentence, ~20-word cap, imperative, no synonyms.
- **Self-check:** the first sentences of the document and each paragraph, read in
  sequence, should tell the whole story.

## Why not a ban-list

Word-level bans backfire (naming the forbidden word primes it — arXiv:2601.08070),
and every coherent writing *system* tested halved lint-scored slop while a
banned-words list barely moved it (woosal1337 STE experiment, 2026). Grounding and
sources: [`RESEARCH_writing-systems.md`](https://github.com/jasonm4130/claude-skills/blob/main/RESEARCH_writing-systems.md).

## Install

```
/plugin install writing-artifacts@jasonm4130-claude-skills
```

No hooks, no Node dependency — a single skill, loaded on demand.
