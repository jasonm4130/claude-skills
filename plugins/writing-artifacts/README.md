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

## The readme skill

`readme` applies the system to one artifact, a project's README.md, and adds checks
that a README can be held to. Its procedure: build a fact inventory with `file:line`
sources before drafting, score the first screen (what it is, who it is for, a picture,
requirements, a first command), pick a short row of true badges, order sections as a
reader funnel, define terms before their first use, and keep the prose plain.

Its checker, `skills/readme/scripts/check-readme.mjs`, flags what a script can verify:
backticked paths that do not exist, relative links and images with missing targets,
`#anchor` links that match no heading under GitHub's slug rules (emoji headings
included), `npm`/`pnpm`/`yarn`/`bun` scripts that `package.json` does not define,
`node <file>` commands whose file is missing, CLI subcommands absent from the CLI's
help, badges whose workflow, LICENSE or manifest version does not match, emoji, and
leftover TODOs. Stdlib only; it needs Node 18+.

```
node skills/readme/scripts/check-readme.mjs README.md --cli "mytool=node bin/mytool.mjs --help"
```

## Install

```
/plugin install writing-artifacts@jasonm4130-claude-skills
```

No hooks. `writing-artifacts` is prose guidance only; `readme`'s checker runs on Node.
