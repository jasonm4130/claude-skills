# Agent roster evaluation

Date: 2026-09-06. Tree read: branch `nightwatch-redesign` at `68989c0`, not `main`. The task named `main`; every line number below is against `68989c0`, which is past every commit the three proposals cite. Re-grep for `agentType:` and `agent(` before editing.

## Headline

The two agents you have are well made and correctly tiered, so keep both and add exactly one. The real defect is not roster size but roster scope: a published plugin (`nightshift` 0.1.7) dispatches `agentType: 'worker'` against a file that exists only at `~/.claude/agents/worker.md`, so the fix is to commit `worker.md` at project scope — a step already planned and empirically validated in `docs/research/2026-09-05-nightwatch-redesign.md` §9 item 3, which never landed. Add a read-only `verifier` for the four Verify and Reconcile sites, because the only enforcement reaching the headless child matches `Bash` and an `Edit` by a Verify agent is unguarded today.

## What we have

Nothing is broken on this machine. `run.sh:129` passes `--setting-sources user,project` and the redesign doc §7 records that a Workflow calling `agentType: 'worker'` resolved the user-level agent under headless `claude -p`. The distribution defect bites third parties and future machines, not this one. Those are two different severities and all three proposals blurred them into one.

| Item | Path | Facts |
|---|---|---|
| `Explore` | `/Users/jasonmatthew/.claude/agents/Explore.md` | 1769 B, `model: sonnet`, no `effort`, `disallowedTools: Write, Edit, NotebookEdit`. No dispatch site in any repo script. |
| `worker` | `/Users/jasonmatthew/.claude/agents/worker.md` | 1375 B, `model: sonnet`, `effort: medium`, `memory: project`, full toolset. |
| Dispatch sites | `plugins/nightshift/nightwatch/nightwatch.mjs` | `agentType: 'worker'` at 171, 188, 219. Plain `agent()` elsewhere. |
| Launcher | `plugins/nightshift/nightwatch/run.sh` | `MAIN_MODEL:=sonnet` (128), `SETTING_SOURCES:=user,project` (129), `UNIT_BUDGET:=8` (125), hooks registered `matcher: "Bash"` (160). |
| Guards | `plugins/gates/scripts/pretooluse-guard-agent-model.mjs`, `pretooluse-guard-workflow-model.mjs` | Resolve `<cwd>/.claude/agents` then `~/.claude/agents`; workflow guard bypasses on `/\bmodel\s*:/`. |
| Repo agent dirs | none | `find . -name worker.md -o -name Explore.md -o -type d -name agents` returns nothing. |

Model and effort at every `agent()` call, read off `68989c0`:

| Line | Phase | Dispatch |
|---|---|---|
| 125 | Record | `model: 'sonnet', effort: 'low'` |
| 133 | Reconcile | `model: 'sonnet', effort: 'low'` |
| 143 | Plan | `model: 'opus', effort: 'high'` |
| 171, 188, 219 | Implement, repair, eval-repair | `agentType: 'worker', effort: 'medium'` |
| 180, 192, 224 | Verify ×3 | `model: 'sonnet', effort: 'low'` |
| 202, 227 | Eval, re-eval | `model: 'opus', effort: 'medium'` |

## Best in class today

Only claims I confirmed from a fetched URL or a file I read.

| Claim | Source | Date |
|---|---|---|
| Agent frontmatter supports 17 fields including `effort`, `memory`, `isolation`, `disallowedTools`, `experimental.cacheTtl` | https://code.claude.com/docs/en/sub-agents | fetched 2026-09-06 |
| Tool restriction is a first-class reason to use a subagent | https://code.claude.com/docs/en/sub-agents | fetched 2026-09-06 |
| Descriptions should be short, say "use proactively", push detail to the body; a 15,000-token combined-description warning fires at startup | https://code.claude.com/docs/en/sub-agents | fetched 2026-09-06 |
| `/tasks` now shows the model and effort each subagent ran on | Claude Code CHANGELOG line 546 | undated; version 2.1.243 |
| `experimental.cacheTtl` added to agent frontmatter | Claude Code CHANGELOG line 382 | undated; version 2.1.248 |
| wshobson/agents: 202 agents, 94 plugins, no benchmark numbers in README | https://github.com/wshobson/agents | fetched, dossier |
| wshobson Discussion #42: a user calls the agents "too broad, very generic" | https://www.heyuan110.com/posts/ai/2026-04-20-wshobson-agents-deep-dive/ | 2026-04-21 |
| VoltAgent: 158+ subagents, 10 categories, read-only agents get `Read, Grep, Glob`, no cited evals | https://github.com/VoltAgent/awesome-claude-code-subagents | fetched, dossier |
| obra/superpowers and mattpocock/skills ship skills, zero named agents | https://github.com/obra/superpowers, https://github.com/mattpocock/skills | fetched, dossier |
| No collection in the field documents an advisor pattern | all four repos above | fetched, dossier |
| Opus lead + Sonnet subagents beat single-agent Opus by 90.2% on Anthropic's internal eval; multi-agent uses ~15x chat tokens | https://www.anthropic.com/engineering/multi-agent-research-system | fetched, dossier |

Two claims this report leans on are **not** confirmed and are excluded from the table: that Anthropic's effort docs name `low` as the subagent fit, and the LLM-reviewer over-correction finding (arxiv 2603.00539). Both sit in the dossier's unverified bucket. Where they appear below they carry that label.

The field splits into two camps: 150-200+ generic agents with no evals (wshobson, VoltAgent) and zero agents with skills instead (superpowers, mattpocock). Two sharp, model-pinned, tool-restricted definitions sits closer to the second camp and is the better shape. Nothing in the field matches `worker.md`'s advisor-consult protocol or its stop-and-report-the-conflict clause.

## Verdict on Explore and worker

### Explore: keep, one description edit, hold effort pending a check

The body is right and the pin is grounded in a local measurement I re-read: `RESEARCH_delegation_model_tiering.md:31` records "Explore omitted 71/75" and line 17 names it "the worst bucket". Line 66 records the v2.1.198 change that made the built-in inherit. That is the single biggest measured leak and the shadow is the docs-blessed fix.

Two changes.

**Add a negative scope to the description.** `~/.claude/CLAUDE.md` requires every skill and agent description to carry one. `worker.md` has it; `Explore.md` does not. Add "use proactively" at the same time, which the sub-agents page endorses for auto-delegation.

**Do not pin `effort` blind.** `~/.claude/settings.json` sets `effortLevel: high` with `modelSettings` overrides only for `claude-fable-5` and `claude-opus-5`, so a Sonnet subagent with unset effort plausibly runs high. "Plausibly" is the honest word. Settle it with the positive check the changelog already gives you: dispatch one Explore, open `/tasks`, read the effort it ran on (2.1.243, line 546). If it reads high, set `effort: low`. The cost of pinning is real and the minimalist proposal identified it correctly: effort comes from the definition, not the call, so `low` cannot be raised per-dispatch, and the description's own "very thorough" breadth mode is a prompt lever, not an effort lever.

Do not switch to `haiku`. `RESEARCH_delegation_model_tiering.md:70` records that an org `availableModels` allowlist silently skips excluded models and falls back to inherit, and `pretooluse-guard-agent-model.mjs:104` would still exit 0 because it only checks the frontmatter model is present and not `inherit`. That is a silent regression path.

### worker: keep the body verbatim, commit it at project scope, drop `memory: project`

The minimalist proposal argued the definition is dead weight because every clause is duplicated at the call site. I read `implPrompt` at `nightwatch.mjs:165-170` and that is about two-thirds true, not wholly true.

Duplicated, so genuinely redundant:

- The advisor instruction. `implPrompt` line 165 reads "Consult the advisor once before committing to an approach, and again if the same error recurs." Verbatim.
- The commit discipline. Line 170 reads "Commit with `git add <specific paths>` then `git commit -m \"<what and why>\"`, never `git commit -a`." Verbatim.
- `model: sonnet` is the same tier `MAIN_MODEL:=sonnet` would inherit; `effort: medium` is re-passed explicitly at all three sites.
- The "final message is your entire product" clause is superseded by the `IMPL` schema.

Not duplicated anywhere, so lost if you sever:

- "If the spec is ambiguous or contradicts the code you find, STOP and report the conflict as your result instead of guessing."
- "Touch only the files the task requires. No adjacent 'improvements'."

Those two clauses are the reason to keep the agent rather than delete it and fold the rest into `implPrompt`. Severing is not the free subtraction it was sold as.

**`memory: project` is inert and should go.** `/Users/jasonmatthew/.claude/projects/-Users-jasonmatthew-Work-Git-nightwatch-ambient/memory/` and the `-transcoder` equivalent both list nothing but `.` and `..`. It advertises a capability that has never fired. Note the mechanism, because two proposals got it wrong: the clone is **not** recreated per run. `init.mjs:263-286` does `git clone -q origin clone` only when `.git` is absent and otherwise reports "already cloned at ${clone}" and skips. Project memory keyed to that path would persist across nights. It is empty because nothing writes to it, not because the path churns.

## Roster recommendation

| Agent | Action | Model | Effort | Tools | Serves | Why |
|---|---|---|---|---|---|---|
| `Explore` | change | sonnet | unset today; set `low` after the `/tasks` check | `disallowedTools: Write, Edit, NotebookEdit` | interactive sessions; `plugins/adr/skills/adr/SKILL.md:31` names it in prose; the `agent-model` guard's pinned-model ack | Fixes the 71/75 measured leak. Description gains the negative scope its own authoring rule requires. |
| `worker` | change | sonnet | medium | full toolset; drop `memory: project` | `nightwatch.mjs:171, 188, 219` | Two clauses are unique to it. Commit at project scope to close the distribution defect. |
| `verifier` | add | sonnet | low | `disallowedTools: Write, Edit, NotebookEdit` | `nightwatch.mjs:133, 180, 192, 224` | Turns a prose invariant into a partial mechanism at the four sites where the report is the product. Behaviour-neutral: same tier and effort they already run at. |
| Plan | no agent | opus | high | n/a | `nightwatch.mjs:143` | One site, one judgment call, prompt inseparable from workflow state. A definition would carry only the two opts already passed. |
| Eval | no agent | opus | medium | n/a | `nightwatch.mjs:202, 227` | Two prompts that genuinely differ (first pass vs. re-check-these-concerns). See rejections below. |
| Record | no agent | sonnet | low | n/a | `nightwatch.mjs:125` | Prompt is complete inline. Costs description tokens in every session for nothing. |
| codex / Terra | no agent | gpt-5.6-terra | codex default | n/a | `plugins/codex-review/.../codex-review.mjs` | External process. No Claude frontmatter reaches it. |

Three definitions total. That is one more than today and roughly two hundred fewer than the field.

### Why `verifier` is the one addition worth making

This is the strongest novel finding across the three proposals and I confirmed it. `run.sh:152-160` assembles both template hooks under `matcher: "Bash"`. `plugins/nightshift/templates/hooks/tests-are-readonly.mjs` fires only on `git commit`, reading the staged diff. So an `Edit` on a source or test file by a Verify agent passes both hooks untouched. Today the only thing holding those four phases to "change nothing; commit nothing" is prose in `RULES` (line 48) and the Verify prompt (line 179).

`docs/research/2026-09-05-nightwatch-redesign.md` §6 rests the whole trust argument on "the PR body being literal captured output rather than a model's account of itself". An agent that can edit what it is measuring weakens exactly that.

It is safe to restrict Write. `RUNCMD` at `nightwatch.mjs:46` writes its logs through bash redirection (`bash -c '<command>' > ${logDir}/${prefix}-<i>.log 2>&1`), not the Write tool, so a read-only agent runs the contract unchanged.

**State the limit honestly.** `disallowedTools: Write, Edit, NotebookEdit` does not constrain Bash, so `bash -c 'echo x > file'` still writes. This closes the observed failure path, not every path. It is a mechanism where there was none, not a proof.

## Frontmatter sketches

These are sketches for a human to apply. I edited no agent file.

### `~/.claude/agents/Explore.md`

```yaml
---
name: Explore
description: Read-only search agent for broad fan-out searches — use proactively when answering means sweeping many files, directories, or naming conventions and only the conclusion is needed, not the file dumps. It reads excerpts rather than whole files, so it locates code; it doesn't review or audit it. Specify search breadth: "medium" for moderate exploration, "very thorough" for multiple locations and naming conventions. Do NOT use for reviewing or auditing code, for edits of any kind, or for a single known file (read it directly).
model: sonnet
disallowedTools: Write, Edit, NotebookEdit
---
```

Body unchanged, including the provenance comment. Add `effort: low` only after `/tasks` shows a Sonnet subagent running at high.

### `.claude/agents/worker.md`, committed in the target repo

```yaml
---
name: worker
description: Tiered implementation worker for well-specified grunt work — multi-file mechanical edits, transcription from a settled spec, refactors with a clear rubric. The dispatch prompt must contain the complete spec; this agent executes, it does not design. Do NOT use for open-ended search (use Explore), for verification-only runs (use verifier), for design decisions, or for anything needing conversation context not included in the prompt.
model: sonnet
effort: medium
---
```

Body copied verbatim from `~/.claude/agents/worker.md`. `memory: project` removed. The only description change is the added `verifier` pointer.

### `.claude/agents/verifier.md`, committed in the target repo

```yaml
---
name: verifier
description: Read-only verification agent — runs the commands it is named, reports exit codes and output verbatim, and cannot edit, write or commit. Use proactively when the report IS the product: acceptance runs, repo checks, git-state reconciliation. Do NOT use to fix what it finds (dispatch worker), to decide anything, or for open-ended search (use Explore).
model: sonnet
effort: low
disallowedTools: Write, Edit, NotebookEdit
---
```

Body:

```
You run commands and report what happened. You never change the thing you are measuring.

- Run exactly the commands the prompt names, in the order given, and nothing else.
- Never repair a failing command. A failure is a result, not a problem to solve.
- Deleting an artifact an acceptance command itself wrote (a screenshot, a build output)
  is not a change to what you are measuring. Delete it and do not report it.
- If a command cannot run at all, say so and stop. Do not substitute a similar one.
- Your final message is your entire product: the dispatcher sees nothing else.
```

The body is deliberately short. The log-naming rule is already verbatim in `RUNCMD` (`nightwatch.mjs:46`) and the must-fail-is-a-PASS semantics are already verbatim in `verifyPrompt` (line 179). Repeating them here would be the same accretion problem that argues against an `evaluator`. The definition carries only what the prompts do not.

The deletion carve-out is not optional. `nightwatch.mjs:133` instructs Reconcile to delete an untracked file an acceptance command wrote, and `verifyPrompt` repeats it. A `verifier` that obeys a blanket "never change anything" leaves the screenshot, `git status --porcelain` comes back non-empty, `clean` goes false, and the launcher burns a repair round on a file that was never a problem.

### Call-site change at `nightwatch.mjs:133, 180, 192, 224`

```diff
-  { label: `verify:u${unit}`, phase: 'Verify', schema: VERIFY, model: 'sonnet', effort: 'low' }
+  { label: `verify:u${unit}`, phase: 'Verify', schema: VERIFY, agentType: 'verifier', effort: 'low' }
```

### Distribution

Do not build an `init.mjs` render step for this. The clone is `git clone -q origin clone` (`init.mjs:284`), so a `.claude/agents/*.md` committed in the target repo travels into the clone for free, and `init.mjs:304-316` already sets `hasTrustDialogAccepted` so project settings are honoured. `run.sh:129` already includes `project` in `SETTING_SOURCES`.

Project scope, not a plugin `agents/` directory, for two reasons. The `nightshift` plugin description says the loop "runs `claude -p --setting-sources project`, where installed plugins never load". And `pretooluse-guard-agent-model.mjs:100-108` resolves only `<cwd>/.claude/agents` then `~/.claude/agents`, so a plugin-shipped agent would resolve to nothing there and be denied on any interactive dispatch.

An `init.mjs` render is the second-order answer for keeping N target repos in sync. `docs/research/2026-09-05-nightwatch-redesign.md` §7 already names its resolution: "A CI diff check between the two, or accept the drift explicitly." Carry that resolution rather than re-opening the question.

**Apply both `worker` edits to the user-level file in the same change.** The sketch above drops `memory: project` and adds the `verifier` pointer to the description. If only the committed copy gets them, a CI diff check against `~/.claude/agents/worker.md` fails on arrival. The two files are not independent going forward either: the committed copy shadows the user copy for every interactive session in that repo, which is the precedence your own guard mirrors at `pretooluse-guard-agent-model.mjs:100-108` (project `.claude/agents` before `~/.claude/agents`).

## What we deliberately do not adopt, and why

| Rejected | Why |
|---|---|
| Roster scale (150-200+ agents) | wshobson ships 202 across 94 plugins and VoltAgent 158+ across 10 categories, both with zero cited evals. wshobson's own Discussion #42 records the "too broad, very generic" criticism. Copying the shape multiplies description tokens against a documented 15,000-token startup warning for no measured gain. |
| Severing `worker` from nightwatch | Sold as free. It is not: the stop-and-report-the-conflict clause and the no-adjacent-improvements clause exist nowhere else. Severing means folding them into `implPrompt`, which trades a resolvable dependency for a longer prompt and loses the interactive dispatch site. |
| An `evaluator` agent for Eval | The two sites at 202 and 227 run genuinely different prompts: a first-pass rubric and a re-check-these-named-concerns pass. arxiv 2603.00539 (**unverified**) finds LLM reviewers over-reject correct code and worsen with more elaborate scaffolding, so consolidating the rubric into one definition that then grows by accretion is the failure mode, not the fix. The current prompt's "Style, naming, and 'could be better' are not concerns" is already the evidence-backed shape. |
| `planner`, `scribe`, `researcher` agents | Plan is one site with a prompt inseparable from workflow state. Record's prompt is complete inline. No deep-research plugin ships in this repo, so a `researcher` would serve no dispatch site. |
| Haiku for Record or Explore | Silent-failure path: an `availableModels` allowlist skips excluded models and falls back to inherit (`RESEARCH_delegation_model_tiering.md:70`), and the agent-model guard would not catch it. Record's own comment says a result that never reaches the file is a dead unit. |
| `isolation: 'worktree'` | The dossier's worktree-isolation bug claim is refuted, and the per-run clone already is the isolation. `~/.claude/rules/code-harness.md` records that worktree isolation resolves against an ambient directory, not the named repo. |
| `experimental.cacheTtl` | Real (changelog 2.1.248, line 382) but nightwatch runs one sequential unit per headless invocation, so there is no cross-agent cache prefix for a per-agent TTL to preserve. |
| `maxTurns` | `run.sh:125` already caps each unit with `--max-budget-usd`, default 8. |
| Lowering `worker` to `effort: low` | Anthropic reportedly documents `low` as the subagent fit (**unverified**), and I am overriding it either way. `docs/research/2026-09-05-nightwatch-first-night.md:30` records a worker omitting a required schema field five times until the retry cap threw the workflow away. An under-thought implementation burns a repair round plus a re-Verify plus a re-Eval, which costs more than the thinking it saved. |
| A `tools:` allowlist on Explore | VoltAgent's convention, but it would cost `git log -S` and `git grep` to close a hole no incident points at. |
| Stripping Explore's read-only prose | `docs/research/2026-09-05-operator-review.md:106` asks for this. Do not. `disallowedTools` does not cover Bash redirection or git writes, which is exactly what that prose forbids. The record is behind the code here. |

## Evidence quality

The dossier carried **19 confirmed**, **4 refuted** and **29 unverifiable** claims (12 anthropic-docs, 2 community, 15 delegation-evidence). I relied on the confirmed set for the field comparison without re-fetching the four collection repos. None of my recommendations rest on the refuted four. I verified fourteen repo-local facts directly this session and refuted three claims the proposals made.

Two unverified claims do carry weight below and are labelled where used: Anthropic's effort docs naming `low` as the subagent fit (the rejection of `effort: low` for `worker` argues *against* it, so the recommendation survives either way), and arxiv 2603.00539 on reviewer over-correction (one of two reasons to decline `evaluator`; the two-different-prompts reason stands alone).

**Refuted, with the check:**

| Proposal claim | What the file says |
|---|---|
| "run.sh clones fresh per run" (role-per-phase), so `memory: project` accumulates nothing | `init.mjs:263-286` clones only when `.git` is absent, otherwise "already cloned at ${clone}" and skips. The clone persists. Project memory would accumulate; it is empty because nothing writes to it. Right conclusion, wrong mechanism. |
| "Adopting the roster breaks the workflow guard" (role-per-phase lead risk) | The bypass is `/\bmodel\s*:/` on the whole script. After routing Verify and Eval to `agentType`, `model:` still appears at lines 25, 28, 126 and 154. The guard does not fire. The risk is real only for a hypothetical fully-`agentType` workflow. |
| "Project-scope resolution is unverified, probe it" (role-per-phase and best-in-class both) | `docs/research/2026-09-05-nightwatch-redesign.md` §9 item 3 records that under `--setting-sources project` a dispatch failed "Agent type 'worker' not found" with the definition in `~/.claude/agents` alone, and **committing it at project scope fixed the dispatch**. Already probed. |

**Confirmed this session:** the `implPrompt` duplication (`nightwatch.mjs:165, 170`); `RUNCMD` writing via bash redirection (line 46); both hooks registered `matcher: "Bash"` (`run.sh:160`); `tests-are-readonly.mjs` firing only on `git commit`; both clone memory directories empty; no agent file anywhere in the repo; the 71/75 Explore measurement (`RESEARCH_delegation_model_tiering.md:31`); the guard resolution order (`pretooluse-guard-agent-model.mjs:100-108`).

**Recommendations resting on unverified ground:**

1. **Explore's `effort`.** That a Sonnet subagent inherits `effortLevel: high` is inference from `~/.claude/settings.json` having no Sonnet override. I did not observe it. This is why the recommendation is "check `/tasks` first", not "set low".
2. **What a Workflow does when `agentType` resolves to nothing.** Not probed. The severity of the distribution defect for third parties depends on it: a hard error fails the unit loudly, a silent fallback to `MAIN_MODEL=sonnet` completes a night that reads as normal with none of the worker's rules. One throwaway Workflow dispatching a nonexistent `agentType` settles it. The fix is the same either way, so this does not gate the recommendation.
3. **Whether `verifier` changes Verify behaviour at all.** Same model and effort as today, so it should be neutral, but I ran no unit with it. Land it on one night and compare the Verify results before trusting it.
4. **The field comparison.** I did not fetch wshobson, VoltAgent, superpowers or mattpocock myself. Those come from the dossier's confirmed claims.

## Sources

Fetched or read this session:

- `plugins/nightshift/nightwatch/nightwatch.mjs` (lines 20-40, 46-56, 125-228)
- `plugins/nightshift/nightwatch/run.sh` (lines 125-160, 372-398)
- `plugins/nightshift/nightwatch/init.mjs` (lines 186, 240-316, 340-416)
- `plugins/nightshift/templates/hooks/tests-are-readonly.mjs`
- `plugins/nightshift/.claude-plugin/plugin.json`
- `plugins/gates/scripts/pretooluse-guard-agent-model.mjs`, `pretooluse-guard-workflow-model.mjs`
- `~/.claude/agents/Explore.md`, `~/.claude/agents/worker.md`
- `~/.claude/projects/-Users-jasonmatthew-Work-Git-nightwatch-{ambient,transcoder}/memory/`
- `docs/research/2026-09-05-nightwatch-redesign.md` §6, §7, §9
- `RESEARCH_delegation_model_tiering.md` (lines 17, 28-34, 66-70, 133-137)

From the dossier's **confirmed** set, not re-fetched here: https://code.claude.com/docs/en/sub-agents; https://www.anthropic.com/engineering/multi-agent-research-system; https://github.com/wshobson/agents; https://github.com/VoltAgent/awesome-claude-code-subagents; https://github.com/obra/superpowers; https://github.com/mattpocock/skills; https://www.heyuan110.com/posts/ai/2026-04-20-wshobson-agents-deep-dive/; Claude Code CHANGELOG line 546 (2.1.243) and line 382 (2.1.248).

From the dossier's **unverified** set, labelled as such at every use: https://platform.claude.com/docs/en/build-with-claude/effort; https://arxiv.org/abs/2603.00539.
