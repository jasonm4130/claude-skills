# SDD Wave-Parallel Execution — Design

**Date:** 2026-07-09
**Status:** Approved (brainstorming) — ready for implementation plan
**Predecessor:** [`2026-06-27-sdd-workflow-design.md`](2026-06-27-sdd-workflow-design.md) (v1 scoped parallelism out; this is the deliberate v2 of that decision)

## Problem

`workflows/sdd.mjs` runs tasks strictly sequentially: the loop chains each task's
base onto the previous task's `headSha` in one shared worktree, so even fully
independent tasks serialize. Wall-clock time is the sum of every task's
implement → review → fix loop. The `tasks[].deps` field already exists in args
but is only validated (`sequenceTasks`), never used for scheduling.

Research (2026-07-09) confirms the architecture is still current — the
review-gated loop matches Anthropic's "Outcomes" second-agent grading pattern,
and sequential-by-default matches their agent-teams guidance for dependent
tasks — but also that parallel coding agents work well when tasks are
file-disjoint and verified by a strong oracle (tests), per the C-compiler
experiment. Sources:

- [Agent teams docs](https://code.claude.com/docs/en/agent-teams) — "for
  sequential tasks, same-file edits, or work with many dependencies, a single
  session or subagents are more effective"; file-disjoint ownership is the top
  conflict rule; 3–5 workers recommended.
- [Building a C compiler with a team of parallel Claudes](https://www.anthropic.com/engineering/building-c-compiler)
  — parallel merge conflicts are frequent but Claude resolves them reliably;
  oracle-verified parallelism scales.
- [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
  — coding has fewer truly parallelizable tasks than research.

## Goal

Deps-driven wave scheduling inside `sdd.mjs`: tasks whose deps are all
satisfied run their full per-task loops concurrently, each in its own git
worktree, followed by a merge/integration gate per wave. Sequential execution
remains the degenerate case with zero new overhead, and every prompt stays a
deterministic function of plan + args (never agent completion order), so
`resumeFromRunId` prefix-caching keeps working.

## Non-goals

- **No rolling ready-set scheduler.** Starting a task the moment its deps merge
  would make each task's base sha depend on completion order — prompts become
  nondeterministic and resume caching degrades. Strict wave barriers only.
- **No shared-tree file claiming** (the C-compiler pattern). It requires
  perfectly file-disjoint tasks including tests/configs/lockfiles, collides on
  concurrent suite runs, and pollutes mid-loop review diffs.
- **No plan-format changes.** `task-brief` parsing, `# Task N` headings, and
  the ADR Decomposition adapter are untouched.
- **No mid-run human gates** (unchanged from v1). Halt remains the valid
  terminal state; humans adjudicate after.

## Decisions (brainstorm Q&A, 2026-07-09)

| Decision | Choice |
|----------|--------|
| Scheduler shape | Strict topological waves (approach A) — determinism/resume over max wall-clock |
| Merge gate autonomy | Bounded auto-repair: merge agent resolves conflicts, runs suite, one repair attempt if red, halt if still red |
| Sibling behavior on task failure | Finish in-flight siblings, merge the successful ones, then halt before the next wave |
| Per-worktree env setup | Optional `args.setupCmd`, run by implementers on entering a fresh worktree (assumed idempotent) |
| Activation & width | Automatic wherever the deps graph allows, capped by `limits.maxParallel` (default 4) |

## Architecture

New pure helper `computeWaves(tasks)` derives topological levels from `deps`
(wave of task = 1 + max wave of its deps; no deps = wave 0). `sequenceTasks`
validation stays: deps must precede numerically, which guarantees acyclicity
and provides deterministic merge order within a wave.

The orchestration loop changes from per-task to per-wave:

1. **Singleton wave** (every task of a linear plan): runs exactly as today —
   same prompts, shared `workdir`, base = current integration head, no
   worktree, no merge step. Existing runs replay identically.
2. **Wave of N > 1**: each task runs its full implement → escalation ladder →
   review → bounded fix loop concurrently, capped in-flight at
   `limits.maxParallel` by a pure promise-pool helper. The cap counts *tasks*;
   a task's own loop is internally sequential (one agent at a time), so
   in-flight agents = in-flight tasks. `runTask` is
   parameterized by two values: the task's working dir (`<workdir>-t<n>`,
   sibling worktree on branch `sdd/t<n>`) and its base (the integration head
   when the wave started — the *wave base*). All of a task's agents
   (implementer, reviewer, fixer) share that worktree; `review-package base
   head` works unchanged because worktrees share the object DB.
3. **Merge gate** (one sonnet agent per multi-task wave): merges successful
   task branches into the integration branch in numeric order, resolves
   conflicts, copies reports, cleans up worktrees, runs the suite, one bounded
   repair if red. Merged head = next wave's base.
4. **Final Opus review** unchanged — `mergeBase..head` as before.

`meta.phases` gains `{ title: "Merge" }`. Implement/Review agents keep their
existing explicit `phase:` labels (already race-safe under parallelism).

## Git mechanics

**`scripts/sdd-worktree <workdir> <baseSha> <n>`** (new bash script): creates a
sibling worktree at `<workdir>-t<n>` on branch `sdd/t<n>` starting at
`baseSha`, prints the path. Sibling paths match the existing
`git worktree add ../wt-<feature>` pattern in SKILL.md. The workflow sandbox
cannot run git, but it can compute the path *string* deterministically, so
reviewer/fixer prompts reference the worktree without a setup agent.

**Idempotency rule:** if the worktree exists and its branch tip is a descendant
of (or equal to) the given base → reuse (escalation re-dispatch and resume
cases). Tip not descended from base → stale debris from an older run: remove
and recreate. If the branch exists but its worktree is gone (resume after
cleanup), re-add the worktree from the existing branch.

**Setup:** when `args.setupCmd` is provided, the implementer runs it right
after entering the worktree.

**Merge agent procedure** (in the integration `workdir`), for each successful
task in numeric order:

1. Merge `sdd/t<n>`, resolving conflicts using the task reports on hand.
2. Copy `<workdir>-t<n>/.sdd/task-<n>-report.md` into the main `.sdd/`.
3. Remove the worktree; delete the branch.

Then run the suite — `args.testCmd` if provided, else inferred from the
implementers' reports. Red → the merge agent itself makes one repair attempt
(freshest context on what it just merged; no separate fixer dispatch),
re-runs, commits. Still red → return `suite: "red"`; the workflow halts.

**Failure retention:** a halted task's worktree and branch are kept for
inspection; its failure entry's `reportPath` points into the kept worktree.

## Interfaces

**Args** (three new optional fields; `deps` unchanged; linear plans need no
args changes):

- `limits.maxParallel` — integer ≥ 1, default 4
- `setupCmd` — optional string, per-worktree environment setup
- `testCmd` — optional string for the merge gate's suite run

**New `MERGE_SCHEMA`:**

```
{ headSha, merged: [taskNs], conflictsResolved: [strings], testSummary,
  suite: "green" | "red" }
```

**Return shape** — one deliberate breaking change. A wave can produce multiple
failures (siblings finish), so:

```
halted: null | { wave, reason, failures: [{ taskN, reason, reportPath }] }
```

Wave-level `reason` covers merge-gate failures ("merge gate red after
repair"); `failures[]` covers task-level ones (blocked after escalation,
review non-convergence, agent returned no result). Either can be empty. The
return also gains `merges: [{ wave, merged, headSha, testSummary }]`. Only
prose consumes `halted` — SKILL.md §7 and the adr skill's return-handling text
are updated in the same change; no code parses it.

**Halt semantics:** a task failure inside a wave does not cancel siblings (the
pool collects all results); successful siblings are merged, then the workflow
halts before the next wave and skips the final review. Downstream waves never
start — no dependency checking against a partial branch.

**Pool:** pure helper `runPool(items, limit, fn)` — shared-index worker loop,
no timers/randomness — unit-testable between the PURE markers.

## Controller changes (SKILL.md)

- **Step 4 (enumerate tasks):** `deps` is now the parallelism contract. Mark a
  dep wherever task B touches files task A creates/changes or builds on its
  behavior; prefer file-disjoint decomposition when the plan allows. When
  unsure, mark the dep — sequential is the safe default.
- **Step 5 (gate):** the go/no-go presentation includes the computed waves, so
  the human sees exactly what will run in parallel before "go".
- **Step 6:** document `setupCmd`, `testCmd`, `limits.maxParallel`; recommend
  passing `testCmd` whenever the repo has a canonical suite command.
- **Step 7:** new `halted` shape and `merges[]`.
- **Red flags:** add "don't invent independence — when unsure whether B
  depends on A, mark the dep."
- **adr SKILL.md:** one-line touch-up — the Decomposition's deps inherit
  parallelism for free.

## Prompts

- `implementer.md`: short worktree-entry section (run `sdd-worktree`, then
  `setupCmd` if given) — applies only when the dispatch prompt names a task
  worktree.
- `merger.md` (new): operating instructions for the merge agent, same style as
  the existing four prompt files.

## Testing

- `sdd.test.mjs` (pure helpers): `computeWaves` — linear plan → all singleton
  waves; diamond graph; deps validation unchanged. `runPool` — cap respected,
  sibling failures don't abort the wave, deterministic result ordering.
  `validateArgs` — new fields' defaults and rejection cases.
- `scripts.test.sh`: `sdd-worktree` in a temp repo — fresh create,
  reuse-when-descendant, recreate-when-stale, branch-exists-but-worktree-gone.
- `sdd.smoke.test.mjs`: two-wave scenario under stubbed agents — wave
  grouping, merge-agent dispatch, halt-with-siblings-merged. (Exact stub
  mechanism to match the existing smoke harness; the implementation plan pins
  this down.)
- Plugin version bump + README update ride along.

## Risks & dependencies

- **Deps honesty is load-bearing.** Falsely-independent tasks surface as merge
  conflicts or red integration suites — caught by the gate, but wasteful.
  Controller guidance (step 4) is the mitigation; worst case degrades to
  bounded repair + halt, never silent breakage.
- **Per-worktree env cost.** Each parallel worktree pays its own `setupCmd`
  (e.g. `npm ci`). A wave of 3 JS tasks = 3 installs. Acceptable at
  `maxParallel: 4` scale; controllers can tier plans accordingly.
- **Shared-resource collisions.** Parallel suite runs in sibling worktrees can
  contend for global resources (fixed ports, shared caches, test DBs). Not
  solvable generically in the workflow; the controller should keep such tasks
  dep-ordered. Worst case is a red suite in a task loop or the merge gate —
  bounded, visible, halting.
- **Wall-clock win = graph width.** Linear plans gain nothing (by design, they
  also lose nothing). The leverage compounds upstream: plans decomposed into
  file-disjoint tasks.
- **Sandbox constraints** (unchanged from v1): `sdd.mjs` cannot touch the
  filesystem or run git; all mechanics live in agents + bash scripts; paths
  are computed as strings from args.
