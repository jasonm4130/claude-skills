# session-retro

Claude Code plugin for interactive session retrospectives. Captures decisions, learnings, and gotchas to native memory after substantial sessions — so they're available in future sessions.

## Why

At the end of a productive Claude Code session, you've made decisions, hit errors, changed approach, discovered patterns. None of it gets captured by default. session-retro fixes that with two complementary mechanisms:

1. **Deterministic suggestions.** A `Stop` hook scores your session (edits, files touched, duration, commits, tests) and writes a nudge flag when work crosses sensible thresholds. A `PreCompact` hook always sets the flag before context is compacted away. A `UserPromptSubmit` hook consumes the flag and injects `additionalContext` so the agent surfaces the nudge in its own voice on your next prompt.
2. **Diff-driven interview.** When you run `/retro`, the skill reads the per-session event log plus `git status`, `git diff --stat`, and `git log` since session start, then asks specific questions about the actual changes ("you edited `auth.ts` 4 times — what was the iteration about?"). No generic "what did you learn" prompts.

## What it does

- **Logs your work** — a tiny `PostToolUse` hook appends one JSONL line per Edit/Write/Bash event to `events-{session_id}.jsonl` (POSIX `O_APPEND`, atomic per PIPE_BUF, race-free under parallel tool calls)
- **Suggests retros** — `Stop` hook aggregates the event log and writes a nudge flag when thresholds are met; `PreCompact` always writes the flag; `UserPromptSubmit` consumes the flag and injects `additionalContext` so the agent delivers the nudge naturally
- **Walks you through** — `/retro` uses the event log + git diff to ask specific, non-generic questions, one at a time
- **Writes native memory** — entries land in your project memory dir using `feedback` / `project` / `reference` types with `**Why:**` and `**How to apply:**` slots

## How it works

Five hooks + one skill. The hooks are Node `.mjs` scripts (stdlib only, no third-party deps).

| Component | What it does |
|---|---|
| `SessionStart` | `mark-session-start.mjs` writes the session start timestamp |
| `PostToolUse` (Edit\|Write\|Bash) | `posttooluse-append-event.mjs` appends one JSONL event |
| `Stop` | `stop-write-retro-flag.mjs` aggregates events and writes a nudge flag if retro-worthy |
| `PreCompact` | `precompact-write-retro-flag.mjs` always writes a nudge flag before compaction |
| `UserPromptSubmit` | `check-retro-flag.mjs` reads the flag and injects `additionalContext` (fire-once) |
| `/session-retro:retro` | The skill — reads events + git, walks you through, writes memory |

No external services. No SQLite. No MCP server. No Python. Just Node 18+ and git.

## Install

```
/plugin marketplace add jasonm4130/session-retro
/plugin install session-retro@jasonm4130-session-retro
/reload-plugins
```

On first load, Claude Code will prompt you to approve the hooks. This is normal — plugins that execute code require explicit user trust.

## Requirements

- Claude Code ≥ 2.1.110
- **Node.js 18+ on PATH** — the native Claude Code installer does not bring Node. Install via Homebrew (`brew install node`), WinGet (`winget install OpenJS.NodeJS.LTS`), or your distro's package manager.
- git (optional — interview-only mode if not in a git repo)

## Usage

### When the hook nudges you

After substantial work, you'll see a Claude-authored line like:

> "[session-retro] This session: 7 edits across 3 files + 25 minutes of work. Suggest running /retro to capture decisions/learnings before /clear."

Run `/retro` when you see it.

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

## Tests

```
node --test plugins/session-retro/tests/
```

The Node `node:test` suite covers event-log init/parallel-writes (race regression), Stop hook threshold scoring (no-trigger, edits, duration, commit, tests-trigger, tool-calls, retro-fired suppression, compound reasons, malformed-line resilience, session_id from stdin), PreCompact flag-write, check-retro-flag handler (consumes flag + emits additionalContext; silent when no flag), and an end-to-end integration test that runs the full SessionStart → PostToolUse → Stop → UserPromptSubmit pipeline.

## License

MIT
