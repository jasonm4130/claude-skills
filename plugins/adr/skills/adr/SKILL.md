---
name: adr
description: Use when the user knows what they want built and says "/adr", "write an ADR for X", "decide and build X", or "ADR-driven". Turns an intent into a grounded, cited, build-ready ADR at docs/adr/YYYY-MM-DD-<slug>.md — load-bearing decisions surfaced to the human — then hands off to `nightshift:plan`'s landing step (the plan is opened as a PR and Nightshift lands it overnight). For exploratory "not sure what I want yet" work use brainstorming first. Do NOT use for domain vocabulary (use domain-modeling) or for prose mechanics on an existing document (use writing-artifacts).
---

# ADR-Driven Development (front-end for `adr → nightshift`)

Turn an intent into one **grounded, cited, build-ready ADR**, then hand it to
`nightshift:plan`'s landing step. This collapses
`brainstorm → spec → writing-plans → nightshift` into **`adr → nightshift`** for
"I know what I want, build it" work.

The arc:

```
intent → GROUND → ADR (you approve) → plan PR → Nightshift lands it → you ratify
```

**Stay thin.** This skill is a four-phase orchestrator — prose plus the two
embedded blocks below. The determinism lives in Nightshift's `loop/`, not here.
One ADR doc, not a multi-file apparatus. For exploratory "not sure what I want
yet" work use `brainstorming` first.

## Phase 1 — Ground (scaled)

Read the real code and current external practice the change touches.
**Default inline; escalate to a `/deep-research` fan-out only when the change is
novel, cross-cutting, or the user asks** — a research fan-out on a one-line
change is the ceremony to avoid.

- **State grounding:** LSP (symbols/types/refs), `git` history, an `Explore`
  agent for breadth.
- **Research grounding:** `context7` for library docs, the cloudflare MCP for CF,
  a `/deep-research` fan-out for novel/cross-cutting work or on request — current
  external knowledge, not ~1-year-stale training.
- **Record which mode was used** (inline vs research fan-out) in the ADR.

**Output:** a grounding brief — every claim already cited — that feeds the ADR.

## Phase 2 — Author the ADR

Write `docs/adr/YYYY-MM-DD-<slug>.md` (dated, not numbered; create `docs/adr/` if
absent) using the template below.

- **Citation rule (hard):** a codebase claim cites a file/symbol; an external
  claim cites a dated source; an ungrounded claim is **excluded** from the ADR.
  This makes "not stale training" auditable.
- **Success criteria must be checkable.** Phrase each so the loop can verify it —
  a test that must pass, a CI signal, a concrete assertion — and mark each
  **oracle-backed** or `[checker]` (checker-agent-evaluable, only when no oracle
  exists). This block is the loop's done-oracle.
- **Decomposition is thin `### Task N` subsections, placed LAST** so `task-brief`
  extracts each cleanly — `{ n, title, tier, deps }`-shaped, not pasted task prose.

### ADR template (embed verbatim; Decomposition LAST)

```markdown
# <Title>
**Status:** Proposed | Accepted | Superseded   **Date:** YYYY-MM-DD

## Context            <!-- grounded; every LOAD-BEARING claim cites a file/symbol or dated source -->
## Decisions          <!-- each load-bearing decision: options + the choice; these bind every task as global constraints -->
## Success criteria   <!-- CHECKABLE; each marked oracle-backed or [checker]; this is the loop's done-oracle -->
## Consequences       <!-- incl. hard-to-reverse bets / risks -->
## Grounding sources  <!-- files/symbols read + external sources WITH dates -->

## Decomposition      <!-- LAST section; thin `### Task N` subsections so task-brief extracts each -->
### Task 1: <title>
<2–4 lines: what to build, which files, deps, tier hint>
### Task 2: <title>
…
```

**Budget the prose.** Everything above `## Decomposition` targets **one page —
roughly 500 words, hard ceiling 900**. Decomposition is exempt; it scales with the
work. The reference ADR is a ten-minute one-pager, and an ADR that takes longer to
write than that is a format fighting its author.

Measured drift this exists to stop: `transcoder/docs/adr/` averages 1,674 words
per ADR, up to 5,283 — three to ten times the target. The inflation is almost
entirely citation ceremony, so: cite the claims a reader would otherwise have to
go verify, not every sentence, and keep `## Grounding sources` to the handful of
files and dated sources that actually moved the decision. A bibliography is not
grounding. If a section needs more than its share, that is a signal the decision
isn't settled yet — go back to Phase 1 rather than writing longer.

## Phase 3 — Tiered decision gate (human-in-the-loop)

- **Always-surface (blocking) set — new dependency · public-API change ·
  schema/data-model change · architecture-shaping choice.** Present each as an
  explicit choice the human picks **before anything builds**.
- **Reversible decisions:** record as *"assuming X — override if wrong"*
  defaults — non-blocking.
- **Hard gate:** nothing implements until the human approves the ADR (its
  decisions + criteria + decomposition).

## Phase 4 — Handoff

1. **Commit the ADR** on its own branch (`git add docs/adr/<file> && git commit`). Nothing lands from an uncommitted file.
2. **Prove every task extracts.** For each `### Task N` in the Decomposition run `loop/task-brief docs/adr/<file> N "$(mktemp)"`; a non-zero exit means the loop cannot read that task — fix the ADR, do not hand off. If the repo has no `loop/` yet, say `/nightshift:init` comes first and stop here.
3. **Hand to `nightshift:plan`'s landing step:** set `PLAN` in `loop/config` to the ADR path (a `loop/config` change is a PR like any other), open the branch as a PR, and tell the user the daylight recipe: merge the PR, `gh variable set LANDING_STATE --body run`, `MAX=1 loop/land.sh`, refreeze. Never merge, never flip the switch yourself.

## Scope guard

Nightshift is for **bounded, test-covered work**. Large ambiguous brownfield → break
into smaller ADRs or run manually; don't force it through one ADR.

## See also

- Design spec: [`2026-06-27-adr-driven-development-design.md`](https://github.com/jasonm4130/claude-skills/blob/main/docs/superpowers/specs/2026-06-27-adr-driven-development-design.md)
- The loop it drives: the `nightshift` plugin
