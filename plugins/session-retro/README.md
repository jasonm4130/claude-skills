# session-retro

Claude Code plugin for interactive session retrospectives. Captures decisions, learnings, and gotchas to native memory after substantial sessions — so they're available in future sessions.

## Why

At the end of a productive Claude Code session, you've made decisions, hit errors, changed approach, discovered patterns. None of it gets captured by default. session-retro fixes that with two complementary mechanisms:

1. **Deterministic suggestions.** A `Stop` hook scores your session (edits, files touched, duration, commits, tests) and suggests `/retro` when work crosses sensible thresholds. A `PreCompact` hook always nudges before context is compacted away.
2. **Diff-driven interview.** When you run `/retro`, the skill reads the per-session event log plus `git status`, `git diff --stat`, and `git log` since session start, then asks specific questions about the actual changes ("you edited `auth.ts` 4 times — what was the iteration about?"). No generic "what did you learn" prompts.

## What it does

- **Logs your work** — a tiny `PostToolUse` hook appends one JSONL line per Edit/Write/Bash event to `events-{session_id}.jsonl` (single jq fork, atomic POSIX append, race-free under parallel tool calls)
- **Suggests retros** — `Stop` hook aggregates the event log and emits a one-liner when thresholds are met; `PreCompact` always suggests
- **Walks you through** — `/retro` uses the event log + git diff to ask specific, non-generic questions, one at a time
- **Writes native memory** — entries land in your project memory dir using `feedback` / `project` / `reference` types with `**Why:**` and `**How to apply:**` slots

## How it works

Four hooks + one skill, all bash:

| Component | What it does |
|---|---|
| `SessionStart` | `mark-session-start.sh` writes the session start timestamp |
| `PostToolUse` (Edit\|Write\|Bash) | `posttooluse-append-event.sh` appends one JSONL event |
| `Stop` | `stop-suggest-retro.sh` aggregates events and emits a suggestion if retro-worthy |
| `PreCompact` | `precompact-suggest-retro.sh` always emits a suggestion before compaction |
| `/session-retro:retro` | The skill — reads events + git, walks you through, writes memory |

No external services. No SQLite. No MCP server. No Python. Just bash, jq, git.

## Install

```
/plugin marketplace add jasonm4130/session-retro
/plugin install session-retro@jasonm4130-session-retro
/reload-plugins
```

On first load, Claude Code will prompt you to approve the hooks. This is normal — plugins that execute code require explicit user trust.

## Requirements

- Claude Code ≥ 2.1.110
- bash
- jq
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

## Tests

```
bash tests/run-all.sh
```

10 bash tests cover event-log init/parallel-writes (race regression), Stop hook threshold scoring (silent-under-threshold, edits, duration, commit, retro-fired suppression, malformed-line resilience, compound reasons), and PreCompact always-fires.

## License

MIT
