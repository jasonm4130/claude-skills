# domain-modeling

Actively build and sharpen a project's **ubiquitous language** — an opinionated
`CONTEXT.md` glossary — so the domain has canonical names. Once terms are pinned
down, code is named consistently, the codebase is easier for an agent to navigate,
and the agent spends fewer tokens reasoning because it has a more concise language.
The cost is one glossary entry; the payoff compounds every session.

This is the *active* discipline of **changing** the model — challenging conflicting
terms, disambiguating overloaded words, stress-testing relationships with edge-case
scenarios, and writing entries down inline the moment they crystallise. Merely
reading `CONTEXT.md` for vocabulary is a one-line habit any skill can do, not this
skill.

*Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT). The
upstream skill also owned an ADR format; here decision-recording is delegated to
this repo's `adr` skill so there's a single ADR convention.*

## What it does

- Maintains a `CONTEXT.md` glossary (single-context) or a `CONTEXT-MAP.md` +
  per-context `CONTEXT.md` set (multi-context). Files are created lazily.
- Keeps `CONTEXT.md` a **glossary and nothing else** — no implementation details,
  no specs, no decision logs.
- Routes hard-to-reverse, non-obvious trade-offs to the `adr` skill, not the
  glossary.
- Offers the glossary **once per repo** via hooks, so a repo that would benefit
  from one doesn't go unnoticed (see below).

## The missing-glossary offer

The skill itself is lazy by design — it creates `CONTEXT.md` only when a term is
resolved during work it's already driving. That leaves a gap: a repo that never
had a glossary never gets one, and the compounding payoff never starts. Three
hooks close it.

`PostToolUse` records which repos the session edited *source* in (prose and
config are ignored — a README edit is not domain work). `Stop` flags the first
such repo that has a `CLAUDE.md` but no `CONTEXT.md` or `CONTEXT-MAP.md`.
`UserPromptSubmit` turns that flag into a one-line offer and records the repo as
offered. The offer goes out as **`systemMessage`**, which Claude Code shows in the
transcript, with `additionalContext` alongside telling the model not to act on it
unprompted. Sending it as `additionalContext` alone put it in front of the model
and never the user: 5 repos were offered that way and none converted.

Noise is the binding constraint — an unconditional "no `CONTEXT.md` here" check
fires on nearly every repo, every session, forever. Hence the three gates: source
work actually happened there, the repo is already `CLAUDE.md`-configured (so the
user opted into agent tooling for it), and the offer is made **once per repo,
ever**. The claim is taken when the nudge reaches the user, not when it's
raised, so a session that ends before the next prompt doesn't burn the ask —
and it's taken with `O_CREAT|O_EXCL`, so two concurrent sessions in the same
repo can both raise a flag and still only one of them speaks.

To re-arm an offer, delete the repo's `offered-*.claim` file from the plugin's
data directory (each claim names its repo in the file body, so
`grep -rl <repo> <dataDir>` finds it).

## Boundaries

- **Not `adr`** — decisions and trade-offs are ADRs, not glossary terms.
- **Not architecture** — module, interface, and seam are *architecture* language;
  `CONTEXT.md` is *domain* language.
- **Not a spec** — no implementation details in `CONTEXT.md`.

## Files

- `skills/domain-modeling/SKILL.md` — the discipline.
- `skills/domain-modeling/CONTEXT-FORMAT.md` — the glossary format (single +
  multi-context).
- `scripts/posttooluse-mark-source-edit.mjs` — records repos with source edits.
- `scripts/stop-check-context-md.mjs` — flags a repo missing a glossary.
- `scripts/check-context-md-flag.mjs` — emits the one-per-repo offer.
