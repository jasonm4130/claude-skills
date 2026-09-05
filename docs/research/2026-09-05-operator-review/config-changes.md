# Config changes implied by the decision list

Checklist, grouped by file. Each item names the decision it serves (D-n in `operator-review.md` section 6) and the evidence. Only changes the evidence supports; items marked "later" wait on a named precondition. Line numbers were read on 2026-09-05. Byte target for `~/.claude/CLAUDE.md`: under 12,288 B, the band `claude-md-guard` already enforces; it is 14,320 B with 8 lines over 400 chars [E5.5]; re-read for this pass it is 14,462 B with nine (lines 13, 15, 39, 41, 51, 88, 115, 122, 134).

## ~/.claude/CLAUDE.md (via `chezmoi source-path ~/.ai/AGENTS.md`, then `chezmoi apply`)

- [ ] D-8. Line 9, rule 1: replace the closing clause (one question at most, never a list) with "One question when the next step is obvious; a structured multi-option gate (AskUserQuestion) before any multi-step or irreversible work, ending in a written spec." Nine explicit asks for a conversation before execution; correlational, so re-measure plan-mode and AskUserQuestion rates in a month [E5.9, R7.7].
- [ ] D-8. Same section, one added sentence: "In AskUserQuestion, randomise option order and always include 'none of these; here is what I need to know first'." Deference is positional (80.0% recommended, 64% first option unlabelled) and the local unlabelled control (43.2%) does not replicate the archive (72.1%), so randomise rather than move the anchor; do not ban the label [E4.3, E4.16, R7.1].
- [ ] D-3. Line 92, "What to confirm before doing": add "When a plan will need classifier-gated actions ($HOME config writes, installs, deploys, service restarts, merges), name the exact commands in the plan-gate question so approval exists before the classifier evaluates them." Cross-repo fact currently living only in `memory/retro_feedback_frontload_gated_permissions.md`; ~30 unblocking turns across 15+ repos [E5.7, E2.8].
- [ ] D-9. Line 55, "Plan before non-trivial work": keep two sentences and move enforcement to the UserPromptSubmit nudge below, or delete the section. An unenforced mandate bought 8 of 78 sessions [R4.11].
- [ ] D-25. Line 65, "Long sessions get split at milestones...": replace with "Open a second session when an unrelated topic arrives. Unlock 1Password before dispatching anything long." Duration is not the tell; stalls of 9.6-19.8 h are waiting on Jason [E4.9, E4.12].
- [ ] D-9. Line 122, "Delegate volume, keep judgment": keep the what-to-delegate sentence; delete the tiering-mechanics sentence that duplicates `~/Work/Git/CLAUDE.md` line 13 and the hook's deny message [R4.2, E5.2].
- [ ] D-9. Line 133, gate 5: replace "the file stays under 200 lines" with "the file stays inside the 12,288 B band claude-md-guard enforces". The 200-line test passes a file the hook fails [E5.5].
- [ ] D-9. Line 134, gate 6: replace "There is no global store" with "`~/.claude/rules/` is the global store: one unscoped file for universal behaviour, `paths:`-scoped files for domain facts. Route cross-repo retro findings there." [E5.8, R4.12].
- [ ] D-18 (if "prose"). Under "Never claim a result you didn't observe", one sentence: "At session close, list each claimed-done item with the command run and its output; anything not run is 'unverified'." Three closings handed verification to the party that did the work [R7.6]. If "hook", see Stop hook below instead.
- [ ] Do not add: a second rule about probing before diagnosing (the existing "Reading a thing is not running it" stays as is) [E2.9]; a second confident-negative rule (the mechanical version goes in the workflow report contract, below) [E2.3, E3.16].
- [ ] D-9. After the edits, `wc -c` must read under 12,288; the 8 long lines are the first candidates for cutting [E5.5].

## ~/Work/Git/CLAUDE.md

- [ ] D-4. Lines 5-9, "LSP-First Code Navigation": delete line 9 (it describes the hook being deleted); cut line 7 to "In code files, prefer `hover` and `documentSymbol` to reading a whole file for a type or its structure. Grep is for text." That is the part a hook could never say [R4.2, E5.1].
- [ ] D-9. Line 13: delete "(measured: 73% of dispatches leaked this way before this rule existed)" and the second sentence describing the hook. The hook carries the rule; "never state a rule twice" applies [E5.2].
- [ ] "Implementation plan path" section: it references SDD, retired 2026-09-05 (brief ground fact); repoint to the nightshift plan format.
- [ ] Do not add codex-review calibration text here; it goes in the skill prompt (below) [R2.19].

## ~/.claude/rules/

- [ ] D-9. Split `harness-behaviours.md` (4,655 B, no `paths:` frontmatter). Keep unscoped: GUI-coordinate, Gmail truncation, Gmail draft, WebFetch paragraphs. Move to a new `code-harness.md` with `paths: ["**/*.{ts,tsx,js,mjs,py,rs,go,sh}"]`: sandbox write allowlist, worktree isolation, codex stdin, background-jobs. `paths:` scopes by file, not by tool, which is why the Gmail rules stay [R4.12]; the volume argument for moving them [E5.6] is declined on that mechanism.

## ~/.claude/settings.json

- [ ] D-3. `autoMode.environment`: regenerate from a real repo (run the profiler from `~/Work/Git/claude-skills`), or hand-edit the "Primary use of Claude Code: personal/hobby use" and "Trusted repo: ... /Users/jasonmatthew ... 0 tracked files" lines. Then re-measure classifier blocks in a fortnight (baseline 42 in 14 days) [E1.10, E1.9].
- [ ] D-3. Decide whether development sessions keep starting in `$HOME` (45% of local sessions, 34% of spend); if yes, the delegation and escalation rules in `~/Work/Git/CLAUDE.md` never load there [E1.10].
- [ ] D-20. Add `"subagentPromptCacheTtl": "1h"` (v2.1.242+). Baseline sidechain cache_create 244,332,750 : cache_read 3,044,727,576 (12.5:1). Re-measure after a week; remove the key if the ratio does not move [R4.4].
- [ ] D-27. Leave `"autoCompactWindow": 400000`. Halving main-loop context moves ~7% of token cost and compaction is not a churn cause; revisit only if `/usage` flags long context at 10% or more [E1.2, E6.4, E6.9, R4.14].
- [ ] D-21 (later). `advisorModel`: leave unset until the tier swap lands; then one week of an Opus advisor with Sonnet fan-out workers on a non-critical repo. Fable rejects an Opus or Sonnet advisor; subagents inherit the configured advisor [R4.7].
- [ ] D-3 (optional). Permission allow rules for the families that keep tripping the classifier: docker and ssh against brok, wrangler, `terraform apply` [E4.14]. The plan-gate sentence is the primary fix.
- [ ] D-15. `enabledPlugins`: set `"handoff@jasonm4130-claude-skills": false` and uninstall; auto-fire has been at HANDOFF_THRESHOLD_PCT=999 since 2026-08-08 [E5.10, E4.8].
- [ ] D-18 (if "hook"). Stop hook that checks the final assistant message for a verification block per claimed-done item, accepting the 8-consecutive-block override [R7.6, R7.10].
- [ ] D-7. UserPromptSubmit hook (or in `plugins/gates`): when the prompt contains "workflow", "best in class", "research" or "audit" and the session is not already in plan mode, inject: "Before dispatching: 5-8 forced-choice questions, a written spec file, and a two-minute pre-mortem (assume it shipped and failed; three most likely causes)." Nudge, not deny; re-measure spec-before-fanout in two weeks; escalate to a main-loop-only Workflow deny only if unchanged, held to the agent-model-guard acceptance test [E4.7, E4.10, R7.2, E5.2].
- [ ] D-25. Notification on completion for long workflows instead of polling (five consecutive "still running?" turns in one session) [E4.12].

## ~/.claude/agents/

- [ ] D-17. `Explore.md`: add `disallowedTools: Write, Edit, NotebookEdit` to the frontmatter and delete the "READ-ONLY. Do not create, edit, delete, or move files..." bullet it replaces. Bash stays, because auto mode routes discovery through the shell [R4.8, E1.11].
- [ ] D-17. `worker.md`: add `memory: project`. Main-conversation auto memory is not loaded into subagents [R4.8].

## ~/Work/Git/claude-skills/plugins/gates

- [ ] D-4. `hooks/hooks.json`: remove the `"${CLAUDE_PLUGIN_ROOT}/bin/ccguard" lsp-first` entry under the Bash matcher; `git revert 136097b`; delete `go/lspfirst.go` (keep `bashsearch.go` if another guard uses it). 354 denials, 2.3% conversion, LSP peaked before the guard [E5.1, E1.4, E1.14].
- [ ] D-4. Audit remaining matchers for Grep or Glob; auto mode produces neither (local Grep 0, Bash 26,268) [E5.13].
- [ ] Leave `pretooluse-guard-workflow-model.mjs:72` alone. 954 of 1,295 agents are already pinned; tightening would fragment fan-out prefix sharing [E1.3, R4.13]. Revisit only after the A/B in D-20: if uniform prefixes win, change the rule to "the fan-out names one model per phase".
- [ ] Keep `pretooluse-guard-agent-model.mjs`; its Jul 1-10 vs Jul 11-23 curve is the acceptance test every other guard must meet [E5.2].
- [ ] docs-sync: no change; add a one-line fire/ack/doc-edit record per firing and re-read in a month before deciding whether a 63% ack rate is design or over-firing [E5.3].
- [ ] Later. `if:` conditions on the gates hooks that currently run to decide they do not apply [R4.9].

## ~/Work/Git/claude-skills/.claude/hooks/no-route-around-ci.mjs (and ambient's copy)

- [ ] D-16. Port docs-sync's heredoc stripping; exempt quoted string literals and any command whose leading binary is read-only (`rg`, `grep`, `sed`, `awk`, `ls`, `cat`, `jq`). It denied `cat > index.py <<'EOF'` on 2026-09-05 06:13:42Z because the body contained a merge string [E5.11].

## ~/.local/bin/claude-hooks secrets-scan

- [ ] Keep. One deliberate red-team write per quarter; six blocks in 4.5 months were all its own tests [E5.4].

## plugins/session-retro, ship-gate, gates:docs-consolidate

- [ ] D-15. Fix the emitOffer nesting (`systemMessage` inside `hookSpecificOutput`) that makes session-retro's Stop hook fail JSON validation and hides the offers; re-measure before retiring any of the three [E5.12, E5.10].
- [ ] Later. A CI test in claude-skills that runs each plugin's hooks against a fixture payload and fails on invalid JSON, a missing interpreter or a missing plugin directory; the repo has no behavioural test layer [E5.12].

## plugins/nightshift/templates/loop

- [ ] D-1. `config:30` and `land.sh:40`: `SKEPTIC_BUDGET:=1` to 5 (ambient's 624012f) [E6.1].
- [ ] D-1. `land.sh:317` `*)` arm (the case block runs 311-318): add a `"")` arm that logs "skeptic returned no verdict (budget or timeout)" and retries the skeptic once, else blocks with that reason; never feed the generator an empty refutation [E6.1].
- [ ] D-1. Back-port ambient 624012f to the template [E6.1].
- [ ] D-2. Generator call: add `--permission-prompts none` (v2.1.259) and `--max-budget-usd`; hypothesis for the first 02:00 run, since one attempt ended "BLOCKED: Edit/Write require approval that this session cannot obtain" [R4.10, E6.2].
- [ ] D-2. Leave `~/Library/LaunchAgents/dev.nightshift.ambient.plist` at 02:00 and do not touch the loop for three nights; report from journal.md, not run dirs, for anything before 2026-09-05 14:34 [E3.5, E6.5].
- [ ] D-12. `SKEPTIC.md`: strengthen the existing "a diff you cannot fault is OK" line to "VERDICT: OK with zero findings is the expected result on a correct diff; do not manufacture findings" [R7.13, R6.9].
- [ ] D-12. Journal: beside each landed PR record reverts, fix-forwards and Jason overrides; override rate is the trust signal [R1.1, R1.5].
- [ ] D-11. Plan template: add `Job: product | quality` and `Risk: edge | core` per task; the loop takes only edge tasks [E3.6, R1.13].
- [ ] Pre-launch: grep the task text's literal CHECK_CMD against `land.sh:213`'s exact-match gate and the repo's `settings.json` Bash allow list [E6.6].
- [ ] ambient `.claude/settings.json`: add `Bash(scripts/quality:*)` or dismiss the round-1 finding in writing [E6.6].
- [ ] Later. Split `MODEL` into `GEN_MODEL` and `SKEPTIC_MODEL` (`config:28`, `land.sh:38`, `ask` at `land.sh:167`); after three 02:00 runs, test generator=sonnet effort high with skeptic=opus for a week, comparing REFUTE rate, turns and landed-task rate [E6.7].
- [ ] Later. `monitors/` entry tailing the journal into the morning session, once unattended runs exist [R4.9].
- [ ] Do not add a Cloudflare-shaped multi-reviewer gate; the record already shows over-rejection [R1.5, E6.1, E6.6].

## plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs

- [ ] D-13. Reviewer prompt: cap output at ~5 findings ranked by confidence; zero findings is a valid, expected result [R2.19, R7.13].
- [ ] D-13. Early exit: end the chain when a round produces no unique finding; keep MAX_REVIEW_ROUNDS=3 [E6.11].
- [ ] D-13. Before opening a chain, check the log for an open chain on the same repo and artifact and resume with `--chain`; 5 same-content-hash repeats [E6.10].

## Workflow scripts (the three largest fan-outs: wf_6ba193c9, wf_12575914, wf_cdc23c2d shapes)

- [ ] D-6. First, one join of sidechain rows to their parent session's model over the existing index [R4.15].
- [ ] D-6. Then set audit and research readers to `model: "sonnet"`, one model per fan-out phase, matching effort, tools and cwd [E1.3, E2.14, R4.13].
- [ ] D-6 (optional, unattended research runs only). `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` with `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` (v2.1.257+); not for nightshift, whose generator is not the settled-spec shape [R4.5, E6.7].
- [ ] D-19. Report contract in the workflow templates: every report ends in a numbered decision list answerable one word each; any "X does not exist" or "unresolvable gap" claim names and runs the enumerating command and quotes it [R7.9, E2.3, E3.16].
- [ ] Before any fan-out over ~50 agents: one sentence naming what the output feeds, when it gets read, and the expected quota and wall clock; no owner, no launch [E1.7, R7.11].

## Commands to run

- [ ] D-5. `/usage` (read the plan-usage breakdown), `/insights`, `/skill-doctor` [R4.14, R4.6].
- [ ] D-10. `cd ~/Work/Git/claude-skills && node benchmarks/harness/run.mjs` on the PR #49 branch (~2h), then `gh pr view 49` and merge or close; `gh pr view 50` and close or schedule [R7.5].
- [ ] D-12. codex-review diff mode over the nine landed nightshift PRs; count findings that survive [R5.1].
- [ ] D-11. Record one real ambient meeting; read the transcript end to end [E3.11].
- [ ] D-14. Archive or publish: `social-mcp`, `content-ops`; pick one of endurebyte, skopia, games, transcoder [E3.9, E3.12].
- [ ] D-23. Calendar: expiry review on the next model-family upgrade; write the retirement condition into the next plugin's README [R1.8, E3.7].
- [ ] D-26. Monthly: plan-equivalent cost per merged non-reverted PR, tooling vs product; weekly: repos at 20+ commits [R1.9, E3.13].
- [ ] Optional weekly: `npx ccusage@latest`; do not stand up the OTel/Grafana stack [R5.2].
- [ ] If the shipping analysis is ever re-run: fix `REVIEW/out/E3-shipping/classify.py` line 38 so `mine` excludes the `claude` identity, and weight by lines changed [E3.14, E3.2].

## Memory and marketplace

- [ ] D-3. Leave `retro_feedback_frontload_gated_permissions.md` in place; its rule now lives in CLAUDE.md [E5.7].
- [ ] D-22 (later). `plugins/writing-artifacts/evals/` and `plugins/domain-modeling/evals/`: three ablation cases each with a rubric the no-plugin baseline fails; run with `CLAUDE_CODE_WALNUT_SPIRE=1 claude plugin eval ... --ablation with-without` [R5.3, R4.3].
- [ ] D-27. No change: session model default [E6.13]; the local skeptic (`docs/research/2026-09-05-local-skeptic-inference.md` closes it) [R5.7]; spec-kit (read its task template once against `loop/task-brief`, twenty minutes) [R5.5]; MCP servers [R5.6]; error-triage subscription until error volume exists [R5.8].
