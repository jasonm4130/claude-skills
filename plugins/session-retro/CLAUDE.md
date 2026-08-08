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
{"ts":"2026-05-25T12:34:56Z","v":2,"tool":"Edit","input":{"file_path":"/repo/foo.ts"},"ok":true,"id":"toolu_abc"}
```

Fields, as of schema `v: 2`:

| field | meaning |
|---|---|
| `v` | schema version. Absent on pre-2026-08 events — filter on it before computing any outcome rate |
| `ok` | **`true` \| `false` \| `null`.** `null` means the payload carried no outcome signal — **never coerce it to `false`** |
| `err` | bounded error string (≤200 chars), present only when `ok` is `false` |
| `id` | `tool_use_id`, for correlating a call with its result |
| `input_truncated` | array of `input` keys that were clipped, or `true`; absent when nothing was clipped |
| `clf` | Bash classifiers matched against the **full** command before clipping — `{t: true}` ran tests, `{c: true}` committed. Absent when nothing matched |

`ok` is tri-state because roughly 44% of real tool results carry no `is_error`
field at all, and a `Bash` response has no exit code — stderr output and failure
are indistinguishable from this payload. Guessing a boolean would manufacture
failures that never happened, so unknown stays unknown.

The append-only design uses POSIX `O_APPEND` (via `fs.appendFileSync`), atomic
per `PIPE_BUF` (typically 4096 bytes). The *whole append* is `line + "\n"`, so
the JSON is budgeted at `PIPE_BUF - 1` and the append lands exactly on the
guarantee. Lines are **enforced** under that budget rather than assumed small — the previous version assumed "~50–600 bytes" and was
wrong, with 3108 events in the live store exceeding `PIPE_BUF` (largest 118,989
bytes) and therefore able to interleave. When a line would exceed the budget the
longest `input` values are clipped from the middle, leaving short structured keys
like `file_path` intact; `command` is clipped last because the `Stop` hook greps
it for test/commit classifiers. `input` always stays an object — the aggregator
falls back to `{}` for a non-object and would silently stop counting files.

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
  Stdlib only. Node is an external prerequisite Claude Code does not ship — install it via Homebrew, WinGet, or your distro's package manager. Without it the hook cannot run and the guard fails open (Claude Code shows a non-blocking `hook error` per matching event). Why there is no silent-skip: `scripts/hook-runtime-guard.test.mjs`.
- **Claude Code >= 2.1.110** — required for `hooks.json` plugin hook
  registration.
- **git** — optional. The `/retro` skill uses it to ask diff-driven questions;
  if absent, falls back to interview-only mode.

## Development

```bash
# Run all tests
node --test plugins/session-retro/tests/*.test.mjs

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
- **Never read stdin you don't need.** `readStdin()` resolves on `"end"`, and a
  session shell's inherited stdin — pipe or TTY — never reaches EOF. The two
  scripts the `/retro` skill invokes from a shell (`collect-batch-sessions.mjs`,
  `mark-retro-done.mjs`) take the session id as `argv[2]` and must read stdin
  *only* when that argument is absent, or they hang until killed. `readStdin()`
  also short-circuits on `process.stdin.isTTY` so a hand-run script can't hang.
  Hook invocations always pipe and always reach EOF, so that path is unaffected.
- **Cross-platform timestamps.** `Date.parse(isoString)` handles ISO-8601
  natively — no BSD/GNU `date` branching.
- **Path joins** via `path.join` — never string concatenation. Use
  `os.tmpdir()`, never `/tmp`.
- Flag files are plain text, not JSON; the on-disk format is wire-compatible
  with v0.4.0 bash scripts.
- `additionalContext` output uses the full `hookSpecificOutput` envelope
  (Claude Code issue #53682 safe form).
- No external services, no transcript parsing, no claude-mem dependency.
