---
name: adr
description: Use when the user knows what they want built and says "/adr", "write an ADR for X", "decide and build X", or "ADR-driven". Turns an intent into a grounded, cited, build-ready ADR at docs/adr/YYYY-MM-DD-<slug>.md — load-bearing decisions surfaced to the human — then hands off to the subagent-driven-development loop. For exploratory "not sure what I want yet" work use brainstorming first.
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
`brainstorming` first.

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

On approval, resolve `sdd.mjs` by literal path — pinned to the version of
**`subagent-driven-development`**, not this plugin's own version — and invoke
the Workflow with the ADR.

**Loud-fail guard:** if the Decomposition has no parseable `### Task N` entries,
**stop and fix the ADR — do not hand off** (mirrors `task-brief`'s "task N not
found" guard). Nothing builds from an ADR the loop can't read.

**Commit the ADR before you hand off.** The loop's wave-0 preflight halts on any
uncommitted change in the workdir — the ADR you just wrote is one — because wave
worktrees are seeded from the committed tip and cannot see it. Commit (or stash)
first, then resolve `branchTip` from the resulting HEAD:

```bash
git status --porcelain     # must be empty
git rev-parse HEAD         # this is branchTip
```

Resolve the loop and invoke it:

```bash
P="$HOME/.claude/plugins/cache/jasonm4130-claude-skills/subagent-driven-development/0.11.0/workflows/sdd.mjs"
[ -f "$P" ] && echo "$P" || echo "MISSING: subagent-driven-development 0.11.0 is not installed at $P — run /plugin marketplace update jasonm4130-claude-skills, or /plugin install subagent-driven-development@jasonm4130-claude-skills if it was never installed"
```

If it reports `MISSING`, **stop and tell the user to update the plugin.** Do not
glob the cache for another version: superseded and rolled-back versions stay on
disk, so picking the highest cached one silently runs a loop whose `args`
contract this skill no longer matches.

```
Workflow({ scriptPath: "<resolved sdd.mjs>", args: {
  adrPath: "<abs path to docs/adr/YYYY-MM-DD-<slug>.md>",
  workdir: "<worktree root>",
  pluginDir: "<plugin root containing workflows/ prompts/ scripts/>",
  globalConstraints: "<the ADR Decisions, verbatim>",
  successCriteria: "<the ADR Success criteria block, verbatim>",
  mergeBase: "<git merge-base main HEAD>",
  branchTip: "<git rev-parse HEAD in the workdir>",
  tasks: [ { n: 1, title: "...", tier: "opus", effort: "medium", deps: [] }, ... ],  // from the Decomposition
  limits: { fixRounds: 2, escalateAttempts: 2 }
}})
```

`branchTip` is not optional in practice: omitting it seeds wave 0 from `mergeBase`,
which is a stale tree the moment the branch has any commits — and the ADR you just
committed is one. Tiering follows `subagent-driven-development`'s own table (its
SKILL.md, § "Model tiering at a glance"); the floor is `opus`/`medium`, with `effort`
as the cost lever rather than a cheaper model.

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

- Design spec: [`2026-06-27-adr-driven-development-design.md`](https://github.com/jasonm4130/claude-skills/blob/main/docs/superpowers/specs/2026-06-27-adr-driven-development-design.md)
- The loop it drives: the `subagent-driven-development` skill
