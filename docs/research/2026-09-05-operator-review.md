# Operator review: Jason Matthew, 2026-09-05

Read section 6, the Decision list, first; read the body only for what would change an answer [R7.9]. Citations: `[E5.1]` is finding 1 (1-based) in `2026-09-05-operator-review/reconciled/E5-tooling.json`; wave-1 numbers are superseded. Denominator: 78 interactive sessions, 675 prompts, 31 flagged corrections in 2026-08-21 to 09-05 [E1.8, E1.1]. E4's per-session rates use the 47 sessions carrying prompts, marked "(of 47)".

## Jason's three hypotheses, one verdict each

1. "I am not doing great at home being in the decision-making chair." Contradicted as stated: free-text refusals of the AskUserQuestion menu rose from 9.8% to 21.5% of answers, p=0.0005 [E4.16], and overrides run both ways, about seven scope cuts to six expansions [E4.4]. Partly true in another sense: they took the "(Recommended)" option 80.0% of the time (204 of 255), it was the first option in 254 of 255 cases, and on 300 questions with no recommendation they still took the first option 64% [E4.3]. Position moves them, not the label.
2. "I fire off workflows without loading context." Behaviourally confirmed: session 82565888 had one human prompt, two Workflow calls, 344 agent transcripts, and no second prompt [E2.15]; session 6f84c451 dispatched a second research pass 11 minutes after the first, before reading any of it [E4.11]. The predicted consequence is absent: short openers produce 0.040 flagged corrections per prompt against 0.054 for long ones [R7.3]. The cost is which problem gets chosen, not rework.
3. "More Socratic questioning would help." Confirmed and already underway: explicit Socratic requests rose from 2% to 13% of sessions, p=0.004, one of only two significant trends in the whole set, both of them Jason improving [E4.10, E4.17]. It works every time it is asked for, and is still a request, not a mode.

## 1. Usage: what works, what fails, where the models fail

**The currency is quota and wall clock.** The local period is $2,510 at list price, $179 per active day, within 3% of the archive's $175, so the model migration did not change burn; on a Max plan that is opportunity cost, never a bill [E1.1]. The one measured loss in the record is a benchmark run killed at a usage rollover in July and never resumed [R7.11]. Cache read is 57% of token cost and output 13%; the main loop carries 199,418 tokens per turn [E1.2]. Subagents are ~53% of token cost and cache creation 33% of it; halving the main loop's context would move ~7% [E6.4]. The lever is what subagents are handed and which tier runs them, not verbosity.

**Working.**
- Nightshift's one-plan-task-per-CI-gated-PR is small-batch discipline, a named DORA capability, and the strongest thing in the setup [R1.4]. Nine PRs landed for $36.87 across five journals, $4.10 per landed PR [E3.5]. The skeptic caught a real integration bug in the plan text on task 4, round 0 [E6.6].
- agent-model-guard is the one guard with a measured save: untiered dispatches fell from 69% (Jul 1-10) to 6% (Jul 11-23) the day it landed, and 793 of 1,030 tiered dispatches went to Sonnet [E5.2]. The interactive Agent path is done: 1 of 39 Opus dispatches was small or mechanical [E6.8].
- Delegation by volume holds: 1,425 of 1,503 local transcripts are subagents carrying 78.3% of cache-creation tokens [R5.2].
- Pruning is real and rare: 11 of the 18 July plugins are gone, 61% [E3.7]. The household stack (transcoder, brok-stacks, Coach, unifi, claude-statusline) is demonstrably load-bearing [E3.10].
- No cache churn; compaction is not a churn cause [E6.9]. Codex-review cache reuse is 91.1% [E6.10].

**Not working.**
- lsp-first: 354 denials corpus-wide (292 local, 62 archive), 291 of them in the six days after commit 136097b widened the matcher to Bash; LSP used within three calls 8 times (2.3%); 268 follow-ups carried the guard's own documented `(?:)` escape; LSP use peaked at 88 calls in April, before the guard existed [E5.1]. 276 of the 297 local denials hit subagents that cannot appeal, and the 21 main-loop denials also converted to zero LSP calls [E1.14]. Grep tool use is exactly 0 locally against 26,268 Bash calls, so any Grep-matched hook is dead [E5.13].
- Nightshift fails closed three ways: `SKEPTIC_BUDGET` defaults to 1, a truncated skeptic returns no VERDICT line, and land.sh reads the empty verdict as REFUTED. That blocked ambient task 3 twice and closed PR #34; the same task passed round 0 on a plain rerun [E6.1]. $7.88 of the day's $28.87 (27%) merged nothing, one attempt ending "BLOCKED: Edit/Write require approval that this session cannot obtain" [E6.2]. The skeptic's round-1 stop on task 4 cost a night; the work merged four minutes later as PR #43 [E6.6]. Seven of nine landings are internal quality work [E3.6]. All 30 loop starts were supervised daylight runs on 2026-09-05 and the 02:00 job has never landed anything [E3.5].
- Workflow subagents run at the frontier tier by explicit choice: 954 of 1,295 are pinned to opus in their agent() opts, so the workflow guard is correctly silent [E1.3]; local subagent messages were 65% Opus 5 and 0% Haiku [E2.14]; 251 of the 972 Opus workflow subagents were small or mechanical [E6.3]. Untested: 30 of 78 main sessions ran Opus against a Fable default, and unpinned subagents inherit [R4.15].
- The auto-mode profile was generated from an empty $HOME and reads "no software-development signal"; 45% of local sessions run in $HOME against 1% in the archive [E1.10]. 142 automode blocks corpus-wide and ~30 human turns spent purely unblocking across 15+ repos; the fix Jason named on 2026-07-09 sits in one repo's memory [E5.7].
- Standing instructions: ~/.claude/CLAUDE.md is 14,320 B against its own guard's 12,288 B band with 8 lines over 400 chars; ~4,700 tokens always-on, ~8,300 in claude-skills, ~8,700 counting 2,374 tokens of plugin descriptions [E5.5, R4.1]. Plan mode was active in 8 of 78 sessions against a mandate [R4.11].
- Plugin hooks fail silently three ways and nothing detects it; session-retro's Stop hook has emitted invalid JSON for four months [E5.12]. Its zero is the only measurable skill gap: gates, ship-gate and nightshift expose no invocable skill, and handoff is off by decision [E3.8].
- no-route-around-ci matches text, not intent: it denied a scratch-file write on 2026-09-05 because a heredoc contained a merge string [E5.11]. docs-sync is acked past 63% of the time [E5.3]. secrets-scan has six blocks in 4.5 months, all on its own tests; keep it, unproven [E5.4].
- /usage was never used, and /insights has no run inside its 30-day retention window; /skill-doctor shipped 2026-09-04 [R4.6, R4.14]. This review hand-rolls them, and the index overstated tokens 2.2-2.4x and misses commits by -41% to +50% [E1.15].

**Where the models fail.**
- Confident negatives after an incomplete search: in every month sampled, both periods, despite the verbatim CLAUDE.md rule [E2.3]. The review reproduced it: the day-job start date was filed as unestablishable while written verbatim in the vault [E3.16].
- Diagnosis asserted before probing: repeat-failure prompts 0.30% local against 0.19-0.29% archive, no measurable improvement [E2.9].
- Goal drift on long autonomous stretches, n=2, one per period [E2.4]; parallel workflows colliding with main-loop work, n=2 [E2.5]; ambiguous abbreviations acted on, three prompts to land one correction [E2.7]; over-refusals, 2 of 14 genuine local failures, paired with 42 classifier blocks in 14 days [E1.9].
- Rate: the cleaned genuine-failure rate roughly doubled, ~1.1% to ~2.1% of prompts [E1.8], but per 1k assistant messages it moved +27%; what grew is session length and unattended reach, so sessions carrying a correction went 7% to 36% [E2.2]. Watch that as reach, not quality. "Practice degraded" fails significance on eight of eight comparisons [E4.17].

Four-way split: skill/hook failures are fixable, operator failures expensive, model failures persistent and small, the rest cost.

**Shipping.** The day job started 2026-08-17; weekday 09:00-17:00 commit share went 54% to 0%; product fell 83% per day, tooling 21%, and tooling ran at 13.1 commits/day in the last three days [E3.4]. Tooling share is 27.0% or 46.3% depending on whether brok-stacks and unifi count as product; quote neither bare [E3.1]. General crowding-out is refuted: July was peak tooling and peak product together [E3.3]. Fronts at 20+ commits/month ran 9, 9, 10, 15, 9, then 3 in September, by hours not decision [E3.13]. Coach's 406 is 68% agent-authored [E3.2]. 40% of sessions are personal or consumer work at 14% of output tokens; a third go into the harness [E4.13]. The blog stopped 2026-07-07 and its distribution repos went dormant eight and nine days later [E3.9]; four flagship products have no measurable users [E3.12]; ambient has seven real recordings, all 08-29/30 [E3.11]. Every skill-usage figure sits after the job began: the index has a hole from 2026-08-01 to 08-21, so no before/after exists [E3.15].

## 2. Best in class, and the gap

Randomised studies on realistic tasks cluster at -19% to +21% and vendor self-reports at +20% to +200%; the split is task realism [R1.2]. Greenfield low-complexity ~35-40%, brownfield high-complexity 0-10% [R1.11]. Review is the measured bottleneck and PRs merged without review is the leading indicator [R1.3]. Google: median change 24 lines, one reviewer, full review under 4 hours, one business day as the ceiling [R2.17, R2.5]; the 400-line rule is 2006 folklore [R2.4].

| | Google [R2.17] | Jason at home | Work team |
|---|---|---|---|
| Median change | 24 lines | nightshift landings 22-244 lines [E3.6] | unmeasured; day-0 number [R2.14] |
| Reviewers | median 1 | 0 humans on nightshift, by design [R1.3] | unmeasured |
| First response | under 4 h | n/a, machine gate | unmeasured |
| Merged without review | leading indicator [R1.3] | 100% on nightshift; mitigation belongs in the machine gate [R1.3] | unmeasured |

Two things travel to a team: the small-batch shape [R1.4] and the acceptance test agent-model-guard passes [E5.2]. One must not: unattended landing into a PHI-bearing product [R1.16]. The playbook carries the rest.

## 3. Operator gaps

- The plan gate works every time it is used, 18 gates, 15 approved, 3 resubmitted and approved (of 47); the trigger is missing [E4.7]. The first question arrives a median 39 minutes in, never within 2, in the 38% of sessions that ask at all (of 47) [E4.2]. What vanished with brainstorming (75 to 0) and writing-plans (74 to 0) is the written spec, not the question step: AskUserQuestion rose 5x per session [R7.7]; nothing replaces the forced-question front end of the retired stack [E4.15].
- Consumption. Two of five research artifacts were consumed by a later session [E4.6]; the 09-02 audit's 150 findings produced 5 landed fixes [E4.5]; PR #49, the eval harness, has 7,444 lines untouched since 2026-07-18 with ~2h of compute left [R7.5]. Fire-and-forget is real and rare, about one product-relevant instance in 47 sessions; its tell is research followed by research [E4.11].
- Closing on assumption: three closings hand verification to the party that did the work, one after 837k output tokens [R7.6]. Decisions dissolve: adr used once; the July benchmark decision evaporated [R7.8].
- Marathons, corrected: 10 of 78 sessions over 12 h are 35% of spend [E1.6], but duration is not the tell, two of four exhibits do not drift [E4.9], and the same sessions hold 9.6 to 19.8 h stalls on a locked 1Password or a session limit [E4.12]. No split-at-hours rule follows. Handoff and retro at zero cannot be called a decline, p=0.600 and p=0.597 [E4.8].
- Cross-repo facts have no home, which is why the permissions fix recurred in six repos [E5.8]. Rule 1's one-question clause runs against nine explicit asks for the opposite; correlational, so rewrite and re-measure [E5.9].

Leader half, labelled opinion as both sources instruct: name which STARS situation the team is in and what observation would disprove it, and test that in weeks 5-8 against delivery data [R6.19]; put one line of acceptance criteria per piece of work that the author verifies before requesting review, instead of holding the outcome personally [R6.18]. The best-sourced finding in the pack: diagnose why they are slow before any tooling push, because AI amplifies what is there [R6.1].

## 4. Tools that move the needle

Yes: `disallowedTools` on Explore.md replacing its prose, `memory: project` on worker.md [R4.8]; a `monitors/` entry pushing the nightshift journal into the morning session, once 02:00 runs exist [R4.9]; a marketplace expiry review on each model-family upgrade [R1.8, E3.7]; heredoc stripping for no-route-around-ci [E5.11]; `--permission-prompts none` and `--max-budget-usd` on the generator as the hypothesis for the first 02:00 run [R4.10, E6.2].

Later: an Opus advisor over Sonnet fan-out workers for one week on a non-critical repo, after the tier swap, vendor-measured at -11.9% cost [R4.7]; three ablation evals each for writing-artifacts and domain-modeling with rubrics the no-plugin baseline fails [R5.3].

No: an error-triage agent until ambient or brok-stacks show error volume [R5.8]; spec-kit [R5.5]; more MCP servers [R5.6]; the local skeptic, priced as a saving a flat-rate plan makes worthless [R5.7]; a Cloudflare-shaped multi-reviewer gate on nine PRs whose measured failures are already over-rejection, R1.5's proposal against the record [R1.5, E6.1, E6.6].

**Stop:** the local skeptic [R5.7]; the hand-rolled index once /usage agrees with it [E1.15, R4.14]; denying on lsp-first [E5.1]; a second research pass while the first has no owner [E4.11]; nightshift on internal scaffolding for a product with no real input [E3.6, E3.11]; adding skills until session-retro's hook is fixed and /skill-doctor has run [E3.8, E5.12]; quoting a tooling percentage without its classification [E3.1]; dollars as the ranking currency [E1.1]; the corrections regex as a quality metric [E2.2].

## 5. Where the lenses disagreed, and the call

1. lsp-first: delete, not scope. The main-loop 21 also converted to zero [E1.14], and the token win scoping would protect is a parked memory note, not a number in this pack. The Work/Git section shrinks to the two sentences a hook could never say [R4.2]; its hook paragraph becomes false.
2. Eval pair: writing-artifacts and domain-modeling [R5.3], not codex-review and session-retro [R4.3], because codex-review's measurement is PR #49 [R7.13] and session-retro's is a hook fix [E5.12].
3. Plugin zeros: one measurable gap [E3.8]. "Stop adding skills" rests on that plus a four-month silent failure [E5.12], not on four zeros.
4. The gate: artefact first, mechanism second. A UserPromptSubmit nudge on E4.7's trigger words that ends in a spec file, plus a two-minute pre-mortem, the one technique measured to beat critique, n=178 [R7.2]. A main-loop-only Workflow deny is the fallback if two weeks show no movement, held to the E5.2 acceptance test.
5. Cross-vendor reviewer on the unattended stream: no, in writing, for repos where a bad merge is cheap; one free codex pass over the nine landed PRs can reverse it [R2.19, R5.1].
6. Marathons: no length rule; a second session on an unrelated topic, 1Password unlocked first, notify on completion, constraints front-loaded [E4.9, E4.12, E1.6].
7. Cost lever order: nightshift defects, classifier profile, then the tier swap, which is ~$270 of quota headroom on a $2,510 period [E1.3].
8. `subagentPromptCacheTtl`: set it and re-measure the 12.5:1 sidechain ratio in a week; the larger lever is prefix uniformity, settled by one night's A/B [R4.4, R4.13].

## 6. Decision list

Each item: the change, the evidence, the cost, and the one-word answer it needs.

1. Fix nightshift's fail-closed defaults: raise `SKEPTIC_BUDGET` from 1 in `plugins/nightshift/templates/loop/{config,land.sh}`, make an empty verdict its own error arm at land.sh:311-318, back-port ambient's 624012f. Evidence: task 3 blocked twice and PR #34 closed on a truncated skeptic, then passed on rerun [E6.1]; $7.88 of $28.87 merged nothing [E6.2]. Cost: two one-line edits. yes/no
2. Let the 02:00 launchd job run three nights untouched, with `--permission-prompts none` and `--max-budget-usd` on night one as a hypothesis; report PRs landed 02:00-07:00, blocked rate, wall clock. Evidence: 30 starts, all supervised daylight; launchd never landed anything [E3.5]; flag shipped v2.1.259 [R4.10]. Cost: three nights of not intervening. yes/no
3. Regenerate `autoMode.environment` from a real repo and add one sentence under "What to confirm before doing" naming classifier-gated commands at the plan gate. Evidence: profile says "no software-development signal", 45% of sessions in $HOME [E1.10]; ~30 unblocking turns, fix named 2026-07-09 in one repo's memory [E5.7]. Cost: 15 minutes. yes/no
4. Delete lsp-first: revert 136097b, remove the hook entry, cut the Work/Git section to two sentences. Evidence: 354 denials, 2.3% LSP conversion, LSP peaked before the guard [E5.1]; main-loop residue also zero [E1.14]. Cost: one commit; forfeits a token win that exists only as a memory note. yes/no
5. Run /usage, /insights and /skill-doctor and diff them against this review; if they name the same heavy contributors, stop maintaining the transcript index. Evidence: usage-data absent [R4.6]; /usage never read [R4.14]; index 2.2-2.4x high, commits off by up to 50% [E1.15]. Cost: three commands. yes/no
6. Join sidechain rows to their parent session's model, then set audit and research readers in the three largest workflow scripts to Sonnet, one model per fan-out phase; touch no guard. Evidence: 954 of 1,295 pinned opus [E1.3]; 30 of 78 sessions ran Opus [R4.15]; prefix sharing needs uniform models [R4.13]. Cost: one query, three edits; ~$270 of the $2,510 period back as quota. yes/no
7. Interview-then-spec before any fan-out, as a UserPromptSubmit nudge on "workflow", "best in class", "research", "audit", ending in a spec file plus a two-minute pre-mortem; re-measure in two weeks; escalate to a main-loop Workflow deny only if it does not move. Evidence: Socratic requests p=0.004 [E4.10]; first question median 39 min [E4.2]; gate works when used [E4.7]; pre-mortem n=178 [R7.2]; session 82565888 [E1.7]. Cost: one hook, five minutes per large dispatch. yes/no
8. Rewrite rule 1's question clause (one question when the next step is obvious; a structured multi-option gate before multi-step or irreversible work), randomise AskUserQuestion option order, and always offer "none of these; here is what I need first"; re-measure in a month. Evidence: nine explicit asks [E5.9]; refusals 21.5% [E4.16]; deference is positional, local control 43.2% vs archive 72.1% [E4.3, R7.1]. Cost: one edit. yes/no
9. Cut ~/.claude/CLAUDE.md under 12,288 B: delete the tiering overlap and the 73% prose, change gate 5 from lines to bytes, delete or hook the plan-mode mandate, scope the code half of harness-behaviours.md. Evidence: 14,320 B, 8 lines over 400 chars [E5.5]; vendor stop-list [R4.1]; rule stated twice [R4.2]; 8 of 78 compliance [R4.11]; unscoped rules [R4.12]. Cost: 20 minutes. yes/no
10. PR #49: resume `run.mjs` (~2h quota) then merge or close; close or schedule #50; book a 10-minute Friday sweep of open PRs and research docs older than 14 days. Evidence: 7,444 lines untouched 49 days [R7.5]; prerequisite for claiming any reviewer works [R7.13]; 150 findings to 5 fixes [E4.5]. Cost: 2 h once, 10 min a week. resume/close
11. Record one real ambient meeting and read the transcript end to end before landing another WER task; rewrite the ambient plan to user-visible tasks, state the loop's job in the plan, tag each task edge or core and let the loop take only edge. Evidence: seven recordings, all 08-29/30, 09-02 zero bytes [E3.11]; 7 of 9 internal [E3.6]; verifier is the ceiling [R1.7]; edge/core [R1.13]. Cost: two hours. yes/no
12. Accept in writing that the unattended stream has no cross-vendor reviewer, confined to claude-skills and ambient; strengthen SKEPTIC.md's clean-pass clause; instrument revert and override rate beside the landed count; run codex diff mode over the nine landed PRs once as the test. Evidence: the binary [R2.19]; free test first [R5.1]; over-rejection is the known failure [R7.13, E6.6]; override rate is the trust signal [R1.5, R1.1]. Cost: one prompt clause, one free pass. yes/no
13. Codex-review: cap at ~5 ranked findings, end a chain on a round with nothing unique, resume open chains on the same artifact. Evidence: 65 of 89 eligible chains used all rounds, worst 1.6-1.8M tokens per unique finding [E6.11]; 5 same-hash repeats [E6.10]. Cost: prompt wording and one predicate. yes/no
14. Name three fronts in writing and park the rest; publish through social-mcp and content-ops within a fortnight or archive both; give one of endurebyte, skopia, games, transcoder a user other than Jason or archive the other three. Evidence: fronts 9-15 to 3 by hours [E3.13]; blog stopped 07-07 [E3.9]; no measurable users [E3.12]. Cost: one hour. yes/no
15. Fix the emitOffer nesting in session-retro's Stop hook (and ship-gate, docs-consolidate), retire handoff, and author no new skill until /skill-doctor has run. Evidence: invalid-JSON hook failure for four months [E5.12]; handoff off by decision [E5.10]; only session-retro's zero is measurable [E3.8]. Cost: one bug fix, one uninstall. yes/no
16. no-route-around-ci: port docs-sync's heredoc stripping and exempt read-only leading binaries, in the claude-skills and ambient repo hooks. Evidence: denied a scratch write on 2026-09-05; the indexer splits its own literals to pass [E5.11]. Cost: small change. yes/no
17. Explore.md gets `disallowedTools: Write, Edit, NotebookEdit` and loses the read-only prose; worker.md gets `memory: project`. Evidence: two of seventeen fields used, read-only enforced in prose [R4.8]. Cost: three frontmatter lines. yes/no
18. Closing demand ("paste the command and output for each thing you say is done; list the rest as unverified"): as a Stop hook (8-block ceiling), as a CLAUDE.md line, or dropped. Evidence: three closings on assumption [R7.6]; oversight by watching fails [R7.10]. Cost: one line or half a day. hook/prose/drop
19. Positive-check rule in the research output contract: any "X does not exist" or "unresolvable gap" names and runs the enumerating command; every report ends in a numbered decision list. Evidence: most persistent model failure [E2.3]; the review did it [E3.16]; forced choices [R7.9]. Cost: two lines in the workflow report template. yes/no
20. Set `subagentPromptCacheTtl: 1h`, re-measure the sidechain create:read ratio (244.3M : 3,044.7M) after a week, remove if unchanged; run one night's uniform-vs-mixed fan-out A/B. Evidence: 12.5:1 vs 53.8:1 [R4.4]; prefix sharing [R4.13]. Cost: one key, one night. yes/no
21. Advisor experiment: Opus advisor over Sonnet fan-out workers, one week, non-critical repo, after item 6. Evidence: vendor benchmark +2.7 pts, -11.9% cost; Fable rejects an Opus advisor, subagents inherit it [R4.7]. Cost: one settings key, one week. yes/no/later
22. Evals: three ablation cases each for writing-artifacts and domain-modeling with rubrics the baseline fails, after /skill-doctor. Evidence: zero evals shipped [R5.3]; meanDelta 0 pilot [R4.3]. Cost: an hour, ~$0.22 a run. yes/no/later
23. Marketplace expiry review on each model-family upgrade; retirement condition in the next plugin's README on day one. Evidence: one documented harness write-down at the vendor [R1.8]; 61% pruned reactively [E3.7]. Cost: one calendar rule. yes/no
24. Five-line decision record at the end of any session that changed a decision, appended to the daily note. Evidence: adr used once; the July benchmark decision evaporated [R7.8]. Cost: one closing prompt. yes/no
25. Sessions: open a second session when an unrelated topic arrives; unlock 1Password before any long dispatch; long workflows notify on completion; front-load the constraints that arrive as prompts 2 and 3. No split-at-hours rule, no handoff or retro revival. Evidence: duration not the tell [E4.9]; 9.6-19.8 h stalls [E4.12]; p=0.600/0.597 [E4.8]; 68e1fc37 [E1.6]. Cost: habit, one notification hook. yes/no
26. One number monthly: plan-equivalent cost per merged, non-reverted PR, tooling versus product; weekly, the count of repos at 20+ commits. Evidence: measurement gap [R1.9]; the one allocation metric that moved [E3.13]. Cost: ten minutes a month. yes/no
27. Confirm "no change" on: the Fable/Opus session default [E6.13]; spend on avoiding compaction [E6.9]; lowering `autoCompactWindow` until /usage flags long context at 10%+ [E1.2, E6.4, R4.14]; tightening workflow-model-guard's predicate [E1.3, R4.13]; the local skeptic [R5.7]; spec-kit [R5.5]; Playwright or GitHub MCP [R5.6]; an error-triage subscription [R5.8]; reviving handoff or retro [E4.8]. Cost: none. yes/no

## 7. Decisions, 2026-09-05

Jason answered the 27 items one at a time. Where the question put to him differed in shape from the item above, the shape he answered is the one recorded.

| # | Answer | Shape decided |
|---|---|---|
| 1 | yes | `SKEPTIC_BUDGET` 5, empty verdict is its own error arm, back-port ambient 624012f, nightshift patch, refresh both repos |
| 2 | later | three unattended nights, after item 1 lands |
| 3 | yes | regenerate `autoMode.environment` from a real repo; one sentence naming classifier-gated commands at the plan gate |
| 4 | research first | not a deletion: a study of what best-in-class LLM code-navigation tooling looks like in repos, then decide |
| 5 | later | /usage, /insights, /skill-doctor diff |
| 6 | yes, plus guidance | Sonnet readers in the fan-out phases, and written routing guidance on when Sonnet's rework costs more than Opus's first pass |
| 7 | yes | UserPromptSubmit nudge in gates on fan-out words, ending in a spec file and a two-minute pre-mortem |
| 8 | yes, reworded | keep "(Recommended)"; rule 1 becomes understand-the-goal-first, one question when the next step is obvious, a structured gate before multi-step or irreversible work |
| 9 | yes | global CLAUDE.md under 12,288 B, gate 5 in bytes, code half of harness-behaviours.md scoped |
| 10 | close | close #49 and #50; ten-minute Friday sweep |
| 11 | no | |
| 12 | yes | accept no cross-vendor reviewer on the unattended stream in writing; SKEPTIC.md clean-pass clause; revert and override rate beside the landed count; one codex diff pass over the nine landed PRs |
| 13 | yes | codex-review: cap at five ranked findings, end a chain on a round with nothing unique, resume open chains on the same artifact |
| 14 | yes | fronts: claude-skills (Nightwatch), transcoder, ambient; brok-stacks is ongoing homelab upkeep, not a front; games and skopia marked done and left deployed; one blog post through social-mcp and content-ops within a fortnight |
| 15 | yes | emitOffer fix (landed as PR #102), retire handoff, no new skill until /skill-doctor has run |
| 16 | yes, and rename | heredoc stripping and read-only leading binaries in the guard; Nightshift becomes **Nightwatch**; design how it runs without blocking daytime work |
| 17 | yes, as a design pass | Explore and worker frontmatter fixes, inside a whole-system pass over the agent definitions in conjunction with Nightwatch |
| 18 | hook | closing demand as a Stop hook, eight-block ceiling |
| 19 | yes | positive-check rule and numbered decision list in the workflow report contract |
| 20 | yes | `subagentPromptCacheTtl: 1h`, re-measure after a week; one uniform-vs-mixed night |
| 21 | yes | Sonnet 5 worker with Opus 5 advisor (`advisorModel: opus`, inherited by subagents; a Fable main gets no advisor by the pairing rule); Fable coordinates; Fable-plus-Fable deferred; two-week count of advisor calls that changed the approach |
| 22 | yes, two skills | ablation cases for writing-artifacts and adr, folded into the gates-config plan's eval task |
| 23 | yes, quarterly | `reviewBy` date in each plugin.json, enforced by the repo-consistency test; first dates 2026-12-05 |
| 24 | yes | five-line decision record (decision, alternatives, evidence, reversibility, review date) in the adr skill's template and the Nightwatch plan header |
| 25 | yes, nudge only | first-prompt nudge to restate goal and success criterion; the item-18 Stop hook carries the closing line |
| 26 | yes | monthly cost-per-merged-PR script under `scripts/`, run by hand |
| 27 | confirmed | no change to: one task per PR; whole-branch codex review; the gates guards beyond items 7 and 16; the Max plan; Coach's commit habit |

Item 27 as originally listed (session default, compaction spend, `autoCompactWindow`, workflow-model-guard's predicate, local skeptic, spec-kit, Playwright and GitHub MCP, error triage, handoff or retro revival) was not put to Jason by name; it stands as "no change" until he says otherwise.
