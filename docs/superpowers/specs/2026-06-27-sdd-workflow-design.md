# Subagent-Driven Development as a Deterministic Workflow — Design

**Date:** 2026-06-27
**Status:** Approved (brainstorming) — ready for implementation plan
**Research:** [`RESEARCH_subagent_driven_workflow.md`](../../../RESEARCH_subagent_driven_workflow.md)

## Problem

The user disabled the entire superpowers post-plan suite — `subagent-driven-development`,
`executing-plans`, `dispatching-parallel-agents`, `test-driven-development`,
`using-git-worktrees`, `finishing-a-development-branch`, `requesting-code-review`,
`receiving-code-review`, `verification-before-completion` — leaving the pipeline as
`brainstorm → plan → (nothing enforced)`.

The prose `subagent-driven-development` skill is a flowchart the controller walks by
hand: per task, dispatch an implementer, package the diff, dispatch a reviewer, run a fix
loop, update a ledger, then a final whole-branch review. Because a model walking a
flowchart can skip a node, the skill leans on prose to beg for determinism (durable
ledger for compaction recovery, "continuous execution" rule, "never skip review" red
flags). The dominant agentic-SWE failure — verification theater / skipped steps /
controller drift — is exactly what prose cannot guarantee against.

The research confirms (medium reliability, primary sources Anthropic, Microsoft Conductor,
Kent Beck, Fowler, MS Red Team) that a known-structure loop like this **should be a
workflow** (control flow in code) with the model filling each node's judgment — the
orchestrator-worker split our `deep-dive/fanout.mjs` already embodies.

## Goal

A single self-contained plugin, `subagent-driven-development`, that replaces the whole
post-plan path with a deterministic Workflow-driven loop. The nine superpowers skills stay
disabled. The skill plans + confirms + hoists human decisions in the controller session,
then hands a lightweight task list to a background Workflow that enforces
implement → review → fix → final-review as code. Ponytail's anti-over-engineering
discipline is codified into the implementer and reviewer prompts, fenced by a hard
counter-boundary.

## Non-goals

- No spec-kit-style multi-file ceremony (Fowler's *Verschlimmbesserung* caution). The plan
  is already written by `writing-plans`; the loop executes it.
- No mid-run human-in-the-loop. A background workflow cannot block on a human; all human
  decisions are hoisted before or after the run.
- No parallel implementers. Tasks run sequentially in one shared worktree (each builds on
  the previous commit). Parallelism is out of scope for v1.
- Not for large ambiguous/brownfield work. Sweet spot is well-specified plans with test
  coverage; the skill says so and recommends smaller tasks or manual otherwise.

## Architecture (Approach A: thin controller, fat workflow)

Two execution surfaces, mirroring `deep-dive`:

### Controller surface — `SKILL.md` (runs as Opus in the user's session)

1. Read the plan; note global constraints.
2. **Pre-flight conflict scan** — tasks that contradict each other or the plan's Global
   Constraints, or plan text that mandates something the review rubric treats as a defect.
   Present all findings as **one batched question**; if clean, proceed silently.
3. **Ensure an isolated worktree** (never start on main/master without explicit consent) —
   logic inlined (self-contained; does not call the disabled `using-git-worktrees`).
4. **Enumerate tasks** into a lightweight list: `{ n, title, tier, deps }`. The controller
   assigns the tier hint per task using complexity signals (1–2 files w/ complete spec →
   `haiku`/cheap; multi-file integration → `sonnet`; design judgment → `opus`), defaulting
   to a Sonnet floor.
5. **Show conflicts + task list + tiers; wait for explicit "go".**
6. Resolve install paths (glob the plugin cache like `deep-dive` resolves `fanout.mjs`;
   `CLAUDE_PLUGIN_ROOT` is unavailable at runtime) for `workflows/sdd.mjs` and the
   `prompts/` dir, build `args`, invoke `Workflow`.
7. On return: present `finalReview` findings + `planConflicts` + any `halted` state. Human
   adjudicates plan-conflicts. Drive `finishing-a-development-branch` behaviour (merge/PR/
   cleanup — irreversible, human-gated) inline.

### Workflow surface — `workflows/sdd.mjs` (background, tiered agents)

Self-contained Workflow script: `meta` block; pure helpers between `// >>> PURE` /
`// <<< PURE` markers; orchestration under `if (typeof phase === "function")`. **`model:`
is set on every `agent()` call** (satisfies `workflow-model-guard`; no agent inherits the
orchestrator's Opus). A sequential `for` loop over tasks — not `parallel()`.

## Interfaces

**args (controller → workflow)** — lightweight, no pasted task text:

```
{
  planPath,            // for `task-brief` extraction inside agents
  workdir,             // abs path to the worktree; agents run here
  templateDir,         // abs path to prompts/ (resolved by controller)
  globalConstraints,   // verbatim binding requirements from the plan
  mergeBase,           // sha the branch started from (final review range)
  tasks: [ { n, title, tier: "haiku"|"sonnet"|"opus", deps: [] } ],
  limits: { fixRounds: 2, escalateAttempts: 2 }
}
```

**return (workflow → controller):**

```
{
  tasks: [ { n, status, headSha, reviewVerdict, fixRounds } ],
  planConflicts: [ ... ],                  // never auto-fixed; human adjudicates
  halted: null | { taskN, reason, reportPath },
  finalReview: { findings, verdict },
  mergeBase, head, ledgerPath, meta
}
```

## Per-task data flow (sequential)

For each task `n`, with `BASE` = prior task's `headSha` (or `mergeBase` for task 1):

1. **Implementer** (`model: task.tier`, runs in `workdir`): first action
   `task-brief planPath n` → read brief. Implement **TDD red→green**; climb the **ponytail
   ladder**; mark deliberate shortcuts `ponytail: <ceiling>, <upgrade>`; run focused tests
   then the suite once; commit; self-review. Writes a full report file; returns
   `{ status, headSha, testSummary, concerns, reportPath }` via schema.
2. **Status gate:** `DONE`/`DONE_WITH_CONCERNS` → review. `BLOCKED`/`NEEDS_CONTEXT` →
   escalation ladder.
3. **Reviewer** (`model = task.tier === "opus" ? "opus" : "sonnet"` — never below Sonnet,
   bumped to Opus only when the task itself was Opus-tier): first action
   `review-package BASE headSha` → read the package file. Returns **three verdicts** —
   spec (Missing/Extra/Misunderstood), code quality, and the **ponytail over-engineering
   lens** (`delete/stdlib/native/yagni/shrink`, `net −N`) — every finding with `file:line`
   and a `planMandated` boolean.
4. **Finding triage:**
   - `planMandated` / plan-conflicting → `planConflicts[]` (never auto-fixed).
   - Critical/Important (non-conflict) → **one** fix agent (`model: "sonnet"`) with *all*
     findings → fix, re-run covering tests, append to report → re-review (capped at
     `limits.fixRounds`).
   - Minor → ledger; surfaced to the final review.
5. **Ledger:** the implementer appends one line to `.superpowers/sdd/progress.md`
   (human-readable trail). True recovery is the Workflow `runId` journal + `git log`.
6. Advance `BASE`; next task.

After the loop: **final reviewer** (`model: "opus"`, explicit) over `mergeBase..head`
(reads its own `review-package`). If findings, **one** fix agent with the complete list.
The final reviewer also greps `ponytail:` markers introduced on the branch and lists them
as a debt trail. Return the result object.

## Escalation, halt & oscillation

- **BLOCKED ladder** (deterministic, from research): on `BLOCKED`/`NEEDS_CONTEXT`,
  escalate one tier along `haiku → sonnet → opus` and re-dispatch with the blocker fed back
  (error-steer) — **one attempt per tier while below `opus`**; at `opus`, allow up to
  `limits.escalateAttempts` (default 2) error-steered attempts. Exhausted → **halt the
  whole workflow** and return `halted` (tasks build on prior commits, so a dead task blocks
  downstream; a halt is a valid terminal state — the human fixes/replans and resumes via
  `runId`).
- **Oscillation breaker:** the same finding-class surviving a fix **twice** → halt that
  task rather than looping forever.
- **Fix loop cap:** `limits.fixRounds` (default 2).

## Human-in-the-loop boundary

| Phase | Human gate |
|-------|-----------|
| Before (controller) | pre-flight conflict scan (one batched question); worktree consent; task list + tiers; explicit "go" |
| During (workflow) | none — never blocks on a human |
| After (controller) | adjudicate `planConflicts`; review `finalReview` + `halted`; drive merge/PR/cleanup (irreversible) |

## Ponytail integration (both sides, bounded)

- **`implementer.md`:** the 7-rung ladder as pre-write discipline; simplicity directive
  ("the minimum that satisfies the brief; no abstraction, flag, or interface without **two
  concrete uses in this change**"); `ponytail: <ceiling>, <upgrade>` markers for deliberate
  shortcuts; one runnable check behind non-trivial logic; **counter-boundary** — never
  minimize away security, input validation, error handling, accessibility, or
  observability ("we know we need this → build it; we might need it someday → don't").
- **`reviewer.md`:** third verdict block — the over-engineering lens with
  `delete/stdlib/native/yagni/shrink` tags and a `net −N lines possible` score; the same
  counter-boundary restated as "do not flag the one smoke test, a `ponytail:`-marked
  deliberate shortcut, or genuinely-needed robustness."
- **`final-reviewer.md`:** lists `ponytail:` markers introduced on the branch (debt trail).

## File layout

```
plugins/subagent-driven-development/
  .claude-plugin/plugin.json
  skills/subagent-driven-development/SKILL.md   # controller-facing flow
  workflows/
    sdd.mjs              # deterministic loop (pure helpers + orchestration)
    sdd.test.mjs         # node --test on pure helpers
  prompts/
    implementer.md
    reviewer.md
    fixer.md
    final-reviewer.md
  scripts/
    task-brief           # adapted near-verbatim from superpowers (awk extract `# Task N`)
    review-package       # adapted (writes diff package file)
    sdd-workspace        # adapted (.superpowers/sdd workspace + ledger)
  README.md
```

Plus a `subagent-driven-development` entry in `.claude-plugin/marketplace.json`.

## Testing

`workflows/sdd.test.mjs` (`node --test`, PURE-marker extraction like `fanout.test.mjs`)
covers the pure helpers: task sequencing/deps partition, escalation next-tier logic,
oscillation detection (same finding-class twice), `args` validation/normalization, and the
ledger-line format. Bash scripts are exercised by a small smoke check (extract a known
`# Task N` block; build a package for a two-commit range).

## Dependencies & risks

- **Plan format:** depends on `writing-plans` output using `# Task N` / `## Task N`
  headings (what `task-brief`'s awk parses). If absent, the controller reformats or asks.
- **Runtime sandbox:** `sdd.mjs` cannot read files, run bash, or use
  `Date.now()`/`Math.random()`; all file/git work happens inside agents. Paths resolved by
  the controller and passed in `args`. (Matches the known deep-dive constraints.)
- **`workflow-model-guard`:** every `agent()` sets `model:` → passes the guard.
- **Worktree sharing:** sequential non-isolated agents share `workdir` and see each other's
  commits — required so each task builds on the last. (Do **not** use per-agent
  `isolation: "worktree"`, which would isolate tasks from each other.)
- **Scope guard (Verschlimmbesserung):** the SKILL states the loop is for well-specified
  plans with test coverage; recommends smaller tasks or manual for ambiguous/brownfield.
