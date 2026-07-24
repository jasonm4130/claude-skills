---
name: visual-plan
description: 'Use when the user wants to plan a change, record an architecture decision (ADR), or recap what a diff changed — especially when the result benefits from visuals (wireframes, diagrams, before/after, annotated split-diffs). Produces a durable, committed Markdown ADR/plan as the source-of-truth record, and only when warranted ALSO emits a self-contained rich plan.html to /tmp. Markdown canonical, HTML disposable. Triggers: "plan this", "write an ADR", "visual plan", "recap this change", "visual recap", "/visual-plan". For decide-and-build ADR work, use adr.'
---

# Visual Plan

Two artifacts, markdown canonical:

1. **The committed Markdown ADR/plan** — the record. Everything markdown can
   render: prose, `mermaid` diagrams, GFM tables, file-trees. This is the
   deliverable; it is what gets committed and read in Obsidian/GitHub.
2. **A rich `plan.html` to `/tmp`** — emitted **only** when the work needs a
   block markdown can't express (wireframe, annotated split-diff, before/after
   columns, tabbed walkthrough). Disposable, regenerable, never committed.

No backend, no build pipeline, no server. You author both directly. When in
doubt, **markdown only**.

## Modes

| Mode | From | Default output | Add rich HTML when |
|---|---|---|---|
| **Plan** (forward) | a spec / requirements | markdown plan | a proposed UI (wireframe) or side-by-side option (columns) clarifies the decision |
| **Recap** (backward) | the real diff | markdown summary | the change is UI (wireframe) or large enough to warrant tabbed annotated split-diffs |

Detect the mode from the request: "plan / ADR / decide" → Plan; "recap / what
changed / summarize this diff/PR" → Recap. If unclear, ask one question.

## Markdown structure (the committed `.md`)

Pick the template by intent:

- **Forward + ratifying a decision** (keywords: ADR, decision record, "why did
  we choose X") → **ADR** template.
- **Forward + work to do** → **Plan** template.
- **Backward, from a diff** → **Recap** template.

**ADR** (Nygard-style — a decision worth recording):

```markdown
# <Title>
**Status:** Proposed | Accepted | Superseded
## Context
## Decision
## Consequences
```

**Plan** (forward work):

```markdown
# <Title> Plan
## Objective
## Approach   <!-- lead with reuse: what already exists that we use -->
## Steps
## Risks / hard-to-reverse bets
## Open questions
```

**Recap** (backward — grounded strictly in the real diff):

```markdown
# <Title> — Recap
## Changed files   <!-- file-tree list or table with a Change column -->
## What changed    <!-- mermaid flow/sequence if the change has a control-flow story -->
## Why             <!-- prose only; the motivation behind the change -->
```

Add a `mermaid` block where a diagram clarifies flow/sequence/state, and GFM
tables for comparisons, data-model changes (with a **Change** column), or API
summaries. Patterns: [`../../references/blocks.md`](../../references/blocks.md),
Part 1.

## When to ALSO emit rich HTML

Markdown is the default. Emit `plan.html` **only** if at least one of these is
genuinely present — otherwise stop at markdown.

| Signal | Block |
|---|---|
| The work changes or proposes a UI | wireframe |
| A code change reads best side-by-side | annotated split-diff |
| A conceptual before→after that isn't a literal diff | before/after columns |
| A multi-file / multi-hunk walkthrough | CSS-only tabs |
| A few lines that each need a "why" | annotated-code |

One qualifying block is enough. Zero → markdown only. Do not emit HTML to "look
nicer"; the markdown is the record.

## How to emit the HTML

1. **Locate and read the bundled files.** Normally the plugin is installed —
   address the cache by literal path, pinned to **this** skill's version
   (`${CLAUDE_PLUGIN_ROOT}` is not reliably available in-session):

   ```bash
   P="$HOME/.claude/plugins/cache/jasonm4130-claude-skills/visual-plan/0.2.0/assets/plan.css"
   [ -f "$P" ] && echo "$P" || echo "MISSING: visual-plan 0.2.0 is not installed at $P — run /plugin marketplace update jasonm4130-claude-skills"
   ```

   If it reports `MISSING`, **emit markdown only and tell the user to update the
   plugin.** Do not glob the cache for another version: superseded and rolled-back
   versions stay on disk, and the class contract between `plan.css` and
   `references/blocks.md` only holds within a single version — pairing a newer
   stylesheet with this skill's blocks produces silently unstyled output.

   (When developing the plugin itself — your cwd is the `claude-skills` repo —
   the files are at `plugins/visual-plan/assets/plan.css` and
   `plugins/visual-plan/references/blocks.md`.) **Read** the resolved `plan.css`
   into context before inlining; never reproduce it from memory.

2. **Build the file** from the page skeleton in `references/blocks.md`, Part 2:
   - Inline the **entire** contents of `assets/plan.css` into the `<style>`
     block — do not link it. The HTML must be one self-contained file.
   - Load mermaid from the exact pinned module and keep every diagram as
     `<pre class="mermaid">…source…</pre>` (readable offline):

     ```html
     <script type="module">
       import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11.15.0/dist/mermaid.esm.min.mjs';
       mermaid.initialize({ startOnLoad: true });
     </script>
     ```
   - Use **only** classes defined in `assets/plan.css`. Never invent a class.

3. **Write it.** First `mkdir -p /tmp/visual-plans/<slug>`, then write the file
   to `/tmp/visual-plans/<slug>/plan.html` (or `recap.html`).

4. **Add one pointer line** to the committed markdown:

   ```markdown
   > Rich view: /tmp/visual-plans/<slug>/plan.html — regenerate with /visual-plan --rich
   ```

   `--rich` re-emits the HTML from the already-committed markdown without
   rewriting the `.md`.

## Output paths & viewing

| Artifact | Path | Committed? |
|---|---|---|
| ADR | `docs/adr/YYYY-MM-DD-<slug>.md` (dated, not numbered; create `docs/adr/` if absent) | yes, by the user |
| Plan | `docs/plans/<slug>.md` (or the repo's existing plans dir) | yes, by the user |
| Rich HTML | `/tmp/visual-plans/<slug>/plan.html` or `recap.html` | no — ephemeral |

Print both paths. Tell the user to review the markdown and, if generated,
`open /tmp/visual-plans/<slug>/plan.html` (cmd+click opens it rendered in the
browser). **Never** start a server or auto-open a browser. Never commit the HTML.

## Grounding rule (recap mode)

First obtain the diff: if it is not already in context, run `git diff HEAD` (or
`git diff <base>..<head>` for a PR) and treat that output as the sole source for
all structured content.

A confidently wrong recap is worse than none. In recap mode, **structured
content is mechanical from the diff** — file lists, line counts, which hunks
go in which split-diff pane all come from the actual diff, not memory. You write
only the prose ("why"). Split-diffs: 3–8 tabs, ≤ ~150 lines each; if a hunk is
bigger, summarize it, don't paste it. If you can't ground a claim in the diff,
cut it.

## Mermaid version

Pinned to exact `mermaid@11.15.0` everywhere (no floating `@11`). Verified
2026-06-19: the jsdelivr ESM URL returns HTTP 200 with
`access-control-allow-origin: *`, so the `file://` import works. To bump the
pin, follow the checklist in [`../../CLAUDE.md`](../../CLAUDE.md).

## Common mistakes

| Mistake | Fix |
|---|---|
| Committing the `plan.html` | HTML is disposable and lives in `/tmp`; only the `.md` is committed |
| Letting the HTML become the record | Markdown is canonical; if they drift, regenerate the HTML from the markdown |
| Emitting HTML when markdown suffices | Emit HTML only if a wireframe/diff/columns/tabs/annotated-code block is genuinely present |
| Floating mermaid tag (`@11`, `@latest`) | Always the exact pin `mermaid@11.15.0` |
| Inventing a CSS class | Use only classes in `assets/plan.css`; add there first if truly needed |
| Linking `plan.css` instead of inlining | Inline the full CSS — the HTML must be self-contained |
| Ungrounded recap (claims not in the diff) | Structured content is mechanical from the diff; cut anything you can't ground |
| Auto-opening a browser or starting a server | Print the path; let the user `open` it |
| Pasting a 500-line hunk into a split-diff | 3–8 tabs, ≤ ~150 lines each; summarize bigger hunks |
