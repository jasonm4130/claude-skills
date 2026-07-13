# codex-review plugin v0.1 — design

**Date:** 2026-07-14
**Status:** approved — survived a full dogfood of its own protocol (3 Terra review rounds + final audit; all findings dispositioned by user 2026-07-14)
**Research basis:** `docs/plans/2026-07-14-codex-adversarial-review-skill-research.md` and `docs/plans/2026-07-11-cross-provider-review-research.md`

## Purpose

A thin Claude Code skill that sends a finalized plan / spec / design doc / ADR to OpenAI Codex (GPT-5.6 Terra) for adversarial review, using the community-proven verdict-loop protocol. Fills the one gap the official `openai/codex-plugin-cc` plugin does not cover (its issue #4, open since launch): plan/design-doc review. Diff review is explicitly out of scope — the official plugin owns that.

## Decisions locked in brainstorming

1. **Scope:** plan/design-doc review only. Deferred options (diff mode, SDD reviewer, adversarial-agents persona) are recorded as escalation paths, not built.
2. **Invocation:** model-invocable at plan gates, **best-effort by construction**: the trigger is SKILL.md frontmatter description text — advisory model behavior that maximizes but cannot guarantee activation (the deterministic script protects only runs that happen; hooks, the only deterministic trigger, were explicitly declined). Claude auto-runs the review when a plan/spec/design doc/ADR is finalized (end of brainstorming, writing-plans output, ADR draft, SDD plan confirmation) or when the user asks. **Deliberate deviation from the research's explicit-invocation recommendation** (user decision 2026-07-14, made with the quota trade-off in view): the research's warning targets *mechanical* Stop-hook loops that fire regardless of context; this is a model-judged gate with bounded rounds. Guardrail is **enforceable, log-backed, and built into the review command itself** (not a separate preflight dependent on model compliance): auto-triggered runs use `review --auto`, which refuses to start if `~/.claude/codex-review-log.jsonl` already holds a non-aborted chain for the artifact's **repo + path + content hash** (hash alone would let identical content in different repos/paths suppress each other across the shared log) — only an explicit user request (`--force`) bypasses this check. Plan-gate integration is via SKILL.md trigger description only (no hooks): the four named gates are listed as triggers in the skill's frontmatter description.
3. **Architecture:** SKILL.md orchestration + thin helper script (`codex-review.mjs`) for the deterministic mechanics. One Codex round per script call; Claude sits in the middle of the loop (it must amend the plan between rounds).
4. **Decision gate:** cross-repo JSONL log at `~/.claude/codex-review-log.jsonl`. Trial criterion: ≥1 confirmed unique finding per ~5 reviews by ~2026-07-28, else retire the skill.

## Components

```
plugins/codex-review/
├── .claude-plugin/plugin.json
├── README.md                        # includes Escalation paths section
└── skills/codex-plan-review/
    ├── SKILL.md                     # orchestration policy (model-invocable)
    └── scripts/
        ├── codex-review.mjs         # deterministic mechanics
        └── codex-review.test.mjs    # node --test
```

Plus: marketplace.json entry (version 0.1.0), **root `README.md` plugin-table entry** (required — `scripts/repo-consistency.test.mjs` fails the build if a marketplace plugin is missing from the root README), and a project memory entry recording escalation paths + gate.

## Script interface (`codex-review.mjs`)

Subcommands, each printing a single JSON object to stdout:

- `review <file> (--auto | --force)` — **opens a chain** and runs round 1. The auto-trigger guard lives **inside** this form, not in a separate preflight that depends on model compliance: `--auto` (what SKILL.md uses at plan gates) refuses if the log already holds a **non-aborted** chain for this artifact's repo + path + content hash, or if the log cannot be read or written (**fail closed in auto mode** — an unreadable log must never be treated as empty); `--force` (explicit user request) bypasses the hash check only — log unwritability still refuses, since an unlogged chain corrupts the gate data. Mints and prints the `chainId`.
- `review <file> --resume <sessionId> --chain <chainId>` — **resumed round** within an open chain. Guard flags don't apply (the guard governs chain *opening* only); no "latest chain" inference — both ids are explicit (ambiguous after forced or concurrent runs otherwise).
- `audit <file> --chain <chainId> [--resume <sessionId>]` — final holistic audit, a fresh Codex session by default (deliberately independent of the fix-loop's accumulated context), logged against the explicit chain. The `--resume` form exists solely for the mode-specific UNPARSEABLE retry of the audit's own session.
- `note --chain <chainId> --unique <n> --outcome <class> [--comment <text>]` — appends Claude's post-walk judgment of how many findings in that chain were unique (real, and not already known/caught by the Claude-side stack) plus the chain's outcome class. Rejects an unknown `chainId`, a duplicate note for the same chain, or an invalid outcome class.
- `stats` — gate readout: chain counts by state/trigger/outcome, unique-finding totals, and rate per 5 **eligible completed chains** (see lifecycle).

**Chain identity & lifecycle:** the first `review` of an artifact mints a `chainId` (short hash of canonical artifact path + content hash + timestamp). **Chain reservation is the guard, and check-and-reserve is atomic:** the hash check and the chain-open append happen under an exclusive lockfile (`~/.claude/codex-review-log.lock`, `O_EXCL` create, bounded stale-lock timeout) so two concurrent auto-triggered sessions cannot both observe "no chain" and double-run; the reservation line is written *before* spawning Codex, and if the lock or the write fails, chain opening refuses (fail closed — both auto and force). A chain is **completed** when its `note` line is logged — the note is mandatory end-of-chain bookkeeping on every path, including failures: timeout, terminal error, UNPARSEABLE-after-retry, and malformed transcripts with no resumable session all end with `note --chain <id> --unique 0 --comment "aborted: <reason>"` (SKILL.md step; the review/audit result JSON reminds Claude by echoing the pending chainId). **Aborted chains are excluded from the gate denominator** and — so a failed run doesn't permanently block the artifact — **the hash guard ignores aborted chains** when deciding whether an auto-run may open a new chain. The **denominator for the decision gate is eligible completed chains** (auto-triggered, non-aborted; see outcome classes below), never rounds or audits. `stats` lists open (note-less) chains so gate data can't silently rot.

**Log-write failure policy (three classes):** (1) **reservation writes — fatal**, refuse to open the chain (the guard's guarantee depends on them); (2) **round/audit result appends — non-fatal**, stderr warning, result JSON still printed (the review already happened; losing one round record beats losing the review); (3) **note writes — fatal**, exit non-zero so Claude retries or surfaces it (notes define chain completion; a silently dropped note removes the chain from the gate denominator forever).

Flags with defaults: `--model gpt-5.6-terra`, `--effort high` (maps to `-c model_reasoning_effort=high`), `--timeout 300` (seconds).

### Codex invocation

```
codex exec --json --sandbox read-only -m <model> -c model_reasoning_effort=<effort> "<prompt>"
```

- **cwd resolution:** repo root of the artifact via `git -C <artifact-dir> rev-parse --show-toplevel` (fallback: the artifact's directory). All spawns — including resume rounds — use this cwd; resume relies on cwd inheritance, not flags (`codex exec resume` exposes neither `--cd` nor `--sandbox`; sandbox/model are assumed inherited from the original session — this assumption is verified in the manual smoke test and revalidated after CLI upgrades).
- The prompt references the artifact by **repo-root-relative canonical path**; artifact content is never inlined (avoids the documented 1MB/ENOBUFS failure class and matches the official plugin's post-#179 pattern).
- `--json` event stream is parsed for: session/thread id (needed for resume), the final agent message, and the **terminal event status**.
- Codex's process exit code is **ignored** (documented unreliable — openai/codex#15536). Success requires BOTH a terminal completion event with non-error status in the JSON stream AND a final agent message; a transcript whose terminal event reports failure/error is reported as `verdict: "error"` even if message text exists.
- Resume rounds use the complete command `codex exec resume <sessionId> --json -m <model> -c model_reasoning_effort=<effort> "<prompt>"` — the CLI supports `--json` and `-m` on resume, so model and effort are passed explicitly there too; only the **sandbox** is assumed inherited from the original session (resume exposes no `--sandbox`), and that single assumption is what the manual smoke test verifies. `--output-schema` is deliberately not used anywhere (breaks with MCP tools active — #15451 closed won't-fix — and unsupported on resume — #14343); the verdict-line convention replaces it.
- Model is always passed explicitly with `-m` on every invocation, fresh and resumed (default-model selection is a documented failure mode — plugin issues #270/#333).

### Prompt template (review mode)

Built from template + file path only — structurally impossible to include Claude's self-assessment (the research's highest-value finding: implementer framing degraded Codex review thoroughness ~3–4×).

> You are an adversarial design reviewer. Review the design/plan document at `<path>`.
>
> Default to skepticism: your job is to break confidence in this artifact, not to validate it. Assume it can fail until the evidence says otherwise. Hunt for: hidden assumptions, failure modes, missing error handling, underspecified interfaces, internal contradictions, and scope creep. Where the document makes claims about code, files, or tools in this repository, check them (read-only).
>
> Report findings as a bullet list, each tagged [P1] (must fix before implementation), [P2] (should fix), or [P3] (nit). Severity must be proportionate to the artifact's scope — do not demand enterprise patterns from small local tooling. Do not rubber-stamp; do not restate the document.
>
> End your final message with exactly one line: `VERDICT: APPROVED` or `VERDICT: REVISE` (REVISE if any P1 or P2 finding exists).

Resume-round prompt: "The artifact at `<path>` has been revised in response to your findings. Re-review: verify each prior finding is addressed, flag any that are not, and check the revisions did not introduce new problems. Same reporting format. End with the VERDICT line."

Audit-mode prompt (fresh session, complete text — the audit deliberately has no knowledge of the fix-loop's findings, so it is scoped to whole-artifact issues rather than told to avoid repeating details it never saw):

> You are performing a final holistic audit of the design/plan document at `<path>`. A separate detailed review process has already examined this artifact section by section; your job is NOT another section-by-section pass. Assess the artifact **as a whole**: internal consistency across sections, completeness (is anything load-bearing missing entirely?), feasibility of the overall approach, and systemic risks that only appear when reading it end to end. Where the document makes claims about this repository, you may check them (read-only). Report at most 5 findings, whole-artifact in scope, same [P1]/[P2]/[P3] tagging. End your final message with exactly one line: `AUDIT: PASS` or `AUDIT: CONCERNS`.

### Verdict parsing

Regex on the final agent message for the **last** occurrence of `VERDICT: (APPROVED|REVISE)` / `AUDIT: (PASS|CONCERNS)`. Missing → `verdict: "UNPARSEABLE"` in the JSON output (not a crash, not an exit-code signal). Findings count = number of `[P1]`/`[P2]`/`[P3]` tagged lines (best-effort, logged per severity).

### Logging

Every round appends one JSONL line to `~/.claude/codex-review-log.jsonl`:

```json
{"ts":"…","chainId":"…","repo":"claude-skills","artifact":"docs/…​.md","contentHash":"…","mode":"review|audit|note","round":1,"verdict":"REVISE","findings":{"p1":1,"p2":3,"p3":2},"sessionId":"…","model":"gpt-5.6-terra","effort":"high","durationMs":91234}
```

`note` lines carry `{"mode":"note","chainId":"…","unique":n,"trigger":"auto|forced","outcome":"audit-pass|audit-concerns-user-approved|audit-concerns-dismissed|cap-revise|aborted","comment":"…"}` (every non-aborted chain ends at the audit, so there is no separate "approved" class; `…-dismissed` records concerns the user dispositioned by dismissal-with-reason rather than amendment). `trigger` is stamped from how the chain was opened (recorded on the reservation line); `outcome` classifies the chain's end. `audit-concerns-user-approved` explicitly labels the case where the user accepted a concern and amended the artifact — **user-approved, audit-unverified** (the audit is never re-run, so its verdict doesn't describe the amended text). `stats` reports the gate rate over **eligible chains** (`trigger:"auto"`, outcome ≠ `aborted`) and shows forced/aborted counts separately. The log directory is created if missing. Write-failure severity is per the three-class policy above (reservation fatal, result appends non-fatal, note fatal).

## SKILL.md orchestration

1. **Trigger:** plan gate reached (spec/plan/ADR finalized) or user request. Announce: "Running Codex plan review (Terra, high effort) — round 1."
2. **Preflight:** artifact must be a file — write conversation-only plans to their canonical path first (`docs/superpowers/specs/…`, `docs/plans/…`, or scratchpad for throwaways). If `codex` is missing or unauthenticated, say so, skip the review, never block the plan.
3. **Fix loop (max 3 rounds):** `review --auto` (or `--force` on explicit user request) → on `REVISE`: walk findings one at a time; amend the plan file for accepted findings; dismissals require a stated reason in the reply (never silent). Then `review --resume <sessionId> --chain <chainId>` to verify fixes. On `APPROVED` → step 4. Still `REVISE` after round 3 → present open findings to the user, log the `note`, and stop.
4. **Final audit:** one fresh-session `audit`. `PASS` → done. `CONCERNS` → surface the findings verbatim and **block**: the plan is not treated as review-complete until the user explicitly dispositions each concern (accept-and-amend, or dismiss with reason). The audit itself is never re-run; if the user amends the artifact in response, the outcome is recorded as `audit-concerns-user-approved` — user-approved, audit-unverified; if they dismiss the concerns with reasons instead, `audit-concerns-dismissed`.
5. **Gate bookkeeping:** after the walk, run `note --chain <chainId> --unique <n> --outcome <class>` (a finding counts as unique if Claude judges it real AND it wasn't already known or produced by the Claude-side review stack). Report one line to the user: rounds used, verdict, unique findings, cumulative `stats`.
6. **UNPARSEABLE handling (mode-specific retry):** one retry via resume — review mode: "Your previous message was missing the verdict line — end with VERDICT: APPROVED or VERDICT: REVISE."; audit mode: "Your previous message was missing the audit line — end with AUDIT: PASS or AUDIT: CONCERNS." Then surface to the user.

## Error handling summary

| Failure | Behavior |
|---|---|
| `codex` binary missing / not logged in | Script exits non-zero with a clear message; SKILL.md says skip + inform user |
| Timeout (default 300s) | Kill subprocess; log round as `"verdict":"timeout"`; exit non-zero |
| Codex exit code non-zero but transcript terminal event is clean + final message present | Ignore exit code; proceed on message |
| Transcript terminal event reports failure/error | `verdict: "error"` regardless of message text; surface to user |
| No parseable verdict | `UNPARSEABLE` JSON result; SKILL.md one nudge-retry then surface |
| Reservation (chain-open) write or lock fails | Refuse to open the chain (fatal, fail closed) |
| Round/audit result append fails | stderr warning; result JSON still printed |
| `note` write fails | Exit non-zero; Claude retries or surfaces (completion depends on it) |

## Testing

- `node --test` (repo convention for plugin `.mjs`).
- Unit: verdict/finding parsing (all verdict variants, missing verdict, multiple verdict lines), JSONL line construction, prompt assembly (asserts artifact content and any self-assessment-like text never appear — only the path).
- Guard & lifecycle unit tests: `--auto` refusal on existing content hash; `--force` bypassing the hash check but not log-unwritability; fail-closed behavior on unreadable/unwritable log (auto and force); chain reservation written before spawn; **concurrent open attempts on the same artifact — exactly one wins the lock and reserves, the other refuses**; stale-lock timeout recovery; `--chain` propagation into resume/audit log lines; `note` rejecting unknown and duplicate chainIds and exiting non-zero on write failure; `stats` computing completed-chain denominators and flagging open chains.
- Spawn/parse end-to-end against a **fake `codex` shim** prepended to PATH emitting canned `--json` event streams: success, timeout, malformed stream, missing verdict line (review and audit variants — asserting the mode-specific retry prompt), and terminal event reporting failure/error (asserting `verdict: "error"` despite message text). No quota, deterministic.
- Real-Codex smoke test: manual only (documented in README), not in CI.

## Escalation paths (documented, not built)

Unlock any of these only after the decision gate passes (≥1 confirmed unique finding per ~5 reviews by ~2026-07-28; check with `codex-review.mjs stats`):

1. **Diff mode** — wrap `codex review --base <ref>/--uncommitted` with the same logging, for headless pipeline use.
2. **SDD integration** — add Codex as an additional reviewer in the subagent-driven-development review stage; findings merge into the existing verify pipeline.
3. **adversarial-agents persona** — a `codex` persona whose dispatch is a Bash CLI call instead of an Agent subagent (requires a small dispatch special-case in that skill).

If the gate fails, retire the skill and keep the official plugin for interactive use only.

## Known constraints

- ChatGPT Plus metering is undocumented and currently in flux (5h caps temporarily lifted 2026-07-12/13); each review chain is bounded (≤3 review rounds + 1 audit) to keep worst-case burn predictable.
- Codex CLI headless review behavior churned in 0.143→0.144.x (Guardian policy regression/revert); after CLI upgrades, run the manual smoke test before trusting auto-triggered reviews.
- macOS-first; Windows sandbox issues in the Codex ecosystem are documented but out of scope.
