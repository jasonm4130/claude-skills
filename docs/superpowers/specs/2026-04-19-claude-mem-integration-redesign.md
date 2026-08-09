# Session Retro v0.2 — claude-mem Integration Redesign

**Date:** 2026-04-19
**Status:** Draft
**Author:** Jason Matthew + Claude
**Supersedes:** `2026-04-19-session-retro-plugin-design.md` (v0.1 architecture)

## Problem

v0.1 parsed session JSONL at retro time, dumping 30,000+ tokens into context. A single retro on a 3-hour session cost ~A$100 in token usage. The approach was backwards — reconstructing a session from raw transcripts instead of leveraging observations that claude-mem already captures continuously in the background.

## Solution

Strip the plugin down to a skill + one hook. Read from claude-mem instead of parsing JSONL. Write back to both native memory and claude-mem.

## Plugin Structure

```
session-retro/
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json
├── hooks/
│   └── hooks.json
├── scripts/
│   └── mark-session-start.sh
├── skills/
│   └── retro/
│       └── SKILL.md
├── CLAUDE.md
├── README.md
└── LICENSE
```

**Removed from v0.1:** `lib/` (parser, config, decisions, memory modules), `bin/` (CLI parser), `tests/`, `pyproject.toml`, PreToolUse hook, SessionEnd hook, SessionStart(compact) hook, all Python dependencies.

## Dependencies

- **claude-mem** plugin must be installed and active
- No bash dependencies beyond coreutils
- No Python, no jq

## Components

### 1. SessionStart Hook (`mark-session-start.sh`)

**Event:** SessionStart
**Matcher:** (empty — all start types)
**Type:** command
**Timeout:** 5 seconds

Writes a timestamp pointer so the retro skill knows exactly when this session started.

**Behaviour:**
1. Read `session_id` and `timestamp` from stdin JSON (via simple string extraction — no jq needed, or use jq if available)
2. Write to `$CLAUDE_PLUGIN_DATA/session-start-{session_id}.txt`
3. Exit 0, no stdout

**Script (~10 lines):**
```bash
#!/usr/bin/env bash
set -euo pipefail
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | grep -o '"session_id":"[^"]*"' | cut -d'"' -f4)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-/tmp/session-retro-data}"
mkdir -p "$PLUGIN_DATA"
echo "$TIMESTAMP" > "$PLUGIN_DATA/session-start-${SESSION_ID}.txt"
exit 0
```

### 2. Retro Skill (`/session-retro:retro`)

**Location:** `skills/retro/SKILL.md`

**Description (for auto-suggestion):** Instructs Claude to suggest the skill when a session has been productive — decisions made, errors resolved, approaches changed. No hook-based nudge; Claude judges from context.

#### Step 1: Determine session window

Read the session start timestamp:
```bash
cat ${CLAUDE_PLUGIN_DATA}/session-start-*.txt 2>/dev/null | tail -1
```

If no file exists, use a reasonable default (last 4 hours).

#### Step 2: Query claude-mem

Use the 3-layer pattern:

1. `search(dateStart=<session_start>, project=<current_project>, limit=50)` — get observation index
2. Review the index for retro-worthy moments (decisions, errors, corrections, discoveries)
3. `timeline(anchor=<id>)` on 2-3 key observations if more context is needed
4. `get_observations([ids])` only for specific items being discussed

**Token budget:** Step 1 returns ~50-100 tokens per observation. For a typical session with 20-30 observations, that's ~1,500-3,000 tokens total. Steps 2-3 are selective and add minimal overhead.

#### Step 3: Guided conversation

Same approach as v0.1 — walk through key moments one question at a time. Questions are derived from claude-mem observations, not from a parsed timeline.

Focus areas unchanged:
- Decisions and rationale
- Corrections to Claude's approach
- Errors and how they were resolved
- Techniques worth remembering

#### Step 4: Write findings

**To native memory** (`~/.claude/projects/{project}/memory/`):
- `retro_feedback_{topic}.md` — corrections to Claude's behaviour
- `retro_project_{topic}.md` — decisions and project context
- `retro_reference_{topic}.md` — external resources
- Update `MEMORY.md` index

**To claude-mem** (via natural language — Claude just describes the learning and claude-mem's hooks capture it as an observation):
- The retro conversation itself generates observations that claude-mem captures automatically
- No explicit API call needed — claude-mem's PostToolUse/Stop hooks pick up the memory writes

#### Step 5: Cleanup

Write retro-done flag:
```bash
touch ${CLAUDE_PLUGIN_DATA}/retro-done-{session_id}.flag
```

### 3. Nudge Mechanism

No hooks. The skill description in SKILL.md frontmatter tells Claude when to suggest a retro:

```yaml
description: >
  Run an interactive session retrospective. Suggest this when a session has
  involved significant work — debugging, architecture decisions, approach
  changes, or error resolution. Do not suggest for quick Q&A sessions.
```

Claude already has session awareness and can see claude-mem observations in context. It judges naturally when to suggest the skill, the same way a colleague would say "want to do a quick retro before you wrap up?"

### 4. hooks.json

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/mark-session-start.sh",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

### 5. plugin.json

```json
{
  "name": "session-retro",
  "description": "Interactive session retrospectives powered by claude-mem",
  "version": "0.2.0",
  "author": {
    "name": "Jason Matthew"
  },
  "license": "MIT",
  "engines": {
    "claude-code": ">=2.1.110"
  }
}
```

## Token Cost Comparison

| Approach | Retro cost | How |
|---|---|---|
| v0.1 full parse | ~37,000 tokens | Parse entire JSONL into context |
| v0.1 summary mode | ~1,400 tokens | Summary parser output |
| v0.2 claude-mem | ~1,500-3,000 tokens | search() index only, selective detail |

v0.2 is comparable to v0.1 summary mode in token cost, but with richer data (claude-mem observations include LLM-extracted insights, not just heuristic pattern matches).

## What claude-mem Handles (that we no longer need to)

| Concern | v0.1 (us) | v0.2 (claude-mem) |
|---|---|---|
| Session data capture | JSONL parser | claude-mem worker |
| Continuous observation | PreToolUse hook counters | claude-mem PostToolUse/Stop hooks |
| Error detection | Regex heuristics | claude-mem observation types |
| Decision detection | Regex heuristics | claude-mem semantic extraction |
| Compaction recovery | SessionStart(compact) hook | claude-mem persists independently |
| Cross-session search | Not supported | claude-mem search/timeline |
| Fallback capture | SessionEnd hook | claude-mem SessionEnd hook |

## Migration from v0.1

1. Remove: `lib/`, `bin/`, `tests/`, `pyproject.toml`, all scripts except `mark-session-start.sh`
2. Remove: PreToolUse, SessionEnd, SessionStart(compact) hooks from `hooks.json`
3. Add: SessionStart hook for timestamp pointer
4. Rewrite: SKILL.md to query claude-mem instead of invoking parser
5. Update: plugin.json version to 0.2.0
6. Update: README.md, CLAUDE.md, marketplace.json

## Testing

- **Skill:** Manual testing via `claude --plugin-dir ./`. Verify search returns observations, guided conversation works, memory entries written.
- **Hook:** `echo '{"session_id":"test"}' | bash scripts/mark-session-start.sh` — verify timestamp file created.
- **Integration:** Run a real session, invoke `/session-retro:retro`, verify end-to-end flow.

## Out of Scope

- Nudge hook (skill description handles this)
- JSONL parsing (claude-mem handles this)
- Python/bash dependencies beyond coreutils
- Offline mode without claude-mem
