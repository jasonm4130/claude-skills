# session-retro

Claude Code plugin for interactive session retrospectives. Captures decisions, learnings, and gotchas to native memory after substantial sessions — so they're available in future sessions.

## Why

At the end of a productive Claude Code session, you've made decisions, hit errors, changed approach, discovered patterns. None of it gets captured by default. session-retro fixes that with two complementary mechanisms:

1. **Ambient, batched suggestions.** A `Stop` hook scores your session (edits, files touched, duration, commits, tests) and writes a nudge flag when work crosses sensible thresholds. On your next prompt a `UserPromptSubmit` hook absorbs that flag *silently* into a cross-session worthy log — it only surfaces a nudge once enough worthy sessions have accrued since your last retro (default: 3 sessions and 7 days), at most once a day, and the nudge tells the agent to run the retro for you. A `PreCompact` hook is the exception: it still nudges immediately, because context loss is a hard event.
2. **Batch-scoped interview.** When you run `/retro`, the skill retrospects *every* unprocessed worthy session since your last retro — not just the current one — because the nudge only fires after several have accrued. For the current session it reads live `git status`/`diff`/`log` plus the event log and asks about actual changes ("you edited `auth.ts` 4 times — what was the iteration about?"). Older sessions have no live diff, so their questions are seeded from their event-log aggregates ("on 2026-07-14 you edited the codex-review plugin 6 times — what was that about?"). No generic "what did you learn" prompts.

## What it does

- **Logs your work** — a tiny `PostToolUse` hook appends one JSONL line per Edit/Write/Bash event to `events-{session_id}.jsonl` (POSIX `O_APPEND`, atomic per PIPE_BUF, race-free under parallel tool calls)
- **Suggests retros, batched** — `Stop` aggregates the event log and writes a nudge flag when thresholds are met; `UserPromptSubmit` folds Stop-origin flags into a cross-session worthy log and only surfaces an agent-directed nudge once enough worthy sessions have piled up since the last retro; `PreCompact` still nudges immediately
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
| `UserPromptSubmit` | `check-retro-flag.mjs` consumes the flag (fire-once): PreCompact nudges immediately, Stop-origin folds into `retro-worthy.jsonl`, and a batched nudge fires once thresholds are met |
| `/session-retro:retro` | The skill — `collect-batch-sessions.mjs` resolves the unprocessed-worthy batch, walks you through it, writes memory, then `mark-retro-done.mjs` appends the batch to `retro-processed.jsonl` |

The batch nudge fires when the **unprocessed** worthy count (distinct sids in `retro-worthy.jsonl` minus those in `retro-processed.jsonl`) is `≥ RETRO_BATCH_MIN_SESSIONS` (default 3), `≥ RETRO_BATCH_MIN_DAYS` (default 7) have passed since the last retro, and no batch nudge fired in the last 24h. Both thresholds are env-overridable. Cleanup is append-only: a retro appends the interviewed sids to `retro-processed.jsonl` rather than rewriting the worthy log, so concurrent sessions can't lose writes.

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

### When the hook nudges you

Individual retro-worthy sessions no longer nudge you — they accumulate silently. Once enough have piled up, you'll see a Claude-authored line like:

> "[session-retro] 3 retro-worthy sessions since the last retro (8+ days). Run the retro skill now to batch-capture learnings, unless the user objects."

The agent will offer to run the retro directly. The exception is a compaction nudge, which still fires immediately:

> "[session-retro] This session: compact imminent. Run the retro skill now to capture decisions/learnings before compaction, unless the user objects."

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

## Migration from v0.2

v0.2 → v3 is a force-push redesign. To upgrade:

```
/plugin update session-retro@jasonm4130-session-retro
/reload-plugins
```

Claude Code will prompt to approve the new hooks (`PostToolUse`, `Stop`, `PreCompact`). Existing memory files keep working — same format. claude-mem is no longer a requirement; remove it if you only had it installed for session-retro.

## Migration from v0.3 to v0.4

v0.3 → v0.4 changes only the nudge mechanism — `/retro` behaviour itself is unchanged.

**What changed:** The `Stop` and `PreCompact` hooks previously emitted a `systemMessage` directly. In v0.4 they instead write a flag file (`retro-nudge-{session_id}.flag`). A new `UserPromptSubmit` hook (`check-retro-flag.sh`) picks up the flag on your next prompt and injects an `additionalContext` block, which the agent surfaces in its own voice. The flag is consumed immediately (fire-once).

**Why:** `systemMessage` is passive — the nudge appeared in the hook output panel and users consistently scrolled past it. `additionalContext` feeds directly into the agent's response, making the nudge much harder to miss.

**To upgrade:**

```
/plugin update session-retro@jasonm4130-session-retro
/reload-plugins
```

Claude Code will prompt to approve the new `UserPromptSubmit` hook.

## Migration from v0.5 to v0.6

v0.5 → v0.6 changes only *when* the nudge surfaces — hooks, flags, and the `/retro` interview are otherwise unchanged.

**What changed:** Per-session Stop nudges no longer interrupt you. `UserPromptSubmit` now folds each retro-worthy Stop into a cross-session worthy log (`retro-worthy.jsonl`) and only emits an agent-directed nudge once `≥ RETRO_BATCH_MIN_SESSIONS` (default 3) worthy sessions have accrued since your last retro and `≥ RETRO_BATCH_MIN_DAYS` (default 7) have passed — at most once per 24h. `PreCompact` still nudges immediately. The `/retro` skill now ends by running `mark-retro-done.mjs`, which records the fired flag and resets the batch clock.

**Why:** In practice the old per-session nudge fired ~60 times over three weeks and yielded 3 retros — noise that trained users to ignore it, while auto-memory already captured ambient facts. Batching trades 60 low-signal nudges for the occasional high-signal one the agent acts on directly.

Just `/plugin update` and `/reload-plugins`; no new hooks to approve, no on-disk format break.

## Tests

```
node --test plugins/session-retro/tests/
```

The Node `node:test` suite covers event-log init/parallel-writes (race regression), Stop hook threshold scoring (no-trigger, edits, duration, commit, tests-trigger, tool-calls, retro-fired suppression, compound reasons, malformed-line resilience, session_id from stdin), PreCompact flag-write, check-retro-flag handler (silent worthy-log absorption + dedup for Stop-origin flags, immediate emission for PreCompact, batch-nudge fire/silence across the session/day/24h gates, env overrides), mark-retro-done (fired flag + last-retro timestamp from stdin or argv), and an end-to-end integration test that runs the full SessionStart → PostToolUse → Stop → UserPromptSubmit pipeline.

## License

MIT
