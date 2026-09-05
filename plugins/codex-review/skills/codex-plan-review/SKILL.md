---
name: codex-plan-review
description: 'Cross-provider adversarial review of a finalized plan, spec, design doc, ADR, or code diff using OpenAI Codex (GPT-5.6 Terra). AUTO-TRIGGER at plan gates — invoke immediately after any of: (1) a plan written by `nightshift:plan` is finalized, (2) an ADR draft is completed. AUTO-TRIGGER for code: after implementing a Codex-reviewed plan, run diff mode on the branch range before opening the PR — a reviewed plan is NOT a reviewed diff. Also invoke on request — "codex review this plan", "codex review this diff", "get a second opinion on this design", "terra review". Do NOT re-run on an artifact already reviewed without an explicit user ask; each chain burns paid quota.'
---

# Codex Plan Review

Send a finalized plan/spec/design/ADR to OpenAI Codex (Terra, high effort, read-only sandbox) for adversarial review. The script handles mechanics; you handle judgment. Script path (resolve via this skill's base directory): `scripts/codex-review.mjs`, run with `node`.

**The one non-negotiable prompt rule:** the reviewer must never see your self-assessment. The script builds prompts from the file path only — never paste plan content, your confidence, or "tests pass" claims into any codex invocation. (Research: implementer framing degrades Codex review thoroughness 3–4×.)

## Flow

1. **Announce:** "Running Codex plan review (Terra, high effort) — round 1." If `codex` is missing or not logged in (`codex login status`), say so, skip, and continue without blocking the plan.
2. **Preflight:** the artifact must be a file. Write conversation-only plans to their canonical path first (`docs/superpowers/specs/…`, the repo's own plans directory, or scratchpad for throwaways).
3. **Round 1:** `node <skill-dir>/scripts/codex-review.mjs review <file> --auto` (use `--force` only when the user explicitly asked for a re-run). If it refuses with "chain already exists", tell the user this artifact version was already reviewed and stop unless they ask to force.
4. **On `REVISE`:** walk findings one at a time. For accepted findings, amend the plan file. Dismissals require a stated reason in your reply — never silent. Then verify fixes: `… review <file> --resume <sessionId> --chain <chainId>`. Max 3 review rounds total — the script now refuses a 4th before spending any paid call. Plans do reach `APPROVED`: 12 of 63 review chains in the first 20 days, 9 of them at round 3 (first on 2026-07-16). If still `REVISE` after folding round-3 findings in, proceed to the audit anyway (see step 5) rather than stopping — the audit is most valuable exactly here, after three rounds of findings have been folded in. Only skip it if the user stops before folding the findings in; then log the note as `cap-revise`.
5. **Run the final audit** — after either an `APPROVED` round or a round-3 `REVISE` whose findings have been folded in: `… audit <file> --chain <chainId>` (fresh Codex session, holistic scope; the script refuses a second audit on the same chain before spending any paid call). `AUDIT: PASS` → done. `AUDIT: CONCERNS` → surface findings verbatim and **block**: the plan is not review-complete until the user dispositions each concern. Never re-run the audit; if the user amends in response, the outcome class is `audit-concerns-user-approved` (user-approved, audit-unverified); if the user dismisses the concerns with reasons instead, it is `audit-concerns-dismissed`.

  **If there is no interactive user turn available to disposition the concerns** — a background/`bg` run, a Workflow-dispatched call, any context where you cannot actually put `AskUserQuestion` in front of a human — do NOT self-disposition and do NOT close with `audit-concerns-user-approved`. That label is a claim a person approved this, and writing it unattended puts a false attribution into the permanent log. Close with `--outcome audit-concerns-unattended`, surface the findings verbatim in your return value, and leave them for the next turn where a human is present. Amending the artifact in response is fine; claiming someone signed off on it is not.
6. **UNPARSEABLE:** retry once — `… review <file> --resume <sessionId> --chain <chainId> --retry-verdict` (or the `audit … --resume <sessionId> --retry-verdict` form). If the result JSON has no `sessionId` (nothing to resume), skip the retry entirely. Still unparseable, or no session → surface to user, close the chain as aborted.
7. **Always close the chain** (every path: pass, cap, concerns, timeout, error, abort): `… note --chain <chainId> --unique <n> --outcome <audit-pass|audit-concerns-user-approved|audit-concerns-dismissed|cap-revise|aborted> --comment "…"`. A finding counts toward `--unique` only if you judge it real AND it wasn't already known or caught by the Claude-side review stack. The result JSON's `pendingNoteChainId` reminds you which chain is open.
8. **Report one line:** rounds used, final verdict, unique findings, and cumulative gate stats (`… stats`). Include token usage from the result JSON so the user can track quota burn.

## Diff mode (code review)

> **Maturity: PROVEN (2026-07-14). The open question is answered — run it.**
>
> Diff mode shipped with the caveat that a cross-family reviewer finding *code* bugs an Opus review
> misses was an open question. Three dogfoods answered it, and each found real bugs **in code that had
> already passed a Claude-side review**:
>
> | Run | Reviewed | Found |
> |---|---|---|
> | 1 | its own introducing commit | a range parser that silently reviewed the **wrong, reversed** git range while reporting success; an off-by-one |
> | 2 | the deep-dive integrity branch — *after* 3 plan rounds + an audit | a host guard that let a fabricated finding aim the verifier's `WebFetch` at `169.254.169.254`; `startsWith`-only placeholder matching; unvalidated `sourceTitle`/`sourceDate` |
> | 3 | the handoff provenance branch | `.claude/handoffs/` as a **git submodule** bypassed the provenance check entirely (the parent tracks only a gitlink) |
>
> **Plan review and diff review catch different classes of thing.** Run #2 is the proof: a plan that
> had survived three review rounds *and* a fresh-session audit still shipped three real bugs. Do not
> treat "the plan was reviewed" as "the code is reviewed."
>
> **So: after implementing a reviewed plan, run `diff <mergeBase>..HEAD --force` before opening the PR.**
> Fold the findings, verify each against the actual code (see below), then merge.

**Verify every finding against HEAD before acting on it.** A finding is a *hypothesis about the code*,
and it can be stale, or simply wrong about the mechanism. Reproduce it at the console first — it costs
one command. In run #3, one finding was a genuine submodule bypass (reproduced end to end, fixed) and
the other named a real test gap but proposed a mechanism that was **false** (`ls-files --error-unmatch`
reads the index, not the worktree, so the unlink it blamed was irrelevant). Both were worth having;
neither should have been applied on trust.

`diff <range> --force` reviews a git range instead of a file; `diff-audit <range> --chain <id>` is its
one fresh-session audit round. Same script, same verdict-loop mechanics, same chain log.

- **Use a fixed base against a moving tip — `main...HEAD`.** The chain's identity *is* the range
  string, so it must stay meaningful as fix commits land. `main...HEAD` still names "the changes on
  this branch" after every commit; `HEAD~1..HEAD` means something *different* after each one and
  therefore **cannot be resumed** — usable only for a one-shot review. Within each round the range is
  pinned to commit SHAs, so the diff Codex renders is the diff that was hashed and recorded. That
  guarantee covers the *diff*; surrounding files are read from the working tree, by design — that is
  what a reviewer needs for context.
- An explicit `..`/`...` range is required — a bare ref would fold in uncommitted working-tree changes
  and make the review unreproducible from the chain record.
- `--max-lines` (default 4000) plus a 400KB byte cap. An oversized diff is **refused, not truncated** —
  narrow the range or raise the limit.
- Files git will not render (binary, or marked `-diff` in `.gitattributes`) are **named in the prompt
  as NOT SHOWN** — never silently dropped.
- Same 3-round + 1-audit protocol as plan mode — **and it is now actually enforced** (documented but
  not implemented before this): a 4th review round and a 2nd audit are both refused before any paid
  call.

## Presenting findings (always)

Never paste Codex's raw findings as your primary output. For every finding you surface to the user (REVISE walks, audit concerns), translate it to plain language in this shape:

> **N. [plain-sentence headline].** What breaks if ignored: [one concrete consequence]. *Fix: [recommended action].*

Keep the reviewer's original text available on request ("want the raw reviewer output?") — don't lead with it. Severity tags ([P1]/[P2]/[P3]) may be kept; reviewer jargon, file:line references, and prompt-protocol vocabulary may not, unless the user asks.

## Decision gate — ✅ PASSED 2026-07-14, two weeks early

The trial required ≥1 unique finding per 5 eligible chains (`uniquePer5 >= 1`) by ~2026-07-28. It came
in at **37.5 per 5 — about 37× the bar** — and diff mode has since cleared its own open question (above).

The skill is **kept**. `stats` is now a health check, not a survival test: if `uniquePer5` collapses
toward 1, revisit. But `uniquePer5` is a **floor, not a target** — a review that produces zero findings
on genuinely-clean work is a success, not a miss, and the reviewer must never be tuned toward producing
findings to keep the number up (LLM reviewers already over-reject correct code; see the
[calibration research](https://github.com/jasonm4130/claude-skills/blob/main/docs/research/2026-07-15-ai-reviewer-calibration-and-clean-pass-research.md)). Remaining escalation paths
(SDD hook, adversarial persona) live in the plugin README and are still ungated — do not wire this into
an automated gate without a fresh trial.

## Common mistakes

| Mistake | Fix |
|---|---|
| Pasting plan content or your own assessment into a codex prompt | The script's file-path-only prompts are the interface — never bypass them |
| Re-running `--force` because a guard refusal seemed inconvenient | The refusal means this exact content was already reviewed — ask the user |
| Skipping the `note` after a failed/aborted chain | Every chain ends with a note; aborted chains unblock the artifact for future auto-runs |
| Treating `AUDIT: CONCERNS` as advisory | It blocks review-completion until the user dispositions each concern |
| Looping the audit | One audit per chain, ever |
| Trusting codex exit codes or retrying a `verdict:"error"` blindly | Read the result JSON; surface errors to the user |
