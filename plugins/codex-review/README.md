# codex-review

Cross-provider adversarial **plan/design-doc review** for Claude Code, using OpenAI Codex (GPT-5.6 Terra) as the reviewer. Fills the gap the official [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) plugin doesn't cover (its issue #4): reviewing plans and design docs, not just diffs. v0.2 adds an experimental **diff mode** (see below) — unproven, and not a replacement for the official plugin's `/codex:review`.

Design: `docs/superpowers/specs/2026-07-14-codex-plan-review-design.md`. Research: `docs/plans/2026-07-14-codex-adversarial-review-skill-research.md`.

## Install

```
/plugin marketplace add jasonm4130/claude-skills
/plugin install codex-review@jasonm4130-claude-skills
```

Requirements: [Codex CLI](https://github.com/openai/codex) ≥ 0.144 (`brew install codex`), authenticated (`codex login`, ChatGPT subscription or API key).

## What it does

At plan gates (finalized spec/plan/ADR) — or on "codex review this plan" — Claude runs a bounded verdict loop: Terra reviews the artifact file in a read-only sandbox → `VERDICT: APPROVED|REVISE` → Claude amends and resumes (max 3 rounds) → one fresh-session holistic audit (`AUDIT: PASS|CONCERNS`). Every chain is logged to `~/.claude/codex-review-log.jsonl` with a uniqueness judgment for the decision gate.

Key protections (see spec for rationale): reviewer never sees Claude's self-assessment; content-hash guard prevents duplicate auto-reviews of the same artifact version (atomic, cross-session); codex exit codes are never trusted; `--output-schema` is never used; explicit `-m gpt-5.6-terra` on every call.

## Diff mode (v0.2, experimental — unproven)

**Maturity: diff mode is unproven.** The decision gate that unlocked it was earned entirely on *plan*
review — every P1 Codex has found to date was in a design artifact, not in code. Whether Codex finds
code bugs an Opus review misses is the open question this mode exists to answer; treat its findings as
a second opinion, not an authority.

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

## Decision gate

Trial until ~2026-07-28: the skill must produce **≥1 confirmed unique finding per ~5 eligible chains** or be retired. Check anytime:

```
node plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs stats
```

## Escalation paths (documented, not built — unlock only if diff mode's own gate passes)

1. **SDD integration** — add Codex as an extra reviewer in the subagent-driven-development review stage.
2. **adversarial-agents persona** — a `codex` persona dispatched via Bash CLI instead of an Agent subagent.

Both need evidence that diff mode itself pulls weight before adding a paid external call to a hot path
like every SDD run. Not planned: PR-number input (`--pr 34`) — a git range already covers it — and
reviewing a diff against its plan, which is exactly what the self-assessment redaction rule forbids.

If the gate fails: retire this plugin; keep the official plugin for interactive diff review.

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

One JSONL line per event at `~/.claude/codex-review-log.jsonl` (override: `CODEX_REVIEW_LOG`): chain-open reservations (`mode:"open"`, with `trigger:"auto"|"forced"` and `contentHash`), round/audit results (verdict, findings by severity, session id, token usage, duration), and one mandatory closing `note` per chain (`unique`, `outcome`: `audit-pass|audit-concerns-user-approved|audit-concerns-dismissed|cap-revise|aborted`). Reservation and note writes are fatal on failure; result writes are best-effort.
