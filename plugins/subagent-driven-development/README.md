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

The background **Workflow** runs tasks in dependency-ordered waves: tasks whose
`deps` are all satisfied run concurrently, each in its own sibling worktree, and
a merge gate integrates each wave before the next one starts (linear plans
degenerate to one task per wave — sequential in effect):

```
for each wave (tasks with satisfied deps, run concurrently in sibling worktrees):
  for each task in the wave:
    implementer (model = task.tier)  → task-brief, TDD red→green, ponytail ladder, commit
    reviewer    (the tier the implementer finished at) → spec + quality + over-engineering lens
    fix loop    (capped)             → fix all Critical/Important, re-review
  merge gate → integrate wave's successful tasks in order, run full suite, one repair attempt
final whole-branch reviewer → merge-readiness + ponytail-debt harvest
```

Before wave 0 dispatches anything, a preflight reports `git status --porcelain` in the
integration workdir, and a non-empty result halts the run (`halted.wave === "preflight"`).
Uncommitted changes there are invisible to the wave worktrees, which are seeded from the committed
tip — and the wave merger then merges into that dirty tree, which either aborts or integrates local
edits nobody reviewed.

Every state advance — each singleton task, each wave merge, and the final fix — is re-checked by
an independent verifier before `base` moves: the claimed commit must resolve, it must
actually be the branch head, it must contain every succeeded task's commit, the range must contain
at least one commit, the tree must have no dirty *tracked* files, and the suite must
be green. Those later checks report `git status --porcelain --untracked-files=no`, unlike the
wave-0 preflight: they run after an agent has already executed the suite, so a repo whose tests
drop `coverage/` or `.pytest_cache/` would otherwise halt mid-run over output `git merge` ignores. The workflow advances only to the SHA the verifier resolved, never to the claim. That
in-workflow check is a confidence check, not proof — the sandbox has no `child_process` — so the
controller re-runs `git` and the suite itself against the returned `head` before presenting or
finishing (see step 7 above).

### The contract

**args (controller → workflow):**
`{ planPath, workdir, pluginDir, globalConstraints, mergeBase, branchTip?, tasks:[{n,title,tier,deps}], setupCmd?, testCmd?, limits:{fixRounds,escalateAttempts,maxParallel,fableEscalation} }`

`n` is the plan's own task id, not a position. Any alphanumeric id works —
`1`, `9A`, `"N2"` — because ids are load-bearing cross-document references
(an ADR citing "Task N3" stops matching the plan the moment you renumber).
Execution order comes from `deps` alone: a topological sort, ties broken on
list order, erroring only on a dep naming a task that isn't in the list or on
a real cycle. Ids never have to ascend.

`mergeBase` anchors the final-review diff range; `branchTip` (the branch's
current tip, `git rev-parse HEAD`) anchors wave-0 dispatch. Omitting
`branchTip` falls back to `mergeBase`, which dispatches wave 0 against a
stale tree whenever the branch is ahead of the merge-base — always pass it.

**return:**
`{ tasks, planConflicts, deferred, halted, finalReview, finalFix, mergeBase, head, merges, meta }`

Each entry in `tasks` carries the implementer's `concerns` and `reportPath`, so a
`DONE_WITH_CONCERNS` status reaches you with the concerns attached. `deferred` is
`{ minors, cannotVerify }` — what the per-task reviews chose not to act on, tagged with
`taskN` and also handed to the final reviewer to triage against the whole branch.

`meta` carries the final review's own verdict alongside the counts: `finalVerdict`, plus
`finalChangesUnaddressed` — `true` when the final review said `changes` but raised only Minor
findings, so no fixer ran. The run completed; the reviewer still said do not merge yet.

### Progress phases

Every agent the workflow dispatches declares a phase, and the live progress tree (`/workflows`) groups
by it:

| Phase | What runs there |
|---|---|
| **Implement** | the tiered implementer, plus the verifier that checks its claimed head on a singleton wave |
| **Review** | the spec + quality + over-engineering reviewer |
| **Fix** | the bounded per-task repair loop |
| **Merge** | the per-wave merge agent and its verifier |
| **Final** | the whole-branch Opus review, the one bounded final fix, its verifier, and the re-review |

**Fix is its own phase (since 0.4.0), and that is deliberate.** Fixers used to be tagged `Review`, so
repairs rendered inside the box that *found* the problems — which hid the number that matters most.
**Fix-round count is a plan-quality signal:** a task that needed two rounds is telling you the plan was
underspecified, and you should be able to see that at a glance rather than reconstruct it from a
transcript.

### Model tiering

One table, one home: **`skills/subagent-driven-development/SKILL.md` § "Model tiering at a glance"**.
This file used to carry a second copy, and the two disagreed in both directions. All that belongs
here is the invariant: `model:` is set on **every** `agent()` call, so none inherit the
orchestrator and the `workflow-model-guard` hook passes.

### Deterministic failure handling

- **BLOCKED ladder:** climb *effort* on `opus` first (`low → medium → high`), then
  spend a pricier model: at `opus`/`high`, up to `escalateAttempts` (default 2); then one
  shot on `fable` — the premium top rung, opt out with `fableEscalation: false` to halt at
  opus (on by default) — then halt the run and return state (resume via
  `resumeFromRunId` after a human fixes the cause — **same Claude Code session
  only**: resume state is not persisted to disk, so exiting the session starts
  the next run fresh from wave 0). A Fable dispatch that fails
  (tier unavailable) degrades to the same clean halt, never a crash.
- **Oscillation breaker:** the same finding-class surviving two consecutive fix
  rounds halts that task instead of looping forever.
- **Fix cap:** `fixRounds` (default 2).
- **Wave scheduling:** tasks whose `deps` are all satisfied run concurrently
  (capped at `limits.maxParallel`, default 4), each in a sibling worktree
  `<workdir>-t<N>` on branch `sdd/t<N>`. A merge gate integrates each
  wave in the dispatched (topological) order, runs the full suite, and gets one bounded repair
  attempt; red after repair halts the run. Task failures don't cancel
  siblings — successful siblings are merged before the halt. Linear plans
  degenerate to singleton waves: identical to sequential execution.

### Scripts

Bash helpers in `scripts/`, all invoked by the agents themselves except the last:

| Script | What it does |
|---|---|
| `sdd-workspace [WORKDIR]` | create the self-ignoring `.sdd/` workspace |
| `task-brief [-C WORKDIR] PLAN N` | materialize one `# Task N` block as a brief file |
| `review-package [-C WORKDIR] BASE HEAD` | build the diff package a reviewer reads |
| `sdd-worktree WORKDIR BASE N` | ensure `<workdir>-t<N>` on `sdd/t<N>`, reusing it iff its tip descends from `BASE` |
| `sdd-gc [WORKDIR]` | **for you, after a halt:** list the worktrees and `sdd/t<N>` branches the run left behind |

`sdd-gc` reports and never deletes — after a halt those worktrees hold the evidence, so it
prints the removal commands and leaves the call to you. It classifies each artefact `merged`,
`unmerged` or `prunable` (registered, directory already gone).

### Ponytail, codified and bounded

The implementer climbs the ladder (YAGNI → reuse → stdlib → native → existing
dep → one line → minimal code), needs two concrete uses before any abstraction,
and marks deliberate shortcuts `ponytail: <ceiling>, <upgrade>`. The reviewer adds
an over-engineering lens (`delete/stdlib/native/yagni/shrink`, `net −N lines`).
**Counter-boundary (never cut):** security, input validation, error handling,
accessibility, observability. *We know we need it → build it; we might need it
someday → don't.*

### Reviewer calibration (a clean pass is a real result)

Both the per-task and whole-branch reviewers are told, like the cross-family
`codex-review` gate, that **zero findings is the correct and expected outcome**
for sound work — AI reviewers over-reject, and these run on every task, so an
inflated finding costs a real fixer round. The one thing they must *not* soften:
because the implementer's job is to make the planned tests pass, a test edited to
pass trivially (a weakened assertion, one that asserts nothing or cannot fail) is
a `Critical` finding — reviewers read test-file changes more carefully than code.

## Requirements

- The plan must use `# Task N` / `## Task N` headings (parsed by
  `scripts/task-brief`). `N` may be any alphanumeric id — `9A`, `N2` — and ids
  are matched as whole tokens, so `Task 9` never picks up `Task 9A`. Keep one
  heading level per task: a heading at the task's own level or shallower ends
  the brief, so anything deeper belongs to the task above it.
- Sweet spot: well-specified plans with test coverage. Not for large ambiguous
  brownfield work.

## Testing

```bash
node --test $(find plugins/subagent-driven-development -name '*.test.mjs')
bash plugins/subagent-driven-development/scripts/scripts.test.sh
```

## See also

- Design spec: [`2026-06-27-sdd-workflow-design.md`](https://github.com/jasonm4130/claude-skills/blob/main/docs/superpowers/specs/2026-06-27-sdd-workflow-design.md)
- Research brief: [`RESEARCH_subagent_driven_workflow.md`](https://github.com/jasonm4130/claude-skills/blob/main/RESEARCH_subagent_driven_workflow.md)
