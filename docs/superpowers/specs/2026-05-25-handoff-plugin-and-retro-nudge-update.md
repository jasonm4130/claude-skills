# Handoff plugin + session-retro nudge update — design

**Date:** 2026-05-25
**Status:** Design — pending implementation
**Scope:** Two plugins in this marketplace — a new `handoff` plugin (v0.1.0) and an update to `session-retro` (v0.3.0 → v0.4.0).

## Context

Session continuity in Claude Code has two distinct gaps:

1. **Activity-based learning capture.** session-retro v0.3.0 already addresses this with deterministic Stop/PreCompact triggers + a diff-driven interview. But the trigger surface (`systemMessage`) is passive — the user often scrolls past it and the nudge "never really hits". Per the user's experience report, this is the single biggest reliability problem with the current implementation.

2. **Context-fill-based handoff.** When context approaches auto-compact (~83% on recent CC versions), the user has no proactive surface telling them to write a resume doc before detail is lost. Research surveyed 7+ public handoff implementations and 4 distinct nudge surfaces; no public tool combines threshold detection with an agent-authored handoff suggestion. This is genuine whitespace.

This spec covers both: a new `handoff` plugin that fills gap (2), and a nudge-mechanism swap in session-retro that fixes gap (1) by adopting the same model-mediated nudge pattern used by the new plugin.

## Goals

- **Fix session-retro's nudge reliability** by swapping the Stop/PreCompact `systemMessage` output for a flag-write that a new `UserPromptSubmit` hook consumes — turning the nudge into an `additionalContext` injection that the agent surfaces in its own voice.
- **Add a `/handoff` skill in a new plugin** that the agent authors from its own context (not via JSONL parsing), writes to a project-local `.claude/handoffs/` directory, and that the next session auto-loads via a pending-flag.
- **Detect context fill via statusLine** at a configurable threshold (default 70% — see Open Questions) and fire the handoff nudge once per crossing using the same flag-write → UserPromptSubmit pattern.
- **No explicit coordination between plugins.** Both plugins emit independent `additionalContext` on UserPromptSubmit; CC concatenates them and the agent synthesises one response.
- **No JSONL transcript parsing in any script.** session-retro's existing event log (PostToolUse-maintained) and statusLine's native `context_window.used_percentage` are the only signals.

## Non-goals

- **No PreCompact blocking.** Research showed `PreCompact` doesn't support `additionalContext` and the `compact` matcher on `SessionStart` is buggy (issue #28305). Both are sidestepped — PreCompact writes a flag the next UserPromptSubmit consumes; SessionStart auto-load uses no matcher (default = `startup` + `resume`).
- **No multi-project handoff store.** Handoffs are project-local (`$PROJECT_ROOT/.claude/handoffs/`). Cross-project search is out of scope (covered by `rg` over `~/Work/`).
- **No session-retro skill rewrite.** The `/retro` skill itself is unchanged. Only the nudge mechanism (trigger surface) changes.
- **No native CC banner reliance.** Issue #50015 documents silent compaction in v2.1.111+ — we don't depend on the native banner firing.
- **No statusLine auto-install.** CC's `statusLine` is a singleton in settings.json; plugins can't ship one. README documents the one-line wiring required.

## Architecture

Two plugins. Each registers its own hooks. Neither parses transcripts.

```
┌─────────────────────────────────────────────────────────────────┐
│  session-retro plugin (updated, v0.4.0)                         │
│                                                                  │
│  Unchanged infrastructure:                                       │
│  • SessionStart  → mark-session-start.sh (timestamp)            │
│  • PostToolUse   → posttooluse-append-event.sh (event log)      │
│                                                                  │
│  Changed: trigger surface                                       │
│  • Stop  → stop-write-retro-flag.sh (was: stop-suggest-retro.sh)│
│           Same threshold logic, but writes a flag file instead  │
│           of emitting systemMessage                             │
│  • PreCompact → precompact-write-retro-flag.sh                  │
│           Writes flag (replaces systemMessage emission)         │
│  • NEW: UserPromptSubmit → check-retro-flag.sh                  │
│           Reads flag, injects additionalContext, deletes flag   │
│                                                                  │
│  /retro skill: unchanged                                        │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  handoff plugin (new, v0.1.0)                                   │
│                                                                  │
│  Trigger source: context-fill % via statusLine                  │
│  • statusLine → status-and-flag.sh                              │
│           Reads context_window.used_percentage, renders         │
│           color bar, writes flag at threshold (fire-once)       │
│                                                                  │
│  Nudge surface: same pattern as session-retro                   │
│  • UserPromptSubmit → check-handoff-flag.sh                     │
│           Reads flag, injects additionalContext, deletes flag   │
│                                                                  │
│  Resume mechanism                                                │
│  • SessionStart → load-pending-handoff.sh                       │
│           If .claude/handoffs/.pending exists, read the linked  │
│           handoff, inject as additionalContext, delete .pending │
│                                                                  │
│  /handoff skill (agent-authored)                                │
│           Writes .claude/handoffs/<timestamp>-<slug>.md         │
│           Touches .claude/handoffs/.pending → next session      │
│           auto-loads                                            │
└─────────────────────────────────────────────────────────────────┘
```

**Trigger interaction.** Both plugins write to separate flag files in their own `$CLAUDE_PLUGIN_DATA`. Both UserPromptSubmit hooks fire independently on the same user prompt. The agent receives two `<system-reminder>` blocks if both flags are set, and synthesises one coherent response — model-mediated coordination, no explicit wiring.

## Components

| Script | Plugin | Hook event | Reads | Writes / outputs | Notes |
|---|---|---|---|---|---|
| `mark-session-start.sh` | session-retro | SessionStart | `$CLAUDE_SESSION_ID` | `session-start-{sid}.txt` | Unchanged |
| `posttooluse-append-event.sh` | session-retro | PostToolUse (Edit\|Write\|Bash) | hook stdin | appends to `events-{sid}.jsonl` | Unchanged. Atomic per POSIX O_APPEND. |
| `stop-write-retro-flag.sh` | session-retro | Stop | events log + session-start ts + `retro-fired-{sid}.flag` | writes `retro-nudge-{sid}.flag` containing trigger reasons | Replaces `stop-suggest-retro.sh`. Same threshold logic. |
| `precompact-write-retro-flag.sh` | session-retro | PreCompact | nothing | writes `retro-nudge-{sid}.flag` with reason `"compact imminent"` | Replaces `precompact-suggest-retro.sh`. |
| `check-retro-flag.sh` | session-retro | UserPromptSubmit | `retro-nudge-{sid}.flag` | additionalContext JSON, deletes flag | NEW. Fire-once-per-set. |
| `status-and-flag.sh` | handoff | statusLine | stdin (`context_window.used_percentage`) + `last-context-pct-{sid}.txt` | status line text + (on crossing) `handoff-nudge-{sid}.flag` + always updates `last-context-pct` | NEW. Tracks last % to detect first crossing of threshold. |
| `check-handoff-flag.sh` | handoff | UserPromptSubmit | `handoff-nudge-{sid}.flag` | additionalContext JSON, deletes flag | NEW. |
| `load-pending-handoff.sh` | handoff | SessionStart | `.claude/handoffs/.pending` + linked doc | additionalContext with handoff content, deletes `.pending` | NEW. Skip + delete if `.pending` >24h old or referenced file missing. |

## State files

| Path | Lifetime | Writer | Reader | Notes |
|---|---|---|---|---|
| `$CLAUDE_PLUGIN_DATA/session-start-{sid}.txt` | session | session-retro SessionStart | session-retro /retro | Existing |
| `$CLAUDE_PLUGIN_DATA/events-{sid}.jsonl` | session | session-retro PostToolUse | session-retro Stop + /retro | Existing, append-only |
| `$CLAUDE_PLUGIN_DATA/retro-fired-{sid}.flag` | session | /retro skill at completion | session-retro Stop (suppresses re-nudge) | Existing |
| `$CLAUDE_PLUGIN_DATA/retro-nudge-{sid}.flag` | until consumed | Stop / PreCompact | UserPromptSubmit (`check-retro-flag.sh`) | NEW. Plain text content = trigger reasons. |
| `$CLAUDE_PLUGIN_DATA/last-context-pct-{sid}.txt` | session | handoff statusLine | handoff statusLine | NEW. Used to detect first crossing. |
| `$CLAUDE_PLUGIN_DATA/handoff-nudge-{sid}.flag` | until consumed | handoff statusLine on crossing | UserPromptSubmit (`check-handoff-flag.sh`) | NEW. Content = `"context at N% (threshold T%)"`. |
| `$PROJECT_ROOT/.claude/handoffs/<ts>-<slug>.md` | persistent | /handoff skill | next session via SessionStart, or manual cat | NEW. Agent-authored. Gitignored by default. |
| `$PROJECT_ROOT/.claude/handoffs/.pending` | until consumed | /handoff skill | SessionStart (`load-pending-handoff.sh`) | NEW. Plain text = doc filename. Stale if >24h. |

## Data flow

### Flow 1 — Activity-based retro nudge

1. User edits ≥3 files over ≥20 min.
2. PostToolUse appends to `events-{sid}.jsonl` (atomic per O_APPEND).
3. Agent finishes a turn → Stop hook fires.
4. `stop-write-retro-flag.sh` aggregates events, sees thresholds met, writes `retro-nudge-{sid}.flag` with trigger reasons as plain text.
5. User submits next prompt → UserPromptSubmit fires.
6. `check-retro-flag.sh` reads flag, emits `additionalContext` JSON, deletes flag.
7. Agent's next response naturally surfaces the suggestion in its own voice ("We've done substantial work — want me to run /retro?").
8. If user accepts, `/retro` runs and touches `retro-fired-{sid}.flag`.
9. Future Stop hooks see `retro-fired` flag → skip writing new flag.

### Flow 2 — Context-fill handoff nudge

1. User works, context grows.
2. Each turn, CC invokes statusLine command with `context_window` data on stdin.
3. `status-and-flag.sh` reads `used_percentage`, renders the status line, updates `last-context-pct`.
4. If `used_percentage ≥ threshold` AND previous `last-context-pct < threshold` → writes `handoff-nudge-{sid}.flag`.
5. User submits next prompt → UserPromptSubmit fires.
6. `check-handoff-flag.sh` reads flag, emits `additionalContext`, deletes flag.
7. Agent surfaces the nudge.
8. If user runs `/handoff`, the agent writes `.claude/handoffs/<ts>-<slug>.md` and touches `.pending` with the filename.
9. User runs `/clear` (or just starts a new session next day).
10. Next session: SessionStart fires → `load-pending-handoff.sh` reads `.pending`, reads referenced doc, injects via `additionalContext`, deletes `.pending`.
11. Agent in fresh session sees the handoff and resumes.

### Flow 3 — Both nudges fire simultaneously

1. Both flags set independently (different signals, different writers).
2. UserPromptSubmit fires both hooks (different plugins, registered separately).
3. Each emits its own `additionalContext`; CC concatenates them into one `<system-reminder>` block.
4. Agent sees both signals and synthesises ("substantial work + context at 76% — consider /retro first, then /handoff, then /clear").

## File-by-file changes

### session-retro plugin (v0.3.0 → v0.4.0)

**Renames:**
- `scripts/stop-suggest-retro.sh` → `scripts/stop-write-retro-flag.sh`
- `scripts/precompact-suggest-retro.sh` → `scripts/precompact-write-retro-flag.sh`

**New file:**
- `scripts/check-retro-flag.sh` — UserPromptSubmit handler.

**Modified files:**
- `hooks/hooks.json` — change Stop/PreCompact command paths, add UserPromptSubmit entry.
- `.claude-plugin/plugin.json` — version `0.3.0` → `0.4.0`.
- `README.md` — explain the new nudge mechanism.

**Unchanged:**
- `scripts/mark-session-start.sh`
- `scripts/posttooluse-append-event.sh`
- `skills/retro/SKILL.md`

**Test updates** (5 tests assert on stdout JSON; switch to asserting on flag-file existence + content):
- `test_stop_commit_trigger.sh`
- `test_stop_compound_reasons.sh`
- `test_stop_duration_threshold.sh`
- `test_stop_edits_threshold.sh`
- `test_stop_no_trigger.sh`
- `test_stop_retro_fired_suppresses.sh`
- `test_precompact_always_fires.sh`

**New tests:**
- `test_check_retro_flag_consumes.sh`
- `test_check_retro_flag_no_flag.sh`

### handoff plugin (new, v0.1.0)

```
plugins/handoff/
├── .claude-plugin/plugin.json
├── skills/handoff/SKILL.md
├── hooks/hooks.json
├── scripts/
│   ├── status-and-flag.sh
│   ├── check-handoff-flag.sh
│   └── load-pending-handoff.sh
├── tests/
│   ├── run-all.sh
│   ├── test_statusline_crossing.sh
│   ├── test_statusline_no_crossing.sh
│   ├── test_statusline_already_above.sh
│   ├── test_check_handoff_flag_consumes.sh
│   ├── test_check_handoff_flag_no_flag.sh
│   ├── test_load_pending_loads.sh
│   ├── test_load_pending_stale.sh
│   └── test_load_pending_missing_file.sh
├── README.md
└── CLAUDE.md
```

**`hooks/hooks.json`** registers:
- `UserPromptSubmit` → `${CLAUDE_PLUGIN_ROOT}/scripts/check-handoff-flag.sh`
- `SessionStart` → `${CLAUDE_PLUGIN_ROOT}/scripts/load-pending-handoff.sh`

**`skills/handoff/SKILL.md`** content shape:
- Frontmatter triggers: `/handoff`, "handoff", "write a handoff", "prep for resume".
- Optional free-form `<focus>` argument (mattpocock-style).
- Prescribes the structured-template sections: Current state / What we tried / Key decisions / Modified files / Blockers / Next concrete step.
- Includes one short worked example inline (few-shot > prescriptive headers).
- Mandates `don't duplicate, reference artefacts` rule.
- Mandates secret redaction rule.
- Pre-write checklist: secrets redacted, file paths concrete, decisions tied to reasons, next step is runnable.
- After writing, touches `.claude/handoffs/.pending` containing the filename.
- Filename format: `<ISO timestamp>-<slug>.md` where slug = focus arg or `auto`.

### marketplace.json updates

```json
{
  "name": "handoff",
  "source": "./plugins/handoff",
  "description": "Context-fill-triggered handoff skill — writes a structured resume doc when context fills, auto-loads it on next session.",
  "version": "0.1.0",
  "author": { "name": "Jason Matthew" },
  "license": "MIT",
  "keywords": ["handoff", "context", "resume", "session-continuity"],
  "category": "productivity"
}
```

Bump session-retro entry: `"version": "0.3.0"` → `"0.4.0"`.

## Error handling

All hooks use `set -euo pipefail` and explicit `|| true` only where graceful degradation is intentional.

| Failure mode | Behaviour |
|---|---|
| jq not installed | Hook outputs nothing, exit 0. README lists jq as a requirement. |
| Hook stdin malformed JSON | Skip gracefully, exit 0. |
| Flag file missing when expected | Silent exit 0. |
| `.pending` references nonexistent file | Delete `.pending`, silent exit 0. |
| `.pending` >24h old | Delete `.pending`, silent exit 0. |
| statusLine command fails | Output `?` to stdout (single char) so user sees something is wrong but no crash. |
| `$CLAUDE_PLUGIN_DATA` not set | Fall back to `/tmp/<plugin>-data` (matches session-retro precedent). |
| `$CLAUDE_SESSION_ID` not in hook stdin | Fall back to env var, then `"unknown"`. |

All `additionalContext` emitters use the full `hookSpecificOutput` envelope:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "..."
  }
}
```
This avoids the issue #53682 silent-drop bug and is harmless even when the bug doesn't apply.

## Testing

CI workflow (`.github/workflows/ci.yml`) adds a `test-handoff` job mirroring `test-session-retro` (Ubuntu + macOS matrix, runs `plugins/handoff/tests/run-all.sh`).

JSON manifest validation already covers the new `plugins/handoff/.claude-plugin/plugin.json` via the existing glob.

## Release sequencing

**Recommended: one PR for both changes.** They're complementary and the full demo flow ("activity + context-fill both nudge, agent synthesises") only works with both shipped.

Alternative if a safer rollout is preferred: PR 1 = handoff plugin standalone (no existing-user impact), PR 2 = session-retro nudge swap (visible behaviour change for current users).

## Open questions for the implementation phase

1. **Threshold calibration.** `used_percentage` reportedly underestimates by ~19% (issues #17959, #19475). At 75% reported ≈ 89% actual — possibly too late. Default to **70%** as a compromise; expose `HANDOFF_THRESHOLD_PCT` env var for tuning. Measure on real sessions and adjust.
2. **Pending-flag staleness window.** Default to 24h. If user typically resumes within a day, fine; longer pauses lose handoffs. Could move to 7d, or never-expire with a staleness warning. Decide on first feedback.
3. **`/handoff` argument format.** Default to free-form description (mattpocock-style). Reconsider if usage suggests structured args are useful.
4. **Post-resume `/retro` behaviour.** After SessionStart loads a handoff, the new session's `events-{sid}.jsonl` is empty. `/retro` quick-skip gate will fire. Correct, but document in README.

## References

- session-retro v3 design: `plugins/session-retro/docs/superpowers/specs/2026-05-01-retro-v3-design.md`
- Anthropic hooks reference: https://code.claude.com/docs/en/hooks
- Anthropic statusLine reference: https://code.claude.com/docs/en/statusline
- Issue #53682 (additionalContext envelope silent-drop): https://github.com/anthropics/claude-code/issues/53682
- Issue #50015 (silent compaction regression v2.1.111+): https://github.com/anthropics/claude-code/issues/50015
- Issue #17959 (used_percentage underestimate): https://github.com/anthropics/claude-code/issues/17959
- mattpocock handoff skill (minimal reference): https://github.com/mattpocock/skills/blob/main/skills/productivity/handoff/SKILL.md
- who96/claude-code-context-handoff (PreCompact + SessionStart reference): https://github.com/who96/claude-code-context-handoff
- jarrodwatts/claude-hud (statusLine reference): https://github.com/jarrodwatts/claude-hud
