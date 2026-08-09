# session-retro v3 design — drop claude-mem, deterministic triggers, diff-driven interview

**Date:** 2026-05-01
**Status:** Design — pending implementation

## Context

session-retro v0.2 (2026-04-19, currently shipped) reads observations from
[claude-mem](https://github.com/thedotmack/claude-mem) at retro time, then
walks the user through a structured interview and writes native memory
entries. The architecture is sound on paper. In practice two problems
broke it:

1. **Triggering is unreliable.** v0.2 relies entirely on Claude noticing the
   skill description and suggesting a retro conversationally. In real use,
   sessions end without retros being suggested — the AI-priming approach
   doesn't fire deterministically.
2. **claude-mem is not a stable dependency.** The user has hit
   tokens-burned-for-nothing failures and silent breakage. Building
   session-retro on top of it inherits all of those problems. claude-mem's
   own repo logs 301 anti-patterns including swallow-and-continue in
   critical paths.

v3 removes the claude-mem dependency entirely and replaces AI-priming with
deterministic hook-based triggers.

## Goals

- **Zero external services.** Bash + git + native memory only. No MCP server,
  no SQLite, no port 37777, no Python.
- **Deterministic triggering.** Stop hook with threshold scoring + PreCompact
  hook for the "save before destruction" moment. No AI-priming for the
  trigger decision.
- **Diff-driven interview.** Replace the current fixed-slot question template
  ("Decisions / Corrections / Errors / Techniques / Open") with adaptive
  questions generated from `git status` + `git diff --stat` + `git log`
  since session start.
- **Same memory format.** Keep the existing `feedback` / `project` /
  `reference` types with `**Why:**` / `**How to apply:**` slots. The user
  has accumulated ~20 entries in this format and it works.
- **Token budget per retro: < 15k tokens** (vs v0.1's 37k disaster, vs
  v0.2's 3-5k *when claude-mem works*).

## Non-goals

- **No ML / embeddings / LoRA / clustering in v3.** A separate graphify
  job covers theme clustering for the memory directory using existing
  infrastructure. ML enhancements (write-time dedup, semantic search)
  are deferred to a Phase 2 design after v3 ships and is in use.
- **No schema redesign.** Memory format unchanged.
- **No new plugin name.** Same plugin, force-pushed redesign. Existing
  installs upgrade in place.
- **No support for sessions across multiple repos.** v3 assumes the user is
  working in one repo per Claude Code session, which matches actual usage.
  Multi-repo sessions get a degraded-but-still-functional retro
  (interview-only, no diff signal).

## Architecture

```
~/Work/Git/session-retro/
├── .claude-plugin/
│   ├── plugin.json                          (unchanged metadata)
│   └── marketplace.json                     (unchanged)
├── skills/retro/SKILL.md                    (REWRITTEN — diff-driven interview)
├── hooks/hooks.json                         (REWRITTEN — adds PostToolUse + Stop + PreCompact)
├── scripts/
│   ├── mark-session-start.sh                (KEPT — timestamp marker)
│   ├── posttooluse-append-event.sh          (NEW — appends one JSONL line per tool use)
│   ├── stop-suggest-retro.sh                (NEW — aggregates events, suggests if threshold met)
│   └── precompact-suggest-retro.sh          (NEW — always suggests before compaction)
├── tests/                                   (NEW — bash tests for the scoring + counter logic)
├── README.md                                (UPDATED — drop claude-mem requirement)
└── (no Python, no MCP server, no external services)
```

### State files (per session)

- `${CLAUDE_PLUGIN_DATA}/session-start-{session_id}.txt` —
  ISO-8601 timestamp written by `mark-session-start.sh`. Used by
  `stop-suggest-retro.sh` to compute session duration and by the skill to
  scope `git log --since=$ts`.
- `${CLAUDE_PLUGIN_DATA}/events-{session_id}.jsonl` —
  Append-only event log. PostToolUse appends one JSON line per tool use:
  ```jsonl
  {"ts":"2026-05-01T08:00:00Z","tool":"Edit","input":{"file_path":"/repo/src/auth.ts"}}
  {"ts":"2026-05-01T08:01:00Z","tool":"Bash","input":{"command":"pytest tests/"}}
  {"ts":"2026-05-01T08:02:00Z","tool":"Edit","input":{"file_path":"/repo/tests/auth.test.ts"}}
  ```
  Stop hook reads + aggregates at evaluation time (counts, files_touched dedup,
  test/commit detection, duration). The append-only shape eliminates the
  read-modify-write race a counter file would have under parallel tool calls
  (PostToolUse fires per-tool, not per-batch — Claude Code's parallel tool
  use is real and observable).

  **On atomicity of append:** POSIX guarantees `O_APPEND` writes smaller than
  `PIPE_BUF` (typically 4096 bytes on macOS/Linux) are atomic. A single
  tool-event JSON line stays well under that — the longest tool input we've
  seen is a Bash command at ~500 bytes, plus ~50 bytes of envelope.
- `${CLAUDE_PLUGIN_DATA}/retro-fired-{session_id}.flag` —
  Empty sentinel file. Created at the end of `/retro`. Suppresses further
  Stop-hook suggestions for this session (PreCompact still suggests
  regardless — context loss is a hard event).

### Component responsibilities

| Component | Trigger | Reads | Writes | Side effects |
|---|---|---|---|---|
| `mark-session-start.sh` | SessionStart hook (any source) | `$CLAUDE_SESSION_ID` | `session-start-{session_id}.txt` | None |
| `posttooluse-append-event.sh` | PostToolUse hook (matcher: `Edit\|Write\|Bash`) | `$CLAUDE_SESSION_ID`, hook stdin (tool name + input) | Appends one JSONL line to `events-{session_id}.jsonl` | None — single atomic append |
| `stop-suggest-retro.sh` | Stop hook (no matcher) | `events-{session_id}.jsonl`, `session-start-{session_id}.txt`, `retro-fired-{session_id}.flag` | stdout JSON for `additionalContext` | Aggregates events, evaluates thresholds, emits suggestion only if retro-worthy AND `retro-fired` flag absent |
| `precompact-suggest-retro.sh` | PreCompact hook (matcher: `auto` + `manual`) | nothing | stdout JSON for `additionalContext` | Always emits suggestion |
| `skills/retro/SKILL.md` | `/retro` slash command, or natural-language ("retro", "what did we learn") | `events-{session_id}.jsonl`, `session-start-{session_id}.txt`, git state | Native memory files via Write tool, `retro-fired-{session_id}.flag` | The retro conversation itself |

## Stop hook scoring algorithm

`stop-suggest-retro.sh` runs every turn. Cost target: <50ms per invocation.

**Inputs:**
- Read `$CLAUDE_PLUGIN_DATA/events-{session_id}.jsonl`. If absent, exit 0
  silently — no events recorded yet.
- Read `$CLAUDE_PLUGIN_DATA/session-start-{session_id}.txt` for first
  timestamp. If absent, fall back to first event's `ts`.
- Check for `$CLAUDE_PLUGIN_DATA/retro-fired-{session_id}.flag`. If present,
  exit 0 silently — user already ran retro this session.

**Aggregation step (single jq pass over the events file):**
- `edits` = count of events where `.tool == "Edit"`
- `writes` = count of events where `.tool == "Write"`
- `bash_calls` = count of events where `.tool == "Bash"`
- `files_touched` = unique `.input.file_path` values from Edit/Write events
- `first_tool_ts` = earliest `.ts`; `last_tool_ts` = latest `.ts`
- `ran_tests` = any Bash event whose `.input.command` matches the test-runner
  pattern (`pytest|jest |go test|cargo test|npm test|npm run test|bun test|yarn test`)
- `ran_commit` = any Bash event whose `.input.command` contains `git commit`

**Threshold (any one of these triggers a suggestion):**

1. `edits + writes >= 3` AND `len(files_touched) >= 2` (the canonical
   "substantial code change" signal)
2. `last_tool_ts - first_tool_ts >= 1200 seconds` (20 minutes of activity)
3. `ran_commit == true` (a commit happened — almost always retro-worthy)
4. `ran_tests == true` AND `edits + writes >= 2` (test/iterate pattern)
5. `bash_calls + edits + writes >= 30` (high tool volume — likely heavy
   debugging or refactor)

**If threshold met, emit:**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "Stop",
    "additionalContext": "[session-retro] This session crossed N edits across M files over T minutes. Suggest running /retro to capture decisions/learnings before /clear."
  }
}
```

The placeholders are filled with the actual numbers so the suggestion is
specific. The assistant surfaces it as a natural one-liner in the next
response — the user sees a Claude-authored nudge, not a system warning.

**Event log appender** (`posttooluse-append-event.sh`):

The PostToolUse hook receives JSON on stdin including the tool name and
input. It extracts the relevant fields and appends a single JSONL line:

```bash
printf '%s\n' "$(jq -c --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{ts: $ts, tool: .tool_name, input: .tool_input}')" >> "$EVENTS_FILE"
```

That's the entire script body (plus shebang, env defaults, mkdir). One jq
fork per event. POSIX `O_APPEND` makes the write atomic against parallel
PostToolUse invocations.

- `Edit`/`Write` → emit event with `tool` and `input.file_path`
- `Bash` → emit event with `tool` and `input.command`. The Stop hook does
  it matches `git commit`, set `ran_commit=true`.
- Always update `last_tool_ts`. Set `first_tool_ts` if absent.

## PreCompact hook

`precompact-suggest-retro.sh` is dumber — it always emits the same
suggestion regardless of state:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreCompact",
    "additionalContext": "[session-retro] Context is about to compact. If this session had substantial work, run /retro now to capture decisions before details are lost."
  }
}
```

The PreCompact event is rare enough (1-2× per long session) that always
suggesting is fine. PreCompact does NOT respect `retro-fired-{session_id}.flag` —
even if a retro fired earlier, more work may have happened since.

## Interview flow (rewritten skill)

`/retro` invocation, in order:

### Step 1 — Quick-skip gate

```bash
SCORE_FILE="${CLAUDE_PLUGIN_DATA}/score-${CLAUDE_SESSION_ID}.json"
if [ ! -f "$SCORE_FILE" ] || [ "$(jq '.edits + .writes' < $SCORE_FILE)" -eq 0 ]; then
    echo "Quick session — no edits to retro on. Anything specific to capture? (y/n)"
    # if n, exit; if y, jump to Step 4 (open catch-all only)
fi
```

### Step 2 — Gather signals

In a single bash block:
- `git status --short` (uncommitted changes)
- `git diff --stat` (since session start, scoped to last commit if needed)
- `git log --since=$session_start --oneline` (commits within this session)
- `cat $SCORE_FILE` (tool counter)

Surface to the user as a memory primer:
> "Quick recap: in this session you edited X, Y, Z (4 edits each), ran tests
> 2 times, made 1 commit. Uncommitted changes in A/b.ts. Want me to walk you
> through?"

### Step 3 — Adaptive questions

For each *interesting* file (touched ≥3 times, or has uncommitted changes,
or appears in a commit), ask **one question at a time**:

- *"You edited `src/auth.ts` 4 times — what was the iteration about?"*
- *"You added `tests/auth.test.ts` — what were you trying to verify?"*
- *"You reverted `config.yaml` partway through — what changed your mind?"*
- *"This session had a commit `fix: token bug` — what was the actual root
  cause?"*

The skill's prompt says: derive 3-5 specific questions from the diff, ask
each in order, wait for response. **Do not batch.** **Do not ask
generic "what did you learn" questions** — the diff is the question seed.

### Step 4 — Open catch-all

After the diff-driven questions:

> "Anything else worth remembering that didn't show up in the diff?
> Surprises, gotchas, things you tried that failed, decisions about
> approach?"

### Step 5 — Write findings

Same as v0.2: write to native memory files using the existing
`feedback`/`project`/`reference` taxonomy with `**Why:**` and
`**How to apply:**` slots. Update MEMORY.md index. Show user each entry
for confirmation before writing.

### Step 6 — Cleanup

```bash
touch ${CLAUDE_PLUGIN_DATA}/retro-fired-${CLAUDE_SESSION_ID}.flag
```

## Memory format (unchanged from v0.2)

Three types, all in `${CLAUDE_PROJECT_DIR}/memory/`:

```markdown
---
name: {short name}
description: {one-line description used by future sessions to decide relevance}
type: feedback | project | reference
---

{The rule, fact, or resource}

**Why:** {The motivation — often a past incident or strong preference}

**How to apply:** {When/where this guidance kicks in}
```

Filenames: `retro_feedback_{topic}.md`, `retro_project_{topic}.md`,
`retro_reference_{topic}.md`. Updates MEMORY.md index.

## Token budget assumptions

Validated against real session JSONLs in `~/.claude/projects/` on
2026-05-01. Per-retro cost breakdown:

| Step | Tokens (typical) | Notes |
|---|---|---|
| Read score file | ~200 | Tiny JSON |
| `git status --short` | ~100-300 | |
| `git diff --stat` | ~300-500 | Cap by file count, not bytes |
| `git log --since=$ts --oneline` | ~100-500 | |
| Memory primer surfaced to user | ~500 | |
| 3-5 adaptive questions + responses | ~3-5k | |
| Open catch-all + response | ~1-2k | |
| 3-5 memory entry writes | ~1-2k | |
| **Total per retro** | **~7-10k** | |

For the Stop hook itself (per turn cost): ~10ms wall, ~0 tokens (no LLM
context injection unless threshold is met, and even then only ~50 tokens).

For PreCompact: same ~50-token suggestion, fires 1-2× per session max.

## Migration

v0.2 → v3 is a force-push redesign of the same plugin. Existing users:

- `/plugin update session-retro@jasonm4130-session-retro` pulls v3
- Existing `mark-session-start.sh` keeps working (kept as-is)
- New hooks (`PostToolUse`, `Stop`, `PreCompact`) require user approval on
  next `/reload-plugins`. Document this in the README upgrade notes.
- Existing memory files keep working — same format. No migration script
  needed.
- claude-mem requirement removed from README. Users with claude-mem
  installed are unaffected; users without it stop seeing errors.

## Testing approach

Bash-level tests in `tests/`:

- `test_counter_init.sh` — first PostToolUse creates the counter file
  correctly
- `test_counter_increment.sh` — subsequent PostToolUse calls increment
  correctly, dedupe `files_touched`
- `test_counter_test_detection.sh` — `pytest`, `jest`, etc. set
  `ran_tests=true`
- `test_counter_commit_detection.sh` — `git commit` sets `ran_commit=true`
- `test_threshold_no_trigger.sh` — counter under threshold → Stop hook
  exits silently
- `test_threshold_edits.sh` — 3 edits across 2 files triggers suggestion
- `test_threshold_duration.sh` — 20+ min duration triggers regardless of
  edit count
- `test_threshold_commit.sh` — any commit triggers
- `test_retro_fired_suppresses.sh` — flag file present → Stop exits silent
- `test_precompact_always_fires.sh` — PreCompact emits even with retro-fired

Shell tests run in CI via existing GitHub Actions config (already in v0.2).

## Open questions

These are flagged for the implementation phase but don't block design:

1. **~~Counter file races.~~ RESOLVED 2026-05-01.** Initial design used a
   counter file with incremental read-modify-write, "atomic" via tmp-then-
   rename. Code reviewer reproduced 96% data loss under 50-way parallel
   PostToolUse invocations — tmp-then-rename prevents torn reads, not lost
   updates. Switched to append-only event log: PostToolUse just `printf`s
   one JSONL line per event (atomic per POSIX `O_APPEND` for writes under
   `PIPE_BUF`), Stop hook aggregates at evaluation time. Eliminates the
   race entirely AND removes the per-call jq forks that the counter
   approach incurred.
2. **MEMORY.md index update conflicts.** If the user is mid-edit on
   MEMORY.md when retro tries to write, we'd want optimistic concurrency.
   For v3 MVP: just append at the end of the file, ignore in-progress
   edits.
3. **What counts as "this session" for git log?** First-cut answer:
   timestamp from `mark-session-start.sh`. If the user opens Claude Code
   inside a long-running tmux session that's been open for hours, the
   timestamp is still anchored to *this* Claude session, not to terminal
   uptime. Should be fine.
4. **Multi-repo or non-repo sessions.** If `git status` returns
   "not a git repository", skip the diff steps and run interview-only.
   No degradation of the memory write step.

## Future (Phase 2, deliberately deferred)

- Embedding-based dedup at memory write time using `sentence-transformers/all-MiniLM-L6-v2`
- Periodic graphify pass over the memory directory (separate to retro
  itself — slot into the existing weekly LaunchAgent)
- Semantic search over past memories during retro to surface relevant
  prior learnings
- Possibly: train a small LoRA on retro outcomes to predict
  retro-worthiness better than the hardcoded thresholds

None of these are needed to ship v3. They're recorded here so the design
choices in v3 don't preclude them.
