# subagent-driven-development

Deterministic, **workflow-driven** subagent development. A written plan goes in;
a reviewed, committed branch comes out. The post-plan execution loop runs as
code, not as a flowchart the model walks by hand — so it can't drift, skip a
review, or rubber-stamp "done."

This plugin is a self-contained replacement for the model-driven superpowers
post-plan suite (`subagent-driven-development`, `executing-plans`,
`dispatching-parallel-agents`, `test-driven-development`, `using-git-worktrees`,
`finishing-a-development-branch`, `requesting-code-review`, `receiving-code-review`,
`verification-before-completion`).

## How it works

**Thin controller, fat workflow.** The `SKILL.md` runs in your (Opus) session and
does only what needs human judgment or Opus reasoning:

1. Read the plan; capture Global Constraints.
2. Pre-flight conflict scan → one batched question (or proceed silently).
3. Ensure an isolated worktree (never `main` without consent).
4. Enumerate tasks into `{ n, title, tier, deps }` with model-tier hints.
5. Show conflicts + tasks + tiers; **wait for "go"**.
6. Resolve install paths and invoke the `workflows/sdd.mjs` Workflow.
7. On return: present results, adjudicate plan-conflicts, drive merge/PR/cleanup
   (irreversible — human-gated, never automated).

The background **Workflow** runs the per-task loop sequentially in the shared
worktree (each task builds on the previous commit):

```
for each task:
  implementer (model = task.tier)  → task-brief, TDD red→green, ponytail ladder, commit
  reviewer    (opus if task=opus, else sonnet) → spec + quality + over-engineering lens
  fix loop    (sonnet, capped)     → fix all Critical/Important, re-review
final whole-branch reviewer (opus) → merge-readiness + ponytail-debt harvest
```

### The contract

**args (controller → workflow):**
`{ planPath, workdir, pluginDir, globalConstraints, mergeBase, tasks:[{n,title,tier,deps}], setupCmd?, testCmd?, limits:{fixRounds,escalateAttempts,maxParallel} }`

**return:**
`{ tasks, planConflicts, halted, finalReview, mergeBase, head, merges, ledgerPath, meta }`

### Model tiering

Implementer = controller-assigned `task.tier` (`sonnet` floor); reviewer = `opus`
for opus tasks else `sonnet`; fixer = `sonnet`; final review = `opus`. `model:` is
set on **every** `agent()` call, so none inherit the orchestrator and the
`workflow-model-guard` hook passes.

### Deterministic failure handling

- **BLOCKED ladder:** escalate `haiku → sonnet → opus`, one attempt per tier
  below opus; at opus, up to `escalateAttempts` (default 2); then halt the run
  and return state (resume via `resumeFromRunId` after a human fixes the cause).
- **Oscillation breaker:** the same finding-class surviving two consecutive fix
  rounds halts that task instead of looping forever.
- **Fix cap:** `fixRounds` (default 2).
- **Wave scheduling:** tasks whose `deps` are all satisfied run concurrently
  (capped at `limits.maxParallel`, default 4), each in a sibling worktree
  `<workdir>-t<N>` on branch `sdd/t<N>`. A sonnet merge gate integrates each
  wave in task order, runs the full suite, and gets one bounded repair
  attempt; red after repair halts the run. Task failures don't cancel
  siblings — successful siblings are merged before the halt. Linear plans
  degenerate to singleton waves: identical to sequential execution.

### Ponytail, codified and bounded

The implementer climbs the ladder (YAGNI → reuse → stdlib → native → existing
dep → one line → minimal code), needs two concrete uses before any abstraction,
and marks deliberate shortcuts `ponytail: <ceiling>, <upgrade>`. The reviewer adds
an over-engineering lens (`delete/stdlib/native/yagni/shrink`, `net −N lines`).
**Counter-boundary (never cut):** security, input validation, error handling,
accessibility, observability. *We know we need it → build it; we might need it
someday → don't.*

## Requirements

- The plan must use `# Task N` / `## Task N` headings (parsed by `scripts/task-brief`).
- Sweet spot: well-specified plans with test coverage. Not for large ambiguous
  brownfield work.

## Testing

```bash
node --test $(find plugins/subagent-driven-development -name '*.test.mjs')
bash plugins/subagent-driven-development/scripts/scripts.test.sh
```

## See also

- Design spec: `docs/superpowers/specs/2026-06-27-sdd-workflow-design.md`
- Research brief: `RESEARCH_subagent_driven_workflow.md`
