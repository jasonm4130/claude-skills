---
name: subagent-driven-development
description: Use when a written implementation plan exists and the user wants to execute it — "execute this plan", "implement the plan", "run the plan", "build it", "subagent-driven development". Plans + confirms in this session, then hands a lightweight task list to a deterministic background Workflow that runs per-task implement → review → fix with tiered models and codified ponytail discipline, then an Opus whole-branch review. Skip for ad-hoc edits with no plan.
---

# Subagent-Driven Development (workflow-driven)

Execute a written plan by handing it to a deterministic Workflow. **You** (the
controller, on the most capable model) do only what needs human judgment or
Opus reasoning — plan parsing, conflict scan, model tiering, the go/no-go gate,
and the irreversible finish. The background Workflow (`workflows/sdd.mjs`) runs
the per-task loop as code so it cannot drift, skip a review, or rubber-stamp.

**Why a workflow, not a flowchart:** the implement → review → fix loop has known
structure. Encoding it as control flow (not prose the model walks by hand) is
the recommended pattern for known-structure tasks and removes the dominant
agentic-SWE failure — verification theater / skipped steps. The model still
fills every node's judgment; only the loop is fixed.

## When to use

- A written plan exists with `# Task N` / `## Task N` headings (what `task-brief`
  parses) and the work has test coverage.
- **Not** for large, ambiguous, or brownfield work where the plan can't be
  decomposed into independently testable tasks — elaborate task ceremony there
  creates review overload without guaranteeing compliance. Recommend smaller
  tasks or manual execution instead.

## Controller process

### 1. Read the plan; capture Global Constraints verbatim
Note the project-wide requirements (exact values, formats, naming rules). They
bind every task and are passed to every agent.

### 2. Pre-flight conflict scan
Scan the plan once for tasks that contradict each other or the Global
Constraints, and for plan text that mandates something the review rubric treats
as a defect (a test that asserts nothing, verbatim-duplicated logic). Present
**everything you find as one batched question** — each finding beside the plan
text that mandates it — before execution. If the scan is clean, proceed silently.
The workflow returns any plan-conflicts the reviewers surface later; you
adjudicate those after the run, not mid-run.

### 3. Ensure an isolated worktree
Never start implementation on `main`/`master` without explicit user consent.
Create or confirm a feature branch / worktree to work in (this is self-contained
— do not rely on the disabled `using-git-worktrees` skill):

```bash
git rev-parse --abbrev-ref HEAD            # confirm not on main/master
# if needed: git worktree add ../wt-<feature> -b <feature>   (or branch in place)
```

The worktree root is `workdir`; all agents run there. `mergeBase` is where the
branch started (`git merge-base main HEAD`); `branchTip` is the branch's
current tip (`git rev-parse HEAD` in the workdir, resolved at dispatch time).
The two are distinct whenever the branch already has commits — spec, plan,
earlier runs — which is the normal case.

### 4. Enumerate tasks with tier hints and honest deps

Turn the plan into a lightweight list — **no pasted task text**, just
`{ n, title, tier, deps }`. Assign `tier` per task with the complexity signals:

| Signal | Tier |
|--------|------|
| 1–2 files, complete spec, transcription/mechanical | `haiku` |
| multi-file, integration concerns (default floor) | `sonnet` |
| design judgment, broad codebase understanding | `opus` |

Default to the `sonnet` floor when unsure; the BLOCKED escalation ladder
self-corrects a mis-tier at runtime.

**`deps` is the parallelism contract.** Tasks whose deps are all satisfied run
concurrently in sibling worktrees (waves), so mark a dep wherever task B
touches files task A creates/changes or builds on its behavior. Prefer
file-disjoint decomposition when the plan allows it. When unsure, mark the
dep — sequential is the safe default.

### 5. Show conflicts + task list + tiers; wait for the go-ahead
Present the batched conflicts (if any) and the task list with tiers **and the
computed waves** (group tasks by dependency level), so the human sees exactly
what will run in parallel before saying "go". **Wait for explicit "go"** before
dispatching. "Execute the plan" is permission for the topic, not for the
dispatch.

### 6. Resolve install paths and invoke the Workflow
`CLAUDE_PLUGIN_ROOT` is not available at runtime, so address the install by
literal path, pinned to **this** skill's version — the `args` contract moves
between versions (in local dev, use the repo path directly):

```bash
P="$HOME/.claude/plugins/cache/jasonm4130-claude-skills/subagent-driven-development/0.5.0/workflows/sdd.mjs"
[ -f "$P" ] && echo "$P" || echo "MISSING: subagent-driven-development 0.5.0 is not installed at $P — run /plugin marketplace update jasonm4130-claude-skills"
```

If it reports `MISSING`, **stop and tell the user to update the plugin.** Do not
glob the cache for another version: superseded and rolled-back versions stay on
disk, so picking the highest cached one silently runs a loop whose `args`
contract this skill no longer matches.

`pluginDir` is the directory **containing** `workflows/`, `prompts/`, and
`scripts/` (the parent of the resolved `sdd.mjs`'s `workflows/`). Then:

```
Workflow({ scriptPath: "<resolved sdd.mjs>", args: {
  planPath: "<abs plan path>",
  workdir: "<worktree root>",
  pluginDir: "<plugin root>",
  globalConstraints: "<verbatim Global Constraints>",
  mergeBase: "<git merge-base main HEAD>",
  branchTip: "<git rev-parse HEAD in the workdir>",
  tasks: [ { n: 1, title: "...", tier: "sonnet", deps: [] }, ... ],
  setupCmd: "<optional: per-worktree env setup, e.g. 'npm ci'>",
  testCmd: "<strongly recommended; pass it whenever the repo has a canonical suite command>",
  limits: { fixRounds: 2, escalateAttempts: 2, maxParallel: 4, fableEscalation: true }
}})
```

`testCmd` — **strongly recommended; pass it whenever the repo has a canonical suite command.**
Without it, every verifier reports `suite: "unknown"` and the workflow can only check that the
claimed commit resolves and is the branch head — it cannot check that anything still passes. If
you omit it, say so explicitly when you present results; do not imply the branch is green.

`mergeBase` anchors the final-review diff range; `branchTip` anchors wave-0
dispatch (task worktrees and the first review diff). Omitting `branchTip`
falls back to `mergeBase` — which dispatches wave 0 against a stale tree
whenever the branch has commits, so always pass it.

Tasks whose deps are all satisfied run concurrently (capped at
`limits.maxParallel`), each in a sibling worktree `<workdir>-t<N>`; a sonnet
merge agent integrates each wave in task order and runs the suite (`testCmd`,
or inferred from implementer reports), with one bounded repair attempt.
Linear plans (every task depending on the previous) run exactly as before.

Every agent the workflow dispatches gets an explicit `model:` (satisfies
`workflow-model-guard`); none inherit your Opus session.

### 6a. ADR-driven dispatch (optional)

The `adr` skill drives this same Workflow from an ADR instead of a `# Task N`
plan. It passes `adrPath` (an alias for `planPath` — the file `task-brief` reads,
whose `### Task N` Decomposition supplies the tasks) and `successCriteria` (the
ADR's Success-criteria block, judged at the whole-branch step as the done-oracle).
Everything else — tiering, escalation, the per-task gate, finishing — is identical.

### 7. On return: present, adjudicate, finish
The workflow returns `{ tasks, planConflicts, halted, finalReview, finalFix,
mergeBase, head, merges, meta }`.

**Verify the returned head yourself before presenting or finishing.** The workflow's
`verified: true` flags come from a verifier *agent* — an independent check, not proof (the
Workflow sandbox has no `child_process`, so nothing in the run captured a real exit code). You
have Bash. Run, in the workdir:

```bash
git -C <workdir> rev-parse --verify <result.head>^{commit}   # the head resolves
git -C <workdir> rev-parse HEAD                              # …and it IS the branch head
<testCmd>                                                    # …and the suite is actually green
```

If no `testCmd` was passed, determine the repo's canonical suite command and run that. If the repo
has none, say so plainly — "the suite was not run" — rather than presenting the run as green.

Quote the real pass/fail line back to the user. If any check disagrees with the workflow's report,
say so and stop: a run that reports `halted: null` while the suite is red is exactly what this
gate exists to catch.

- **`halted`** → `{ wave, reason, failures: [{ taskN, reason, reportPath }] }`.
  A wave can produce multiple failures (siblings run to completion and
  successful ones are merged before the halt). Wave-level `reason` covers
  merge-gate failures ("merge gate red after repair"); `failures[]` covers
  task-level ones. Failed tasks keep their worktree and branch for
  inspection. After you fix the plan/blocker, resume with
  `Workflow({ scriptPath, resumeFromRunId })` (completed tasks return cached) —
  **but only within the same Claude Code session**: resume state lives in that
  session's memory, not on disk, so exiting the session (or a crash) loses it
  and the next run starts fresh from wave 0. There is no durable ledger; if you
  need to resume across sessions, keep the failed task's worktree/branch and
  re-run the plan from that task manually.
  A halt can now also come from the **Final** phase (`wave: "final"`) — a missing final
  review, a missing fixer result, or a final fix that could not be confirmed — from a **merge
  gate** whose claimed green the verifier could not confirm, and from a **singleton task** whose
  claimed head could not be confirmed.
- **`merges`** → `[{ wave, merged, headSha, testSummary }]` — what each
  wave's merge gate did.
- **`planConflicts`** → findings that conflict with what the plan mandates. You
  decide which governs; the workflow never auto-fixes these.
- **`finalReview`** → whole-branch verdict + any `ponytailDebt` markers.
- **`finalFix`** → `{ headSha, fixed, testSummary, verified }` — what the final fixer changed,
  re-checked against git and the suite. `head` points past it. `null` when the final review found
  nothing to fix.
- Then drive **finishing** — present merge / PR / cleanup options and let the
  user choose. Merging is irreversible and stays human-gated **in this session**;
  the workflow never merges. Default to `gh pr merge --merge` only when the user
  asks to merge.

## Model tiering at a glance

| Role | Model |
|------|-------|
| implementer | `task.tier` (controller-assigned; `sonnet` floor) |
| reviewer | `opus` if the task was `opus`, else `sonnet` |
| fixer | `sonnet` |
| final whole-branch review | `opus` |
| BLOCKED escalation ceiling | `fable` — opt-in top rung tried once above a stuck `opus` (`fableEscalation`, default on) |

## Red flags — never

- Start on `main`/`master` without explicit consent.
- Paste task text into `args` (hand the workflow `planPath`; agents run
  `task-brief` to materialize each brief as a file).
- Auto-merge, or act on `planConflicts` without asking.
- Dispatch an agent without an explicit `model:`.
- Invent independence: don't invent independence to force parallelism — when
  unsure whether task B depends on task A, mark the dep.

## Dependencies

- The plan must use `# Task N` / `## Task N` headings.
- The nine superpowers post-plan skills stay disabled — this plugin is their
  self-contained replacement.
- See `../../README.md`, the design spec, and `RESEARCH_subagent_driven_workflow.md`.
