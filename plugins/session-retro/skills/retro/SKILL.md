---
description: >
  Run an interactive session retrospective. Reads the per-session event log
  (maintained by the PostToolUse hook) and uses git diff/status/log as
  memory primer, then walks through specific moments via adaptive questions
  driven by what changed, and writes structured native memory entries.
  Suggest this when a Stop or PreCompact hook has injected a /retro
  suggestion, or when the user explicitly asks for one.
  Triggers: "retro", "session summary", "what did we learn", "lessons learned",
  "session retrospective".
---

# Session Retrospective

You are running an interactive session retrospective. Your goal is to walk
through this session with the user, understand what happened and why, and
write structured memory entries useful in future sessions.

The retro reads from two cheap signals: a per-session JSONL event log
(append-only, maintained by the PostToolUse hook) and live git state
(`git status`, `git diff --stat`, `git log` since session start). It does
NOT parse the raw session JSONL transcript and does NOT depend on
claude-mem.

## Step 1: Quick-skip gate

Read the event log to decide whether a full retro is worth doing. If there
are no Edit/Write events, this was a read-only session — offer to skip.

```bash
EVENTS_FILE="${CLAUDE_PLUGIN_DATA}/events-${CLAUDE_SESSION_ID}.jsonl"
if [ ! -f "$EVENTS_FILE" ] || ! jq -R 'fromjson? | select(.tool == "Edit" or .tool == "Write")' "$EVENTS_FILE" 2>/dev/null | grep -q .; then
    echo "This session had no edits/writes. Anything specific you want to capture?"
    # If user says no → exit cleanly with "clean session, nothing to capture".
    # If user says yes → skip directly to Step 4 (open catch-all only).
fi
```

## Step 2: Gather signals

In one bash block, collect the session signals:

```bash
EVENTS_FILE="${CLAUDE_PLUGIN_DATA}/events-${CLAUDE_SESSION_ID}.jsonl"
START_FILE="${CLAUDE_PLUGIN_DATA}/session-start-${CLAUDE_SESSION_ID}.txt"
SESSION_START=$(cat "$START_FILE" 2>/dev/null || echo "4 hours ago")

echo "=== event summary ==="
jq -R -s '
    split("\n")
    | map(select(. != "") | fromjson?)
    | {
        edits: ([.[] | select(.tool == "Edit")] | length),
        writes: ([.[] | select(.tool == "Write")] | length),
        bash_calls: ([.[] | select(.tool == "Bash")] | length),
        files_touched: ([.[] | select(.tool == "Edit" or .tool == "Write") | .input.file_path // empty] | map(select(. != "")) | unique)
    }
' < "$EVENTS_FILE" 2>/dev/null

echo "=== git status ==="
git status --short 2>/dev/null || echo "(not a git repo)"
echo "=== git diff stat ==="
git diff --stat 2>/dev/null
echo "=== git log since session start ==="
git log --since="$SESSION_START" --oneline 2>/dev/null
```

If `git status` errors with "not a git repository", skip the diff steps and
proceed with interview-only mode. The event log alone is enough signal.

Surface the recap to the user in plain English. Example:

> "Quick recap: this session you edited `auth.ts` 4 times, added
> `auth.test.ts`, ran tests twice, and made 1 commit. Uncommitted changes
> in `config.yaml`. Want me to walk through?"

## Step 3: Adaptive questions

Pick 3-5 specific moments from the diff/log/event-log. Ask **one question at
a time**. Wait for the response before the next question. Examples of good
questions:

- "You edited `src/auth.ts` 4 times — what was the iteration about?"
- "You added `tests/auth.test.ts` — what were you trying to verify?"
- "You reverted part of `config.yaml` — what changed your mind?"
- "Your commit `fix: token bug` — what was the actual root cause?"
- "Tests ran 2 times before passing — what was breaking?"

Rules for the question set:

- Each question MUST reference something visible in the diff, log, or event
  log
- Do NOT ask generic questions ("what did you learn?", "any decisions?") —
  the diff IS the question seed
- Do NOT batch questions
- Do NOT ask about routine successful operations
- Skip a question if the user says "nothing notable" — move on to the next

## Step 4: Open catch-all

After the diff-driven questions:

> "Anything else worth remembering that didn't show up in the diff?
> Surprises, gotchas, things you tried that failed, decisions about
> approach, corrections to my behaviour?"

## Step 5: Write findings

Write to native memory files. Use the existing 3-type taxonomy (these have
to match the format the user's MEMORY.md system already uses):

**Corrections to Claude's behaviour → `feedback`:**

```markdown
---
name: {short name}
description: {one-line description used by future sessions to decide relevance}
type: feedback
---

{The rule or preference}

**Why:** {The reason the user gave}

**How to apply:** {When/where this applies}
```

Filename: `retro_feedback_{topic}.md`

**Decisions, project context → `project`:**

```markdown
---
name: {short name}
description: {one-line description}
type: project
---

{The decision or fact}

**Why:** {The motivation}

**How to apply:** {How this shapes future suggestions}
```

Filename: `retro_project_{topic}.md`

**External resources → `reference`:**

```markdown
---
name: {short name}
description: {one-line description}
type: reference
---

{The resource and what it's useful for}
```

Filename: `retro_reference_{topic}.md`

Write each file via the Write tool, then update the project's MEMORY.md
index (append a one-liner under ~150 chars: `- [Title](file.md) — one-line
hook`). Show the user each entry for confirmation before writing.

## Step 6: Cleanup

```bash
touch "${CLAUDE_PLUGIN_DATA}/retro-fired-${CLAUDE_SESSION_ID}.flag"
```

This suppresses further Stop-hook suggestions for the rest of the session
(PreCompact still suggests regardless, since context loss is a hard event).

## Guidelines

- Ask ONE question at a time. Wait for the response.
- Focus on the "why" — decisions, rationale, trade-offs. Not the "what."
- Keep memory entries concise. One entry per distinct learning.
- Only write memories for things genuinely useful in future sessions.
- If the session was routine with no notable decisions, say so. A short
  "clean session, nothing to capture" is fine.
- Never fabricate learnings. If the diff/log doesn't show clear decision
  points, ask the user what they found valuable rather than inventing
  insights.
- The diff is the question seed. Avoid generic prompts.
