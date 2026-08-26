---
name: frontend-design
description: 'Guidance for distinctive, intentional frontend/UI design — aesthetic direction, typography, layout, motion, and copy — when building new UI or reshaping existing UI. Gates by scope before designing: a light/surgical change (one component, one page section, extending an existing design system) gets inline design principles; a wide-sweeping or highly-detailed design (a new page, a new flow, a visual identity, an ambiguous "make it look better") gets a paste-ready goal/layout/content/audience brief to build in Claude Design at claude.ai/design instead of being designed blind in a terminal. Do NOT use for backend/API/data-model work, copy-only edits with no visual change, or a design the user has already fully specified (exact tokens/brand guide supplied) — apply those directly. Do NOT use when the user wants a visual mockup, wireframe, canvas, or artboard to tweak by hand rather than code they will ship — that is the built-in `design` skill. This skill applies design decisions to real code in the repo.'
---

# Frontend Design

## Scope gate — decide before you design

Check the request against both columns before doing any design work. This gate is the whole point of this skill: it decides where the design actually gets *made*, not just how it's described.

| Signal | Light — design inline | Heavy — hand off to the browser |
|---|---|---|
| Surface | One component, one page section, a targeted visual fix | A new page, a new flow, a whole product surface |
| Anchor | An existing design system / token set to extend | No system to anchor to, or the brief asks to establish one |
| Brief clarity | User already named the look, or it follows an established pattern | Ambiguous or exploratory ("make it look better", "redesign the dashboard") |
| Iteration need | One good pass is enough; cheap to tweak inline afterward | User will want to compare directions, see it live, iterate visually |

Any single "heavy" signal is usually enough to route heavy — visual exploration degrades badly in a terminal loop, and a wrong guess there costs more than the handoff.

## Light path: design inline

Work this loop: ground it in the subject, apply the design principles below, cut the AI tells, explore a couple of concrete directions, then self-critique before you call it done.

### Ground it in the subject

If the request doesn't pin down what's being designed, pin it yourself: name the concrete surface, its audience, and the one job it does — then state that choice rather than silently assuming it. Read the surrounding codebase first: existing components, tokens, and patterns are the anchor for a light change, not a blank page. A surgical change that ignores the system around it isn't surgical.

### Design principles

- **One clear focal point.** Every surface earns one thing the eye lands on first — a heading, a key number, a primary action. Don't spread emphasis evenly; that reads as "no decision was made."
- **Typography is a design decision, not a default.** Pick a type scale and weight relationship on purpose; don't inherit whatever the last component used without checking it still fits.
- **Structure should mean something.** Dividers, numbering, and labels should encode a real property of the content (an actual sequence, an actual grouping) — not decorate an arbitrary list.
- **Motion is optional, not default.** Add it only where it clarifies state change (a loading state, a reveal, a hover affordance); unmotivated animation reads as noise, not polish.
- **Match effort to ambition.** A minimal direction needs precise spacing and restraint; a bolder direction needs the follow-through to execute it fully. Half of either looks unfinished.
- **Copy is part of the design.** Interface text is read by the person using it, not by the system that built it — name things by what the user controls, use active voice, and keep error/empty states specific about what happened and what to do next.

### Cut the AI tells

A concrete **anti-tell floor** that *subtracts* the marks of generated design. These remove recognizable tells; they don't prescribe a house look (a fixed "anti-slop" style just trades one sameness for another). Apply them while building and judge by eye — they're defaults that yield to real content, accessibility, and the surface's purpose, not a blocking checklist.

- **Real assets, not fakes.** No `<div>`-built "fake screenshots" of product UI and no hand-rolled decorative SVG illustrations as a default; use real or generated imagery, or leave an explicit `TODO` placeholder.
- **No invented telemetry or chrome.** Drop fake version labels (`BETA`, `v0.6`), section-number eyebrows (`00 / INDEX`), scroll cues, and locale/weather strips unless they encode real state.
- **Vary the section rhythm.** Don't reuse one section layout family down the page, and don't stack more than two image-and-text split sections in a row — a page where every band is the same shape reads as generated.
- **Hero discipline.** One focal hero: aim for a headline of one or two lines and, where the surface has one, a primary CTA visible without scrolling; avoid a kitchen-sink stack of taglines, trust strips, and avatar rows above the fold. (Real content, localization, and accessibility win over the line count — don't truncate meaning or invent a CTA to hit it.)
- **Grids fit their content.** N items means N cells — reshape the grid rather than padding it with an empty tile.
- **One coherent theme per surface.** No light/dark flips mid-page — while still designing both light and dark where the surface is theme-aware.

### Explore

Sketch 2–3 concrete variations of the specific decision at hand (not a whole redesign) — a component's layout, a palette choice, a copy treatment — before committing to one. State which you picked and why in one line; don't silently default to the first idea.

### Self-critique

Before calling it done, check the result against the trap of templated defaults: would this exact choice be your answer to almost any similar brief, regardless of subject? If yes, revise the part that's generic. Then check the accessibility floor that never gets cut for speed: responsive down to mobile width, visible keyboard focus, and color contrast that holds up — these are cheap to get right the first time and expensive to retrofit.

## Heavy path: hand off to Claude Design in the browser

Do not design a wide-sweeping or highly-detailed surface blind, inline, in a back-and-forth text loop — visual work like this is genuinely better iterated where it can be seen and steered live.

### Route it first

Two destinations, and the difference is what the user walks away with:

- **A mockup they will tweak by hand** — a wireframe, a screen flow, a poster, a layout nobody is about to ship as code. That is the **built-in `design` skill**, which draws artboards on a canvas the user edits directly. Hand off and stop.
- **A real surface that becomes code** — a new page, a new flow, a product identity, anything anchored to a live codebase or design system. That is **Claude Design** at `claude.ai/design`: iterate on the canvas, then bring the result back here to build. Give them the brief below.

### The brief

Tell the user directly, then hand them a brief they can paste straight in:

> This reads as a wide-sweeping / highly-detailed design rather than a surgical tweak — better iterated visually in **Claude Design** (claude.ai/design, in the browser) than designed blind here. Here's a paste-ready brief to carry the context over:

Fill in every field you can from what's already known (the codebase, the conversation, an existing design system); leave the rest as an explicit placeholder rather than inventing detail that wasn't given. Emit exactly this shape:

```markdown
# Design brief: <what you're building>
**Goal** — the surface + the one job it does: …
**Audience** — who uses it, where, and what they care about most: …
**Layout / screens** — named screens or sections, how they're arranged, key flows and states (empty / loading / error / success): …
**Content** — the real copy, data, and labels to show (not lorem); for data views, the fields, metrics, and chart types: …
**Visual direction** — mood + brand ("calm, premium, dark"), the existing patterns and tokens to match, or "match <attached asset / our codebase>": …
**Constraints** — responsive targets, accessibility (contrast, keyboard), and what to leave OUT: …
**Assets to attach** — codebase / design system / screenshots / competitor refs / an existing deck: …
```

Keep the first prompt specific but not exhaustive — hit goal, layout, content, and audience, attach the assets, and add complexity through iteration rather than one giant prompt. Anthropic's own guidance: *start simple, then layer in complexity.*

**Attach the design system, don't describe it.** Claude Design self-checks its output against a real style/font/component set, and reads a linked codebase to build from your actual components — prose about them buys none of that. From Claude Code, `/design-sync` pulls the design system in (also the fix for a large repo, where linking the whole thing lags). `/design-sync` is not built in — it arrives once the Claude Design MCP server is connected: `claude mcp add --scope user --transport http claude-design https://api.anthropic.com/v1/design/mcp`, then `/design-login`.

Stop there on this path — don't also produce inline mockups or code for the same surface; that duplicates the work Claude Design is about to do and drifts out of sync with whatever the user actually lands on in the browser.
