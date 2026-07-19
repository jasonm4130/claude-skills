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

## Boundaries

- **Not `adr`** — decisions and trade-offs are ADRs, not glossary terms.
- **Not `codebase-design`** — that skill's vocabulary (module, interface, seam) is
  *architecture* language; `CONTEXT.md` is *domain* language.
- **Not a spec** — no implementation details in `CONTEXT.md`.

## Files

- `skills/domain-modeling/SKILL.md` — the discipline.
- `skills/domain-modeling/CONTEXT-FORMAT.md` — the glossary format (single +
  multi-context).
