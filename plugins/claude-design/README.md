# claude-design

Write *great* prompts and specs for **Claude Design** — Anthropic's `claude.ai/design` tool that turns a
prompt plus real assets into a self-contained, live artifact (prototype, dashboard, slide deck, landing
page, internal-tool UI). The skill codifies Anthropic's own official guidance into a paste-ready brief and
covers both ways to run the tool.

## Install

```
/plugin marketplace add jasonm4130/claude-skills
/plugin install claude-design@jasonm4130-claude-skills
```

## Use

Triggers when the user wants to build or prototype something visual with Claude Design and needs a strong
prompt/spec. Not for building UI yourself in the repo (that's `frontend-design`'s light path),
backend/API/data-model work, or generic Claude API / chat prompt engineering.

## What it gives you

- **The brief** — a paste-ready `# Claude Design brief:` template built on Anthropic's official
  **goal / layout / content / audience** framework, extended with visual direction, constraints, and the
  real assets to attach. Plus the official first-move rule: *start simple, then layer in complexity.*
- **Two ways to run it** — write a brief to build in the **browser** (`claude.ai/design`), or **drive it
  from Claude Code**: connect the Claude Design MCP server
  (`claude mcp add --scope user --transport http claude-design …`), `/design-login`, then `/design` and
  `/design-sync`, and hand a finished design off to build.
- **Feed real assets, don't describe them** — codebase, `/design-sync` design system, screenshots,
  competitor refs, DOCX/PPTX/XLSX, web capture.
- **Iterate through the right channel** — chat for structural changes, inline comments for one element,
  direct edits for quick tweaks, sliders for live tuning; ask for variations; request responsiveness and
  accessibility explicitly.
- **Where it stops** — prototype-grade not pixel-perfect vector, front-end only, export flattens
  interactivity — so a brief targets the right tool.

## Relationship to `frontend-design`

Complementary, not a replacement. `frontend-design` owns the design *decision* (light-inline vs. heavy
handoff) and timeless design principles; `claude-design` is the deep how-to for the specific product its
heavy path hands off to. `frontend-design` stays self-contained and points here for the full brief.
