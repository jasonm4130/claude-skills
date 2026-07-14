---
name: codex-plan-review
description: Cross-provider adversarial review of a finalized plan, spec, design doc, or ADR using OpenAI Codex (GPT-5.6 Terra). AUTO-TRIGGER at plan gates — invoke this skill immediately after any of: (1) a brainstorming spec is written and user-approved, (2) a writing-plans implementation plan is finalized, (3) an ADR draft is completed, (4) an SDD plan is confirmed at its gate. Also invoke on request — "codex review this plan", "get a second opinion on this design", "terra review". Runs a bounded verdict loop (max 3 rounds + 1 audit) via the local codex CLI; each chain burns ChatGPT-subscription quota, so never re-run on the same artifact without an explicit user ask.
---

# Codex Plan Review

Send a finalized plan/spec/design/ADR to OpenAI Codex (Terra, high effort, read-only sandbox) for adversarial review. The script handles mechanics; you handle judgment. Script path (resolve via this skill's base directory): `scripts/codex-review.mjs`, run with `node`.

**The one non-negotiable prompt rule:** the reviewer must never see your self-assessment. The script builds prompts from the file path only — never paste plan content, your confidence, or "tests pass" claims into any codex invocation. (Research: implementer framing degrades Codex review thoroughness 3–4×.)

## Flow

1. **Announce:** "Running Codex plan review (Terra, high effort) — round 1." If `codex` is missing or not logged in (`codex login status`), say so, skip, and continue without blocking the plan.
2. **Preflight:** the artifact must be a file. Write conversation-only plans to their canonical path first (`docs/superpowers/specs/…`, `docs/plans/…`, or scratchpad for throwaways).
3. **Round 1:** `node <skill-dir>/scripts/codex-review.mjs review <file> --auto` (use `--force` only when the user explicitly asked for a re-run). If it refuses with "chain already exists", tell the user this artifact version was already reviewed and stop unless they ask to force.
4. **On `REVISE`:** walk findings one at a time. For accepted findings, amend the plan file. Dismissals require a stated reason in your reply — never silent. Then verify fixes: `… review <file> --resume <sessionId> --chain <chainId>`. Max 3 review rounds total — the script now refuses a 4th before spending any paid call. No plan has ever reached `APPROVED` by round 3; if still `REVISE` after folding round-3 findings in, proceed to the audit anyway (see step 5) rather than stopping — the audit is most valuable exactly here, after three rounds of findings have been folded in. Only skip it if the user stops before folding the findings in; then log the note as `cap-revise`.
5. **Run the final audit** — after either an `APPROVED` round or a round-3 `REVISE` whose findings have been folded in: `… audit <file> --chain <chainId>` (fresh Codex session, holistic scope; the script refuses a second audit on the same chain before spending any paid call). `AUDIT: PASS` → done. `AUDIT: CONCERNS` → surface findings verbatim and **block**: the plan is not review-complete until the user dispositions each concern. Never re-run the audit; if the user amends in response, the outcome class is `audit-concerns-user-approved` (user-approved, audit-unverified); if the user dismisses the concerns with reasons instead, it is `audit-concerns-dismissed`.
6. **UNPARSEABLE:** retry once — `… review <file> --resume <sessionId> --chain <chainId> --retry-verdict` (or the `audit … --resume <sessionId> --retry-verdict` form). If the result JSON has no `sessionId` (nothing to resume), skip the retry entirely. Still unparseable, or no session → surface to user, close the chain as aborted.
7. **Always close the chain** (every path: pass, cap, concerns, timeout, error, abort): `… note --chain <chainId> --unique <n> --outcome <audit-pass|audit-concerns-user-approved|audit-concerns-dismissed|cap-revise|aborted> --comment "…"`. A finding counts toward `--unique` only if you judge it real AND it wasn't already known or caught by the Claude-side review stack. The result JSON's `pendingNoteChainId` reminds you which chain is open.
8. **Report one line:** rounds used, final verdict, unique findings, and cumulative gate stats (`… stats`). Include token usage from the result JSON so the user can track quota burn.

## Diff mode (code review)

> **Maturity: diff mode is unproven.** The decision gate that unlocked it was earned entirely on
> *plan* review — every P1 Codex has found to date was in a design artifact, not in code. Whether a
> cross-family reviewer finds code bugs an Opus review misses is an **open question this mode exists
> to answer**. Treat its findings as a second opinion, not an authority, and do not wire it into an
> automated gate until it has earned one the way plan mode did.

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

## Decision gate (trial until ~2026-07-28)

`stats` must show ≥1 unique finding per 5 eligible chains (`uniquePer5 >= 1`) for the skill to survive. If the trial fails, recommend retiring the skill (escalation paths live in the plugin README).

## Common mistakes

| Mistake | Fix |
|---|---|
| Pasting plan content or your own assessment into a codex prompt | The script's file-path-only prompts are the interface — never bypass them |
| Re-running `--force` because a guard refusal seemed inconvenient | The refusal means this exact content was already reviewed — ask the user |
| Skipping the `note` after a failed/aborted chain | Every chain ends with a note; aborted chains unblock the artifact for future auto-runs |
| Treating `AUDIT: CONCERNS` as advisory | It blocks review-completion until the user dispositions each concern |
| Looping the audit | One audit per chain, ever |
| Trusting codex exit codes or retrying a `verdict:"error"` blindly | Read the result JSON; surface errors to the user |
