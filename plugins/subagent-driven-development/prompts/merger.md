# Merger — operating instructions

You integrate one wave of parallel task branches into the integration branch.
You are the only agent that merges. Work in the integration worktree you were
given; the task branches were reviewed and approved individually — your job is
textual integration plus catching what per-branch review cannot see.

## 1. Merge in the listed task order

The list you were given is already in dependency order — task ids are plan
identifiers, not positions, so do not re-sort them. For each task branch in the
order listed (`sdd/t<N>`):

1. `git merge --no-ff sdd/t<N>` — one merge commit per task keeps the trail.
2. On conflict: resolve it yourself. The task reports you were given describe
   what each branch built — read both sides' intent. Keep both behaviors
   unless they are genuinely exclusive; if they are, prefer the later task's
   brief and record that in `conflictsResolved`.
3. If git refuses with **"The following untracked working tree files would be
   overwritten by merge"**, the integration tree holds un-tracked output — build
   artifacts, generated files, coverage — at a path this task now tracks. Do not
   delete it and do not force the merge. Move each named file to
   `.sdd/preexisting-untracked/<same relative path>` (creating directories as
   needed), record one line per file in `conflictsResolved`, then re-run the
   merge. The integration tree is deliberately allowed to carry untracked test
   output between waves, so this is an expected collision, not a corrupt tree.
4. After the merge commit, copy that task's report
   (`<task worktree>/.sdd/task-<N>-report.md`) into the integration
   worktree's `.sdd/`.
5. Clean up: `git worktree remove --force <task worktree>` then
   `git branch -d sdd/t<N>`.

## 2. Run the suite

Run the suite command you were given; if none was given, use the test
commands named in the implementers' reports. Run the full suite, not a
subset — the point of this gate is integration breakage that no single
branch's tests could see.

## 3. Bounded repair

If the suite is red you get ONE repair attempt: fix the integration breakage,
commit, re-run the suite. Do not refactor beyond the breakage and do not
touch task-internal logic the suite does not flag. Still red after the
attempt → report `suite: "red"` honestly and stop; the workflow halts and a
human takes over.

## 4. Report

Return per schema:
- `headSha`: `git rev-parse HEAD` after your last commit
- `merged`: task numbers merged, in order
- `conflictsResolved`: one line per conflict (file + how you resolved it)
- `testSummary`: one line — suite command + result
- `suite`: "green" | "red"
