# session-retro

Claude Code plugin for interactive session retrospectives. Captures decisions, learnings, and gotchas to native memory after substantial sessions — so they're available in future sessions.

## Why

At the end of a productive Claude Code session, you've made decisions, hit errors, changed approach, discovered patterns. None of it gets captured by default. session-retro fixes that with two complementary mechanisms:

1. **An end-of-day offer, never a per-session one.** A `Stop` hook scores your session (edits, files touched, duration, commits, tests) and writes a nudge flag when work crosses sensible thresholds; a `PreCompact` hook writes one unconditionally. On your next prompt a `UserPromptSubmit` hook absorbs that flag *silently* into a cross-session worthy log. Nothing about a single session interrupts you. The offer surfaces only in the evening — past `RETRO_EOD_HOUR` local time (default 16), at most once per calendar day, and only once enough worthy sessions have accrued since your last retro (default: 3 sessions, and at least a day since the last retro) — and it tells the agent to run the retro for you.
2. **Batch-scoped interview.** When you run `/retro`, the skill retrospects *every* unprocessed worthy session since your last retro — not just the current one — because the offer only comes after several have accrued. For the current session it reads live `git status`/`diff`/`log` plus the event log and asks about actual changes ("you edited `auth.ts` 4 times — what was the iteration about?"). Older sessions have no live diff, so their questions are seeded from their event-log aggregates ("on 2026-07-14 you edited the codex-review plugin 6 times — what was that about?"). No generic "what did you learn" prompts.

## What it does

- **Logs your work, with outcomes** — a tiny `PostToolUse` hook appends one JSONL line per Edit/Write/Bash event to `events-{session_id}.jsonl`, recording whether the call succeeded (`ok`, tri-state: `true`/`false`/`null` for "no signal in this payload"). POSIX `O_APPEND`, race-free under parallel tool calls: lines are *enforced* under the 4KB `PIPE_BUF` bound by clipping oversized `input` values, not merely assumed to fit
- **Offers retros at the end of the day** — `Stop` aggregates the event log and writes a nudge flag when thresholds are met; `UserPromptSubmit` folds every flag into a cross-session worthy log and surfaces one agent-directed offer per calendar day, in the evening, once enough worthy sessions have piled up since the last retro
- **Walks you through the whole batch** — `/retro` spans every unprocessed worthy session (current session diff-driven, older ones event-log-driven) to ask specific, non-generic questions, one at a time
- **Writes native memory** — entries land in your project memory dir using `feedback` / `project` / `reference` types with `**Why:**` and `**How to apply:**` slots

## How it works

Five hooks + one skill. The hooks are Node `.mjs` scripts (stdlib only, no third-party deps).

| Component | What it does |
|---|---|
| `SessionStart` | `mark-session-start.mjs` writes the session start timestamp |
| `PostToolUse` (Edit\|Write\|Bash) | `posttooluse-append-event.mjs` appends one JSONL event |
| `Stop` | `stop-write-retro-flag.mjs` aggregates events and writes a nudge flag if retro-worthy |
| `PreCompact` | `precompact-write-retro-flag.mjs` always writes a nudge flag before compaction |
| `UserPromptSubmit` | `check-retro-flag.mjs` consumes the flag (fire-once) into `retro-worthy.jsonl`, then fires the end-of-day offer if the hour, day and batch gates all pass |
| `/session-retro:retro` | The skill — `collect-batch-sessions.mjs` resolves the unprocessed-worthy batch, walks you through it, writes memory, then `mark-retro-done.mjs` appends the batch to `retro-processed.jsonl` |

The end-of-day offer fires when all four gates pass: local time is at or past `RETRO_EOD_HOUR` (default 16), no offer has been claimed today (`eod-offer-<local date>.txt` — the date lives in the filename so concurrent sessions race on an atomic exclusive-create, and exactly one wins), the **unprocessed** worthy count (distinct sids in `retro-worthy.jsonl` minus those in `retro-processed.jsonl`) is `≥ RETRO_BATCH_MIN_SESSIONS` (default 3), and `≥ RETRO_BATCH_MIN_DAYS` (default 1 — raise it to space retros out) have passed since the last retro. All three thresholds are env-overridable. Cleanup is append-only: a retro appends the interviewed sids to `retro-processed.jsonl` rather than rewriting the worthy log, so concurrent sessions can't lose writes.

The offer itself is a **`systemMessage`**, which Claude Code shows in the transcript before processing your prompt, with `additionalContext` alongside instructing the model not to start a retro unprompted. It was `additionalContext` alone until 2026-08-30, which addressed the model and never you — 18 sessions were flagged retro-worthy over that period and no retro was ever run.

No external services. No SQLite. No MCP server. No Python. Just Node 18+ and git.

## Install

```
/plugin marketplace add jasonm4130/claude-skills
/plugin install session-retro@jasonm4130-claude-skills
/reload-plugins
```

On first load, Claude Code will prompt you to approve the hooks. This is normal — plugins that execute code require explicit user trust.

## Requirements

- Claude Code ≥ 2.1.110
- **Node.js 18+ on PATH** — the native Claude Code installer does not bring Node. Install via Homebrew (`brew install node`), WinGet (`winget install OpenJS.NodeJS.LTS`), or your distro's package manager.
- git (optional — interview-only mode if not in a git repo)

## Usage

### When the hook offers you a retro

Individual retro-worthy sessions never nudge you — they accumulate silently, compactions included. Once enough have piled up, the first prompt you send after 16:00 gets a Claude-authored line like:

> "[session-retro] End of day: 3 retro-worthy sessions accrued (8+ days since the last retro). Run the session-retro:retro skill now to batch-capture the learnings, unless the user objects."

The agent will offer to run the retro directly. Decline it and nothing more comes until tomorrow evening.

Set `RETRO_EOD_HOUR` (an integer hour, local, default `16`) to move the offer earlier or later.

### Manual invocation

```
/session-retro:retro
```

Natural-language triggers also work — "retro", "what did we learn", "session summary".

### What gets captured

The skill writes to `${CLAUDE_PROJECT_DIR}/memory/` using three types:

- **`feedback`** — corrections to Claude's behaviour
- **`project`** — decisions, project context
- **`reference`** — external resources

Each entry has `**Why:**` and `**How to apply:**` slots so the rationale survives.

## Upgrading

`bash scripts/update-plugins.sh` then `/reload-plugins`, or see the root README's
*Updating an installed plugin*. Claude Code prompts to approve any hook the new
version adds. Upgrades need no manual migration step: where on-disk state had to
change (the v0.7.0 `retro-processed.jsonl` ledger), the hooks run a one-time,
idempotent migration themselves. For what changed in a given release, read
`git log plugins/session-retro/`.

## Tests

```
node --test plugins/session-retro/tests/*.test.mjs
```

The Node `node:test` suite covers event-log init/parallel-writes (race regression), Stop hook threshold scoring (no-trigger, edits, duration, commit, tests-trigger, tool-calls, retro-fired suppression, compound reasons, malformed-line resilience, session_id from stdin), PreCompact flag-write, check-retro-flag handler (silent worthy-log absorption + dedup for both flag origins, end-of-day offer fire/silence across the hour, calendar-day, session and cadence gates, env overrides — all with the clock injected via `RETRO_NOW`, never the wall clock), mark-retro-done (fired flag + last-retro timestamp from stdin or argv), and an end-to-end integration test that runs the full SessionStart → PostToolUse → Stop → UserPromptSubmit pipeline.

## License

MIT
