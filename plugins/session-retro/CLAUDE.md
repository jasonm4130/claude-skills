# session-retro — Claude Code Plugin

## What this is

A Claude Code plugin that captures decisions, learnings, and gotchas at the
end of a substantial session by walking the user through an interview and
writing structured native memory entries.

Five hooks log activity into a per-session JSONL event log and evaluate
retro-worthy thresholds at `Stop`. As of v0.6.0 the per-session Stop nudge is
**ambient and batched**: a retro-worthy `Stop` is absorbed silently into a
cross-session worthy log, and `UserPromptSubmit` injects `additionalContext`
only when enough worthy sessions have accrued since the last retro. `PreCompact`
keeps its immediate per-session nudge, since context loss is a hard event.

As of **v0.7.0** the `/retro` interview is **batch-scoped**: because a batched
nudge only fires after several worthy sessions accrue, the interview now spans
**every unprocessed worthy session** (`retro-worthy.jsonl` minus
`retro-processed.jsonl`) **plus the current session**, not just the current one.
A `collect-batch-sessions.mjs` script resolves and aggregates that batch into a
single snapshot the skill reuses. Cleanup is **append-only and by identity**: on
completion (or an accepted skip) `mark-retro-done.mjs` *appends* the interviewed
sids to `retro-processed.jsonl` — it never rewrites the concurrently-appended
worthy log — and writes the `last-retro.txt` days-cadence hint.

## Plugin structure

```
session-retro/
├── .claude-plugin/
│   └── plugin.json           — name, version, author, engines
├── hooks/
│   └── hooks.json            — 5 events: SessionStart, PostToolUse, Stop, PreCompact, UserPromptSubmit
├── scripts/
│   ├── lib.mjs               — shared helpers: stdin/env/flag/iso + migration + unprocessed-worthy set-difference
│   ├── mark-session-start.mjs           — SessionStart: writes session-start-{sid}.txt timestamp
│   ├── posttooluse-append-event.mjs     — PostToolUse: appends one JSONL event per Edit/Write/Bash
│   ├── stop-write-retro-flag.mjs        — Stop: aggregates events; writes retro-nudge-{sid}.flag if thresholds met
│   ├── precompact-write-retro-flag.mjs  — PreCompact: always writes retro-nudge-{sid}.flag
│   ├── check-retro-flag.mjs             — UserPromptSubmit: consumes flag → worthy log (silent) or batched nudge
│   ├── collect-batch-sessions.mjs       — /retro Step 1: resolves the unprocessed-worthy batch → retro-batch-{sid}.json
│   └── mark-retro-done.mjs              — /retro cleanup: appends processedSids to retro-processed.jsonl + fired flag + last-retro.txt
├── skills/
│   └── retro/
│       └── SKILL.md          — /retro skill definition (batch-scoped interview)
├── tests/
│   ├── lib.test.mjs
│   ├── mark-session-start.test.mjs
│   ├── posttooluse-append-event.test.mjs
│   ├── stop-write-retro-flag.test.mjs
│   ├── precompact-write-retro-flag.test.mjs
│   ├── check-retro-flag.test.mjs
│   ├── collect-batch-sessions.test.mjs
│   ├── mark-retro-done.test.mjs
│   └── integration.test.mjs
├── README.md
└── CLAUDE.md                 — this file
```

Data files under `${CLAUDE_PLUGIN_DATA}` (all append-only except the last two):
`events-{sid}.jsonl` (per-session tool log), `retro-worthy.jsonl` (one line per
worthy session, **never rewritten**), `retro-processed.jsonl` (append-only ledger
of retro'd sids — the reset mechanism), `retro-batch-{sid}.json` (the Step-1
snapshot, consumed at cleanup), `last-retro.txt` (days-cadence hint),
`last-batch-nudge.txt` (24h nudge de-dupe).

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

`UserPromptSubmit` (`check-retro-flag.mjs`) reads the flag content and deletes
the flag (fire-once), then branches:

- **PreCompact flag** (`"compact imminent"`) → emits a `hookSpecificOutput`
  envelope immediately, instructing the agent to run the retro skill now.
- **Stop-origin flag** (any other content) → appended silently to the
  cross-session worthy log `retro-worthy.jsonl` (one line per session:
  `{"ts","sid","reasons"}`, deduped by `sid`). No immediate nudge.

After consuming the flag, the hook evaluates the **batch condition**. `worthy_count`
is the number of **unprocessed worthy sessions** — distinct sids in
`retro-worthy.jsonl` minus sids in `retro-processed.jsonl` (identity set-difference,
shared helper `unprocessedWorthySessions` in `lib.mjs`; no timestamp compare). A
single agent-directed nudge fires when all of these hold:

- `worthy_count ≥ RETRO_BATCH_MIN_SESSIONS` (default 3)
- `days_since_last_retro ≥ RETRO_BATCH_MIN_DAYS` (default 7, from `last-retro.txt`)
- no batch nudge already fired in the last 24h (tracked by `last-batch-nudge.txt`)

Both thresholds are env-overridable. The reset is by **identity, append-only**: the
`/retro` cleanup (`mark-retro-done.mjs`) appends the interviewed sids to
`retro-processed.jsonl`, so those sessions drop out of the set-difference and
`worthy_count` falls — `retro-worthy.jsonl` is never rewritten. It also writes
`retro-fired-{sid}.flag` and the `last-retro.txt` cadence hint.

**Upgrade note (v0.7.0):** `check-retro-flag` and the collector run a one-time
migration — if `retro-processed.jsonl` is absent, it's seeded with every worthy sid
whose `ts ≤ last-retro.txt` (what the old timestamp-prune treated as done), so an
upgrade doesn't resurface already-retro'd sessions. Idempotent (guarded by the
ledger's existence). This is the only place a timestamp touches membership.

**Concurrency:** every shared-log mutation is an append (`retro-worthy.jsonl`,
`retro-processed.jsonl`) — never a read-modify-write — so parallel sessions can't
clobber each other's writes. Batch ownership is at-least-once, not exactly-once: two
`/retro` interviews running at the same instant could both process the same batch
(duplicate memories, which Step 5 shows for confirmation first). No lock is added —
`/retro` is a synchronous interview, so simultaneous runs are degenerate.

**Design rationale:** the old per-session `"Consider running /retro"` fired ~60
times over 21 days and produced 3 actual retros — dead UX, while auto-memory
already captures ambient facts. Batching replaces 60 low-signal nudges with an
occasional high-signal one the agent acts on directly.

## Dependencies

- **Node.js 18+ on PATH.** No third-party packages, no `package.json`.
  Stdlib only. Claude Code ships a self-contained native binary and its documented system requirements do **not** include Node, so this is an external prerequisite the host does not provide — install it via Homebrew, WinGet, or your distro's package manager. On a machine without it the hook cannot run and Claude Code shows a non-blocking `hook error` per matching event, so the guard fails open. There is no silent-skip: probing for node needs shell syntax that is not portable across the shells Claude Code picks per platform, and the exec-form alternative is unsupported before 2.1.139 with no way to enforce that floor (`engines` is not a recognised manifest field). See `scripts/hook-runtime-guard.test.mjs` for the full reasoning.
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
