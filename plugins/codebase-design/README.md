# codebase-design

Shared vocabulary and discipline for designing **deep modules** — a lot of
behaviour behind a small interface, placed at a clean seam, testable through that
interface. The aim is leverage for callers, locality for maintainers, and
testability for everyone. Use this language wherever code is being designed or
restructured so naming stays consistent across sessions and agents.

*Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT). The
sub-agent dispatch examples carry explicit model tiers so they satisfy this repo's
`workflow-model-guard` and delegation-tiering conventions.*

## What it covers

- **Glossary** — module, interface, seam, depth, adapter, leverage, locality, used
  exactly (not "component"/"service"/"API"/"boundary").
- **The deletion test** — would deleting the module concentrate complexity across
  callers (earning its keep) or just remove a pass-through (shallow)?
- **Seam discipline** — one adapter is a hypothetical seam, two is a real one.
- **Deepening** (`DEEPENING.md`) — dependency categories and replace-don't-layer
  testing.
- **Design it twice** (`DESIGN-IT-TWICE.md`) — model-tiered parallel sub-agents
  each designing the interface under a different constraint, then compared.

## Boundaries

- **Not `frontend-design` / `claude-design`** — those are *visual/UI* design; this
  is *structural* design.
- **Not domain vocabulary** — a project's *domain* language (what the business
  calls things) is a different axis from *architecture* language (module,
  interface, seam). Keep them distinct.
- **Not a bug hunt or quality-cleanup pass** — this is interface/seam design.

## Files

- `skills/codebase-design/SKILL.md` — glossary, deep-vs-shallow, principles.
- `skills/codebase-design/DEEPENING.md` — dependency categories + testing strategy.
- `skills/codebase-design/DESIGN-IT-TWICE.md` — tiered parallel-sub-agent interface
  exploration.
