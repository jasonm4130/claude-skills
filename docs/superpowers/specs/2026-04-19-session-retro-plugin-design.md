# Session Retro — Claude Code Plugin Design Spec

**Date:** 2026-04-19
**Status:** Draft
**Author:** Jason Matthew + Claude

## Overview

A Claude Code plugin that automatically detects substantial coding sessions, nudges developers to do an interactive retrospective before ending, and writes structured memory entries capturing decisions, learnings, and rationale.

### Problem

Existing session retro tools (accidentalrebel/claude-skill-session-retrospective, bitwarden/ai-plugins claude-retrospective) share three gaps:
1. **Manual invocation only** — no one remembers to run them
2. **No memory integration** — produce markdown narratives but don't feed back into Claude's memory system
3. **Post-compaction data loss** — by the time you run a retro, compaction may have destroyed the critical "why we chose X over Y" reasoning

### Differentiators

1. **Auto-nudge** — PreToolUse hook detects substantial sessions and primes Claude to suggest a retro at a natural conversational moment
2. **Memory-native** — writes feedback, project, and reference memory entries in Claude's standard format
3. **Full context capture** — reads JSONL transcripts directly, not just what survived compaction
4. **Compaction recovery** — SessionStart(compact) hook extracts decisions from the full JSONL after compaction, injecting a summary into the fresh context
5. **Interactive** — guided walkthrough with the developer, not a data dump

### Strategic context

Fits Jason's north star: "I want my work to reach beyond one company. Open source, tools that get adopted, teaching — building things that other people build on top of." Operationalises agentic workflow research on session hygiene and context debt. Portfolio piece demonstrating principal-level engineering judgment.

## Plugin Identity

- **Name:** `session-retro`
- **Namespace:** `/session-retro:retro`
- **License:** MIT
- **Min Claude Code version:** 2.1.110 (PreToolUse + failed tool turn-termination fix)
- **Dependencies:** bash 4.0+, python 3.10+ (stdlib only), jq

## Directory Structure

```
session-retro/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   └── retro/
│       └── SKILL.md
├── hooks/
│   └── hooks.json
├── scripts/
│   ├── track-activity.sh          # PreToolUse — activity counter + one-time nudge
│   ├── extract-on-compact.py      # SessionStart(compact) — decision extraction
│   └── capture-session.sh         # SessionEnd — fallback metadata capture
├── bin/
│   └── session-retro-parse        # JSONL parser utility (Python, used by skill + scripts)
├── CLAUDE.md
├── .gitignore
└── README.md
```

## Component Specifications

### 1. PreToolUse Hook — Activity Tracker (`track-activity.sh`)

**Event:** PreToolUse
**Matcher:** (empty — matches all tools)
**Type:** command
**Performance target:** <100ms per invocation

#### Behaviour

On every tool call:
1. Read stdin JSON, extract `session_id`, `transcript_path`, `tool_name`
2. Read or create activity file at `$CLAUDE_PLUGIN_DATA/activity-{session_id}.json`
3. Increment counters:
   - `toolCalls` (total count)
   - `filesChanged` (unique set, increment for Write/Edit tool calls based on `tool_input.file_path`)
   - `subagentsSpawned` (increment for Agent tool calls)
   - `gitCommits` (increment for Bash tool calls where `tool_input.command` contains "git commit")
4. Track `firstSeenAt` timestamp (set once on first call)
5. Compute weighted score against thresholds
6. If score exceeds threshold AND `$CLAUDE_PLUGIN_DATA/nudge-sent-{session_id}.flag` does not exist:
   - Write flag file
   - Return `additionalContext` via stdout
   - Exit 0
7. Otherwise: exit 0 with no stdout (tool proceeds normally)

#### Activity scoring

```
score = (filesChanged × 2) + (subagents × 2) + (gitCommits × 1)
```

Note: `approachChanges` and precise error counts require LLM judgment or JSONL parsing, which is too slow for a per-tool-call hook. These are assessed during the retro skill, not during tracking. The hook score is a rough proxy based on observable tool calls only.

Minimum bar before scoring: `toolCalls >= minToolCalls AND elapsedMinutes >= minDurationMinutes`

Default thresholds:

| Sensitivity | Score threshold | minToolCalls | minDurationMinutes |
|-------------|---------------|--------------|-------------------|
| low         | 15            | 10           | 20                |
| normal      | 8             | 5            | 10                |
| high        | 3             | 3            | 5                 |

#### additionalContext output

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "Session activity: This session has had significant work ({score} activity score: {errors} errors resolved, {filesChanged} files changed, {elapsed} minutes). When the user's current task appears complete, suggest running /session-retro:retro to capture learnings before ending the session. Do not interrupt active work to suggest this."
  }
}
```

Kept under 500 characters to minimise context accumulation. Injected exactly once per session.

#### What the hook does NOT track

The hook only sees PreToolUse input (tool name + tool input for the *upcoming* call). It cannot see:
- **Errors** — `is_error` is on tool *results*, which are in PostToolUse (unreliable for context injection) or the JSONL (too slow to parse per-call). Error analysis is deferred to the retro skill.
- **Approach changes** — requires LLM judgment on user message content. Assessed during the interactive retro.
- **User corrections** — same as above, requires understanding intent.

The hook's score is a rough activity proxy. The retro skill does the real signal analysis.

#### Activity file schema

```json
{
  "sessionId": "abc-123",
  "transcriptPath": "/path/to/session.jsonl",
  "cwd": "/path/to/project",
  "firstSeenAt": "2026-04-19T10:00:00Z",
  "lastSeenAt": "2026-04-19T10:45:00Z",
  "toolCalls": 47,
  "filesChanged": ["src/auth.ts", "src/auth.test.ts"],
  "subagentsSpawned": 2,
  "gitCommits": 1,
  "score": 8
}
```

### 2. SessionStart(compact) Hook — Decision Extractor (`extract-on-compact.py`)

**Event:** SessionStart
**Matcher:** `compact`
**Type:** command
**Timeout:** 60 seconds

#### Behaviour

Fires after compaction completes and the session resumes with fresh context.

1. Read stdin JSON, extract `session_id`, `transcript_path`
2. Parse the JSONL at `transcript_path` (the full file is still on disk even though context was compacted)
3. Extract decision signals:
   - User corrections ("no, use X instead", "that's wrong because Y")
   - Approach changes (pivot points where direction shifted)
   - Error → fix sequences (what broke and how it was resolved)
   - Explicit decisions ("let's go with X", "I think we should Y")
   - Configuration/architecture choices
4. Derive project memory path: `transcript_path` follows the pattern `~/.claude/projects/{encoded_cwd}/{session_id}.jsonl`. Strip the session filename to get the project directory, then append `memory/`.
5. Write a memory entry to `{project_dir}/memory/compact_extract_{timestamp}.md`:
   - Type: `project`
   - Contains: bullet-point list of decisions and rationale extracted
6. Update `{project_dir}/memory/MEMORY.md` index
6. Return `additionalContext` via stdout summarising what was extracted (so Claude has it in the fresh context)

#### Output

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "Pre-compaction decisions recovered:\n- Chose X over Y because [reason]\n- Fixed [error] by [approach]\n- [N] other decisions captured in memory"
  }
}
```

Kept under 2,000 characters. Full details are in the memory file.

#### JSONL parsing strategy

The script uses `bin/session-retro-parse` for parsing. For files >2MB, it processes in a streaming fashion (line by line, no full load into memory). Decision signals are identified by pattern matching on user messages:
- Correction patterns: "no", "don't", "stop", "instead", "wrong", "not that"
- Decision patterns: "let's go with", "we should", "I think", "the trade-off is"
- Error patterns: tool results with `is_error: true` followed by successful retries

This is heuristic, not perfect. The interactive retro skill does the deeper analysis with LLM judgment.

### 3. SessionEnd Hook — Fallback Capture (`capture-session.sh`)

**Event:** SessionEnd
**Matcher:** (empty — all exit reasons)
**Type:** command
**Timeout:** 30 seconds

#### Behaviour

1. Read stdin JSON, extract `session_id`, `transcript_path`, `cwd`, `source` (exit reason)
2. Check for `$CLAUDE_PLUGIN_DATA/retro-done-{session_id}.flag` — if exists, skip (retro already done)
3. Read `$CLAUDE_PLUGIN_DATA/activity-{session_id}.json` for session stats
4. If session was substantial (score > 0 from activity file):
   - Run `git diff --stat` in `cwd` for change summary
   - Write `$CLAUDE_PLUGIN_DATA/pending-retro-{session_id}.json`
5. Clean up session-scoped temp files:
   - Delete `activity-{session_id}.json`
   - Delete `nudge-sent-{session_id}.flag`
   - Keep `pending-retro-{session_id}.json` (persists for next session)
   - Write `retro-done-{session_id}.flag` (persists as record)
6. Prune stale flags: delete any `retro-done-*.flag` and `pending-retro-*.json` files older than 30 days to prevent accumulation

#### Pending retro schema

```json
{
  "sessionId": "abc-123",
  "transcriptPath": "/path/to/session.jsonl",
  "cwd": "/path/to/project",
  "startedAt": "2026-04-19T10:00:00Z",
  "endedAt": "2026-04-19T10:45:00Z",
  "exitReason": "prompt_input_exit",
  "activity": {
    "toolCalls": 47,
    "errorTools": 3,
    "filesChanged": 8,
    "subagentsSpawned": 2,
    "gitCommits": 1,
    "score": 13
  },
  "gitDiffStat": "8 files changed, 234 insertions(+), 56 deletions(-)"
}
```

### 4. Retro Skill (`/session-retro:retro`)

**Location:** `skills/retro/SKILL.md`
**Trigger:** User-invoked via `/session-retro:retro` or natural language ("retro", "session summary", "what did we learn", "lessons learned")

#### Skill flow

**Step 1 — Session ingestion**

The skill instructs Claude to:
1. Check for pending retros from previous sessions (`$CLAUDE_PLUGIN_DATA/pending-retro-*.json`). If found, offer to retro that session too.
2. For the current session: run `session-retro-parse` (from `bin/`) against the current session JSONL
3. The parser outputs a structured timeline: user messages, tool calls (success/failure), approach changes, subagent dispatches and outcomes, git commits

For large sessions (>2MB JSONL), the parser outputs a condensed timeline — key moments and decision points, not every line.

The skill instructs Claude to invoke the parser via the Bash tool: `session-retro-parse /path/to/session.jsonl --include-subagents` (the parser is on PATH via the plugin's `bin/` directory). For large sessions, add `--condensed`.

**Step 2 — Guided conversation**

Claude walks through the session chronologically, asking session-specific questions derived from what actually happened. Focus areas:

- **Decisions:** "You explored [A] and [B] before choosing [B]. What tipped the decision?"
- **Corrections:** "You corrected me when I tried [approach]. What was wrong with my suggestion?"
- **Errors:** "You hit [error] and resolved it by [fix]. Was that the right call, or would you do it differently?"
- **Techniques:** "The pattern you used for [X] — is this standard for this codebase or something new?"
- **Surprises:** "Anything unexpected that came up that's worth remembering?"

Questions are derived from the parsed timeline, not a generic template. Claude asks one question at a time (per Jason's preference).

**Step 3 — Memory generation**

Based on the conversation, Claude writes memory entries to `~/.claude/projects/{project}/memory/`:

| Memory type | What gets captured | Example |
|---|---|---|
| `feedback` | Corrections to Claude's behaviour, workflow preferences | "Don't mock the DB in integration tests — prior incident where mock/prod diverged" |
| `project` | Decisions, architecture, context | "Auth uses JWT+refresh because session cookies don't work with the edge CDN" |
| `reference` | Pointers to external resources | "Rate limiting docs at [URL], tracked in issue #456" |

Each entry uses standard frontmatter format (name, description, type) with a markdown body structured as: rule/fact, then **Why:** and **How to apply:** lines for feedback/project types.

Claude updates `MEMORY.md` index and shows the user what was written.

**Step 4 — Cleanup**

- Write `$CLAUDE_PLUGIN_DATA/retro-done-{session_id}.flag`
- If retroing a pending session, delete that `pending-retro-{session_id}.json`

#### Pending retro handling

On invocation, if pending retro files exist, Claude offers: "I found a pending retro from your last session ({date}, {duration}, {summary}). Want to review that one too?" The JSONL is still on disk at the captured `transcriptPath`, so the full session is available for analysis.

### 5. JSONL Parser (`bin/session-retro-parse`)

**Language:** Python 3.10+, stdlib only
**Interface:** CLI tool, reads JSONL from path argument, outputs structured JSON to stdout

#### Usage

```bash
session-retro-parse /path/to/session.jsonl [--condensed] [--include-subagents]
```

#### Output schema

```json
{
  "sessionId": "abc-123",
  "startedAt": "2026-04-19T10:00:00Z",
  "endedAt": "2026-04-19T10:45:00Z",
  "cwd": "/path/to/project",
  "version": "2.1.112",
  "gitBranch": "feature/auth",
  "timeline": [
    {
      "timestamp": "2026-04-19T10:00:00Z",
      "type": "user_message",
      "summary": "Asked to implement JWT auth",
      "raw": "Can you add JWT authentication to the API?"
    },
    {
      "timestamp": "2026-04-19T10:02:00Z",
      "type": "tool_call",
      "tool": "Write",
      "target": "src/auth.ts",
      "success": true
    },
    {
      "timestamp": "2026-04-19T10:05:00Z",
      "type": "error",
      "tool": "Bash",
      "error": "TypeError: Cannot read properties of undefined",
      "resolution": "Fixed in next Edit to src/auth.ts"
    },
    {
      "timestamp": "2026-04-19T10:08:00Z",
      "type": "user_correction",
      "summary": "Don't use cookie sessions, use bearer tokens",
      "raw": "No, we can't use cookies because of the CDN. Use bearer tokens."
    },
    {
      "timestamp": "2026-04-19T10:15:00Z",
      "type": "subagent",
      "agentType": "Explore",
      "description": "Research JWT libraries",
      "outcome": "Recommended jose over jsonwebtoken"
    },
    {
      "timestamp": "2026-04-19T10:30:00Z",
      "type": "git_commit",
      "message": "Add JWT auth middleware"
    }
  ],
  "stats": {
    "totalMessages": 84,
    "toolCalls": 47,
    "errors": 3,
    "corrections": 2,
    "filesChanged": ["src/auth.ts", "src/auth.test.ts", "src/middleware.ts"],
    "subagents": 2,
    "gitCommits": 1
  }
}
```

#### Condensed mode

For sessions >2MB, `--condensed` skips routine tool calls (sequential Write/Edit without errors or corrections) and only emits:
- User messages
- Errors and their resolutions
- User corrections / approach changes
- Subagent dispatches and outcomes
- Git commits
- First and last tool call per file (to show what changed)

#### Subagent inclusion

`--include-subagents` reads `{session_id}/subagents/*.meta.json` for subagent metadata and includes a summary entry per subagent in the timeline. Does not parse full subagent JSONL transcripts.

#### Overflow handling

When a tool result contains `<persisted-output>`, the parser notes the overflow file path but does not read it. The timeline entry includes `"overflow": true` and `"overflowPath": "/path/to/file.txt"` for optional follow-up.

### 6. Configuration

**File:** `$CLAUDE_PLUGIN_DATA/config.json`
**Created:** Only when user explicitly customises. Defaults are hardcoded.

#### Schema

```json
{
  "sensitivity": "normal",
  "minToolCalls": 5,
  "minDurationMinutes": 10,
  "signals": {
    "fileChangesWeight": 2,
    "subagentSpawnsWeight": 2,
    "gitCommitsWeight": 1
  },
  "thresholds": {
    "low": 15,
    "normal": 8,
    "high": 3
  },
  "projectOverrides": {
    "**/infrastructure/**": { "sensitivity": "high" },
    "**/scratch/**": { "enabled": false }
  },
  "enabled": true
}
```

All fields optional. Missing fields fall back to defaults. Project overrides use glob patterns matched against `cwd`.

### 7. hooks.json

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/track-activity.sh",
            "timeout": 5
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "compact",
        "hooks": [
          {
            "type": "command",
            "command": "python3 ${CLAUDE_PLUGIN_ROOT}/scripts/extract-on-compact.py",
            "timeout": 60
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/capture-session.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

### 8. plugin.json

```json
{
  "name": "session-retro",
  "description": "Interactive session retrospectives with auto-nudging and memory integration",
  "version": "0.1.0",
  "author": {
    "name": "Jason Matthew"
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/jasonmatthew/session-retro"
  },
  "engines": {
    "claude-code": ">=2.1.110"
  }
}
```

## Data Flow

### During a session

```
User works normally
  └─ Every tool call → PreToolUse hook fires
       └─ track-activity.sh increments counters in $PLUGIN_DATA/activity-{sid}.json
       └─ Once score threshold met → injects additionalContext (one time)
            └─ Claude naturally suggests /session-retro:retro when task is complete
```

### If compaction happens

```
Context fills up → compaction triggers
  └─ SessionStart(compact) fires with fresh context
       └─ extract-on-compact.py reads full JSONL (still on disk)
       └─ Writes memory entry: compact_extract_{timestamp}.md
       └─ Returns additionalContext summary into fresh context
```

### When user runs /session-retro:retro

```
Skill invoked
  └─ Checks for pending retros from previous sessions
  └─ Runs bin/session-retro-parse on current session JSONL
  └─ Guided walkthrough conversation (one question at a time)
  └─ Writes memory entries (feedback, project, reference)
  └─ Updates MEMORY.md index
  └─ Sets retro-done flag
```

### When session ends

```
Session terminates
  └─ SessionEnd hook fires
       └─ If retro done: clean up temp files, skip capture
       └─ If no retro: write pending-retro-{sid}.json for next session
       └─ Clean up activity counter and nudge flag files
```

## File Locations

### Plugin data (`$CLAUDE_PLUGIN_DATA/`)

| File | Purpose | Lifecycle |
|---|---|---|
| `activity-{session_id}.json` | Tool call counter, scores | Created first tool call → deleted session end |
| `nudge-sent-{session_id}.flag` | Prevents repeat nudge | Created on nudge → deleted session end |
| `retro-done-{session_id}.flag` | Signals retro completed | Created by skill → persists |
| `pending-retro-{session_id}.json` | Fallback capture | Created session end → deleted when retro done |
| `config.json` | User preferences | Persistent, user-managed |

### Memory entries (`~/.claude/projects/{project}/memory/`)

| Source | File pattern | Memory type |
|---|---|---|
| Compaction extraction | `compact_extract_{timestamp}.md` | project |
| Interactive retro | `retro_feedback_{topic}.md` | feedback |
| Interactive retro | `retro_project_{topic}.md` | project |
| Interactive retro | `retro_reference_{topic}.md` | reference |

## Known Limitations and Risks

1. **PreToolUse additionalContext accumulates permanently** in conversation history. Mitigated by injecting once per session, keeping message under 500 characters.

2. **PreCompact hook is broken for auto-compaction** (bug #50467, v2.1.105-v2.1.114). Replaced with SessionStart(compact) which fires reliably after compaction.

3. **PostToolUse additionalContext is unreliable for built-in tools** (issue #18427, closed NOT_PLANNED). Not used in this design — PreToolUse only.

4. **Long sessions (100+ tool calls) may hit cache_control bugs** (#38542). Minimal injection (once per session) reduces risk.

5. **Decision extraction in extract-on-compact.py is heuristic** — pattern matching, not LLM judgment. It catches obvious signals but may miss nuanced decisions. The interactive retro does the deeper analysis.

6. **Large JSONL files** (>10MB) may slow down the retro skill's initial parsing. Condensed mode mitigates this. 90% of sessions are under 1MB.

7. **bin/ scripts may not receive CLAUDE_PLUGIN_DATA env var** — not explicitly documented for bin/ executables. Fallback: pass the path as a CLI argument from the skill.

## Out of Scope for v1

- `/session-retro:config` skill for conversational settings adjustment
- Cross-project pattern detection ("this is the third time you've hit this bug")
- Post-session review by a separate fresh-context model
- Handoff document generation (retro + "here's where we left off")
- Trend analysis across retros
- Integration with external systems (Linear, Jira, Notion)
- Publishing to official Anthropic marketplace (do this after community feedback)

## Testing Strategy

- **Hook scripts:** Unit test with piped stdin JSON. Verify output schema, flag file creation/deletion, threshold logic.
- **JSONL parser:** Test against real session files from `~/.claude/projects/`. Cover small (<100KB), medium (1MB), and large (>10MB) sessions. Verify condensed mode drops routine entries.
- **Skill:** Manual testing via `claude --plugin-dir ./`. Verify guided walkthrough flow, memory entry format, MEMORY.md updates.
- **Integration:** End-to-end test: work a session, verify nudge appears, run retro, verify memory entries written, end session, verify cleanup.
