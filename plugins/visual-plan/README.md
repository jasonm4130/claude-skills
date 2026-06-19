# visual-plan

A durable, committed **Markdown ADR/plan** as the source-of-truth record — and,
only when the content needs visuals markdown can't express, **also** a
self-contained rich `plan.html` written to `/tmp`. Markdown is canonical; the
HTML is a disposable rich view of the same work.

> **Why markdown-canonical, HTML to `/tmp`?** The committed `.md` renders in the
> tools you actually use (Obsidian, GitHub) and is the record. Rich blocks —
> wireframes, annotated split-diffs, before/after columns, tabbed walkthroughs —
> can't be expressed in markdown, so for those (and only those) the skill emits a
> standalone HTML file to `/tmp`. It's never committed, so the two can't
> meaningfully drift: when the plan changes, regenerate the HTML. Rejected along
> the way: **true MDX** (needs a React/MDX build pipeline and doesn't render in
> Obsidian/GitHub anyway) and a **vendored multi-MB `mermaid.min.js`** (conflicts
> with the repo's stdlib-only convention) — mermaid loads from a pinned CDN
> instead, with the diagram source kept readable as the offline fallback.

## Install

```
/plugin marketplace add jasonm4130/claude-skills
/plugin install visual-plan@claude-skills
```

## Use

Trigger phrases: "plan this", "write an ADR", "visual plan", "recap this
change", "visual recap" — or invoke it directly as `/visual-plan`.

Two modes:

- **Plan (forward)** — from a spec/requirements. A markdown plan by default
  (`Objective · Approach · Steps · Risks · Open questions`, leading with reuse).
- **Recap (backward)** — from the real diff. A markdown summary (file-tree
  table + mermaid + narrative), grounded strictly in the diff.

Either mode adds the rich `/tmp/visual-plans/<slug>/plan.html` only when a
wireframe, annotated split-diff, before/after columns, or a tabbed walkthrough
genuinely helps.

## How it works

1. **Markdown by default.** Prose, `mermaid` diagrams, and GFM tables go in a
   normal `.md` written into the repo (`docs/adr/NNNN-<slug>.md` or
   `docs/plans/<slug>.md`). You commit it like any doc.
2. **Rich HTML on demand.** When the work needs a block markdown can't render,
   the skill also writes a self-contained `plan.html` to
   `/tmp/visual-plans/<slug>/`. It inlines the plugin's `plan.css` and loads
   mermaid from a pinned CDN module. cmd+click opens it rendered in the browser.
3. **Offline-safe diagrams.** Every diagram is a `<pre class="mermaid">` holding
   its source, so if the CDN is unreachable the source is still readable text.
4. **No backend.** No server, no database, no auto-opened browser — the skill
   prints the paths and you open what you want.

## What it deliberately does not do

No Plan MCP / `@agent-native` toolchain, no MDX compiler or React renderer, no
hosted sharing/commenting, no generator script, and no vendored JS blob.
