# codex-review

Cross-provider adversarial **plan/design-doc review** for Claude Code, using OpenAI Codex (GPT-5.6 Terra) as the reviewer. Fills the gap the official [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) plugin doesn't cover (its issue #4): reviewing plans and design docs, not just diffs. v0.2 added **diff mode** (see below), now proven on three dogfoods — still not a replacement for the official plugin's interactive `/codex:review`.

Design: `docs/superpowers/specs/2026-07-14-codex-plan-review-design.md`. Research: `docs/plans/2026-07-14-codex-adversarial-review-skill-research.md`.

## Install

```
/plugin marketplace add jasonm4130/claude-skills
/plugin install codex-review@jasonm4130-claude-skills
```

Requirements: **Node.js 18+** on `PATH` (runs `scripts/codex-review.mjs` directly) and
[Codex CLI](https://github.com/openai/codex) ≥ 0.144 (`brew install codex`), authenticated
(`codex login`, ChatGPT subscription or API key).

## What it does

At plan gates (finalized spec/plan/ADR) — or on "codex review this plan" — Claude runs a bounded verdict loop: Terra reviews the artifact file in a read-only sandbox → `VERDICT: APPROVED|REVISE` → Claude amends and resumes (max 3 rounds) → one fresh-session holistic audit (`AUDIT: PASS|CONCERNS`). Every chain is logged to `~/.claude/codex-review-log.jsonl` with a uniqueness judgment for the decision gate.

Key protections (see spec for rationale): reviewer never sees Claude's self-assessment; content-hash guard prevents duplicate auto-reviews of the same artifact version (atomic, cross-session); codex exit codes are never trusted; `--output-schema` is never used; explicit `-m gpt-5.6-terra` on every call.

## Diff mode — ✅ PROVEN (2026-07-14)

Diff mode shipped with a caveat: whether a cross-family reviewer finds *code* bugs an Opus review misses
was an open question. **Three dogfoods answered it — each found real bugs in code that had already
passed a Claude-side review:**

| Run | Reviewed | Found |
|---|---|---|
| 1 | its own introducing commit | a range parser that silently reviewed the **wrong, reversed** git range while reporting success; an off-by-one |
| 2 | the deep-dive integrity branch — *after* 3 plan rounds + an audit | a host guard that let a fabricated citation aim the verifier's `WebFetch` at `169.254.169.254`; `startsWith`-only placeholder matching; unvalidated `sourceTitle`/`sourceDate` |
| 3 | the handoff provenance branch | `.claude/handoffs/` shipped as a **git submodule** bypassed the new provenance check entirely |

**Plan review and diff review catch different classes of thing.** Run 2 is the proof: a plan that had
survived three review rounds *and* a fresh-session audit still shipped three real bugs.

**So the skill now runs diff mode after implementing a reviewed plan, before the PR opens.** Findings are
still a second opinion, not an authority — verify each against HEAD before acting (run 3 produced one
genuine bypass and one finding that named a real test gap but was wrong about the mechanism).

`diff <range> --force` reviews a git range instead of a file; `diff-audit <range> --chain <id>` is its
one fresh-session audit round:

```
node plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs diff main...HEAD --force
```

- **Use a fixed base against a moving tip — `main...HEAD`**, not `HEAD~1..HEAD`. The chain's identity
  is the range string, so it must stay meaningful as fix commits land; `HEAD~1..HEAD` means something
  different after every commit and therefore cannot be resumed (fine only for a one-shot review). Each
  round pins the range to commit SHAs, so the diff Codex renders is the diff that was hashed and
  recorded — surrounding files are still read from the working tree, by design.
- An explicit `..`/`...` range is required — a bare ref would fold in uncommitted changes.
- `--max-lines` (default 4000) plus a 400KB byte cap; an oversized diff is refused, never truncated.
- Files git will not render (binary, or `-diff` in `.gitattributes`) are named in the prompt as NOT
  SHOWN, never silently dropped.
- Same 3-round + 1-audit protocol as plan mode, now actually enforced: a 4th review round and a 2nd
  audit are both refused before any paid call.

## Decision gate — ✅ PASSED 2026-07-14, two weeks early

The trial required **≥1 confirmed unique finding per ~5 eligible chains** by ~2026-07-28. It came in at
**37.5 per 5 — roughly 37× the bar.** The plugin is kept. `stats` is now a health check rather than a
survival test; if `uniquePer5` collapses toward 1, revisit. Treat `uniquePer5` as a **floor, not a
target**: a clean review that produces zero findings is a success, and the reviewer is never tuned toward
producing findings (LLM reviewers over-reject correct code — see
`docs/plans/2026-07-15-ai-reviewer-calibration-and-clean-pass-research.md`).

```
node plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs stats
```

## Escalation paths (documented, not built — still ungated)

1. **SDD integration** — add Codex as a **whole-branch** reviewer *after* an SDD run completes (the
   `diff main...HEAD` gate), **not** a per-task reviewer inside the loop. Evidence favours whole-branch:
   an SDD run whose 8 tasks each passed their own per-task gate still had 6 whole-branch blockers (2
   data-destroying) that per-task review structurally cannot see; and a per-task external reviewer pays
   N× the paid-call cost and N× the reviewer's over-rejection surface to catch strictly less. See
   `docs/plans/2026-07-15-ai-reviewer-calibration-and-clean-pass-research.md`.

Diff mode has now earned its keep (above), which was the precondition. This is not built yet: it puts a
**paid external call on a hot path** (every SDD run), so it needs its own trial before it goes in — the
same discipline that made diff mode worth keeping. Do not wire it into an automated gate on the strength
of diff mode's numbers alone.

(A second candidate, an `adversarial-agents` codex persona, is moot — that plugin was retired
2026-08-03 after zero invocations in ten weeks.)

Not planned: PR-number input (`--pr 34`) — a git range already covers it — and reviewing a diff against
its plan, which is exactly what the self-assessment redaction rule forbids.

## Manual smoke test (run after Codex CLI upgrades)

Headless review behavior churned in codex 0.143→0.144.x; before trusting auto-triggered reviews after an upgrade:

```
echo "# throwaway plan: add a --dry-run flag to foo.sh" > /tmp/smoke-plan.md
node plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs review /tmp/smoke-plan.md --force --timeout 180
# expect: result JSON with a VERDICT, a sessionId, and usage tokens
# then one resume round — this is what validates the sandbox-inheritance assumption:
node plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs review /tmp/smoke-plan.md --resume <sessionId> --chain <chainId> --timeout 180
# expect: a second result JSON with a VERDICT; then close the chain:
node plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs note --chain <chainId> --unique 0 --outcome aborted --comment "aborted: smoke test"
```

The smoke test also validates the one undocumented assumption: resumed sessions inherit the read-only sandbox (resume exposes no `--sandbox` flag).

## Log schema

One JSONL line per event at `~/.claude/codex-review-log.jsonl` (override: `CODEX_REVIEW_LOG`): chain-open reservations (`mode:"open"`, with `trigger:"auto"|"forced"` and `contentHash`), round/audit results (verdict, findings by severity, session id, token usage, duration), and one mandatory closing `note` per chain (`unique`, `outcome`: `audit-pass|audit-concerns-user-approved|audit-concerns-dismissed|audit-concerns-unattended|cap-revise|aborted`; `audit-concerns-unattended` is the background/Workflow path, where no human was present to disposition the concerns and claiming otherwise would put a false attribution in the log). Reservation and note writes are fatal on failure; result writes are best-effort.
