# session-retro — Claude Code Plugin

## What this is

A Claude Code plugin that captures decisions, learnings, and gotchas at the
end of a substantial session by walking the user through a diff-driven
interview and writing structured native memory entries.

Five hooks log activity into a per-session JSONL event log, evaluate
retro-worthy thresholds at `Stop`, force a nudge at `PreCompact`, and inject
`additionalContext` on the next `UserPromptSubmit` so the agent surfaces the
nudge in its own voice. The `/retro` skill itself is unchanged from v0.4.

## Plugin structure

```
session-retro/
├── .claude-plugin/
│   └── plugin.json           — name, version, author, engines
├── hooks/
│   └── hooks.json            — 5 events: SessionStart, PostToolUse, Stop, PreCompact, UserPromptSubmit
├── scripts/
│   ├── lib.mjs               — shared stdin/env/flag/iso helpers
│   ├── mark-session-start.mjs           — SessionStart: writes session-start-{sid}.txt timestamp
│   ├── posttooluse-append-event.mjs     — PostToolUse: appends one JSONL event per Edit/Write/Bash
│   ├── stop-write-retro-flag.mjs        — Stop: aggregates events; writes retro-nudge-{sid}.flag if thresholds met
│   ├── precompact-write-retro-flag.mjs  — PreCompact: always writes retro-nudge-{sid}.flag
│   └── check-retro-flag.mjs             — UserPromptSubmit: consumes flag → additionalContext
├── skills/
│   └── retro/
│       └── SKILL.md          — /retro skill definition (unchanged)
├── tests/
│   ├── lib.test.mjs
│   ├── mark-session-start.test.mjs
│   ├── posttooluse-append-event.test.mjs
│   ├── stop-write-retro-flag.test.mjs
│   ├── precompact-write-retro-flag.test.mjs
│   ├── check-retro-flag.test.mjs
│   └── integration.test.mjs
├── README.md
└── CLAUDE.md                 — this file
```

## How it works

The plugin uses a per-session JSONL event log — **not** claude-mem, not any
external service. Each line in `${CLAUDE_PLUGIN_DATA}/events-{session_id}.jsonl`
is one tool-use event:

```
{"ts":"2026-05-25T12:34:56Z","tool":"Edit","input":{"file_path":"/repo/foo.ts"}}
```

The append-only design uses POSIX `O_APPEND` (via `fs.appendFileSync`), which is
atomic per `PIPE_BUF` (typically 4KB) — events are ~50–600 bytes, so parallel
hook invocations cannot interleave or corrupt lines.

The `Stop` hook reads the event log, aggregates counts and timestamps, evaluates
thresholds, and writes `retro-nudge-{sid}.flag` if any of these match:

- `edit_write ≥ 3 AND files_touched ≥ 2`  → `"<N> edits across <M> files"`
- `duration ≥ 20 min`                     → `"<N> minutes of work"`
- ran `git commit`                        → `"committed during session"`
- ran tests AND `edit_write ≥ 2` (and not already covered) → `"ran tests + <N> edits"`
- `total_tools ≥ 30`                      → `"<N> tool calls"`

Multiple matching reasons are joined with `" + "`. If `retro-fired-{sid}.flag`
already exists (the `/retro` skill writes this after a successful interview),
the Stop hook exits silently.

`PreCompact` skips threshold evaluation entirely — context loss is a hard event,
so the flag is always written with the reason `"compact imminent"`.

`UserPromptSubmit` (`check-retro-flag.mjs`) reads the flag content, deletes the
flag (fire-once), and emits a `hookSpecificOutput` envelope with
`additionalContext` so the next agent response surfaces the nudge.

## Dependencies

- **Node.js 18+ on PATH.** No third-party packages, no `package.json`.
  Stdlib only.
- **Claude Code >= 2.1.110** — required for `hooks.json` plugin hook
  registration.
- **git** — optional. The `/retro` skill uses it to ask diff-driven questions;
  if absent, falls back to interview-only mode.

## Development

```bash
# Run all tests
node --test plugins/session-retro/tests/

# Run a single test file
node --test plugins/session-retro/tests/stop-write-retro-flag.test.mjs

# Manual smoke test (PostToolUse append)
CLAUDE_PLUGIN_DATA=/tmp/test-session-retro \
  echo '{"session_id":"dev","tool_name":"Edit","tool_input":{"file_path":"/foo.ts"}}' \
  | node plugins/session-retro/scripts/posttooluse-append-event.mjs

# Manual smoke test (Stop hook with synthetic events)
CLAUDE_PLUGIN_DATA=/tmp/test-session-retro \
  echo '{"session_id":"dev"}' \
  | node plugins/session-retro/scripts/stop-write-retro-flag.mjs
```

## Conventions

- **ESM only.** Every script is `.mjs`. No CommonJS, no `package.json`,
  no `require`.
- **Stdlib only.** Allowed imports: `node:fs`, `node:fs/promises`,
  `node:path`, `node:os`, `node:process`, `node:child_process`, `node:url`,
  `node:test`, `node:assert/strict`.
- **`// @ts-check` at the top of every file**, with JSDoc `@typedef` for stdin
  payload shapes. Editors get IntelliSense without a build step.
- **Graceful degradation.** Any JSON parse error, missing payload, or missing
  event file → `process.exit(0)` silently. Hooks never crash the session.
- **Cross-platform timestamps.** `Date.parse(isoString)` handles ISO-8601
  natively — no BSD/GNU `date` branching.
- **Path joins** via `path.join` — never string concatenation. Use
  `os.tmpdir()`, never `/tmp`.
- Flag files are plain text, not JSON; the on-disk format is wire-compatible
  with v0.4.0 bash scripts.
- `additionalContext` output uses the full `hookSpecificOutput` envelope
  (Claude Code issue #53682 safe form).
- No external services, no transcript parsing, no claude-mem dependency.
