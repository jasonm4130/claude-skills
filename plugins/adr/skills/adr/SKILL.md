---
name: adr
description: Use when the user knows what they want built and says "/adr", "write an ADR for X", "decide and build X", or "ADR-driven". Turns an intent into a grounded, cited, build-ready ADR at docs/adr/YYYY-MM-DD-<slug>.md — load-bearing decisions surfaced to the human — then hands off to the subagent-driven-development loop. For exploratory "not sure what I want yet" work use brainstorming first; for visual planning use visual-plan.
---

# ADR-Driven Development (front-end for `adr → sdd`)

Turn an intent into one **grounded, cited, build-ready ADR**, then hand it to the
deterministic `subagent-driven-development` (SDD) loop. This collapses
`brainstorm → spec → writing-plans → sdd` into **`adr → sdd`** for "I know what I
want, build it" work.

The arc:

```
intent → GROUND → ADR (you approve) → SDD loop → you ratify
```

**Stay thin.** This skill is a four-phase orchestrator — prose plus the two
embedded blocks below. The determinism lives in `sdd.mjs`, not here. One ADR doc,
not a multi-file apparatus. For exploratory "not sure what I want yet" work use
`brainstorming` first; for visual planning/recaps use `visual-plan` (which keeps
the visual niche — `adr` carries its own build-oriented template).

## Phase 1 — Ground (scaled)

Read the real code and current external practice the change touches.
**Default inline; escalate to a `deep-dive` fan-out only when the change is novel,
cross-cutting, or the user asks** — a deep-dive on a one-line change is the
ceremony to avoid.

- **State grounding:** LSP (symbols/types/refs), `graphify` if a
  `graphify-out/graph.json` exists, `git` history, an `Explore` agent for breadth.
- **Research grounding:** `context7` for library docs, the cloudflare MCP for CF,
  a `deep-dive` fan-out for novel/cross-cutting work or on request — current
  external knowledge, not ~1-year-stale training.
- **Record which mode was used** (inline vs deep-dive fan-out) in the ADR.

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

## Context            <!-- grounded; every claim cites a file/symbol or dated source -->
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

## Phase 3 — Tiered decision gate (human-in-the-loop)

- **Always-surface (blocking) set — new dependency · public-API change ·
  schema/data-model change · architecture-shaping choice.** Present each as an
  explicit choice the human picks **before anything builds**.
- **Reversible decisions:** record as *"assuming X — override if wrong"*
  defaults — non-blocking.
- **Hard gate:** nothing implements until the human approves the ADR (its
  decisions + criteria + decomposition).

## Phase 4 — Handoff

On approval, resolve `sdd.mjs` (glob the install, pick the highest version — same
as the sdd skill) and invoke the Workflow with the ADR.

**Loud-fail guard:** if the Decomposition has no parseable `### Task N` entries,
**stop and fix the ADR — do not hand off** (mirrors `task-brief`'s "task N not
found" guard). Nothing builds from an ADR the loop can't read.

Resolve the loop and invoke it:

```bash
ls -d "$HOME"/.claude/plugins/cache/jasonm4130-claude-skills/subagent-driven-development/*/workflows/sdd.mjs | sort -V | tail -1
```

```
Workflow({ scriptPath: "<resolved sdd.mjs>", args: {
  adrPath: "<abs path to docs/adr/YYYY-MM-DD-<slug>.md>",
  workdir: "<worktree root>",
  pluginDir: "<plugin root containing workflows/ prompts/ scripts/>",
  globalConstraints: "<the ADR Decisions, verbatim>",
  successCriteria: "<the ADR Success criteria block, verbatim>",
  mergeBase: "<git merge-base main HEAD>",
  tasks: [ { n: 1, title: "...", tier: "sonnet", deps: [] }, ... ],   // from the Decomposition
  limits: { fixRounds: 2, escalateAttempts: 2 }
}})
```

`pluginDir` is the directory **containing** `workflows/`, `prompts/`, and
`scripts/`. The loop runs per-task implement → review → fix (model-tiered,
ponytail-lensed) — Decomposition tasks whose `deps` allow it run as parallel
waves with a per-wave merge gate, so mark deps honestly there — then judges
the whole branch against the ADR's Success criteria (oracle gates + a checker
agent). It converges only when oracles pass and the checker is satisfied;
**merge stays human-gated in your session** — the loop never merges.

## Scope guard

The loop is for **bounded, test-covered work**. Large ambiguous brownfield → break
into smaller ADRs or run manually; don't force it through one ADR.

## See also

- Design spec: `docs/superpowers/specs/2026-06-27-adr-driven-development-design.md`
- The loop it drives: `plugins/subagent-driven-development/`
