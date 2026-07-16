# frontend-design

Guidance for distinctive, intentional visual design when building new UI or reshaping an existing
one. Gates by scope before designing: a light/surgical change (one component, one page, extending an
existing design system) gets inline design principles; a wide-sweeping or highly-detailed design (a new
page, a new flow, a visual identity, an ambiguous "make it look better") gets routed to Claude Design in
the browser with a paste-ready design brief instead of being designed blind in a terminal.

## Install

```
/plugin marketplace add jasonm4130/claude-skills
/plugin install frontend-design@jasonm4130-claude-skills
```

## Use

Triggers automatically when building new UI or reshaping existing UI. Not for backend/API/data-model
work, copy-only edits with no visual change, or a design the user has already fully specified (exact
tokens/brand guide supplied) — those apply directly, no gate needed.

## The scope gate

The skill checks the request against a light/heavy table (surface, anchor, brief clarity, iteration
need) before doing any design work — any single "heavy" signal routes heavy.

- **Light path** — design inline: ground it in the subject and the surrounding codebase, apply the
  design principles (one clear focal point, purposeful typography, meaningful structure, motion only
  where it clarifies state, effort matched to ambition, copy as part of the design), explore 2–3
  concrete directions, then self-critique against templated defaults and the responsive/focus/contrast
  floor.
- **Heavy path** — hand off to **Claude Design** (claude.ai, in the browser) rather than iterate
  wide-sweeping or highly-detailed visual work blind in a text loop. The skill emits a paste-ready
  `# Design brief: <feature>` template (goal, users & context, constraints, screens/components,
  existing patterns, references) filled from what's already known, and stops there — no duplicate
  inline mockups for the same surface.
