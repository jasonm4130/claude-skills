---
name: claude-design
description: 'Use when the user wants to build or prototype something visual with Claude Design — Anthropic''s claude.ai/design tool — and needs a strong prompt or spec: a prototype, dashboard, slide deck, landing page, marketing page, or internal-tool UI. Covers both writing a paste-ready design brief to build in the browser and driving Claude Design from Claude Code (the /design and /design-sync commands and the Claude Design MCP server). Do NOT use for building the UI yourself in the repo (that is frontend-design''s light path), backend/API/data-model work, or generic Claude API / chat prompt engineering.'
---

# Claude Design

**Claude Design** (Anthropic Labs, `claude.ai/design`) turns a prompt plus real assets into a self-contained, live artifact — a prototype, dashboard, slide deck, landing page, or internal-tool UI — that you refine in the browser or drive from Claude Code. Beta on Pro/Max/Team/Enterprise (Opus 4.7; web + desktop, not mobile) — on Enterprise an admin must enable it first under Organization Settings → Capabilities → Anthropic Labs.

**Core principle:** a great first prompt names the **goal, layout, content, and audience**, hands over your *real* assets, then iterates through the right channel. Don't one-shot the whole thing in one giant prompt — start specific, then layer.

## Two ways to run it

- **In the browser** (`claude.ai/design`) — paste a brief, then iterate on the canvas.
- **From Claude Code** (the terminal) — use `/design` to create, edit, and sync design projects without leaving the terminal, then hand a finished design off to build.

Same brief discipline either way: the prompt you give `/design` *is* the brief.

## The brief — the thing worth getting right

Fill every field you can from what's known (codebase, conversation, brand); leave the rest as an explicit placeholder rather than inventing detail. Emit exactly this:

```markdown
# Claude Design brief: <what you're building>

**Goal** — the artifact + the one job it does: …
**Audience** — who uses it, where, and what they care about most: …
**Layout / screens** — named screens or sections, how they're arranged, key flows and states (empty / loading / error / success): …
**Content** — the real copy, data, and labels to show (not lorem); for data views, the fields, metrics, and chart types: …
**Visual direction** — mood + brand ("calm, premium, dark"), or "match <attached asset / our codebase>"; design tokens if you have them: …
**Constraints** — responsive targets, accessibility (contrast, keyboard), and what to leave OUT: …
**Assets to attach** — codebase / `/design-sync` design system / screenshots / competitor refs / an existing deck: …
```

**First move:** keep the first prompt specific but not exhaustive — hit the four fields and attach your assets, then add complexity through iteration. Anthropic's own guidance: "start simple, then layer in complexity."

## Feed it real assets, don't describe them

The biggest quality lever after specificity — Claude Design reads real inputs, not prose about them:

- a linked **codebase** (or `/design-sync` for a large repo) so it builds from your actual components;
- a **design system** — styles, fonts, components — which it self-checks its output against;
- **screenshots, wireframes, competitor products, an existing deck or doc**;
- images and **DOCX / PPTX / XLSX**; or a **web capture** of a live page.

## Drive it from Claude Code

Connect once, then work from the terminal:

```bash
claude mcp add --scope user --transport http claude-design https://api.anthropic.com/v1/design/mcp
```

Then `/design-login` to sign in.

- **`/design`** — create, edit, and sync a design project from the terminal: import a design into your codebase, turn code into a live prototype, or carry a project end-to-end.
- **`/design-sync`** — pull your design system in so every screen starts from your real components (also the fix for large-repo lag).
- **Handoff bundle** — when a design is ready to become software, hand it to Claude Code, which continues from the real work instead of starting over from a screenshot.

## Iterate — pick the right channel

| Change you want | Use |
|---|---|
| Broad / structural (relayout, new section, color scheme) | **Chat** |
| Targeted, one element on the canvas | **Inline comment** (faster than describing the location) |
| Quick visual/text tweak | **Edit directly** (drag, resize, retype) |
| Live-tune spacing, color, layout | **Sliders / knobs** (spends no generation turn) |

Ask for **variations** to compare directions. Branch without losing a good draft: "save this, try another direction." After refining one component, ask Claude to **apply it across the whole design** for consistency. Request **responsiveness and accessibility explicitly** — there's no breakpoint toggle to fall back on.

## What it's for — and where it stops

Great at top-of-funnel visual work: prototypes, dashboards, decks, landing pages, internal tools, even code-powered voice / video / shaders / 3D. It stops at **pixel-perfect vector work** (Figma still owns precision and production), it's **front-end only** (no backend, database, or auth), and **PDF/PPTX export flattens interactivity** — the live HTML is the interactive form.

## Known quirks (beta)

Inline comments occasionally don't render — open the comments view to see them. A "chat upstream error" → start a new chat tab in the same project. Large or complex codebases lag → use `/design-sync`. Real-time multi-person editing is still basic.
