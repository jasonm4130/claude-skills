# ADR-Driven Development — Design

**Status:** Proposed
**Date:** 2026-06-27
**Author:** Jason (via brainstorming)
**Related:** `RESEARCH_subagent_driven_workflow.md`, `docs/superpowers/specs/2026-06-27-sdd-workflow-design.md`, `plugins/subagent-driven-development/`, `plugins/visual-plan/`

## Summary

A new front-end skill, **`adr`**, turns an intent into a *grounded, decided, build-ready* ADR, then hands it to the existing `subagent-driven-development` (SDD) loop. This collapses the `brainstorm → spec → writing-plans → sdd` chain into **`adr → sdd`** for "I know what I want, build it" work, while keeping `brainstorming` for genuinely exploratory work and `visual-plan` for visual planning/recaps.

The arc:

```
intent → GROUND → ADR (you approve) → SDD loop → you ratify
```

## Problem

Superpowers' spec-driven path fires correctly but its flow doesn't match the intended one:
- It produces a **separate plan** (`writing-plans`) downstream of the spec; the intent wants the ADR to be the *single* planning artifact.
- The spec/ADR is **not grounded** — nothing forces it to reflect actual codebase state or *current* external best-practice (vs ~1-year-stale model training).
- Small, load-bearing decisions are made by the agent rather than **bubbled up to the human first**.

The SDD loop itself (`sdd.mjs`) already does the hard part well: per-task implement → review (with the ponytail/over-engineering lens) → fix, model-tiered, with an oscillation breaker, a deterministic escalation ladder, worktree isolation, and HITL hoisted out of the loop. We reuse it wholesale.

## Goals

1. One grounded ADR doc per change at `docs/adr/YYYY-MM-DD-<slug>.md` that carries intent, decisions, **checkable** success criteria, and a thin task decomposition — **no second plan file**.
2. The ADR is **grounded and cited**: every codebase claim cites a file/symbol; every external claim cites a dated source. Ungrounded claims don't enter the ADR.
3. **Tiered decision-surfacing**: load-bearing decisions block on the human at ADR time; reversible ones become overridable defaults; new load-bearing decisions mid-loop halt and return.
4. The loop judges "done" against the ADR via **deterministic gates + a checker agent**, with the human as final ratifier.
5. Reuse the existing SDD loop; the only loop change is an ADR input adapter + the ADR-criteria done-oracle.

## Non-goals

- A spec-kit-style multi-file ceremony. One ADR doc; the determinism lives in the workflow, not in prose. (Fowler's *Verschlimmbesserung*, per the research.)
- Replacing `brainstorming` for exploratory "I'm not sure what I want yet" work, or `visual-plan` for visual artifacts.
- Changing the SDD loop's internals (escalation ladder, oscillation breaker, model tiering, ponytail lens, merge-gating all stay).
- Large ambiguous brownfield: out of scope for the loop — recommend smaller ADRs or manual execution.

## Component 1 — the `adr` skill (new plugin in `jasonm4130/claude-skills`)

Plugin + skill name: **`adr`**. Borrows `visual-plan`'s Nygard ADR template; distinct skill (visual-plan keeps its visual niche).

### Phase 1 — Ground (scaled; default inline, escalate when earned)

- **State grounding:** read the real code the change touches — LSP (symbols/types/refs), `graphify` if a `graphify-out/graph.json` exists, `git` history, an `Explore` agent for breadth.
- **Research grounding:** current external knowledge — `context7` for library docs, the cloudflare MCP for CF, a **deep-dive fan-out** for novel/cross-cutting work or on request.
- **Escalation rule (C):** inline by default; escalate to the deep-dive fan-out when the change is novel, cross-cutting, or the user asks. Record which mode was used.
- **Output:** a grounding brief feeding the ADR, with citations.

### Phase 2 — Author the ADR

Document at `docs/adr/YYYY-MM-DD-<slug>.md` (dated, not numbered; create `docs/adr/` if absent). Sections:

```markdown
# <Title>
**Status:** Proposed | Accepted | Superseded   **Date:** YYYY-MM-DD

## Context            <!-- grounded; every claim cited -->
## Decisions          <!-- each load-bearing decision: options + the choice -->
## Success criteria   <!-- CHECKABLE conditions — this is the loop's done-oracle -->
## Decomposition      <!-- thin task list; the "no separate plan" lives here -->
## Consequences       <!-- incl. hard-to-reverse bets / risks -->
## Grounding sources  <!-- files/symbols read + external sources WITH dates -->
```

**Citation rule (hard):** a claim about the codebase cites a file/symbol; a claim about an external practice/library cites a dated source. If it can't be grounded, it doesn't go in the ADR. This makes "not stale training" auditable.

**Success criteria must be checkable.** Each criterion is phrased so the loop can verify it: a test that must pass, a CI signal, a concrete assertion ("`GET /x` returns 200 with shape Y"), or — only when no oracle exists — a checker-agent-evaluable statement, explicitly marked as such.

**Decomposition** is a thin list (`{ n, title, tier, deps }`-shaped, the same shape SDD's controller already enumerates), not pasted task prose.

### Phase 3 — Tiered decision gate (the human-in-the-loop)

- **Always-surface (blocking) set:** new dependency · public API change · schema/data-model change · architecture-shaping choice. These are presented as explicit choices; the human picks before anything builds.
- **Reversible decisions:** recorded in the ADR as *"assuming X — override if wrong"* defaults; non-blocking.
- **Hard gate:** nothing implements until the human approves the ADR (its decisions + criteria + decomposition).

### Phase 4 — Handoff

On approval, resolve the SDD workflow path and invoke it with the ADR (see Component 2).

## Component 2 — extended `sdd.mjs` (existing loop, two additions)

Everything else in `sdd.mjs` is untouched. The current contract (from the skill):

```
Workflow({ scriptPath: <sdd.mjs>, args: {
  planPath, workdir, pluginDir, globalConstraints, mergeBase,
  tasks: [{ n, title, tier, deps }], limits: { fixRounds, escalateAttempts }
}})
→ returns { tasks, planConflicts, halted, finalReview, mergeBase, head, ledgerPath, meta }
```

### Addition 1 — ADR input adapter

- Accept `adrPath` as an alternative to `planPath` (the `# Task N` plan path still works — backward compatible).
- When `adrPath` is given: `tasks` come from the ADR's **Decomposition** section; `globalConstraints` come from the ADR's **Decisions** (the chosen, load-bearing ones bind every task); the ADR's **Success criteria** are passed through as the done-oracle input.

### Addition 2 — done-oracle = D (deterministic gates + checker agent)

- **Deterministic gates (authoritative):** the ADR's criteria *that have an oracle* run as oracles — tests pass, CI green, concrete assertions hold. (Reuses SDD's existing per-task test verification; adds an ADR-criteria gate to the whole-branch step.)
- **Checker agent (the gap-filler):** a separate model (maker≠checker) reads the diff + the ADR's Success criteria and judges **only the criteria that have no oracle**, plus one holistic pass — "do these changes add up to the stated intent?". It never re-litigates a passing oracle. Runs at the whole-branch step.
- The loop converges only when **all oracle criteria pass and the checker is satisfied**; then it returns for the human to ratify. **Merge stays human-gated** in the session, exactly as today.
- Tier: checker agent on `opus` for the final whole-branch judgment (it's the gate that matters); `sonnet` if consulted per-task.

### Addition 3 — mid-loop load-bearing halt

If an implementer hits a fork that is itself a load-bearing decision (a *new* dependency / public-API / schema change not already decided in the ADR), the loop **halts and returns it** (the existing `halted` path) rather than blocking in place or silently deciding. The human chooses, updates the ADR, and resumes via `resumeFromRunId` (completed tasks return cached). This reuses the existing oscillation/blocked halt machinery.

## What it replaces / coexists with

| Tool | Disposition |
|---|---|
| `brainstorm → spec → writing-plans → sdd` chain | **Replaced** by `adr → sdd` for "I know what I want" work. |
| `brainstorming` | **Kept** — for exploratory "not sure what I want yet" work, *before* an ADR. |
| `visual-plan` | **Kept** — visual planning/recaps; `adr` borrows its ADR template only. |
| 9 denied superpowers skills | **Stay denied** — SDD already replaces them. |
| `sdd.mjs` loop | **Reused**, +2 additions above. |

## Scope guards (ponytail / from the research)

- The `adr` skill stays **thin** — determinism in the workflow, not prose ceremony.
- One ADR doc, not a multi-file spec apparatus. Scaled grounding (don't deep-research a one-line change).
- The loop is for **bounded work with test coverage**; large ambiguous brownfield → smaller ADRs or manual.
- The implementer keeps the ponytail ladder + simplicity directive; the reviewer keeps the over-engineering lens — both fenced by the hard counter-boundary (never strip security, validation, error handling, accessibility, observability).

## How we'll know it works (success criteria for the skill itself)

1. Running `/adr "<intent>"` on a real repo produces a `docs/adr/YYYY-MM-DD-<slug>.md` whose every Context claim is traceable to a cited file/symbol or dated source.
2. A load-bearing decision (e.g. a new dependency) is surfaced as a blocking choice, not silently made.
3. On approval, the SDD loop runs from the ADR with **no separate plan file**, and converges only when deterministic gates + checker agree.
4. Introducing a new schema change mid-loop halts the run and returns it for a decision.
5. The skill body stays under a reasonable size (thin orchestrator); the determinism is in `sdd.mjs`.

## Open questions / risks

- **ADR ↔ loop contract drift:** the Decomposition/Success-criteria shape is the interface; a manifest/contract test should fail loudly if the ADR lacks a parseable Decomposition (mirrors SDD's `# Task N` loud-failure guard).
- **Grounding cost:** the scaled escalation must default to inline; a deep-dive fan-out on every ADR would be the Verschlimmbesserung the research warns about.
- **Naming:** plugin/skill `adr` vs `adr-driven-development`. Defaulting to `adr` (clean `/adr` invocation); overridable.
</content>
