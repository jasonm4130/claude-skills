---
name: land
description: Use when a human-approved plan with "# Task N" headings is committed on main and the user wants every task landed without watching — "land the plan", "run this unattended", "/landing-loop:land <plan>". Preflights the repo, then hands the plan to a deterministic Workflow that lands one task at a time as its own pull request, CI green as the only gate, merged through the repo's merge command, ledger in git. Do NOT use to write or approve a plan (brainstorming, writing-plans, adr do that), for a plan with open questions, on a repo with no CI gate, or for ad-hoc edits with no plan.
---

# Land a plan unattended

A human approved the plan; that approval is the only human gate in this run, and it
happened before you started. After it, every gate is a machine: the check command, the
pull request's CI, the repo's merge command. **You** (the controller) do the preflight,
enumerate the tasks, launch the loop, and write the final report. The loop itself is
`workflows/land.mjs` — control flow as code, so it cannot skip a gate, merge by another
route, or call a task done that GitHub says is open. Per task it runs
`subagent-driven-development`'s workflow as a child for implement → review → fix.

## Invocation

```
/landing-loop:land <plan-path> [--max-tasks N] [--skeptics N] [--dry-run]
```

For a run nobody is watching, from a terminal that stays open:

```sh
claude --permission-mode auto --permission-prompts none -p "/goal Every task in <plan-path> is landed or blocked, shown by the ledger beside it and by gh pr list; stop after 40 turns. Get there with /landing-loop:land <plan-path>"
```

`--permission-prompts none` (v2.1.259+) denies anything that would have prompted instead
of hanging. `/goal` adds a judge that is not you. Without a bound in the condition the run
has no ceiling but the harness's own.

## Preflight — every line must hold, or refuse and list every failure at once

Print each check with its result.

1. **Plan.** Committed on `main` (its own pull request is where the human approved it),
   parses into `# Task N` / `## Task N` headings, and its `## Open Questions / Unresolved
   Assumptions` section is empty or absent. An open question is a decision; unattended
   runs execute decisions, they do not make them.
2. **Scope per task.** Every task lists the files it may touch (`**Files:**`). Without
   that line a task has no authorized scope, and overeager rates go from 0% to 17% on
   that omission alone (arXiv 2607.05743).
3. **Check command.** The plan's `## Global Constraints` names a `Verify:` command, or
   the repo has one canonical suite command you can name. Its last line on success must
   be short; a verifier that prints thousands of lines on pass gets wrapped first (see
   *Quiet verifier*).
4. **Merge command, and it is allow-listed.** Preferred: a repo script that waits for
   CI and merges (`./merge-pr.sh {pr}`). Otherwise `gh pr merge {pr} --auto --merge`,
   only if `gh api repos/{owner}/{repo}/branches/main/protection` returns required
   checks. Neither → refuse: there is no CI gate to land through. Then confirm the
   command appears in `permissions.allow` of the repo's `.claude/settings.json` (e.g.
   `Bash(./merge-pr.sh:*)`). Auto mode's classifier denied `./merge-pr.sh` on
   2026-09-04 with no rule in place; an allow rule bypasses the classifier, a denial
   mid-run halts the loop.
5. **Tree.** On `main`, `git status --porcelain` empty, `git fetch` succeeds, `main`
   equals `origin/main`.
6. **Session.** Permission mode is `auto`, or the run was launched with
   `--permission-prompts none`. In `default` mode the first `gh pr create` hangs on a
   prompt nobody answers.
7. **Inner loop installed.** Resolve the SDD workflow by literal path, pinned to the
   version this skill was written against:

   ```sh
   S="$HOME/.claude/plugins/cache/jasonm4130-claude-skills/subagent-driven-development/0.12.0/workflows/sdd.mjs"
   [ -f "$S" ] && echo "$S" || echo "MISSING: subagent-driven-development 0.12.0 — run /plugin marketplace update jasonm4130-claude-skills"
   ```

   `MISSING` is a stop, not a glob for another version.

`--dry-run` stops here and prints the task order with tiers.

## Enumerate the tasks

Turn the plan into `{ n, title, tier, effort, deps }` — ids as the plan writes them,
never renumbered. Tier by the same table SDD uses: 1–2 files and a complete spec →
`opus`/`low`; multi-file or integration → `opus`/`medium`; design judgment →
`opus`/`high`. `deps` is honest: mark one wherever task B touches files task A changes.
The loop lands tasks one at a time in dependency order, so a dep costs nothing but
ordering; a missing dep costs a red merge.

`slug` is the plan file's name without date and extension, lowercase, hyphens only
(`2026-09-04-landing-loop-bootstrap.md` → `landing-loop-bootstrap`). Branches are
`land/<slug>-t<N>`.

## Launch the loop

Resolve this plugin's own workflow the same way, pinned to this version:

```sh
L="$HOME/.claude/plugins/cache/jasonm4130-claude-skills/landing-loop/0.1.0/workflows/land.mjs"
[ -f "$L" ] && echo "$L" || echo "MISSING: landing-loop 0.1.0 — run /plugin marketplace update jasonm4130-claude-skills"
```

```
Workflow({ scriptPath: "<resolved land.mjs>", args: {
  planPath: "<abs plan path>",
  workdir: "<repo root>",
  slug: "<slug>",
  checkCmd: "<check command>",
  mergeCmd: "./merge-pr.sh {pr}",
  sddPath: "<resolved sdd.mjs>",
  sddPluginDir: "<parent of sdd.mjs's workflows/>",
  globalConstraints: "<plan's Global Constraints, verbatim>",
  sessionLink: "<the Claude-Session trailer the harness gave you, or omit>",
  approvedOn: "<today, ISO date>",
  tasks: [ { n: 1, title: "...", tier: "opus", effort: "medium", deps: [] }, ... ],
  limits: { fixRounds: 1, skeptics: 0, maxTasks: 0, consecutiveBlocked: 2, sddFableEscalation: false }
}})
```

`mergeCmd` must contain `{pr}`. `limits.skeptics: 3` adds an adversarial panel after the
local check — three independent agents told to refute completeness, majority refutes →
blocked; worth it for tasks whose acceptance is hard to test. `maxTasks: 0` is unlimited.
`sddFableEscalation` stays off unless the human asked for it; it is the one cost with no
ceiling.

The Workflow runs in the background and notifies you when it returns. Do not poll it and
do not start other work in the repo while it runs; the tree is its.

## What the loop does per task, so you can read its log

Orient (fresh `main`, status reconciled from `gh pr list`, branch) → Implement (SDD
child run, one task) → Verify (head is HEAD, tree clean, check command's last line) →
Ship (ledger row committed, push, PR) → Gate (merge command; on a red check one fix
round, then the PR is parked as a draft with the log in a comment). Two consecutive
blocked tasks halt the run; an infrastructure failure at the gate halts it; a shipped PR
from an earlier run resumes at the gate.

## On return: verify, then report

The return is `{ landed, blocked, skipped, todo, halted, ledger, meta }`. Before
reporting, confirm the two claims that matter with real commands:

```sh
git switch main && git pull --ff-only && git log --oneline -<landed count>
gh pr list --search "head:land/<slug>-" --state all
```

Every `landed` entry has a merged PR; every `blocked` one is an open draft. If either
disagrees with the return, say so and stop — a loop reporting landed while GitHub says
open is exactly what this check exists for.

Then the final message, standing on its own for a reader with no transcript:

- Landed: task numbers with PR numbers.
- Blocked or skipped: task, reason in one line, where the log is (the PR comment).
- Halted: the reason, and the next runnable step.
- Out of scope, noticed: merged from the PR bodies and commit messages.

In an interactive session, offer `handoff:handoff`. Never mark a task landed you did not
see merged.

## Rationalizations this skill exists to refuse

| Thought | Answer |
| --- | --- |
| "The test is clearly wrong, I'll fix it." | The test is the oracle. The loop blocks the task and says why. |
| "CI is flaky, I'll merge with `--admin`." | `--admin` is the bypass the gate exists to stop. |
| "I can answer this open question myself." | A decision made unattended is a decision nobody approved. Refuse at preflight. |
| "Two tasks are small, I'll batch them in one PR." | One task per PR is what makes a blocked task revertible alone. |
| "The plan didn't mention this file but the fix needs it." | Out of scope, noticed. Blocked if the task cannot land without it. |
| "Progress has been made, I'll call it done." | Status comes from `gh pr view`, not from how the transcript reads. |

## Quiet verifier

A check that prints thousands of lines on success eats the context it protects. The
pattern three practitioner groups arrived at independently — silent on pass, full log on
fail — as a shell wrapper the plan can name as its `Verify:` command:

```sh
#!/usr/bin/env bash
# scripts/check — one line per step on success, the full log on failure.
set -uo pipefail
log=$(mktemp)
run() { if "$@" >"$log" 2>&1; then echo "✓ $*"; else echo "✗ $*"; cat "$log"; exit 1; fi; }
run cargo fmt --check
run cargo clippy --all-targets -- -D warnings
run cargo test --all-targets
echo "CHECK OK"
```

Adapt the commands to the repo. `CHECK OK` is the line the ledger and the PR body quote.
