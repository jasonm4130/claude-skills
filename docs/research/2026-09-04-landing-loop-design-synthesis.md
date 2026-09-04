# Landing loop design review (2026-09-04) — judge panel synthesis

Output of a 12-agent Workflow: four independent designs (Ralph-minimal, harness-as-code, product-native, git-native), three judges (control, simplicity, landing), one synthesis. Companion to [2026-09-04-unattended-agent-loops-research.md](2026-09-04-unattended-agent-loops-research.md). Claims marked verified were re-run against the working tree; the open questions in §7 were not.

# Recommended design for the unattended landing loop — Nightshift

## 1. Recommendation

**Build Night Ralph's body and Merge Machine's gate.** A ~90-line bash driver on the Mac picks one
task, runs one budget-capped `claude -p` that implements and commits but never pushes, then the
*shell* measures, a second read-only `claude -p` refutes, and the shell opens the PR. A workflow on
the default branch (`land.yml`, fired by `workflow_run: [ci] completed`) does the merging — so the one
irreversible action lives in code no agent in the loop can write, and it lands whether or not the Mac
is still awake. The two winners disagree on exactly one axis, where the merge decision lives, so
grafting Merge Machine's server-side gate onto Night Ralph's shell loop costs one YAML file and drops
Merge Machine's issue mirror, `lane:` labels, cloud lane and worker mutex — none of which a single
developer landing one task at a time needs. Total new surface: ~330 lines across nine files, no
plugin, no JavaScript orchestrator, no ledger.

| Design | control | simplicity | landing | total |
|---|---|---|---|---|
| Night Ralph — 40-line bash loop | 7 | **9** | 6 | **22** |
| Merge Machine — GitHub is the loop | **8** | 5 | **8** | **21** |
| loop.md landing — product surface | 7 | 6 | 6 | 19 |
| Foreman — deterministic harness | 5 | 4 | **8** | 17 |

Winning angle: **Night Ralph** on totals and on maintainability; **Merge Machine** on two of three
judges' explicit picks, on the axis that decides whether anything lands. Nightshift takes Night
Ralph's shape and Merge Machine's merge authority.

## 2. The design

### Components

| Path | Size | What it is |
|---|---|---|
| `ambient/loop/land.sh` | ~90 lines | The driver. Preflight, queue derivation, generator call, measure, skeptic call, `gh pr create`, merge poll, stop rules. |
| `ambient/loop/PROMPT.md` | ~55 lines | The generator prompt. Byte-identical every iteration (Huntley: "deterministically allocate the stack the same way every loop"). |
| `ambient/loop/SKEPTIC.md` | ~25 lines | The refute prompt. Read-only, refute-by-default. |
| `ambient/scripts/check` | ~40 lines | The quiet verifier. `cargo fmt --check` → `clippy -D warnings` → `cargo test --all-targets` → `cargo run --bin symbolcheck`. One `✓` per step, `CHECK OK` last; on first failure `ERROR <cmd>` then that step's full log, exit 1. |
| `ambient/.claude/settings.json` | ~25 lines | Allow rules (bypass the auto-mode classifier) + scoped deny rules. Ambient has no `.claude/` today — verified, `ls .claude` returns "No such file or directory". |
| `ambient/.claude/hooks/no-route-around-ci.mjs` | ~45 lines | PreToolUse(Bash) deny: `gh pr merge`, `--admin`, `git push --force`, any push targeting `main`, and any `git commit` staging `.github/workflows/**`. |
| `ambient/.claude/hooks/tests-are-readonly.mjs` | ~50 lines | PreToolUse(Bash) deny on a `git commit` whose staged diff is net-negative on `#[test]` / `#[cfg(test)]` lines. |
| `ambient/.github/workflows/ci.yml` | edit | Add a `changes` path-filter job, make `rust`/`ui`/`hygiene`/`docs` conditional, fold `docs.yml` in as a `docs` job, add a final `gate` job with `if: always()` + `needs: [...]` that fails unless every dependency is `success` or `skipped`. Delete `docs.yml`. |
| `ambient/.github/workflows/land.yml` | ~70 lines | The merge machine. `on: workflow_run: {workflows: [ci], types: [completed]}`. |
| `ambient/merge-pr.sh` | edit | Demoted to the human path. `expected=(hygiene ui rust build)` → `expected=(gate)`. |
| `~/Library/LaunchAgents/dev.ambient.nightshift.plist` | ~25 lines | `StartCalendarInterval` 02:00, `caffeinate -s /bin/bash …/loop/land.sh <plan> 3`, explicit `EnvironmentVariables` PATH (launchd gives a minimal env). |
| repo variable `LANDING_STATE` | — | Kill switch. Read by `land.sh` at preflight and by `land.yml` before merging. |
| `ambient/docs/developing/landing.md` | ~40 lines | The human doc: launching a night, reading the morning, what `land:blocked` means. |

**Why `docs.yml` has to be folded in.** `paths:` filters are per-workflow (its own header says so),
but `land.yml` merges on one workflow's conclusion and cross-workflow `needs:` does not exist — so a
docs-touching PR would merge on `ci` success without ever waiting for `docs`. Folding is the
correctness fix; the `gate` job preserves the macOS saving. It also fixes a latent bug three of four
designs caught and I confirmed by reading both files: `merge-pr.sh` hardcodes
`expected=(hygiene ui rust build)`, `build` is the only job in `docs.yml`, and `docs.yml` is
`paths:`-filtered to `docs/**`, `docs-site/**`, `.github/workflows/docs.yml`. On the first `src/`-only
PR that check never registers, the script waits 60×5s and exits 1 with "checks never appeared". Every
PR this repo has merged touched `docs/` — so it has never fired, and the first unattended Rust task is
exactly where it would.

### The loop, in order

1. **Shell preflight.** `gh variable get LANDING_STATE` — anything but `run` exits 0. `git switch main
   && git pull --ff-only origin main`; refuse if `git status --porcelain` is non-empty or main ≠
   origin/main. `git bundle create ~/backups/ambient-$(date +%F).bundle --all`.
2. **Shell derives the queue** — no model involved. Landed = `git log origin/main --grep="^Landed-Task: $SLUG#"`.
   In-flight and blocked = `gh pr list --state all --search '"[task" in:title' --json number,title,state,labels`.
   Pick the first PR carrying `ci:red` with a repair round left; otherwise the lowest task number
   neither landed nor open nor `land:blocked`. None left → journal, exit 0. The shell picking the task
   is the direct mitigation for Anthropic's "a later agent instance would look around, see that
   progress had been made, and declare the job done."
3. **Shell branches**: `git switch -c land/<slug>-t<N>` off the fresh main — named after the task, not
   the agent, because the git log outlives the run.
4. **Generator**, one call, fresh context: `{ echo "PLAN: $PLAN"; echo "TASK: $N"; cat loop/PROMPT.md; } | claude -p --permission-mode auto --permission-prompts none --max-budget-usd 4 --model opus --effort medium --output-format json`.
   It implements inside the task's `**Files:**` list, runs `scripts/check`, and commits. It never
   pushes, opens a PR, or merges — none of those is in its permission surface.
5. **Shell measures, with no license to fix.** HEAD moved off main's sha; `git status --porcelain`
   empty; `scripts/check` exits 0. Any failure → `git switch main`, delete the branch, journal
   `BLOCKED task N: <the ERROR line>`, go to 2.
6. **Skeptic**, a second call, read-only: `{ cat loop/SKEPTIC.md; git diff main...HEAD; } | claude -p --permission-mode plan --max-budget-usd 1 --model opus --effort medium`.
   Hunts a listed file untouched, a checkbox step with no evidence in the diff, a weakened or deleted
   test, a change outside `**Files:**`. Refutes under uncertainty; last line is `VERDICT: OK` or
   `VERDICT: REFUTED <reason>`, which the shell greps.
7. **Shell opens the PR** — `git push -u origin HEAD`, then `gh pr create --title "[task N] <title>"
   --label land`. On a refuted verdict it pushes anyway, opens a **draft** PR carrying the skeptic's
   reasons, labels it `land:blocked`, and goes to 2. PR creation lives in the shell, out of every
   agent's reach.
8. **Shell polls for the landing** — `gh pr view <pr> --json state,mergedAt` every 20s, ceiling 25
   minutes, zero tokens. Merged → `git switch main && git pull --ff-only`, journal `LANDED task N
   pr#<n> $<cost>`, go to 1. `ci:red` → journal, go to 2 (which picks the red PR for its one repair
   round). Timeout → journal, end the night; `land.yml` finishes without us.
9. **`land.yml`, minutes later, server-side.** `ci` completes → `workflow_run` fires the default-branch
   copy. Refuses unless the head branch matches `land/*`, the PR carries `land`, carries no
   `land:blocked`, and `LANDING_STATE == run`. On `conclusion: success` and a clean merge state:
   `gh pr merge --merge --delete-branch=false`. On `failure`: add `ci:red`, comment
   `gh run view <id> --log-failed | tail -80`; a second `ci:red` on the same PR converts it to draft
   and swaps `land` → `land:blocked`. On `cancelled`: **no-op** — `ci.yml` carries
   `cancel-in-progress: true` (verified), so a repair push cancels the in-flight run and treating
   cancelled as red would false-block every fix.

### Unit of work

One `# Task N` from an approved plan → one branch → one PR → one merge commit on main, chosen so
`git revert -m 1 <merge-sha>` undoes exactly one task. Sequential, one open `land` PR at a time: each
task branches from a main that already contains its predecessor, removing merge conflicts rather than
resolving them (HumanLayer's lesson, after a React refactor PR died on conflicts, was that re-running
beats rebasing; sequential landing needs neither). Sizing from `writing-plans`, unchanged: "the
smallest unit that carries its own test cycle and is worth a fresh reviewer's gate."

### Verification

- **`scripts/check` before every commit** (by the generator) **and again after** (by the shell, which
  may not fix). Rust sits at the strong end of the backpressure hierarchy because its errors feed
  straight back to the model; `symbolcheck` asks the OS a real question. Output is small on success
  (`CHECK OK`) and complete on failure (`ERROR <cmd>` plus that step's full log, nothing else) —
  HumanLayer's `run_silent` and Carlini's grep-able one-line `ERROR` converged on this independently,
  after 4,000 lines of *passing* test output made an agent hallucinate files it had just read.
- **Keep `scripts/check` deliberately narrower than CI**, which also runs `typos`, `cargo-deny`, the
  whole `ui` job, `git diff --exit-code assets/settings.html`, `make-app.sh`, `codesign -v` and
  `plutil -lint`. That gap is the cheap version of a holdout suite: arXiv 2605.21384 finds the
  visible-vs-holdout gap widens with task complexity, and METR measured Opus 4.6 attempting to reward
  hack in ~80% of attempts when tests were hidden (metr.org/blog/2026-05-19-frontier-risk-report).
- **The skeptic is not the generator.** Anthropic (2026-03-24): "agents reliably skew positive when
  grading their own work," and a standalone skeptical evaluator is "far more tractable."
- **`land.yml` reads `github.event.workflow_run.conclusion`** — a value no agent in the loop can write,
  in a file the `no-route-around-ci` hook forbids the generator from staging. Landing is then
  confirmed from git, never from a report: `Landed-Task: <slug>#<N>` grepped off `origin/main`.

### Stop rules — every one an integer, an exit code, or a repo variable

- `LANDING_STATE != run` → both `land.sh` and `land.yml` stop. One `gh variable set LANDING_STATE
  --body frozen` from a phone kills the night mid-flight.
- `MAX=3` iterations per night; `timeout 1800` around each `claude -p`.
- `--max-budget-usd 4` per generator call, `--max-budget-usd 1` per skeptic — verified present on
  2.1.260: `claude --help` lists `--max-budget-usd <amount>  Maximum dollar amount to spend on API calls`.
  This **corrects** research-platform-features.md:71 ("no first-class dollar/token budget flag").
- Measure fails, or the skeptic refutes → that task stops; no retry inside the night. Two `ci:red`
  rounds on one PR → draft + `land:blocked`, enforced by `land.yml`, not by prose. Two consecutive
  blocked tasks → end the night (consecutive failures are almost always environmental). Merge poll
  over 25 minutes → end the night; the server-side gate finishes on its own.
- Free from the harness: `--permission-prompts none` denies rather than hangs and strips
  `AskUserQuestion` from the toolset; headless terminates after 3 consecutive denials or 20 blocks
  (code.claude.com/docs/en/headless, code.claude.com/docs/en/permission-modes).
- **Not used: `--max-turns`.** I ran `claude --help | grep -c max-turns` on 2.1.260 → `0`. It is an
  SDK option, not a CLI flag. Any stop rule built on it does not exist.

### State and resume

There is no ledger, because every fact is a git or GitHub object. Landed = a merge commit on
`origin/main` carrying `Landed-Task: <slug>#<N>`. In flight = an open PR titled `[task N] …`. Given
up on = a draft PR labelled `land:blocked` with the failing log in its first comment. `loop/journal.md`
and `loop/run-*.json` are gitignored and disposable. Resume is the absence of a feature: re-run the
identical command. A crash leaves four recoverable shapes — no branch, a local branch with no PR, a
pushed branch with no PR, an open PR — and steps 1–2 resolve all four with no special-case code.
(A committed ledger is also impossible here: `.githooks/pre-commit` refuses commits on `main`, so
each update would need its own PR.) Contrast SDD, whose `resumeFromRunId` resumes only within the
same Claude Code session's in-memory state — a crash restarts it from wave 0.

### Human touchpoints

1. **Plan approval, upstream of everything.** The plan lands on main through its own PR that Jason
   reads. Preconditions the shell refuses without: every task has a `**Files:**` list, `## Open
   Questions` is empty, `## Global Constraints` names `scripts/check`. arXiv 2607.05743 measured
   Claude Code's overeager rate moving 0.0% → 17.1% on prompt phrasing alone when the authorized
   scope was left unstated — the `**Files:**` line is the control, not documentation.
2. **`gh variable set LANDING_STATE --body run`**, once. No secret anywhere: `land.yml` merges with the
   built-in `GITHUB_TOKEN`, so there is no PAT and no 1Password service account to stand up — the
   cheapest way to satisfy 1Password's constraints (service accounts can never reach the Private
   vault; desktop-app `op` sessions revoke on lock — 1password.dev service-accounts and
   cli/app-integration-security).
3. **Breakfast, five minutes.** `cat loop/journal.md`, `gh pr list --state all --search '"[task" in:title'`,
   and `git log origin/main --grep=docs-sync:ack --since=yesterday` — every bypassed gate is recorded
   in a commit message. **Undo:** `git revert -m 1 <merge-sha>`; `gh workflow disable land.yml`.
4. **Not a touchpoint: the merge.** Human-gating it is what makes a landing loop not a landing loop,
   and it is where SDD flinched ("the workflow never merges"). Safety comes from the unit being one
   revertible merge commit and CI being real.

### Budgets

**CI, measured:** the `rust` job on `macos-latest` ran 2:02, 2:04, 2:18 and 3:29 across the four most
recent runs cited by two independent judges; at $0.062/min that is **$0.13–$0.22 per PR**. `hygiene`,
`ui` and `docs` run on `blacksmith-4vcpu-ubuntu-2404`, outside GitHub's meter. Three PRs a night ≈
**$0.50**, less once `changes` skips `rust` on docs-only work. (The $0.062/min rate is flagged in
research-platform-features.md:130 as WebSearch-sourced — re-fetch
docs.github.com/en/billing/reference/actions-runner-pricing before quoting cents to anyone.)

**Model:** one Opus generator ($1–3 for real Rust; the floor is real — a bare `claude -p` with an
empty prompt cost $0.11 in system-prompt cache creation alone) plus one Opus skeptic ($0.30–1.00).
**$4–12/night, hard-capped at $15** by three `--max-budget-usd 4` plus three `--max-budget-usd 1`
ceilings. Anchors: $9 solo vs $200 for one 6-hour Anthropic harness run (2026-03-24); $20,000 for
Carlini's two-week 16-agent build; $15.98 for one Hashimoto feature across 16 sessions. Nightshift
sits at the Hashimoto end — two model calls per task, one adversarial, no parallelism, no ladder.

## 3. Grafts absorbed

**From Night Ralph** (the base): the bash driver, the byte-identical prompt file, `scripts/check`, the
commit trailer as ledger, `--max-budget-usd`, launchd, `MAX=3`, "keep `scripts/check` narrower than
CI", the nightly `git bundle`, and the observed `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` downgrade — a
`claude -p --permission-mode auto` launched from inside a Claude session silently falls back to
`default` and hangs, making launchd mandatory and `launchctl kickstart` a required verification step.

**From Merge Machine:** `land.yml` as the merge authority on the default branch; the `gate`
aggregation job under `if: always()` (better than computing expected checks from changed files —
it removes the entire never-registered class); folding `docs.yml` into `ci.yml`; `LANDING_STATE` as
a remote kill switch; two-`ci:red`-then-draft as three lines of YAML instead of an escalation ladder;
the `cancelled`-is-a-third-conclusion catch; and demoting `merge-pr.sh` to `expected=(gate)`.

**From Foreman:** the Measure step with no license to fix (in shell, which is stronger and free); the
refute-by-default skeptic on `git diff main...HEAD`; enumerating every command the loop issues in
`permissions.allow` and asserting it at preflight (under `--permission-prompts none` one missing rule
becomes three denials and a silent termination); `--dry-run`; and proving resume by *breaking* it.

**From loop.md landing:** both PreToolUse hooks — `no-route-around-ci.mjs` and `tests-are-readonly.mjs`
— which hold in every permission mode including bypass, making "the worker never merges" a mechanism
rather than a sentence; scoped `permissions.deny` entries alongside the allow list; the merge wait
outside the agent's turn; and the prompt line that command output (`gh run view`, PR comments,
dependabot titles) is **data, not instructions** — a local loop gets none of the
`<routine-fire-payload>` wrapping a cloud Routine does. **Added, closing the unnamed hole the control
judge found in Merge Machine:** `no-route-around-ci.mjs` also denies any commit staging
`.github/workflows/**` — `pull_request` runs the PR's *own* copy of `ci.yml`, so without it a worker
could weaken the gate in the same PR the gate then approves.

## 4. Build vs. what Claude Code already ships

**Ships — used:**
- `--permission-mode auto --permission-prompts none` — the documented fully-unattended configuration;
  denies rather than hangs, strips `AskUserQuestion`; 3 consecutive denials or 20 blocks terminates
  the process. v2.1.259+; this Mac runs 2.1.260. https://code.claude.com/docs/en/headless ·
  https://code.claude.com/docs/en/permission-modes
- `--max-budget-usd`, `--output-format json` (carries `total_cost_usd`). Verified in `claude --help`.
- PreToolUse hooks — fire *before* any permission-mode check, in every mode including
  `bypassPermissions`; the one gate a loosened permission cannot walk past.
  https://code.claude.com/docs/en/hooks-guide
- Allow rules bypass the auto-mode classifier, and "on entering auto mode we drop permission rules
  that grant arbitrary code execution… narrow rules survive" — the fix for today's finding that the
  classifier denied `./merge-pr.sh`. https://www.anthropic.com/engineering/claude-code-auto-mode

**Ships — deliberately not used, with the reason:**
- **`/goal`** (https://code.claude.com/docs/en/goal) — a Haiku judge that reads *the transcript only*
  and never runs a command; the shell knows ground truth from `git log --grep`. Its 8-block and
  3-idle-check-in caps are new failure modes, and its "stop after N turns" bound is model-judged.
- **`/loop`** (https://code.claude.com/docs/en/scheduled-tasks) — needs a session that stays open and
  expires hard at 7 days. launchd survives sleep, reboot and a crashed run. **`/batch`** — "5 to 30
  worktree-isolated subagents that each open a pull request": parallel fan-out sequential landing does
  not have, at 5–30× the macOS CI.
- **Routines / `--cloud` / Auto-fix PR** (https://code.claude.com/docs/en/routines ·
  .../claude-code-on-the-web) — structurally impossible: `ci.yml`'s own comment says "the crate does
  not compile anywhere but macOS: process taps, objc2-app-kit and objc2-web-kit have no other
  target." Auto-fix PR could only repair the Linux jobs, and cannot react to merge conflicts.
- **Workflow scripts** (https://code.claude.com/docs/en/workflows) — no `child_process`, and
  `Date.now()`/`Math.random()` throw by design, so every `git`/`gh` call becomes an agent call with a
  shape-checked result. Bash calls `git` and believes the exit code.
- **`gh pr merge --auto`** — waits only on *required* checks, and branch protection on a private repo
  still needs GitHub Pro or above (https://docs.github.com/en/get-started/learning-about-github/githubs-plans,
  fetched 2026-09-04). `merge-pr.sh`'s header records what happens without it: "`--auto` merges at
  once, before CI has run — which is how cargo fmt drift sat on main for six pushes."

**Build:** the thirteen rows of the components table above, and nothing else.

## 5. Disposition of the existing plugins

**`subagent-driven-development` — delete the plugin (923-line `sdd.mjs`, its tests, five prompts, the
317-line SKILL.md, `sdd-worktree` / `sdd-gc` / `review-package` / `sdd-workspace`).** Two properties
are disqualifying, both confirmed by grep in local-plugin-coverage.md §4: it never pushes, opens a PR
or merges, so it cannot do the step that makes a run unattended; and its resume is same-session
in-memory, so a 3am crash restarts from wave 0. Its parallel waves answer a coordination problem
sequential landing does not have, and its implementer/reviewer/fixer/merge-agent/verifier cast exists
because a sandbox that cannot run `git` needs an agent to check a claimed sha — the shell runs `git`.

Salvage: **`scripts/task-brief` (40 lines) — keep**, copied to `ambient/loop/task-brief`; it
materialises one `# Task N` section from the plan at runtime, so task text never travels through
arguments and cannot drift. **The oscillation breaker** (same failure class twice → halt) becomes
two-`ci:red`-then-blocked in `land.yml`; **"CI is the authoritative done-oracle, never the
implementer's self-report"** becomes the shell's `git log --grep`. Neither is code.

**Two dependents break when SDD goes:**
- `plugins/adr/skills/adr/SKILL.md` **lines 99–121, 130** resolve `sdd.mjs` by literal path pinned to
  `subagent-driven-development/0.12.0` and invoke `Workflow({ scriptPath: … })`. Rewrite Phase 4 to
  end at "ADR merged on main, plan written and merged." Also line 3 (the description) and lines 9,
  20, 145, 165, which name SDD in prose.
- `plugins/superpowers-core/skills/writing-plans/SKILL.md` **lines 65 and 185** name
  `subagent-driven-development` as **REQUIRED SUB-SKILL** — and line 65 is emitted *into every plan
  file*, so every plan on disk points at a deleted plugin. Swap both (and the prose at lines 3, 14,
  20, 183) to name the landing loop. The plan *format* stays exactly as it is — `## Global
  Constraints`, `### Task N`, `**Files:**`, `**Interfaces:**`, checkbox steps, mandatory `## Open
  Questions` — because that format is the loop's input contract and the best thing in the marketplace.

**`landing-loop` 0.1.0 — delete.** Registered in `marketplace.json` (line 122) but **not installed** —
`ls ~/.claude/plugins/cache/jasonm4130-claude-skills/` lists 11 plugins and landing-loop is not among
them, so its own preflight, resolving a literal `0.1.0` cache path, cannot run today. Its 448-line
`land.mjs` + 130-line test express a `for` loop through a sandbox that cannot call `git`;
`renderLedger()` writes a file that can disagree with the `gh pr list` it derives from; and it pins
SDD's cache path at `0.12.0`, so a `/plugin marketplace update` breaks it at 2am. Salvage as prose
into `docs/developing/landing.md`: the preflight refusal checklist (~12 `[ ] || die` lines atop
`land.sh`) and the README's *Known constraint* paragraph on the classifier denying `./merge-pr.sh`.
Do not rewrite or rename — a second repo can copy four files.

**`gates` — keep all of it, and feed it rather than fight it.**
- **`docs-sync`** is the gate the loop relies on. It denies a `git commit` when a staged code file's
  nearest-ancestor README/CLAUDE.md/AGENTS.md is not also staged. `ambient` has exactly two READMEs —
  `./README.md` and `./docs/adr/README.md` (verified by `find`) — so the root README covers all of
  `src/`, `ui/src/` and `.github/`, and every generator commit needs a staged doc or `docs-sync:ack`.
  Two quirks the prompt must encode, both in this repo's memory: the hook matches "commit" anywhere in
  the Bash text, and reads the ack out of a `-F -` heredoc *only when `git commit` is the first
  command* — so stage in one call and commit in another, never chained (a deny kills the whole call).
  Fix while you are here: the file's header comment at line 10 says "plugins/ monorepo layout only —
  silent anywhere else", which is stale; Rule 2 at lines 329–370 is generic.
- **`agent-model` / `workflow-model` / `lsp-first`** — inert in the loop (no `Agent`, no `Workflow`),
  useful in the morning session. **`design-gate`** — an `ask` with nobody present has no defined
  behaviour, but the loop runs no scaffolder, so it cannot fire. **`json-config-guard`** — PostToolUse,
  reports after the fact. Keep all four.

**`codex-review` — keep, upstream only.** One `codex-plan-review` pass on the plan file before the
night, never per-task and never on the diff. Its `audit-concerns-unattended` outcome is the precedent
for how a tool should behave with no human present — log honestly, refuse to fabricate approval — and
it was introduced after 86 of 141 real chains closed as `audit-concerns-user-approved` with no user
ever asked. Copy that honesty into how `land:blocked` comments are worded.

**`ship-gate` — inert, do not extend**: its Stop hook nudges into the *next interactive prompt*, which
an unattended run never sends. **`handoff` / `session-retro` / `domain-modeling` / `writing-artifacts`**
— untouched, for interactive sessions.

## 6. The first run on ambient

`docs/superpowers/plans/2026-09-04-landing-loop-bootstrap.md` already exists and its Task 1
(`scripts/check` + `.claude/settings.json`) is correct as written. Rewrite the rest to these tasks,
in this order — the loop's own bootstrap is the loop's first workload, run in daylight, watched:

1. **`scripts/check`** — the quiet verifier. (Existing Task 1, keep verbatim.)
2. **`.claude/settings.json`** — allow every command the loop issues, plus scoped denies for
   `Bash(gh pr merge:*)`, `--admin`, `git push --force*`, pushes to `main`.
3. **`ci.yml`: `changes` + conditional jobs + `gate`; delete `docs.yml`; `merge-pr.sh` → `expected=(gate)`.**
   Must land before any unattended night — without it the first `src/`-only PR stalls and exits 1.
4. **`land.yml`** — the merge machine, plus `gh variable set LANDING_STATE --body run`.
5. **The two PreToolUse hooks**, with a test each.
6. **`loop/land.sh` + `PROMPT.md` + `SKEPTIC.md` + `.gitignore` + `docs/developing/landing.md`**, then
   the launchd plist (uncommitted; it lives in `~/Library/LaunchAgents`).

**What would prove the loop works** — in this order, each a falsification attempt, not a demo:

1. **Break the verifier deliberately.** Introduce a format violation and confirm `scripts/check`
   prints `ERROR cargo fmt --check`, rustfmt's diff, and exits 1. Reading it is not running it.
2. **Prove the `build`-check bug is gone.** A whitespace-only PR touching one file under `src/` must
   show `gate` within 90s, with `rust` run and `docs` skipped.
3. **Prove the docs-sync commit shape.** Stage one `src/*.rs` file, commit with no ack → observe an
   actual deny. Repeat with `docs-sync:ack` in a `-F -` heredoc where `git commit` leads the call →
   observe it pass. Ground the prompt in an observed deny, not a reading of the hook.
4. **Prove the allow rule fixes the classifier.** Run the loop's `gh pr create` under
   `--permission-mode auto --permission-prompts none` before and after adding the rule.
5. **One foreground run, in daylight, `MAX=1`, on a throwaway docs task** — real branch, real PR, real
   `land.yml` merge, no human commands.
6. **Prove resume by breaking it.** SIGKILL `land.sh` during the merge poll, re-run the identical
   command; it must see the open PR and *not* re-implement. If it re-implements, resume is false.
7. **Prove the kill switch.** `LANDING_STATE=frozen` mid-run; `land.sh` and `land.yml` both stop.
8. **`launchctl kickstart -k gui/$(id -u)/dev.ambient.nightshift`** — the only step that proves the
   launchd environment (PATH, keychain, `gh` auth). Running it by hand never proves it.
9. **Only then, one unwatched night with `MAX=1`.**

## 7. Open questions only a real run can answer

1. **Does `land.yml`'s `gh pr merge` with the built-in `GITHUB_TOKEN` trigger main's own `ci` run?**
   GitHub's recursion guard was cited but *not* verified — Merge Machine failed two fetches for it and
   I did not re-fetch it either. Nightshift is built so the invariant does not depend on it (`land.yml`
   requires the PR up to date before merging), but if main's post-merge `ci` matters it costs a
   fine-grained PAT — the only secret that would exist in the system.
2. **Does `workflow_run` reliably resolve the PR from `head_branch`** here, and does the default-branch
   context hold as documented (docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows,
   cited by the Merge Machine design, not re-fetched this session)?
3. **How often does the skeptic refute a good task?** Refute-by-default trades false blocks for missed
   regressions and nobody has run it on Rust diffs. Watch the first ten. Related: **is 25 minutes the
   right merge-poll ceiling** on a cold `ort` cache (an 80 MB re-download)?
4. **Does `--permission-prompts none` survive a launchd-launched session** given the observed
   `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` downgrade inside a Claude session?
5. **Is a green Rust suite still an oracle here?** Ambient's tests are inline `#[cfg(test)]` modules,
   so `tests-are-readonly.mjs` is a diff heuristic a determined agent can restructure around, and
   there is no hidden suite beyond the CI/`scripts/check` gap.

**What the judges disagreed about, and how this design resolves it:**

- **Where the merge decision lives.** Control and landing ranked Merge Machine first for putting it in
  `land.yml`; simplicity ranked it second-from-last for the YAML state machine, issue mirror and
  two-lane fleet that came with it. Resolved by taking `land.yml` and leaving the rest.
- **How much machinery a verification story is worth.** Landing scored Foreman 8 for its Measure/Refute
  separation; simplicity scored it 4 because most of its length is tax for a sandbox that cannot call
  `git`. Resolved by keeping both roles and implementing Measure in shell — the separation survives,
  the ~350 lines of sealed JS do not.
- **Whether the hooks are worth their lines.** Control called `tests-are-readonly.mjs` the field's only
  mechanical answer to reward hacking; simplicity called it 50 lines added for a cited paper rather
  than an observed failure, in a repo that has run zero unattended nights. Kept, on the narrow ground
  that a PreToolUse deny is the only control that holds when auto mode's published 17% false-negative
  rate is the alternative — but it is the first thing to delete if a month of journals never shows it
  firing.
- **Night Ralph's one factual miss.** All three judges flagged its "`merge-pr.sh` already correct,
  unchanged" against the real, latent `build`-check stall. Resolved by making the `ci.yml`/`gate` fix
  Task 3 of the bootstrap, ahead of any unattended night.
