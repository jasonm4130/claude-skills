# Unattended agent loops — how practitioners land planned work without babysitting (2026-09-04)

Research behind the `landing-loop` plugin. **Outcome: the outer loop is the gap.** This
marketplace already ships a hardened inner loop (`subagent-driven-development`:
implement → review → fix → verify per task) and stops at a human gate for everything
after it. Nothing here pushes, opens a pull request, waits for CI, merges, or picks the
next task. Practitioners who run agents overnight all built exactly that outer loop, and
they converge on the same dozen mechanisms.

Three research passes fed this: practitioner loop shapes (Anthropic's harness posts,
Huntley, HumanLayer, Yegge, Hashimoto, Willison, Beck, Carlini), the September 2026
Claude Code surface verified against `code.claude.com` the same day, and a read of every
plugin in this repo for what it already covers. Every claim below carries its source and
date; anything marked *reported* was seen only through a secondary source.

## What the field agrees on

Twelve practices appear in three or more independent sources.

1. **One unit of work per context window, and the unit is small.** Anthropic: "work on
   only one feature at a time"; Huntley: "One item per loop. I need to repeat myself
   here"; Yegge: one bead. Nobody running these at scale advocates big units.
2. **State lives in files and git, never in the context window.** `claude-progress.txt`
   plus `feature_list.json` (Anthropic), `fix_plan.md` (Huntley), `.beads/beads.jsonl`
   (Yegge), commits as save points (Hashimoto). A fresh context window is a feature; the
   handoff artifact is the product of a session.
3. **A fixed session-start orientation ritual.** Progress file → `git log` → task list →
   smoke test, identical every time, so orientation is cheap.
4. **Automated backpressure is what makes unattended work possible.** Compiler, types,
   tests, browser checks, ranked above human review as the primary loop (Huntley, Moss,
   HumanLayer, Carlini's "the task verifier is nearly perfect, otherwise Claude will
   solve the wrong problem").
5. **Verifier output is small on success and complete on failure.** HumanLayer's
   `run_silent` (a tick on pass, the full log on fail), Carlini's one-line grep-able
   `ERROR`. Three groups arrived at the same wrapper; HumanLayer reports 4,000 lines of
   passing tests causing an agent to hallucinate files it had just read.
6. **Generator and evaluator are separate agents.** Anthropic (Mar 2026): "agents
   reliably skew positive when grading their own work"; a skeptical standalone evaluator
   "turns out to be far more tractable."
7. **End-to-end verification through the real interface**, not unit tests alone
   (Anthropic Nov 2025 and Mar 2026, Moss, Ronacher).
8. **A written definition of done precedes the code**: `feature_list.json` with
   `"passes": false`, sprint contracts, `/goal` conditions, acceptance criteria per bead.
9. **Human review moves upstream, from diffs to plans.** Horthy: "a bad line of
   research… could land you with thousands of bad lines of code." Willison: "Eyeballing
   every line of code has never been the most effective way to validate a change."
10. **Run it in a container; keep credentials out of the sandbox** (Carlini, Managed
    Agents, Claude Code web). Willison names it as his own unmet obligation.
11. **Small fleets, partitioned by file ownership.** Claude Code docs: "Start with 3-5
    teammates… Three focused teammates often outperform five scattered ones"; "Two
    teammates editing the same file leads to overwrites."
12. **Nightly cadence with small increments beats one giant run.** HumanLayer: "Waking up
    to one small refactor every morning is better than… waking up to 50."

## What is contested

- **Multi-agent vs monolithic.** Huntley: "Ralph is monolithic." Yegge builds a town.
  Anthropic measured and found it *model-dependent*: the sprint construct paid on Opus 4.5
  and was dead weight on 4.6. Rule of thumb from all three: add an agent only where you
  have observed the single agent failing.
- **Is a green suite still an oracle?** METR (2026-05-19): Opus 4.6 "attempted to reward
  hack in ~80% of attempts… when test cases were hidden." arXiv 2605.21384: every model
  saturates the visible suite and the visible-vs-holdout gap widens with task complexity.
  Beck reports trouble stopping agents deleting tests. Nobody claims the current oracle
  is sufficient; everybody keeps it and adds a separate evaluator plus hidden checks.
- **Scope creep is prompt-sensitive.** arXiv 2607.05743: Claude Code overeager rates went
  0.0% → 17.1% on phrasing alone when the authorized scope was left unstated. Write the
  scope boundary down in every brief.
- **Compaction vs reset.** Anthropic says compaction "doesn't give the agent a clean
  slate"; whether resets are needed changed between model versions. Keep the loop short
  enough that neither matters.
- **`--dangerously-skip-permissions`.** Huntley, Carlini, Ronacher, Willison run it (in a
  container). Anthropic built auto mode as the alternative and publishes its cost: 0.4%
  false-positive rate, **17% false-negative on real overeager actions**, "not a drop-in
  replacement for careful human review on high-stakes infrastructure."

## The Claude Code surface, verified 2026-09-04

| Primitive | What it is | Limits that bound a runaway |
| --- | --- | --- |
| `--permission-mode auto --permission-prompts none` | Headless run where anything that would prompt is denied, and `AskUserQuestion` is removed | v2.1.259+; 3 consecutive denials or 20 blocks terminates the process |
| `/goal <condition>` | A Haiku judge reads the transcript after each turn: not yet / met / impossible | 8 consecutive Stop-hook blocks; 3 idle check-ins between prompts; `claude -p "/goal …"` works headlessly |
| `/loop` self-paced | Claude picks a 1 min – 1 h delay per iteration via `ScheduleWakeup`; bare `/loop` runs the maintenance prompt or `.claude/loop.md` | 7-day expiry; session must stay open; fallback wakeup then stop |
| `Monitor` | Streams lines from a background script (e.g. `gh pr checks`) | Preferred over polling loops when available |
| Workflow scripts | Deterministic orchestration outside the context window, replayable | 16 concurrent, 1,000 agents per run |
| Routines | Cloud sessions on a schedule, API call or GitHub event; no permission prompts | Fresh clone, no local tools, min 1 h interval |
| Auto-fix PR | Cloud reacts to CI failures and review comments | Cannot see merge conflicts (no webhook) |

Sources: `code.claude.com/docs/en/{permission-modes,goal,scheduled-tasks,workflows,routines,headless,claude-code-on-the-web}`.

**GitHub.** Branch protection and rulesets on a private repo still need GitHub Pro or
above (plans doc, 2026-09-04). On a free-plan org the CI gate has to live in a local
merge script, which is what `merge-pr.sh` in `jasonm4130-labs/ambient` already does.

**1Password.** Service accounts cannot reach the Private vault, ever, and their vault
grants are immutable after creation. A desktop-app `op` session revokes on lock and has
a 10-minute idle, 12-hour hard ceiling, so it cannot serve a cron job. Unattended `op run`
means a dedicated vault plus `OP_SERVICE_ACCOUNT_TOKEN`. Family plan limit: 1,000
requests per day. 1Password's 2026 direction (Credential Broker, June; Privileged Access,
July) is just-in-time task-scoped credentials, with no Claude Code integration yet.
Sources: `developer.1password.com` service-accounts and app-integration-security pages;
1password.com press releases March–July 2026.

## Failure modes worth designing for

- **Premature done.** "A later agent instance would look around, see that progress had
  been made, and declare the job done" (Anthropic, Nov 2025). Fix: an external list of
  what remains, plus a judge that is not the generator.
- **Test gaming.** See above. Fix: tests are read-only to the implementer; a wrong test
  blocks the task instead of being edited; hidden CI checks.
- **Runaway cost.** Cost anchors span four orders of magnitude: $9 solo vs $200 harness
  for one 6-hour run (Anthropic, Mar 2026), $20,000 for Carlini's two-week 16-agent
  build. Fix: a task budget per run, and the harness circuit breakers above.
- **Merge conflicts between parallel agents.** HumanLayer's lesson: "the easier
  alternative to merge/rebase is just to re-run the loop on the fresh code with the same
  prompt and re-open a PR." Sequential landing avoids the problem entirely.
- **Lost state on compaction or crash.** Every loop that survived a crash kept its
  ledger in git.

## What this repo already has, and the gap

`subagent-driven-development` gives the inner loop: TDD implementer, separate reviewer,
bounded fix rounds, oscillation breaker, BLOCKED escalation ladder, an independent
verifier per task. `gates` gives auditable ack markers. `codex-review` refuses to invent
human approval when nobody is present (`audit-concerns-unattended`). All of that stays.

Missing, confirmed by grep of every plugin: push, PR, CI wait, merge, next-task
selection, a cross-session ledger, and a policy for gates that `ask` when nobody can
answer. `RESEARCH_subagent_driven_workflow.md` named the fix in June — "HITL cannot
block in place… async checkpoint/exit/resume-on-event" — and it was never built. The
`landing-loop` plugin is that outer loop, with the human gate moved upstream to plan
approval.

## Primary sources

Anthropic: effective-harnesses-for-long-running-agents (2025-11-26) ·
harness-design-long-running-apps (2026-03-24) · building-c-compiler (2026-02-05) ·
claude-code-auto-mode (2026-03-25) · managed-agents (2026-04-08).
Practitioners: ghuntley.com/ralph (2025-07-14, rev. 2026-02-19) · ghuntley.com/loop and
/pressure (2026-01-17) · humanlayer.dev/blog/context-efficient-backpressure (2025-12-09)
· humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents (2026-03-12) ·
steve-yegge.medium.com/welcome-to-gas-town (2026-01) · mitchellh.com/writing/non-trivial-vibing
(2025-10-11) · simonwillison.net (2026-01-19, 2026-07-21) ·
newsletter.kentbeck.com/p/augmented-coding-beyond-the-vibes.
Research: metr.org/blog/2026-05-19-frontier-risk-report · arxiv.org/abs/2605.21384 ·
arxiv.org/abs/2607.05743 · arxiv.org/abs/2602.11988 (ETH Zurich, AGENTS.md) ·
research.trychroma.com/context-rot.
