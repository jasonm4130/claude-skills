---
name: plan
description: Use when the user has an idea, feature, or fix that is more than a one-sitting edit and says "plan this", "write a plan for X", "/nightshift:plan", or "what would it take to build X". Sizes the work (trivial → no artifact; medium → a lean plan; large → a short spec first), asks one question at a time until the design is settled, then writes a plan the overnight landing loop can land unattended — self-contained `# Task N` sections, empty Open Questions — proves each task extracts with `loop/task-brief`, runs one Codex pass, and opens the plan as its own pull request. Do NOT use to execute a plan (the loop does that at night, or a human by day), for ad-hoc edits, or when the design is already settled and written down (go straight to the task).
---

# Plan by day

A plan is the only thing Nightshift reads. What this skill produces is read at
2 a.m. by a generator that cannot ask anyone anything, so every task must be
complete on its own, and every open question must be closed before the plan
merges. Announce: "Using nightshift:plan to turn this into a landable plan."

## 1. Size it, and stop early when you can

| Size | Looks like | Do |
|---|---|---|
| Trivial | one sitting, one file or one clear edit, no design choice | No artifact. Say so and do it now, or hand it to the user. |
| Medium | a few files, one design choice or none, a day's work | A lean plan: header, constraints, tasks. No spec. |
| Large | several subsystems, choices that are hard to reverse, more than a day | A short spec first (`docs/specs/YYYY-MM-DD-<slug>.md`: problem, decision, what is out), user-approved, then the plan. |

If the work spans independent subsystems, propose one plan per subsystem;
each must produce working software on its own.

## 2. Settle the design, one question at a time

Read the code the change touches before asking anything. Then ask only what
the code cannot answer, one question per turn, preferring multiple choice.
State your interpretation and proceed when a wrong guess is cheap; ask when it
is not. Two or three questions is typical; ten means the size was wrong.

**HARD GATE:** no implementation, no scaffolding, no "quick spike" before the
user has approved the design (large) or the task list (medium). The loop
lands what the plan says, so a plan written to a design nobody approved lands
the wrong thing overnight.

## 3. Write the plan

Path: `docs/plans/YYYY-MM-DD-<slug>.md` (the repo's `loop/config` names the
plan being landed; a plan directory elsewhere wins if the repo already has one).

```markdown
# <Feature> Implementation Plan

**Goal:** one sentence.
**Architecture:** two or three sentences on the approach.
**Tech Stack:** what the tasks use.

## Global Constraints
- one line each: version floors, naming rules, platform requirements.
  Every task inherits these.

### Task 1: <component>

**Files:**
- Create: `exact/path.ts`
- Modify: `exact/existing.ts:120-140`
- Test: `tests/exact.test.ts`

**Interfaces:**
- Consumes: what this task uses from earlier tasks, exact names and types.
- Produces: what later tasks rely on, exact names and types.

- [ ] **Step 1:** write the failing test — show the test.
- [ ] **Step 2:** run it, expect FAIL with "<message>".
- [ ] **Step 3:** implement — show the code.
- [ ] **Step 4:** run `<the repo's test command>`, expect PASS.
- [ ] **Step 5:** commit: `git add <paths> && git commit -m "<why>"`.

## Open Questions
(must be empty before the plan merges)
```

Rules that make a task landable:

- **Self-contained.** The generator sees one task's section and the repo,
  nothing else. Repeat what it needs; never write "as in Task 2".
- **No placeholders.** "TBD", "add error handling", "write tests for the
  above", or a step that says what without showing how are plan failures.
- **Tests are read-only at night.** A task that must change an existing
  test says so explicitly and shows the new test; otherwise the guard denies it.
- **One task, one pull request.** Split where a reviewer could reject one
  task and approve its neighbour; fold setup and docs into the task that
  needs them. Target 3 to 8 tasks; 15 is two plans.
- **Nothing touches `.github/workflows/`, `.claude/`, `loop/`, or the
  verifier.** The hooks deny those commits; a task that needs them is a
  daytime task for a human, and the plan says so.
- **Under 200 lines** when you can. Constraints and interfaces are the
  content; narrative is not.

Self-review before handing off: every requirement maps to a task; no
placeholder patterns; names and types match across tasks.

## 4. Prove it and open it

1. **Extractability.** For each N: `loop/task-brief <plan> N /dev/null`
   must exit 0. A task that does not extract does not exist to the loop.
   (No `loop/` in this repo yet? Say `/nightshift:init` comes first.)
2. **Open Questions empty.** Each line there is a question you ask now,
   one at a time, and fold in. "None" is a claim you have checked.
3. **One Codex pass on the file** — `codex-review:codex-plan-review` on the
   plan path, once, upstream of landing; never per task. Fold or dismiss
   with a reason, per that skill's protocol. Skipped when Codex is
   unavailable: say so in the PR body.
4. **The plan is a pull request.** Branch `plan/<slug>`, commit the plan
   (and the spec), `gh pr create`. The loop reads plans from `origin/<base>`,
   so nothing lands until a human merges this PR. End with: the PR URL, the
   task count, and the daylight recipe from the repo's landing doc
   (`gh variable set LANDING_STATE --body run`, `MAX=1 loop/land.sh`).

What this skill does not do: run tasks, install launchd, or touch
`loop/config`. Landing is the loop's job; reading the night is `morning`'s.
