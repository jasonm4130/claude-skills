# Nightwatch redesign

2026-09-05. Produced by a 31-agent research-and-design workflow (Sonnet 5 readers, researchers, designers and critics with the Opus 5 advisor; Opus 5 synthesis and fact-check edit), then reshaped by Jason around Clare Liguori's "frontier developer" habits. Every claim carries its source. Every negative names the page that proves it. Supersedes the loop sections of `2026-09-05-operator-review.md` §7 where they conflict.

## 1. The decision

**Decision.** Plan in a Claude Code session, then let it cook. One engine: a Workflow script (`nightwatch.mjs`) driven by headless `claude -p`, running in a Docker container on the laptop with its own clone, launched from the planning session into a herdr pane. One spec per outcome, one long-lived branch per outcome, verification local, GitHub CI as the final required check only. The same container runs unchanged on Brok when a night needs the lid closed; Brok is a later step, not the first one.

**Shape, from Liguori's "frontier developer" habits (AI Engineer World's Fair, youtube.com/watch?v=pqlWNihgdjI, posted 2026-08-28; Amazon Stores pilot of 50 teams, median 4.5x deployment velocity for the half that changed how they worked):** make intent explicit by iterating on a document, not on code; feed the agent what it needs and how it self-validates, then leave it for hours; shift testing left so the loop is local and fast; run several in parallel; and after every miss, ask what the agent context lacked. Nightwatch's planning session is the first habit, the spec's acceptance command is the second, the Docker verify phase is the third, herdr workspaces are the fourth, `decisions.jsonl` feeding CLAUDE.md is the fifth.

**Alternatives rejected.** Cloud Routines as the engine — `workflows.md` ("Turn workflows off") enumerates the surfaces that run the Workflow tool as CLI, Desktop, IDE extensions, `claude -p`, Agent SDK; cloud sessions and routines are absent, and `routines.md` never names workflows anywhere. Routines for verification — `routines.md` states a routine runs on Anthropic cloud infrastructure with no local access, so Brok and the laptop's Docker are unreachable from it. Keeping `land.sh`'s Task-N walk — digest §3: the loop mechanically reads only a numeric heading and one text block, so the format's cost buys nothing the redesign needs.

**Evidence.** `claude -p` is the *only* surface that is both confirmed to run the Workflow tool (workflows.md, fetched 2026-09-05) and has local shell access (routines.md, same date). Jason asked for unattended-while-he-works *and* "just get it all local for verification" on "a really powerful local machine": a container with its own clone on the M5 Max is the intersection of those two. Brok has no GPU and an Unraid CPU, so ambient's Rust builds verify slower there; what removes the daytime conflict is the separate clone, not the separate machine.

**Reversibility.** High — `land.sh` stays on disk until migration step 9, so reverting is `git revert` plus re-enabling the launchd plist.

**Review date.** 2026-10-05, after three unattended nights and a 30-day revert window on whatever lands.

## 2. The four pain points

**1. Outcomes, not tasks.** The unit becomes one spec: Outcome, Acceptance (a runnable command), Non-goals, optional Context. The orchestrator phase (Opus 5) decides each next bounded unit at runtime against that fixed acceptance criterion and writes its brief to the branch and the PR body, so the decomposition is recorded even though nobody wrote it up front. *Evidence it works:* digest §3's mechanical audit — Files/Interfaces/Step-1-5/Global-Constraints/"Open Questions must be empty" appear zero times in `land.sh`; they were never load-bearing. *Counter-evidence:* Devin's retrospective (cognition.com, 2025-11-14) shows merge rate rising 34%→67% as requirements got *clearer*; Anthropic's field data (arXiv 2512.04123) has 16/20 production cases preferring structured workflows. Answered by keeping the acceptance command human-written and non-negotiable, and the phase sequence in a reviewable script. No controlled study isolates a bare PRD plus autonomy (digest §6) — this is a bet with a short revert.

**2. Daytime conflict.** The run lives in its own clone, in its own container, on the laptop (Brok later). Not a scheduling fix and not a lock fix: there is no shared checkout to collide on, and all three measured collisions require one (plan read from the primary checkout, `land.sh:30-34,90,101-104`; `ensure_worktree` hard-resetting in-flight work, `land.sh:183`, confirmed at HEAD this session; lock keyed on repo basename, `land.sh:54-55`). *Also fixed, because the container does not fix it:* both PreToolUse guards sit on the bare `Bash` matcher in `.claude/settings.json` and so deny Jason's own daytime commands including the kill-switch flip — they gain a `cwd` check (hooks receive `cwd`, and it tracks the worktree — `worktrees.md`), failing closed when cwd is unresolvable, the opposite of `no-route-around-ci.mjs`'s fail-open today.

**3. Ceremony and CI cost.** Ceremony: deleted, per §3 above — the three-field spec replaces the whole `task-brief`/template apparatus. CI cost, split into two claims that were conflated in every proposal: (a) the inner iterate-fix-reverify loop moves into Docker on the laptop, running the repo's *actual* `ci.yml` commands rather than a reinvention of them — this is where the minutes go, and it needs no runner registration; (b) moving the *final required check* off billed minutes needs a self-hosted runner, which is safe on **ambient only** (`gh repo view --json visibility`, this session: ambient PRIVATE, claude-skills PUBLIC) — GitHub's secure-use guidance warns that any fork PR executes on a self-hosted runner attached to a public repo, so claude-skills keeps GitHub-hosted runners for its gate.

**4. Trust and triage.** Three mechanisms, honestly scoped: this changes *what* Jason reads, not how much. (a) The PR body is assembled by the script from literal command output — the acceptance command, its exit code, its raw stdout — never the executor's summary. (b) A cap of 2–3 open Nightwatch PRs: relevance-related issues are the largest cause of agentic-PR rejection at 24.8% — Table 1's "Relevance of the fix" category, Inactivity 17.3% + Superseded 5.9% + Low priority 1.0% + Architecture 0.3% + Test PR 0.3%, 76/306 — against 5.6% for incorrect-fix rejections (arXiv 2606.13468, Table 1); the staleness-only subset (Inactivity + Superseded) is 23.2%, 71/306. So a queue that outruns triage destroys its own work. (c) `decisions.jsonl` records every merge, block, override and dismissal by change-category — the raw material for graduating clean categories to lighter review (arXiv 2606.01969) and for the dismissal-feedback cadence that took one practitioner's reviewer false-positive rate 40%→12% over 8 weeks (dev.to/thegdsks, 2026-04-13). What none of it fixes: wer-task4 was Jason merging over a standing REFUTE four minutes later (`gh pr view 43`); no label gates a human override, and this design does not pretend to add one.

## 3. Target architecture

**Components.** `nightwatch.mjs`, a Workflow script committed to each repo, phases: **Reconcile** (an agent runs `git`/`gh` and reports real branch/PR/commit state) → **Plan next unit** (Opus 5, high effort, against the spec's acceptance criterion and the branch log) → **Implement** (`agent()` with the project-scoped `worker` definition: Sonnet 5 + Opus advisor, worktree-isolated, commits, never merges) → **Verify** (runs the repo's real CI commands in Docker) → **Narrow eval** (one scoped call against a repo-seeded checklist, flagging correctness-affecting gaps only — `best-practices.md`'s stated fix for reviewer over-flagging, in place of raising a budget number) → **Publish** (push, open or update the PR, write the body from captured output).

**Where each runs.** All of it in one container on the laptop (`git`, `node`, `gh`, `claude`, the repo's toolchain), with its own clone under a Nightwatch directory, never the working checkout. The container's stdout is a herdr pane in a `nightwatch` workspace, so the sidebar shows each run as working, blocked or done and the laptop can be closed to the planning session without stopping anything (herdr 0.8.2, installed 2026-09-05). Brok can host the same image later (`git`, `node`, Docker 29.5.3 present; `gh` and `claude` absent, verified by SSH this session). GitHub Actions runs once per push, as the required check.

**Shared state.** GitHub only — issue, branch, PR — plus a small `run.json` on Brok (issue number, container id, start time). **Hard rule: every start and every resume begins with Reconcile; no cached agent return is ever state.** Workflow resume replays cached returns and reruns the failed agent plus everything after it, never consulting the filesystem (`workflows.md`, "Resume after a pause").

**Unit identity.** One branch per issue, `nightwatch/<issue-number>`; each runtime-decided unit is a commit on it. The branch log *is* the record of what is done — digest §3's "stable, uniquely matchable id" comes from the issue number, no sub-unit ids invented, and a fresh Reconcile after a mid-unit kill cannot replan a different unit than the one in flight.

**How a run starts.** In a Claude Code session, Jason and Fable iterate on the spec until the acceptance command is agreed; that conversation is the planning ceremony, and it is about a document, not code (Liguori, habit four). Then `nightwatch run <spec>`: the session commits the spec to the branch, starts the container, and points a herdr pane at it. That is "run whenever I want": any hour, several at once, each in its own clone. A `nightwatch` GitHub issue with the same three fields is a second entry point for a phone-filed outcome that Fable plans from at the next session; there is no watcher or cron in the first version.

**How it proceeds and ends.** The script loops Plan→Implement→Verify→Eval to one of four named terminal states — **PASS** (PR ready), **PARTIAL** (draft PR, `land:partial`, what remains named), **BLOCKED** (draft PR, `land:blocked`, the ambiguity named), **FAILED** (no PR, an issue comment and a journal entry). Four states rather than one completion string is the fix for the Ralph Wiggum predicate's named limitation (ghuntley.com/ralph, 2025-07-14). One outcome ending does not touch any other — `land.sh:72,389` calls `stop()`, which exits the whole night.

**How it is killed.** At the desk: `docker kill` or closing the herdr pane. From a phone: Jason flips the existing repo variable from the GitHub mobile app; a sidecar loop started by `nightwatch run` polls it every 30 seconds and issues `docker kill` on the run container. That is a genuine hard kill mid-phase, which no current path has: `land.sh` polls DEADLINE only between tasks (`land.sh:47,393,401`), and lock cleanup is an `EXIT` trap that does not fire on SIGKILL (`land.sh:363-370`).

**Rejected mechanisms, one line each.** *Cloud Routines as engine or verifier* — see §1. *`nektos/act`* — Linux-only emulation with thinner images, when the repo's real CI commands already run in Docker on Brok. *Dagger* — a new dependency for a problem `docker run` solves. *Three-refuter adversarial vote* — `best-practices.md` fixes over-flagging by scoping the reviewer's prompt, not by adding reviewers. *Terra/codex inside the unattended loop* — `codex exec` reads stdin and hangs indistinguishably from a long review without `< /dev/null` (confirmed against codex-cli 0.151.0 this session), bills to a separate surface, and has no unattended proof; it stays a daytime pass. *`--setting-sources user,project`* — fixes agent resolution by loading every global setting and hook into an unattended process. *Local skeptic inference* — already rejected (`docs/research/2026-09-05-local-skeptic-inference.md`).

## 4. What Jason writes before a run

One spec, three required fields, written with Fable in the planning session and committed to the branch as `docs/specs/<slug>.md`; a phone-filed issue carries the same fields. Anything the session learned that the run needs (which files, which conventions, which prior attempt failed) goes under a fourth, optional Context heading, because the run starts with none of the conversation. Real example, verified at HEAD today (`land.sh:233` cats `skeptic-$round.md` inside `pr_body()`; line 329 calls it on the double-empty-verdict block path, while line 334 shows the retry transcript exists and is read elsewhere):

```markdown
Title: PR bodies show the transcript that decided the block
Labels: nightwatch

## Outcome
When a task blocks because the skeptic returned no verdict twice, the PR body
shows the retry transcript that actually decided the block, not the first,
empty-verdict one. Every other block path is unchanged.

## Acceptance
node --test plugins/nightshift/templates/loop/land.test.mjs
  (add a case: given skeptic-1.md empty and skeptic-1-retry.md non-empty,
   pr_body emits the retry content; given only skeptic-1.md, it emits that)

## Non-goals
Don't touch SKEPTIC_BUDGET semantics or the 200,000-char diff truncation
(land.sh:312,320) — separate issues.
```

No Files, no Interfaces, no Step 1-5, no "Open Questions must be empty".

## 5. Migration, one PR per step

**Keep, unchanged:** branch protection and required checks on `main`; both guards' intent; GitHub PR review; the repo-variable kill switch; the journal's location and format.

1. **Fix `pr_body()`** to pass the deciding transcript file (`land.sh:225-233,329`). One line, fixes a live bug regardless of what else ships.
2. **Rescope both guards** on `cwd`, failing closed when cwd is unresolvable — stops them denying Jason's own daytime commands.
3. **Commit `.claude/agents/worker.md`** at project scope (**unverified against the docs — empirically observed this session only**: under `--setting-sources project` a dispatch failed "Agent type 'worker' not found" with the definition in `~/.claude/agents` alone, and committing it at project scope fixed the dispatch; `settings-reference.md` documents the settings keys but states no agent-directory discovery precedence for `--setting-sources`, so this is a session observation, not a doc-sourced fact. Settled by re-running the dispatch both ways under `--setting-sources project`, or by a docs page stating the precedence rule), and add `Workflow(nightwatch.mjs)` to the allow rules — headless denies the tool silently under `dontAsk` otherwise (`workflows.md`).
4. **Add the spec template** (`docs/specs/`, three required fields plus optional Context) and the `nightwatch` issue label with the same fields.
5. **Land `nightwatch.mjs`** with the six phases and four terminal states, plus a `--dry-run` that stops after Reconcile. Cycle counters are plain script variables and timestamps arrive through `args`: `Date.now()`, `Math.random()` and no-arg `new Date()` throw inside the script (`workflows.md`).
6. **Build the container image and the `nightwatch run` launcher:** own clone per run, the OAuth credential path (`claude setup-token`, per `authentication.md`), a preflight that aborts if `ANTHROPIC_API_KEY` is set — the documented $1,800-in-two-days stray-key incident is exactly this deployment shape (github.com/anthropics/claude-code/issues/37686) — a herdr pane per run, and the kill-switch sidecar.
7. **Brok as a second host** for the same image, only if nights with the lid closed turn out to matter.
8. **Self-hosted runner on ambient only**, scoped to owner-authored branches; claude-skills keeps GitHub-hosted.
9. **Delete** `land.sh`, `task-brief`, the launchd plist and the plan-format ceremony in `nightshift:plan` — after ambient's seven in-flight `nightshift-*` worktrees are landed or abandoned, or that work is stranded.
10. **Rename** Nightshift → Nightwatch across docs and skills.

## 6. Trust

Earned by: the PR body being literal captured output rather than a model's account of itself; the open-PR cap keeping the queue inside triage capacity; and `decisions.jsonl` accumulating a record per change-category.

Measured monthly by three numbers: **cost per landed, non-reverted PR** (baseline $5.88 — $135.19 over 23 landed, digest §2); **revert rate** at 30 days; **override rate**, PRs merged with an unresolved eval finding, which is 1 today (wer-task4). Cost is deliberately not projected: the one lever with a mechanism behind it is the 27%-of-spend-that-merged-nothing share ($7.88 of $28.87 in a mid-day snapshot), partly recoverable now that a blocked outcome no longer stops the night. Measure after three nights; trust no range before then. Night one cannot report revert rate — the window has not elapsed, and merged-PR count alone says nothing about quality (Microsoft's Feb–Apr 2026 rollout disclaims it explicitly).

## 7. Risks and unverified assumptions

| Open question | What settles it |
|---|---|
| Does headless `claude -p` actually invoke the Workflow tool with the allow rule present? | `claude -p --permission-prompts none "run the workflow at .claude/workflows/hello.mjs"`, then grep the transcript for a Workflow tool call. |
| Does `advisorModel: opus` fire inside a Workflow `agent()` call? | **Settled 2026-09-05:** every Sonnet workflow agent in run wf_161432f3-ac7 carries `advisorModel: claude-opus-5`, and the design agents made one to two `advisor` calls each. The calls are `server_tool_use` blocks, which is why a `tool_use` count reads zero. |
| Is `--max-budget-usd` enforced under subscription OAuth billing? Documented print-mode only (`cli-reference.md`), with no subscription-vs-API-key qualification anywhere (digest §6). | A deliberate overrun run on Brok with a $1 cap. |
| Does the committed `worker.md` drift from `~/.claude/agents/worker.md`? | A CI diff check between the two, or accept the drift explicitly. |
| Does `gh issue list --label nightwatch` distinguish "no work" from "label typo"? It exits 0 and empty for both. | Watcher asserts `gh label list \| grep -q nightwatch` before polling. |
| Does a container on the laptop keep running through sleep, and does the OAuth token reach `claude` inside it? | One overnight run with the lid closed and `claude-stay-awake.sh` active; `docker ps` in the morning. Brok is the fallback if it does not. |
| Can Jason edit a repo variable from the GitHub mobile app? The kill switch depends on it. | Open the repo's Settings → Variables on the phone and change one. |
| Worktree isolation is opt-in per session/subagent (`worktrees.md`: "while a session is isolated in a worktree"), not a blanket property — Reconcile, Verify and Publish must be isolated too or they can touch the primary clone. | Set isolation on every phase, not only Implement; assert `pwd` in each phase's first command. |

## 8. Decisions for Jason

1. Plan in a Claude Code session, then `nightwatch run` launches headless `claude -p` + the Workflow script in a container on the laptop, one clone per run, a herdr pane each? **yes / no**
2. Reject cloud Routines as engine and verifier on the doc evidence above? **yes / no**
3. The spec (Outcome, Acceptance command, Non-goals, optional Context), written in-session and committed to the branch, as the plan artifact; a phone-filed issue with the same fields as the second entry point? **yes / no**
4. One branch per outcome, runtime-decided units as commits, Reconcile-from-git on every start and resume? **yes / no**
5. Four terminal states (PASS/PARTIAL/BLOCKED/FAILED) replacing the single verdict string? **yes / no**
6. Cap concurrent runs and open Nightwatch PRs at 3? **yes / no**
7. Kill: `docker kill` at the desk, repo variable plus a launcher sidecar from the phone? **yes / no**
8. Self-hosted Actions runner on ambient only, deferred until local verification has cut the CI bill and the remainder is still worth it? **yes / no**
9. Keep Terra/codex as a daytime pass, out of the unattended loop? **yes / no**
10. Ship steps 1–3 (pr_body fix, guard rescope, worker.md + Workflow allow rule) before anything else? **yes / no**
11. Run the three remaining settling checks in §7 (Workflow under headless `claude -p`, budget cap under subscription billing, container through sleep) before step 5? **yes / no**
12. Track cost per landed non-reverted PR, revert rate and override rate monthly, first report after three runs? **yes / no**
13. Delete `land.sh` and the plan ceremony only after ambient's seven in-flight worktrees are drained? **yes / no**
14. After every BLOCKED or FAILED run, the next planning session starts by asking what the repo's agent context lacked, and fixes CLAUDE.md, a skill or an error message before re-running? **yes / no**

## 9. Decisions, 2026-09-05

Jason confirmed all fourteen as listed in §8. Two were reshaped from the workflow's draft before confirmation: the engine host is the laptop first with Brok as a later step, and the run is launched from a planning session rather than by a watcher polling issues. Next: migration steps 1 to 3, then the three settling checks in §7, then `nightwatch.mjs`.
