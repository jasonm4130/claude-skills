# visual-plan Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `visual-plan` plugin — a skill that writes a durable, committed Markdown ADR/plan as the source-of-truth record and, only when visuals warrant it, also emits a self-contained rich `plan.html` to `/tmp`.

**Architecture:** A new stdlib-only plugin in `jasonm4130/claude-skills`. Markdown (prose + `mermaid` + GFM tables) is canonical and committed to the active repo. A rich, self-contained HTML companion is authored to `/tmp/visual-plans/<slug>/` only when wireframes / annotated split-diffs / before-after columns / CSS-only tabs are needed. `assets/plan.css` is the "renderer" (inlined into the HTML). Diagrams use a pinned mermaid CDN ES module with a readable `<pre class="mermaid">` source as the offline fallback. No build pipeline, no server, no generator script — Claude authors both artifacts directly.

**Tech Stack:** Markdown + GFM, mermaid `@11.15.0` (jsdelivr CDN ES module), plain hand-authored HTML + CSS. No JS toolchain, no `node_modules`, no vendored binaries.

## Global Constraints

These apply to **every** task; copied verbatim from the spec (`docs/superpowers/specs/2026-06-19-visual-plan-design.md`).

- **Stdlib-only convention.** No `hooks/`, `scripts/`, `workflows/`, `package.json`, or vendored multi-MB JS blobs. Mermaid is CDN, not vendored.
- **Mermaid pin:** exact `mermaid@11.15.0` ES module from `https://cdn.jsdelivr.net/npm/mermaid@11.15.0/dist/mermaid.esm.min.mjs` (verified 2026-06-19: HTTP 200, `access-control-allow-origin: *`, so the `file://` import works). Every diagram is `<pre class="mermaid">…source…</pre>` so the source stays readable if the CDN is unreachable.
- **Markdown canonical, HTML disposable.** The committed `.md` is the deliverable. The HTML is a regenerable rich view written to `/tmp/visual-plans/<slug>/` — never the record, never committed.
- **No backend.** No hosted DB, sharing, visibility, commenting, interactive canvas, server, or auto-open of a browser. The skill prints paths and tells the user to `open` the HTML / review the markdown.
- **Plugin metadata:** name `visual-plan`, version `0.1.0`, license MIT, author `Jason Matthew <jasonm4130@gmail.com>`, category `productivity`, keywords `visual-plan, adr, visual-recap, diagram, local`.
- **Match repo conventions** of the four existing skill plugins (`adversarial-agents`, `deep-dive`, `handoff`, `session-retro`): SKILL.md frontmatter is exactly `name` + `description`; dense structured body with tables and a closing "Common mistakes" table; README modeled on `plugins/deep-dive/README.md`.

## File Structure

```
plugins/visual-plan/
  .claude-plugin/plugin.json        # metadata; model on plugins/deep-dive/.claude-plugin/plugin.json
  skills/visual-plan/SKILL.md       # modes (plan/recap), md structure + discipline, when/how to emit rich HTML
  references/blocks.md              # markdown patterns (mermaid/tables) + HTML block catalog w/ copy-paste examples
  assets/plan.css                   # the HTML "renderer": --wf-* tokens + styles for every HTML block type
  README.md                         # user-facing (Why / Install / Use / How it works)
  CLAUDE.md                         # dev doc: structure + mermaid version-bump note
.claude-plugin/marketplace.json     # add a plugins[] entry
```

`assets/plan.css` is the **canonical class contract**. `references/blocks.md` examples and any sample HTML must reference only classes defined there. Build CSS before the docs that cite it.

---

### Task 1: Plugin metadata (plugin.json + marketplace entry)

**Files:**
- Create: `plugins/visual-plan/.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json` (append one `plugins[]` entry)

**Interfaces:**
- Produces: the plugin name `visual-plan` and source path `./plugins/visual-plan`, consumed by the marketplace and `settings.json` enablement (Task 7) as `visual-plan@jasonm4130-claude-skills`.

- [ ] **Step 1: Write `plugin.json`** (mirror `plugins/deep-dive/.claude-plugin/plugin.json` shape exactly):

```json
{
  "name": "visual-plan",
  "description": "Writes a durable, committed Markdown ADR/plan as the source-of-truth record, and — only when the content needs visuals markdown can't express (wireframes, annotated split-diffs, before/after columns) — also emits a self-contained rich plan.html to /tmp. Markdown canonical, HTML disposable. No backend, no build pipeline; mermaid via pinned CDN.",
  "version": "0.1.0",
  "author": {
    "name": "Jason Matthew",
    "email": "jasonm4130@gmail.com"
  },
  "homepage": "https://github.com/jasonm4130/claude-skills",
  "repository": "https://github.com/jasonm4130/claude-skills",
  "license": "MIT",
  "keywords": ["claude-code", "visual-plan", "adr", "visual-recap", "diagram", "local"]
}
```

- [ ] **Step 2: Append the marketplace `plugins[]` entry** (after the `session-retro`/`workflow-model-guard` entries, matching their field order):

```json
{
  "name": "visual-plan",
  "source": "./plugins/visual-plan",
  "description": "Durable Markdown ADR/plan as the record, with an on-demand self-contained rich plan.html (wireframes, annotated diffs, columns) to /tmp. Markdown canonical, HTML disposable. No backend.",
  "version": "0.1.0",
  "author": {
    "name": "Jason Matthew"
  },
  "license": "MIT",
  "keywords": ["visual-plan", "adr", "visual-recap", "diagram", "local"],
  "category": "productivity"
}
```

- [ ] **Step 3: Verify both files are valid JSON**

Run: `python3 -m json.tool plugins/visual-plan/.claude-plugin/plugin.json >/dev/null && python3 -m json.tool .claude-plugin/marketplace.json >/dev/null && echo OK`
Expected: `OK`

- [ ] **Step 4: Verify the marketplace entry is wired**

Run: `python3 -c "import json; ps=json.load(open('.claude-plugin/marketplace.json'))['plugins']; print([p['name'] for p in ps])"`
Expected: list ending with `'visual-plan'`

- [ ] **Step 5: Commit**

```bash
git add plugins/visual-plan/.claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "visual-plan: add plugin metadata + marketplace entry"
```

---

### Task 2: `assets/plan.css` — the class contract / renderer

**Files:**
- Create: `plugins/visual-plan/assets/plan.css`

**Interfaces:**
- Produces: the full CSS class vocabulary that `references/blocks.md` (Task 3), `SKILL.md` (Task 4), and any sample HTML (Task 6) reference. Define each class exactly once here; downstream files cite, never invent.

Required token + class surface (the block vocabulary from the spec):

- **Design tokens** under `:root` — `--wf-*` for the wireframe system (bg, surface, border, text, muted, primary, radius, gap, font) plus a few shared doc tokens. Light, neutral, print-friendly.
- **Page chrome:** `body`, a centered `.plan` container, headings, `code`/`pre`, links.
- **Callouts:** `.callout` (+ `.callout.warn` / `.callout.note`).
- **Wireframe system:** `.wf` wrapper; surface presets `.wf.browser`, `.wf.desktop`, `.wf.mobile`, `.wf.popover`, `.wf.panel` (chrome via `::before` where useful); content primitives `.wf-card`, `.wf-pill`, `.wf-muted`, `.wf-row`, `.wf-col`, `button.primary`, `button` (default).
- **Annotated split-diff:** `.diff` (two-column grid), `.diff-pane`, `.diff-pane.before`/`.diff-pane.after`, line classes `.diff-add`, `.diff-del`, `.diff-ctx`, and an annotation `.diff-note`.
- **Before/after columns:** `.columns` (responsive 2-col grid), `.col`, `.col-label`.
- **CSS-only tabs:** `.tabs`, `input[type=radio].tab-toggle` (visually hidden), `label.tab-label`, `.tab-panel` — selected panel shown via `:checked ~` sibling selectors, **no JS**.
- **Annotated code:** `.annotated-code`, `.ac-line`, `.ac-note`.
- **Mermaid:** `pre.mermaid` baseline (readable monospace source as the offline fallback) and `.mermaid svg` sizing once rendered.

- [ ] **Step 1: Write `plan.css`** defining every token and class above. Keep it self-contained, dependency-free, and printable. Comment each block with the block-type it serves.

- [ ] **Step 2: Verify the CSS is well-formed (balanced braces)**

Run: `python3 -c "s=open('plugins/visual-plan/assets/plan.css').read(); print('braces OK' if s.count('{')==s.count('}') else 'MISMATCH %d/%d'%(s.count('{'),s.count('}')))"`
Expected: `braces OK`

- [ ] **Step 3: Extract the class/token contract for downstream tasks**

Run: `grep -oE '(--wf-[a-z-]+|\.[a-z][a-z0-9-]+|button\.primary)' plugins/visual-plan/assets/plan.css | sort -u`
Expected: prints the full vocabulary (`.wf-card`, `.diff-add`, `.columns`, `.tabs`, `pre.mermaid`, `--wf-*`, …). Keep this list — Task 3 must be a subset of it.

- [ ] **Step 4: Commit**

```bash
git add plugins/visual-plan/assets/plan.css
git commit -m "visual-plan: add plan.css renderer (wf tokens + block styles)"
```

---

### Task 3: `references/blocks.md` — markdown patterns + HTML block catalog

**Files:**
- Create: `plugins/visual-plan/references/blocks.md`

**Interfaces:**
- Consumes: the class vocabulary from `plan.css` (Task 2, Step 3). Every class shown in an HTML example MUST exist in `plan.css`.
- Produces: copy-paste block examples that `SKILL.md` (Task 4) points to by section name.

Contents — two clearly separated halves:

1. **Markdown-renderable** (go in the committed ADR/plan): prose/headings, callouts (blockquotes), a `mermaid` fenced example (flowchart + sequence), GFM tables (comparison; data-model **with a Change column**; api summary), nested-list file-trees, fenced code, task lists. Each with a short "use when".
2. **HTML-only** (presence triggers a rich render): `wireframe` (with each surface preset `.wf.browser/.desktop/.mobile/.popover/.panel`), `diff` (annotated split, two-column), `columns` (labeled before/after), `tabs` (CSS-only), `annotated-code`. Each is a copy-paste snippet using only Task 2's classes, plus a one-line "trigger" note.

Also include the **HTML page skeleton** (doctype, `<style>` with `plan.css` inlined, the pinned mermaid `<script type="module">` block, a `.plan` container) so the skill can paste-and-fill.

- [ ] **Step 1: Write `blocks.md`** with both halves and the page skeleton, using the exact pinned mermaid URL from Global Constraints.

- [ ] **Step 2: Verify every HTML class in the examples is defined in plan.css**

Run:
```bash
comm -23 \
  <(grep -oE 'class="[^"]+"' plugins/visual-plan/references/blocks.md | grep -oE '[a-z][a-z0-9-]+' | sort -u) \
  <(grep -oE '\.[a-z][a-z0-9-]+' plugins/visual-plan/assets/plan.css | sed 's/^\.//' | sort -u)
```
Expected: **empty output** (no class used in blocks.md that is missing from plan.css). Any line printed = an undefined class to fix.

- [ ] **Step 3: Verify the mermaid pin is exact (no floating tag)**

Run: `grep -c 'mermaid@11.15.0/dist/mermaid.esm.min.mjs' plugins/visual-plan/references/blocks.md`
Expected: `≥1`, and `grep -c 'mermaid@11/' plugins/visual-plan/references/blocks.md` Expected: `0`

- [ ] **Step 4: Commit**

```bash
git add plugins/visual-plan/references/blocks.md
git commit -m "visual-plan: add blocks.md (md patterns + HTML block catalog)"
```

---

### Task 4: `skills/visual-plan/SKILL.md` — the skill itself

**Files:**
- Create: `plugins/visual-plan/skills/visual-plan/SKILL.md`

**Interfaces:**
- Consumes: `references/blocks.md` (points to it by section), the mermaid pin, the output-path convention.
- Produces: the user-visible skill (frontmatter `name: visual-plan`, `description:` with trigger phrases like "plan this", "write an ADR", "visual plan", "recap this change", "visual recap").

Body sections (dense, table-driven, matching the repo's SKILL.md voice):

- **Two modes:** **Plan (forward)** from a spec — markdown plan by default (`Objective · Approach · Steps · Risks/hard-to-reverse bets · Open questions`, lead with reuse); **Recap (from diff)** grounded strictly in the real diff — markdown summary (file-tree table + mermaid + narrative) by default.
- **Markdown structure:** ADR mode (`Status · Context · Decision · Consequences`, Nygard-style) vs Plan mode; where mermaid/tables earn their place.
- **When to ALSO emit rich HTML** — a decision table: wireframe needed (UI change), annotated split-diff, before/after columns, tabbed walkthrough → yes; otherwise markdown only. "If in doubt, markdown only."
- **How to emit the HTML:** paste the skeleton from `references/blocks.md`, inline `assets/plan.css`, use the pinned mermaid module, write to `/tmp/visual-plans/<slug>/plan.html` (or `recap.html`). Add the pointer line to the markdown: `> Rich view: /tmp/visual-plans/<slug>/plan.html — regenerate with /visual-plan --rich`.
- **Output paths:** ADRs → `docs/adr/NNNN-<slug>.md` (scan next number); plans → `docs/plans/<slug>.md` (or repo's existing plans dir). Print both paths; tell the user to `open` the HTML / review the markdown. Never start a server or auto-open.
- **Grounding rule (recap):** structured content (file lists, diff line counts, split-diff panes) comes mechanically from the diff; the model writes only prose. Recap split-diffs: 3–8 tabs, ≤~150 lines each. A confidently wrong recap is worse than none.
- **Mermaid version-bump note:** pinned `@11.15.0`; to bump, re-verify the ESM URL + CORS and update `blocks.md` + samples.
- **Common mistakes** table (closing), e.g.: committing the HTML; letting HTML become the record; floating mermaid tag; inventing CSS classes not in `plan.css`; emitting HTML when markdown suffices; ungrounded recap; auto-opening a browser.

- [ ] **Step 1: Write `SKILL.md`** with valid frontmatter and all sections above.

- [ ] **Step 2: Verify frontmatter parses and has the right keys**

Run:
```bash
python3 -c "import sys; t=open('plugins/visual-plan/skills/visual-plan/SKILL.md').read(); fm=t.split('---')[1]; print('name:' in fm and 'description:' in fm and 'OK' or 'MISSING KEYS')"
```
Expected: `OK`

- [ ] **Step 3: Verify it points at blocks.md and the exact pin, and forbids invented classes**

Run: `grep -c 'references/blocks.md' plugins/visual-plan/skills/visual-plan/SKILL.md` (Expected `≥1`); `grep -c '11.15.0' plugins/visual-plan/skills/visual-plan/SKILL.md` (Expected `≥1`).

- [ ] **Step 4: Commit**

```bash
git add plugins/visual-plan/skills/visual-plan/SKILL.md
git commit -m "visual-plan: add SKILL.md (modes, md discipline, rich-HTML triggers)"
```

---

### Task 5: `README.md` + `CLAUDE.md`

**Files:**
- Create: `plugins/visual-plan/README.md`
- Create: `plugins/visual-plan/CLAUDE.md`

**Interfaces:**
- Consumes: nothing downstream depends on these. README models `plugins/deep-dive/README.md` (Why / Install / Use / How it works).

- [ ] **Step 1: Write `README.md`** — sections: one-line summary; a "Why markdown-canonical, HTML to /tmp" blockquote (the two-artifact rationale + that MDX/vendored-mermaid were rejected); Install (`/plugin marketplace add jasonm4130/claude-skills` + `/plugin install visual-plan@claude-skills`); Use (trigger phrases, plan vs recap); How it works (markdown default, rich HTML on demand, offline mermaid fallback).

- [ ] **Step 2: Write `CLAUDE.md`** (dev doc) — plugin structure, the class-contract rule (plan.css is canonical), and the mermaid version-bump checklist (re-verify ESM URL + CORS, update blocks.md + samples + SKILL.md pin).

- [ ] **Step 3: Verify no stray placeholders**

Run: `grep -nE 'TODO|TBD|FIXME|lorem' plugins/visual-plan/README.md plugins/visual-plan/CLAUDE.md || echo "clean"`
Expected: `clean`

- [ ] **Step 4: Commit**

```bash
git add plugins/visual-plan/README.md plugins/visual-plan/CLAUDE.md
git commit -m "visual-plan: add README + CLAUDE dev doc"
```

---

### Task 6: Sample artifacts + real render verification

**Files:**
- Create: `/tmp/visual-plans/sample/adr.md` (sample ADR: mermaid flowchart + comparison table + data-model table)
- Create: `/tmp/visual-plans/sample/plan.html` (exercises wireframe + annotated split-diff + before/after columns + CSS-only tabs + mermaid, with `assets/plan.css` inlined and the pinned mermaid module)

These are throwaway verification artifacts in `/tmp` (not committed) that prove the skill's two outputs actually render. They double as the smoke test for the CSS contract and the offline fallback.

- [ ] **Step 1: Author `adr.md`** using only markdown-renderable blocks from `blocks.md`.

- [ ] **Step 2: Author `plan.html`** by filling the skeleton from `blocks.md`, inlining the full `plan.css`, and including one of every HTML-only block.

- [ ] **Step 3: Verify the markdown's mermaid + tables are syntactically valid**

Run: `grep -c '```mermaid' /tmp/visual-plans/sample/adr.md` (Expected `≥1`); eyeball the GFM tables have header + `---` separator rows.

- [ ] **Step 4: Render `plan.html` in a real browser (online) and check for console errors**

Use the Playwright MCP: `browser_navigate` to `file:///tmp/visual-plans/sample/plan.html`, then `browser_console_messages` (Expected: no errors; mermaid rendered to `<svg>`), then `browser_take_screenshot`.
Expected: wireframe, split-diff, columns, tabs all styled; mermaid diagram rendered as SVG; zero console errors.

- [ ] **Step 5: Verify offline degradation**

Re-render with network disabled (e.g. Playwright `browser_navigate` after blocking the jsdelivr request, or temporarily point the import at a bad host in a copy). Expected: the `<pre class="mermaid">` **source text stays visible and readable**; all non-mermaid blocks render unchanged.

- [ ] **Step 6: Verify the inlined CSS matches the source `plan.css`**

Run: `grep -c -- '--wf-' /tmp/visual-plans/sample/plan.html` (Expected `≥1`, confirming tokens were inlined, not linked).

(No commit — `/tmp` artifacts are disposable. Capture the screenshot/console result in the session as the verification evidence.)

---

### Task 7: Enable the plugin + whole-skill review

**Files:**
- Modify: `~/Work/Git/dotfiles/private_dot_claude/settings.json` (add `visual-plan@jasonm4130-claude-skills` to `enabledPlugins`)

**Interfaces:**
- Consumes: the plugin name from Task 1.

- [ ] **Step 1: Whole-skill consistency review.** Re-run the Task 3 Step 2 class-contract check; confirm SKILL.md → blocks.md → plan.css form a closed loop (no dangling references, no undefined classes, single exact mermaid pin everywhere).

Run (repo-wide pin check):
```bash
grep -rn 'mermaid@11' plugins/visual-plan | grep -v '11.15.0' || echo "pin consistent"
```
Expected: `pin consistent`

- [ ] **Step 2: Enable via dotfiles** — add the plugin to `enabledPlugins` in `~/Work/Git/dotfiles/private_dot_claude/settings.json`. (This is a **dotfiles repo** change, separate from the claude-skills commits; surface it to the user to commit with their other dotfiles changes.)

- [ ] **Step 3: Verify enablement JSON is valid**

Run: `python3 -m json.tool ~/Work/Git/dotfiles/private_dot_claude/settings.json >/dev/null && echo OK`
Expected: `OK`

- [ ] **Step 4: Confirm install** — after a marketplace refresh / new session, `visual-plan` appears in the skills list and `/visual-plan` produces a markdown doc (and, when warranted, the `/tmp` HTML). Report this as the final exit criterion.

---

## Self-Review

- **Spec coverage:** Goal (markdown-canonical + on-demand HTML) → Tasks 4+6; two artifacts → Tasks 2/3/6; plugin layout → Tasks 1–5; block vocabulary → Tasks 2/3; two modes → Task 4; output & viewing → Task 4; verification criteria → Task 6; marketplace + enablement → Tasks 1/7. All spec sections mapped.
- **Non-goals honored:** no MCP/MDX/React (constraint), no backend (constraint), no generator/server (Task 4 authors directly), no vendored blob (mermaid CDN, Global Constraints).
- **Contract consistency:** `plan.css` defines classes (Task 2); `blocks.md` (Task 3 Step 2) and the sample (Task 6) are verified subsets; single exact mermaid pin `11.15.0` enforced in Tasks 3/4/7.
