# codex-review

Cross-provider adversarial **plan/design-doc review** for Claude Code, using OpenAI Codex (GPT-5.6 Terra) as the reviewer. Fills the gap the official [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) plugin doesn't cover (its issue #4): reviewing plans and design docs rather than diffs. Diff review is deliberately out of scope — use the official plugin's `/codex:review` for that.

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

## Decision gate

Trial until ~2026-07-28: the skill must produce **≥1 confirmed unique finding per ~5 eligible chains** or be retired. Check anytime:

```
node plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs stats
```

## Escalation paths (documented, not built — unlock only if the gate passes)

1. **Diff mode** — wrap `codex review --base <ref>/--uncommitted` with the same logging for headless pipeline use.
2. **SDD integration** — add Codex as an extra reviewer in the subagent-driven-development review stage.
3. **adversarial-agents persona** — a `codex` persona dispatched via Bash CLI instead of an Agent subagent.

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
