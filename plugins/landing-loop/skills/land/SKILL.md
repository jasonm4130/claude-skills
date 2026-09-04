---
name: land
description: Use when a human-approved plan with "# Task N" headings exists and the user wants every task landed on main without watching — "land the plan", "run this unattended", "/landing-loop:land <plan>". One task per iteration, one pull request per task, CI green as the only gate, merge through the repo's own merge command, a ledger in git. Do NOT use to write or approve a plan (brainstorming, writing-plans, adr do that), for a plan with open questions, on a repo with no CI gate, or for ad-hoc edits with no plan.
---

# Land a plan unattended

You are the outer loop. A human approved the plan; that approval is the only human
gate in this run, and it happened before you started. Everything after it is a
machine gate: the repo's check command, the pull request's CI, the repo's merge
command. Your job is to pick one task, get it through those gates, record the
result in git, and pick the next one — until every task is landed or blocked.

`subagent-driven-development`'s workflow runs the inner loop per task (implement →
review → fix → verify, with tiered models and a BLOCKED ladder). You never implement
in this session; you orient, dispatch, verify, push, wait, merge, and record.

## Invocation

```
/landing-loop:land <plan-path> [--max-tasks N] [--dry-run]
```

For a run nobody is watching, launch it from a terminal that stays open:

```sh
claude --permission-mode auto -p "/goal Every task in <plan-path> is landed or blocked, shown by the ledger beside it; stop after 40 turns. Get there with /landing-loop:land <plan-path>" --permission-prompts none
```

`--permission-prompts none` (v2.1.259+) denies anything that would have prompted
instead of hanging. `/goal` adds a judge that is not you. Without a bound in the
condition the run has no ceiling but the harness's own.

## Preflight — every line must hold, or refuse and say which

Print the check and its result for each. A refusal lists every failure at once.

1. **Plan.** The file is committed on `main` (its own pull request is where the human
   approved it), parses into `# Task N` / `## Task N` headings, and its
   `## Open Questions / Unresolved Assumptions` section is empty or absent. An open
   question is a decision; unattended runs execute decisions, they do not make them.
2. **Scope per task.** Every task lists the files it may touch (`**Files:**`). A task
   without one gets no authorized scope, and overeager rates go from 0% to 17% on
   that omission alone (arXiv 2607.05743).
3. **Check command.** The plan's `## Global Constraints` names a `Verify:` command, or
   the repo has one canonical suite command you can name. Its last line on success must
   be short. If the only verifier prints thousands of lines on pass, wrap it first
   (see *Quiet verifier* below).
4. **Merge command.** In order of preference: a repo script that waits for CI and merges
   (`./merge-pr.sh`, `scripts/merge-pr`), else `gh pr merge --auto --merge` **only if**
   `gh api repos/{owner}/{repo}/branches/main/protection` returns required checks.
   Neither → refuse: there is no CI gate, so there is nothing to land through.
5. **Tree.** On `main`, `git status --porcelain` empty, `git fetch` succeeds,
   `main` equals `origin/main`.
6. **Session.** Permission mode is `auto` or the run was launched with
   `--permission-prompts none`. In `default` mode the first `gh pr create` will hang
   on a prompt nobody answers.
7. **Ledger.** `<plan-path minus .md>.ledger.md` exists or you create it from the
   template below in the first task's branch.

`--dry-run` stops here and prints the task order.

## The ledger

Lives beside the plan, committed on each task's branch, so it lands with the task.
Pull requests are the truth about status; the ledger stores the mapping and the notes.

```markdown
# Ledger — <plan title>

Approved by the human who invoked /landing-loop:land on <ISO date>.
Merge command: ./merge-pr.sh · Check command: scripts/check

| Task | Branch | PR | Status | Note |
| --- | --- | --- | --- | --- |
| 1 | land/<slug>-t1 | #12 | landed | |
| 2 | land/<slug>-t2 | #13 | blocked | CI red twice: rust/clippy, log in PR |
| 3 | | | todo | deps: 2 |
```

Status values: `todo`, `in-progress`, `landed`, `blocked`, `skipped` (a dep is blocked).
Derive `landed` from `gh pr view <n> --json state` at orientation, never from memory.

## Orientation — run this at the top of every iteration

Identical every time; the cost of orientation is what keeps context small.

```sh
git switch main && git pull --ff-only
gh pr list --search "head:land/<slug>-" --state all --json number,headRefName,state,isDraft
cat <ledger>
```

Reconcile: a merged PR marks its task `landed`; an open draft with a blocked note
marks it `blocked`. Then pick the first `todo` task, in plan order, whose deps are all
`landed`. If none: go to *Finish*.

## One task per iteration

### 1. Branch

```sh
git switch -c land/<slug>-t<N> main
```

Name the branch after the task; the git log outlives the agent.

### 2. Dispatch the inner loop

Resolve the SDD workflow by literal path, pinned to the version this skill was written
against, and fail loud if it is missing:

```sh
P="$HOME/.claude/plugins/cache/jasonm4130-claude-skills/subagent-driven-development/0.12.0/workflows/sdd.mjs"
[ -f "$P" ] && echo "$P" || echo "MISSING: subagent-driven-development 0.12.0 — run /plugin marketplace update jasonm4130-claude-skills"
```

`MISSING` is a stop, not a glob for another version.

```
Workflow({ scriptPath: "<resolved sdd.mjs>", args: {
  planPath: "<abs plan path>",
  workdir: "<repo root>",
  pluginDir: "<parent of workflows/>",
  globalConstraints: "<plan's Global Constraints> + <the unattended constraints below>",
  mergeBase: "<git rev-parse main>",
  branchTip: "<git rev-parse HEAD>",
  tasks: [ { n: <N>, title: "<title>", tier: "opus", effort: "<low|medium|high>", deps: [] } ],
  testCmd: "<check command>",
  limits: { fixRounds: 2, escalateAttempts: 1, maxParallel: 1, fableEscalation: false }
}})
```

One task in the list. Tier by the SDD table (mechanical → `low`, integration →
`medium`, judgment → `high`). `fableEscalation: false` keeps the cost ceiling
predictable; set it true only when the human asked for it.

**Unattended constraints**, appended verbatim to `globalConstraints`:

```
Authorized scope: only the files this task lists. Anything else you notice goes in the
commit body under "Out of scope, noticed" and stays unchanged.
Tests are read-only. A test that seems wrong blocks the task: report BLOCKED with the
test name and why, do not edit or delete it.
Docs in the same commit: update every doc that describes behaviour this task changes.
If none does, the commit body carries "docs-sync:ack" and a one-line reason.
Commit messages end with the session link the harness supplies.
```

### 3. Verify the returned head yourself

The workflow's `verified` flags come from an agent. You have Bash.

```sh
git rev-parse --verify <result.head>^{commit} && git rev-parse HEAD
<check command>
```

Quote the check command's last line. `halted` non-null, a head that is not `HEAD`, or
a red check → the task is `blocked`; go to *Record and move on*.

### 4. Push and open the pull request

```sh
git push -u origin land/<slug>-t<N>
gh pr create --title "<task title>" --body-file - <<'EOF'
Task <N> of <plan-path>, landed unattended.

<two lines: what changed, what verified it — quote the check's last line>

Out of scope, noticed: <from the commit bodies, or "nothing">

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

Add the ledger row (`in-progress`, branch, PR number) in a second commit on the same
branch and push it.

### 5. Wait for CI, then merge through the repo's gate

Run the merge command. A repo script that waits and merges is the whole step:

```sh
./merge-pr.sh
```

If the merge command does not wait, watch first:

```sh
gh pr checks <n> --watch --fail-fast
```

Use `Monitor` for the watch when it is available; it streams instead of polling.

**Red CI:** pull the failing log (`gh run view <run-id> --log-failed`), dispatch **one**
fix: a `worker` agent with an explicit `model`, the task brief, the log, and the same
unattended constraints. Push, watch again. Red a second time → `blocked`: mark the PR
draft (`gh pr ready --undo <n>`), put the last 40 log lines in a PR comment, and move on.

**A check that never registers** (the merge script reports missing checks) is
infrastructure, not the task. Retry the wait once after 2 minutes; then stop the whole
run and say so.

### 6. Record and move on

Landed: `git switch main && git pull --ff-only`, confirm the merge commit is on main,
update the ledger row to `landed` in the next task's branch. Blocked: the draft PR
carries the row; every task depending on it becomes `skipped`. Then the next iteration.

## Stop rules — stop the run, not just the task

- Two consecutive `blocked` tasks. Something upstream is wrong; more iterations spend
  money on the same wall.
- `--max-tasks` reached.
- Any gate `deny` that repeats for the same reason after one fix attempt.
- The merge command exits non-zero for a reason other than a red check.
- A permission denial: in `--permission-prompts none` that is the host telling you the
  action was outside what was authorized. Do not find another route to the same action.

## Finish

Final message, standing on its own for a reader with no transcript:

- Landed: task numbers and PR numbers.
- Blocked or skipped: task, reason in one line, where the log is.
- Out of scope, noticed: merged from the PR bodies.
- The next runnable step, if any.

Then, in an interactive session, offer `handoff:handoff`. Never mark a task landed you
did not watch merge.

## Rationalizations this skill exists to refuse

| Thought | Answer |
| --- | --- |
| "The test is clearly wrong, I'll fix it." | The test is the oracle. Block the task and say why. |
| "CI is flaky, I'll merge with `--admin`." | `--admin` is the bypass the gate exists to stop. Block. |
| "I can answer this open question myself." | A decision made unattended is a decision nobody approved. Refuse at preflight. |
| "Two tasks are small, I'll batch them in one PR." | One task per PR is what makes a blocked task revertible alone. |
| "The plan didn't mention this file but the fix needs it." | Out of scope, noticed. Block if the task cannot land without it. |
| "Progress has been made, I'll call it done." | Status comes from `gh pr view`, not from how the transcript reads. |

## Quiet verifier

A check that prints thousands of lines on success eats the context it protects. The
pattern three practitioner groups arrived at independently — silent on pass, full log
on fail — as a shell wrapper the plan can name as its `Verify:` command:

```sh
#!/usr/bin/env bash
# scripts/check — one line on success, the full log on failure.
set -uo pipefail
log=$(mktemp)
run() { if "$@" >"$log" 2>&1; then echo "✓ $*"; else echo "✗ $*"; cat "$log"; exit 1; fi; }
run cargo fmt --check
run cargo clippy --all-targets -- -D warnings
run cargo test --all-targets
echo "CHECK OK"
```

Adapt the commands to the repo. `CHECK OK` is the line the ledger quotes.
