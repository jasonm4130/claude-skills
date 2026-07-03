# Issue-Driven Development with Sub-Agents — Research Brief

**Date:** 2026-05-26
**Purpose:** Inform v1 design of an issue-driven dev plugin for the claude-skills monorepo.
**Grounding:** Transcoder's working practice — 220+ issues, ~10–20 closed/day, 8 concurrent worktree sub-agents at `.claude/worktrees/agent-<hash>/`, `kind(scope):` titles, `(#issue) (#pr)` squash subjects, rich issue bodies (Summary / Impact / Reproduction / Suggested fix / Out of scope / References).

---

## Executive summary

Issue-driven dev with coding agents has converged on a recognisable shape across the ecosystem: AGENTS.md (or per-tool shim) as the portable convention file, branch names like `<tool>/<issue-num>` or `<kind>/<issue-num>-<slug>`, and "trigger by label/mention → agent reads issue + repo conventions → PR with `Closes #N`." The dominant failure mode (65% of failed SWE-bench instances per Liu et al. 2025) is *reasoning failure* — superficial keyword matching and cognitive deadlock — not tool or environment failure. The single highest-leverage mitigation is **acceptance criteria framed as independently testable assertions**, validated empirically by Aider's 26.3% SWE-bench Lite score (vs 1.96% no-AC baseline).

Three concrete additions to the v1 plugin earn their place:

1. **Pre-flight triage** — human-label-gated, not strict-rubric-gated. Strict rubrics filter 68% of issues at benchmark scale; that's friction-hell as a dispatch gate. Ship a `trivial` bypass from day one.
2. **Decomposition** — refuse at dispatch when >5 ACs / >5 files / >4k-token body, propose 3–5 child issues max (the GitHub `/plan` workflow's hard cap, the strongest anti-fragmentation rule found). Propose-and-confirm only — no autonomous decomposition.
3. **Worktree GC** — detection signal: PR merged + `git fetch --prune` removes the remote tracking branch. Handles squash-merge, force-push, and close-without-merge uniformly. Three-tier removal (`remove` → `remove --force` → `rm -rf + prune`).

Transcoder is already doing 80% of the right things; the gap is codifying the convention so it travels.

---

## Part 1 — Issue-driven dev landscape

### 1.1 Key findings

**1. Acceptance criteria as testable assertions is the single highest-leverage variable.** Lisa's `spec_compliance` stage auto-retries on unmet ACs; GitHub's `one-shot-feature-issue-planner` enforces "observable behavior, not subjective"; Aider's harness uses 6-attempt retry against plausibility (no syntax/test breaks). Checkbox lists outperform bullets; both beat paragraphs.

**2. Failure mode split: ~65% reasoning, ~25% knowledge, ~10% environment** (Liu et al., arXiv 2509.13941, 150 failed SWE-bench instances). Expert-executor dual-agent setups resolved 22.2% of previously intractable issues vs 6.5% single-agent baseline.

**3. AGENTS.md is consolidating as the portable convention** across Claude Code, Copilot, Aider, Codex (nimble-mold, code-copilot-team). `CLAUDE.md`, `.cursorrules`, `.aider.conf.yml` are tool-specific shims around the same contract.

**4. Branch-naming convergence**: Claude Code Action defaults to `claude-code/issue-{N}`, Cursor `cursor/issue-N`, Devin `devin/issue-123`. Transcoder's `(#issue) (#pr)` squash subject is rarer but provides stronger bidirectional linkage.

**5. Parallel worktree productivity collapses at 7+ concurrent sessions** (Code With Seb, Apr 2026 — single source, treat as directional): 4 = review backlog, 5 = manifest needed, 6 = weekly conflicts, 7+ = productivity collapse. Transcoder's 8 worktrees is right at the cliff edge. Surprise-overlap files are barrel exports, shared constants, test configs — not the obvious code files.

**6. Three coupling patterns dominate**: (a) trigger via label/mention/title-prefix, (b) spec-as-artifact between phases (brainstorm → plan → execute writes files between sessions), (c) portable conventions file. Tools that skip (b) and go brainstorm→code directly fail the dominant reasoning failure mode.

**7. Verification theater** (claude-code field reports #46797, #61932) is endemic — agent declares done without satisfying ACs, human approval becomes rubber-stamp. Two highest-leverage countermeasures: AC-as-tests (write the failing test first), and judge-pass that requires grep/diff evidence before "done."

### 1.2 Contradictions surfaced

- **Agent Teams / auto-conflict-resolution**: claude-workflow + multiagent-template show success on independent tasks; claude-code field reports document cascade-loop failures when two agents touch the same shared type definition. Resolution: the pattern works for genuinely independent tasks, fails for cross-cutting ones.
- **Localization vs reasoning as dominant failure**: MAGIS attributes failure to planning/localization; Liu et al. 2025 attributes to reasoning. Likely artifact of architecture (pipeline-based agents bottleneck on localization, fully agentic loops bottleneck on reasoning).

### 1.3 Source diversity warning

Failure-mode evidence draws 5 of 12 sources from `github.com/anthropics/claude-code` issues. Not a single-perspective problem (those are field reports from many users), but it skews toward the Claude Code ecosystem; less direct evidence on Aider/Cursor/Devin failure rates at scale.

---

## Part 2 — Triage / Decomposition / Worktree GC

### 2.1 Triage / pre-flight check

- **Real systems gate via human labels, not strict rubrics.** Lisa (`needs-spec` / `ready`), OpenHands (`needs-triage` / `needs-info`), Sweep (15-character minimum check + comment-back) — none enforce hard AC presence at dispatch. The empirically-strict rubric (SWE-bench Verified's ICA + TCA scales, 0–3) filtered 68.3% of 1,699 samples — but that's a *benchmark filter*, not a dispatch gate. No production system runs it pre-dispatch because the friction on small issues is unacceptable.
- **Lisa's two-stage validation is the closest production pattern**: extract `- [ ]` ACs from issue body → run LLM verification *post-implementation* against the diff → re-invoke agent if ACs unmet. This is a verification gate (blocks PR), not a dispatch gate (blocks agent start). The distinction matters.
- **Devin uses confidence signals** (🟢/🟡/🔴) the agent self-reports — the agent decides if the brief is good enough to proceed, escalates if yellow/red.
- **Output formats converge**: comment-back with what's missing (Sweep, OpenHands); apply a label (Lisa, OpenHands); rarely hard-block.
- **Failure mode named in sources**: typo-fix, doc-update, and dead-code-removal issues fail "missing ACs" gates and create author friction. Strict rubrics shipped without a "trivial-fix bypass" get walked back.

### 2.2 Issue decomposition

- **GitHub native sub-issues** (Dec 2024, public preview Aug 2025) are the cleanest linkage standard. Supersedes ad-hoc `Part of #N` text — the parent/child link is structured, surfaced in the UI, queryable via `gh`. Copilot supports automatic linking and retroactive parent-creation.
- **The `/plan` workflow caps child issues at 3–5 per cycle** as a hard rule, explicitly to prevent over-fragmentation. Strongest practical heuristic found.
- **"Too big" thresholds reported across sources**: >5 files OR >200 lines OR >2–3 days work OR >15 events/4 entities. Indicative, not validated — most sources cite intuition, not measured agent-success-rate data. *(One claimed formal optimum at "0.85√S subtasks" was dropped — its source domain doesn't resolve to a recognised preprint server.)*
- **Over-fragmentation failure mode is well-documented by analogy** to microservices-regret postmortems (47 services → modular monolith). Audit heuristic: if children must execute sequentially OR merging them takes <1 hour, they were over-split.
- **Epic+stories pattern net-positive only when**: (a) stories are independently testable AND deployable, (b) no synchronous coupling between children. Otherwise it's a distributed monolith with coordination overhead.
- **Cross-issue coordination during parallel execution** requires explicit contracts between children — shared-file boundaries identified before dispatch, interface contracts agents read without re-negotiating, sequential validation after merge (never parallel).

### 2.3 Worktree GC

- **Detection signal that handles all edge cases**: PR merged AND `git fetch --prune` removes the remote tracking branch, then `git rev-parse --verify refs/remotes/origin/<branch>` fails. Works for squash-merge (different hash), force-pushed-then-merged (different hash), and PR-closed-without-merge — cleanup logic is "branch gone on origin," not commit-hash-matching.
- **Three-tier removal pattern**: `git worktree remove` (refuses if dirty) → `git worktree remove --force` (safe when origin branch is gone) → `rm -rf <dir> && git worktree prune` (corrupted metadata fallback). **Important distinction**: `prune` only cleans `.git/worktrees/` metadata *after the directory is already gone*; `remove` deletes the directory. People conflate these.
- **Retention policy consensus**: delete-on-merge for immediate cleanup, plus a monthly bulk sweep as safety net. Kunwar's empirical sweep reduced 256 stale worktrees to 28 and reclaimed 27 GB in under 2 minutes.
- **Safety guards before `--force`**: at minimum, check for unpushed commits not on origin. The "remote branch deleted" signal implies unpushed work was either merged or abandoned, but a paranoid check costs nothing.
- **Edge cases handled by the same signal**: detached-HEAD worktrees (no branch tracking, safe to force-remove); submodule worktrees (clean up the same way, just can't be `git worktree move`d).

### 2.4 Contradictions / things to flag

- **Triage strictness**: Lisa enforces ACs post-implementation (high cost, high signal); Sweep enforces only minimum length pre-dispatch (low cost, low signal); no surveyed system enforces ACs pre-dispatch. There's a missing middle: a cheap pre-dispatch readiness check lighter than full LLM-judge but stronger than character-count. **This is the design opportunity for v1.**
- **Decomposition heuristics are mostly intuition.** No source quantifies "issues with >N ACs have X% agent failure rate." Treat thresholds (5 files, 200 lines, 5 ACs) as starting points to measure against.
- **Source-diversity warning on worktree GC**: 3 of 4 sources are personal-blog scale. Technical content cross-references git-scm.com docs and is internally consistent, but treat any specific cadence claim ("monthly", "weekly") as one blogger's practice.

---

## Part 3 — Design implications for v1

### A. `docs/issue-style.md` (per-project reference doc)

Lives at the project level (one per repo), not in the skill. The skill *reads* it; the project *defines* it. This lets the convention evolve in one place.

Minimum contents:

- **Title convention**: `kind(scope): description` (transcoder's existing; portable, parses into commit prefixes, recognised by Conventional Commits tooling)
- **Body schema** (required sections, in order):
  - *Summary* — 1–3 sentences, the what
  - *Acceptance criteria* — checkbox list of independently testable, observable assertions (non-negotiable per the empirical evidence)
  - *Reproduction* (bugs) or *Success signal* (features)
  - *File/line anchors* — `path:line` form, concrete not prose
  - *Scope* / *Out-of-scope* — explicit non-goals to prevent drift
  - *References* — related issues, prior commits, doc paths
- **Implementer contract** (agent-facing prefix): "Touch only files matching Scope. If an AC can't be verified by an automated check, write one. If you discover scope drift seems necessary, open a separate issue and stop — do not silently fix."
- One worked example per `kind`: `bug`, `feat`, `perf`, `ci`, `docs`, `refactor`. Use transcoder's existing closed issues as the corpus.

What NOT to include: rigid label taxonomy, mandatory assignees, project-board automation. Transcoder uses labels sparingly and that's working.

### B. Built-in default style (ships with the plugin)

Lives as a literal file in the plugin (`plugins/<name>/defaults/issue-style.md`) — so "the default" and "the scaffolding template" are the same source of truth, no drift.

Precedence rule: if `docs/issue-style.md` exists in the project, use it; else fall back to the built-in default and emit a one-time notice (`Using built-in issue style. Run \`<plugin> init-style\` to copy it into the repo and customise.`).

Keep the default at the minimum that's empirically load-bearing (AC checkboxes + Scope are non-negotiable; everything else is style). Per-`kind` worked examples belong in the scaffolded in-repo doc, not the built-in default.

### C. `brainstorm→issue` skill

Minimum cut:

1. Reads brainstorm artifact (HTML in `.superpowers/brainstorm/*` or plan in `~/.claude/plans/*`)
2. Reads the project's `docs/issue-style.md` (or falls back to built-in default)
3. Drafts an issue body matching the schema
4. Confirms title parses as `kind(scope): description`
5. Shows the draft, lets the user edit, then `gh issue create`
6. Returns the issue URL

What to avoid: rigid templates baked into the skill, auto-labeling, comment-thread automation. The skill is a structurer, not a process.

Edge cases: brainstorm artifact missing → ask user for source; ACs absent → prompt user to write them before creating issue; no style guide → fall back to built-in and warn.

### D. `issue→sub-agent dispatcher` skill

Minimum cut:

1. `gh issue view <N>` — fetches body + comments + labels
2. Parses title for `kind(scope)`, derives slug
3. Creates worktree: `.worktrees/issue-<N>` (matches existing transcoder convention)
4. Creates branch: `<kind>/<N>-<slug>`
5. Briefs sub-agent with: full issue body + project `CLAUDE.md` + `docs/issue-style.md` + **Implementer contract** prefix (touch only Scope files, AC-as-tests first, surface scope drift as comment not silent fix)
6. Sub-agent implements + tests + opens PR with title `kind(scope): description (#N)` and body containing `Closes #N`
7. Orchestrator verifies PR opened, returns URL

**Concurrency safety** (missing from the empirical setup):
- Before dispatch, skill reads modified-files list across all existing `.worktrees/*` and refuses if the new issue's Scope overlaps any active worktree's files
- Soft cap at **6 concurrent worktrees** with override flag. Transcoder runs 8 today — at or over the empirical cliff. Either start enforcing the cap and watch what changes, or measure conflict rate for a week and recalibrate.
- Surface-area check: warn when Scope includes barrel exports, shared constants, or test config (Unmarkdown's empirical surprise-overlap files).

What to avoid: auto-merge, auto-comment on PR, auto-label, automatic conflict resolution between sibling worktrees. Keep merge gates manual.

### E. Pre-flight triage check (sub-command of dispatcher)

Three-tier check, run on `gh issue view <N>` before dispatch:

1. **Hard gate (cheap, automated)**: issue has a Summary section, has at least one `- [ ]` checkbox under "Acceptance criteria" OR has a `trivial` label that bypasses AC requirement. Anything failing this → comment back with what's missing, refuse dispatch.
2. **Soft warning (medium cost, automated)**: if Scope section is empty OR no `path:line` anchors are present, post a warning but allow override with `--ack-no-anchors` flag. These correlate with scope-drift failures but aren't strictly required.
3. **Optional LLM judge (high cost, opt-in)**: a `--judge` flag runs Lisa-style AC-vs-body coherence check. Off by default; for high-stakes issues only.

Critical design rule: ship the **`trivial` label bypass** from day one. Without it, typo-fixes and doc updates create friction that pushes you to disable triage entirely.

### F. Decomposition refusal (sub-command of dispatcher)

Soft refusal at dispatch time when **any** of:
- More than 5 `- [ ]` ACs in body, OR
- Scope section lists more than 5 files, OR
- Body length exceeds 4000 tokens (starting point — same order as Aider's per-prompt budget).

Refusal output: post a comment with a draft decomposition proposal (3–5 child issues max, using GitHub's native sub-issue structure if `gh api` exposes it, falling back to `Part of #N` text-linkage otherwise). Author confirms or overrides with `--force-monolithic`.

Use the **3–5 children per cycle hard cap** from GitHub `/plan` workflow — strongest anti-fragmentation rule found.

**Don't** build autonomous decomposition in v1 — the planner-agent failure mode (Copilot's epic→story→test tree exploding) is real. Propose-and-confirm only.

### G. Worktree GC command

A `gc-worktrees` subcommand on the dispatcher plugin. Default behavior:

1. `git fetch --prune` in the main repo
2. For each `.worktrees/<name>` (or `.claude/worktrees/<name>` per transcoder layout), resolve its branch
3. If remote tracking branch no longer exists AND no unpushed commits to a different remote exist → safe to remove
4. Run `git worktree remove --force` (only when the remote-branch-gone signal is true)
5. Run `git worktree prune` at the end to clean any metadata orphans

Defaults: dry-run on first invocation, prints what it *would* remove. `--apply` to execute. `--keep-days N` grace period that retains worktrees less than N days old regardless of merge status.

Hook integration (v1.1): wire into the dispatcher's post-PR-open path — when the dispatcher learns its PR merged, trigger cleanup for that specific worktree automatically.

---

## Consolidated risks

1. **Codifying the convention freezes evolution.** Make `docs/issue-style.md` the single point of truth; the skills *enforce structure-from-reference* rather than bake shape into code. When the doc changes, the next dispatch picks up the new shape.
2. **The 6-worktree cap is single-sourced.** One blogger's empirical claim. Build it as a soft cap with override, log conflict rate, recalibrate after two weeks of real data.
3. **AC-as-tests has upfront cost.** Every non-trivial issue gets a failing test before any implementation — 5–15 minutes per issue. The 4× improvement (Aider 26.3% vs 1.96% baseline) is what you get in return. Worth it; don't ship the dispatcher without enforcing this, or you get verification theater.
4. **`docs/issue-style.md` is per-project, not shared.** Each project (transcoder, claude-skills, others) needs its own. The bridge skill detects missing style guides and offers to scaffold one from the built-in default.
5. **AC checkbox parsing is fragile.** Markdown allows `- [ ]`, `* [ ]`, `[]`, and other variants. Build the parser strict (one canonical form documented in `docs/issue-style.md`); reject variants with a clear error rather than silently accepting them.
6. **Decomposition's heuristics aren't validated.** Ship them as soft warnings with override, log every override, measure after a month, then tighten or loosen.
7. **Worktree GC `--force` is irreversible.** The "remote branch deleted" signal is safe in steady state but vulnerable in edge cases: branch deleted by mistake on GitHub, branch deleted before PR merged (force-push gone wrong), local-only branches that intentionally have no remote. Mitigation: log every removal to `.claude/gc-log` with the worktree path and what triggered removal; let users `--restore` for 24h via git reflog.
8. **GitHub sub-issues API surface.** GitHub's native sub-issues are new (2024–2025) and `gh` CLI support is uneven. The decomposition skill might need to fall back to text-based `Part of #N` linkage for older `gh` versions; check capability at runtime.

---

## Sources (deduplicated, grouped)

### Issue-driven dev landscape
- Jimenez et al., *SWE-bench: Can Language Models Resolve Real-World GitHub Issues?*, ICLR 2024 — proceedings.iclr.cc/paper_files/paper/2024/file/edac78c3e300629acfe6cbe9ca88fb84-Paper-Conference.pdf
- Aider, *How aider scored SOTA 26.3% on SWE Bench Lite*, May 2024 — aider.chat/2024/05/22/swe-bench-lite.html
- Lisa, *Issue-Driven Agentic Development*, github.com/tarcisiopgs/lisa (Feb 2026)
- GitHub Awesome Copilot, *one-shot-feature-issue-planner* — github.com/github/awesome-copilot
- anthropics/claude-code-action — github.com/anthropics/claude-code-action
- *Cursor Background Agents Isolation*, iamraghuveer.com/posts/cursor-background-agents/, May 2025
- *Devin Issue Fix Automation*, docs.devin.ai/automation-templates/devin-issue-fix
- SWE-agent docs, github.com/princeton-nlp/SWE-agent
- Cline triage workflow, github.com/cline/cline
- Sweep.dev docs, sweepai/sweep
- nimble-giant/nimble-mold, sighup/claude-workflow, azevedo/dev-workflow
- PatrickJS/awesome-cursorrules, gertalot/cursor-rules

### Failure modes
- Liu et al., *Why LLM Agents Fail*, arXiv 2509.13941, Sep 2025 (150 instances, 25-category taxonomy)
- *Beyond Final Code*, arXiv 2503.12374v3, 2025 (3,977 trajectories)
- APEX-SWE, arXiv 2601.08806
- anthropics/claude-code issues #61932, #54393, #19739, #41350, #46797
- Code With Seb, *Parallel Claude Code Sessions with Git Worktrees*, Apr 2026
- moranbickel/peer-worker-convergence, May 2026

### Triage
- ModelBox, *Introducing SWE-bench Verified*, Nov 2024 — 1,699 samples, 68.3% filter rate
- *SWE-bench Verified Annotation Rubric*, arXiv 2507.09108 (2024) — ICA + TCA scales
- microsoft/SWE-bench-Live validation, 2024
- tarcisiopgs/lisa README — `spec_compliance`, `proof_of_work`, `needs-spec` label
- sweepai/sweep `on_ticket.py` — 15-char minimum check (2023)
- OpenHands Event-Based Automations docs (2026)

### Decomposition
- GitHub Changelog, *Create sub-issues with Copilot*, Aug 2025
- GitHub Docs, *Use Copilot to create or update issues*
- github/awesome-copilot, `one-shot-feature-issue-planner.agent.md`
- github/gh-aw `plan.md` workflow — hard cap of 3–5 sub-issues
- kelsi-andrewss/claude-multi-agent-pipeline — SQL-backed epic/story tracking
- addyosmani/agent-skills `task-decomposition` SKILL.md — 7-cognitive-unit working memory limit
- syarif, *We Built 47 Microservices and Regretted It*, Medium, Feb 2026

### Worktree GC
- git-scm.com, `git-worktree(1)` docs, v2.54.0 (Apr 2026)
- Kunwar, *Bulk cleaning stale git worktrees*, brtkwr.com, Mar 2026 — 256→28 worktrees, 27 GB reclaimed
- Sleczka, *Parallel Claude Code Sessions with Git Worktrees*, Code With Seb, Apr 2026
- Phasr, *Git worktree isolation*, phasr.sh, Mar 2026

### Dropped as unverifiable
- `clawrxiv.io/abs/2604.00690` "Task Decomposition Granularity Phase Diagram" — domain is not a recognised preprint server; the "0.85√S subtasks" formula did not propagate into the design implications.
