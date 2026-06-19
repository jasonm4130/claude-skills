# visual-plan — markdown ADR/plan + on-demand rich HTML render

**Date:** 2026-06-19
**Status:** design, pending approval
**Repo:** `jasonm4130/claude-skills` (new plugin `visual-plan`)

## Goal

A skill that produces a **durable, committed Markdown ADR/plan** as the
source-of-truth decision/planning record, and — only when the content needs
visuals that markdown can't express — **also** emits a self-contained, rich
`plan.html` view to `/tmp`. The markdown is the artifact; the HTML is a
disposable rich view of the same work. No hosted backend, no build pipeline.

## Why / context

The BuilderIO visual-plan/recap skills were removed this week: their rendering
required the agent-native Plan MCP + `npx @agent-native/core` toolchain. A
deep-dive workflow (run `wf_31b4055f-486`) confirmed the *good* parts — the
block vocabulary, wireframe HTML contract, diff→block discipline, recap
budgets, grounding rule — are all prompt-layer and backend-free.

Two design turns refined the original "single HTML file" idea:
1. **True MDX is rejected.** MDX needs a React/MDX render pipeline (bundler +
   `node_modules`, or an in-browser CDN runtime that hits the `file://`
   `fetch()` wall and needs a server) — structurally the bloat we cut. And
   MDX components don't render in the viewers actually used (Obsidian/GitHub
   render markdown, not JSX).
2. **The doc-as-artifact instinct is kept** via plain Markdown + mermaid, with
   a rich HTML companion only when wireframes / annotated diffs / columns are
   warranted.

## Non-goals (deliberately cut)

- No Plan MCP / `@agent-native` toolchain, MDX compiler, or React renderer.
- No hosted database, sharing, visibility, or commenting/feedback loop.
- No interactive canvas/prototype surface.
- No generator script and no local server — Claude authors both artifacts
  directly.
- No vendored multi-MB JS blob committed to the repo (mermaid is CDN).

## Architecture — two artifacts, markdown canonical

### 1. Markdown ADR/plan (primary, committed, durable)

- A normal `.md` file in the active repo. **This is the deliverable.** It holds
  everything markdown can render: ADR/plan prose, `mermaid` fenced diagrams,
  GFM tables (comparisons, data-model, api summaries), file lists.
- Renders visually in any mermaid-aware viewer — **Obsidian and GitHub** are
  the primary targets (the user's tools). In Zed, cmd+click opens it as source
  unless Zed's preview renders mermaid.
- Structure:
  - **ADR mode:** `Status` · `Context` · `Decision` · `Consequences`
    (Nygard-style), plus mermaid where a diagram clarifies the decision.
  - **Plan mode:** `Objective` · `Approach` · `Steps` · `Risks / hard-to-reverse
    bets` · `Open questions`, lead with reuse.
- If a rich HTML view is also generated, the markdown includes one pointer line:
  `> Rich view: /tmp/visual-plans/<slug>/plan.html — regenerate with /visual-plan --rich`.

### 2. Rich HTML render (on demand, ephemeral)

- A self-contained `plan.html` / `recap.html` written to
  **`/tmp/visual-plans/<slug>/`**. Produced when the work needs blocks markdown
  can't express: **wireframes** (UI changes), **annotated split-diffs**,
  **before/after columns**, **tabbed** code walkthroughs.
- Plain HTML; inlines `assets/plan.css` (`--wf-*` tokens + block styles) into a
  `<style>` block. Diagrams via **pinned CDN** mermaid as an ES module:
  ```html
  <script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11.x.x/dist/mermaid.esm.min.mjs';
    mermaid.initialize({ startOnLoad: true });
  </script>
  ```
  Each diagram is `<pre class="mermaid">…source…</pre>`, so if the CDN is
  unreachable the source is still readable (offline fallback). Pin an exact
  `11.x.x` at build time.
- cmd+click the `.html` opens it **fully rendered in the browser** (`.html` was
  deliberately left out of the Zed default-app set). The CDN ES-module import
  works under `file://` because jsdelivr serves permissive CORS headers; the
  build verifies this.

### Keeping the two in sync (the accepted cost)

The HTML is **not** a mechanical transform of the markdown (no parser, no
generator). Claude authors both from the same understanding + diff/context, the
markdown being canonical. Drift is bounded because the HTML is disposable: when
the plan changes, regenerate the HTML; it is never the source of record.

## Plugin layout

```
plugins/visual-plan/
  .claude-plugin/plugin.json        # name, description, version 0.1.0, author, license MIT
  skills/visual-plan/SKILL.md       # modes (plan/recap), md structure + discipline, when/how to emit rich HTML
  references/blocks.md              # markdown patterns (mermaid/tables) + HTML block catalog w/ copy-paste examples
  assets/plan.css                   # the HTML "renderer": --wf-* tokens + styles for every HTML block type
  README.md                         # user-facing
  CLAUDE.md                         # dev doc (structure, mermaid version-bump note) — optional
```

No `hooks/`, `scripts/`, `workflows/`, `package.json`, or vendored binaries —
matches the repo's stdlib-only convention.

Marketplace: add a `plugins[]` entry to `.claude-plugin/marketplace.json`
(name `visual-plan`, version `0.1.0`, MIT, category `productivity`, keywords
`visual-plan`, `adr`, `visual-recap`, `diagram`, `local`). Enable via
`settings.json` `enabledPlugins` (a dotfiles change, made when we install).

## Block vocabulary

**Markdown-renderable (go in the committed ADR/plan):**
- prose / headings / callouts (blockquotes), `mermaid` diagrams, GFM tables
  (comparison, data-model with a Change column, api summary), nested-list
  file-trees, fenced code, task lists.

**HTML-only (trigger a rich render when present):**
- `wireframe` — content-only HTML, `.wf-card`/`.wf-pill`/`.wf-muted`/
  `button.primary` + `--wf-*` tokens; surface presets
  (browser/desktop/mobile/popover/panel).
- `diff` (annotated split, two-column), `columns` (labeled before/after),
  `tabs` (CSS-only, no JS), `annotated-code`.

`references/blocks.md` documents both sets with copy-paste examples.

## Two modes, one skill

- **Plan (forward):** from a spec/requirements. Markdown plan by default; rich
  HTML when wireframes/diffs add value.
- **Recap (from diff):** grounded strictly in the real diff. Markdown summary
  (file-tree table + mermaid + narrative) by default; rich HTML for UI changes
  (wireframes) or substantial diffs (annotated split-diff tabs, 3–8, ≤~150
  lines each). Grounding rule: structured content comes mechanically from the
  diff; the model writes only prose. A confidently wrong recap is worse than
  none.

Discipline lives entirely in SKILL.md + `references/blocks.md`; no runtime code.

## Output & viewing

- **Markdown:** written into the repo following its convention — ADRs to
  `docs/adr/NNNN-<slug>.md` (next number scanned from existing), plans to
  `docs/plans/<slug>.md` (or the repo's existing plans dir). Committed by the
  user as a normal doc.
- **Rich HTML (when generated):** `/tmp/visual-plans/<slug>/plan.html` (or
  `recap.html`) — ephemeral, no repo clutter, browser-rendered on cmd+click.
- The skill prints both paths and tells the user to `open` the HTML / review the
  markdown. It never starts a server or auto-opens a browser.

## Verification (build phase exit criteria)

1. No scripts to typecheck; validate generated HTML opens and CSS is well-formed.
2. **Markdown:** author a sample ADR with a mermaid block + tables; confirm it
   renders in Obsidian and/or GitHub preview (diagrams + tables display).
3. **HTML:** author a sample `plan.html` exercising wireframe + annotated diff +
   columns + tabs + mermaid; `open` it online → all render, no console errors;
   then disable network → mermaid source visible as text, other blocks fine.
4. After install: skill appears in the session skills list; a real `/visual-plan`
   run produces the markdown doc (and, when warranted, the `/tmp` HTML).

## Open questions

None blocking. Single-file portability of the HTML (emailable) is deferred — a
`--inline` export could inline mermaid later if cross-machine sharing is needed.
