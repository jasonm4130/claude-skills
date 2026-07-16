---
name: frontend-design
description: Guidance for distinctive, intentional frontend/UI design — aesthetic direction, typography, layout, motion, and copy — when building new UI or reshaping existing UI. Gates by scope before designing: a light/surgical change (one component, one page, extending an existing design system) gets inline design principles; a wide-sweeping or highly-detailed design (a new page, a new flow, a visual identity, an ambiguous "make it look better") gets routed to Claude Design in the browser with a paste-ready design brief instead of being designed blind in a terminal. Do NOT use for backend/API/data-model work, copy-only edits with no visual change, or a design the user has already fully specified (exact tokens/brand guide supplied) — apply those directly.
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

Work this loop: ground it in the subject, apply the design principles below, explore a couple of concrete directions, then self-critique before you call it done.

### Ground it in the subject

If the request doesn't pin down what's being designed, pin it yourself: name the concrete surface, its audience, and the one job it does — then state that choice rather than silently assuming it. Read the surrounding codebase first: existing components, tokens, and patterns are the anchor for a light change, not a blank page. A surgical change that ignores the system around it isn't surgical.

### Design principles

- **One clear focal point.** Every surface earns one thing the eye lands on first — a heading, a key number, a primary action. Don't spread emphasis evenly; that reads as "no decision was made."
- **Typography is a design decision, not a default.** Pick a type scale and weight relationship on purpose; don't inherit whatever the last component used without checking it still fits.
- **Structure should mean something.** Dividers, numbering, and labels should encode a real property of the content (an actual sequence, an actual grouping) — not decorate an arbitrary list.
- **Motion is optional, not default.** Add it only where it clarifies state change (a loading state, a reveal, a hover affordance); unmotivated animation reads as noise, not polish.
- **Match effort to ambition.** A minimal direction needs precise spacing and restraint; a bolder direction needs the follow-through to execute it fully. Half of either looks unfinished.
- **Copy is part of the design.** Interface text is read by the person using it, not by the system that built it — name things by what the user controls, use active voice, and keep error/empty states specific about what happened and what to do next.

### Explore

Sketch 2–3 concrete variations of the specific decision at hand (not a whole redesign) — a component's layout, a palette choice, a copy treatment — before committing to one. State which you picked and why in one line; don't silently default to the first idea.

### Self-critique

Before calling it done, check the result against the trap of templated defaults: would this exact choice be your answer to almost any similar brief, regardless of subject? If yes, revise the part that's generic. Then check the floor that never gets cut for speed: responsive down to mobile width, visible keyboard focus, and color contrast that holds up — these are cheap to get right the first time and expensive to retrofit.

## Heavy path: hand off to Claude Design in the browser

Do not design a wide-sweeping or highly-detailed surface blind, inline, in a back-and-forth text loop — visual work like this is genuinely better iterated where it can be seen and steered live. Tell the user directly, then hand them a brief they can paste straight in:

> This reads as a wide-sweeping / highly-detailed design rather than a surgical tweak — better iterated visually in **Claude Design** (claude.ai, in the browser) than designed blind here. Here's a paste-ready brief to carry the context over:

Fill in every field you can from what's already known (the codebase, the conversation, an existing design system); leave the rest as an explicit placeholder rather than inventing detail that wasn't given. Emit exactly this shape:

```markdown
# Design brief: <feature>
**Goal / job-to-be-done:** …
**Users & context:** …
**Constraints:** (brand, platform, a11y, perf) …
**Screens / components:** …
**Existing patterns to match:** …
**References / inspiration:** …
```

Stop there on this path — don't also produce inline mockups or code for the same surface; that duplicates the work Claude Design is about to do and drifts out of sync with whatever the user actually lands on in the browser.
