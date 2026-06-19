# visual-plan — dev notes

Stdlib-only plugin: no `hooks/`, `scripts/`, `workflows/`, `package.json`, or
vendored binaries. The skill authors both artifacts directly; there is no
runtime code to test.

## Structure

```
.claude-plugin/plugin.json   # metadata
skills/visual-plan/SKILL.md   # the skill — modes, md discipline, rich-HTML triggers
references/blocks.md          # copy-paste blocks: Part 1 markdown, Part 2 HTML
assets/plan.css               # the HTML "renderer" — inlined into generated plan.html
README.md                     # user-facing
CLAUDE.md                     # this file
```

## The class contract

`assets/plan.css` is canonical. Every class used in `references/blocks.md` (and
in any generated HTML) must be defined in `plan.css`. Add a class to `plan.css`
first, then document it in `blocks.md`. CI for this is a one-liner:

```bash
comm -23 \
  <(grep -oE 'class="[^"]+"' references/blocks.md | sed -E 's/class="//; s/"$//' | tr ' ' '\n' | sort -u) \
  <(grep -oE '\.[a-z][a-z0-9-]+' assets/plan.css | sed 's/^\.//' | sort -u)
```

Empty output = closed contract.

## Bumping the mermaid pin

Pinned to an exact version in `SKILL.md`, `references/blocks.md`, and any
samples — never a floating `@11` tag. To bump:

1. Pick the new exact version (latest 11.x): `curl -s https://registry.npmjs.org/mermaid | python3 -c "import sys,json; print(json.load(sys.stdin)['dist-tags']['latest'])"`
2. Verify the ESM URL serves with permissive CORS (required for the `file://` import):
   ```bash
   curl -sI "https://cdn.jsdelivr.net/npm/mermaid@<VER>/dist/mermaid.esm.min.mjs" | grep -iE "^(HTTP|access-control-allow-origin)"
   ```
   Expect `HTTP/2 200` and `access-control-allow-origin: *`.
3. Update the pin in `references/blocks.md` and `skills/visual-plan/SKILL.md`.
4. Re-run the render verification (see below). Confirm online render + offline
   degradation (mermaid source still readable).

## Render verification

Author a sample ADR (`mermaid` + tables) and a sample `plan.html` exercising
wireframe + annotated split-diff + columns + tabs + mermaid (CSS inlined). Open
the HTML in a browser online → every block renders, mermaid → SVG, no console
errors. Then disable network → the `<pre class="mermaid">` source stays readable;
all other blocks unaffected.
