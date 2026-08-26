---
name: retro
description: >
  Run an interactive session retrospective. Reads the per-session event log
  (maintained by the PostToolUse hook) and uses git diff/status/log as
  memory primer, then walks through specific moments via adaptive questions
  driven by what changed, and writes structured native memory entries.
  Suggest this when the end-of-day hook has injected a /retro suggestion,
  or when the user explicitly asks for one.
  Triggers: "retro", "session summary", "what did we learn", "lessons learned",
  "session retrospective".
---

# Session Retrospective

You are running an interactive session retrospective. Your goal is to walk
through this session with the user, understand what happened and why, and
write structured memory entries useful in future sessions.

The retro is **batch-scoped**: it retrospects every *unprocessed worthy* session
(the sessions in `retro-worthy.jsonl` not yet in `retro-processed.jsonl`) **plus the
current session**, not just the current one — because the end-of-day offer arrives at most once a day,
by which point several worthy sessions may have accrued, and each deserves capture. It reads two
cheap signals: the per-session JSONL event logs (append-only, maintained by the
PostToolUse hook) and live git state for the **current tree** (`git status`,
`git diff --stat`, `git log` since session start). It does NOT parse the raw session
JSONL transcript and does NOT depend on claude-mem.

## Step 1: Collect the batch + quick-skip gate

Run the collector **once**. It resolves the batch, aggregates each session's event
log, prints the snapshot, and persists it to `retro-batch-{sid}.json` for Steps 2 and
6 to reuse — **do not run it again** in later steps.

```bash
CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/scripts/collect-batch-sessions.mjs" "${CLAUDE_SESSION_ID}"
```

The snapshot is `{ boundaryTs, processedSids, totalSessions, cappedFrom?, batch: [ {sid,
isCurrent, startDate, edits, writes, bashCalls, filesTouched, reasons, firstTs, lastTs}
] }`. Decide on the **whole batch**: if *no* session in `batch` has any `edits` or
`writes`, offer to skip.

- If the user declines a skip / there is signal → continue to Step 2.
- If the user accepts the skip (nothing to capture) → **still run Step 6 cleanup**.
  A skip is a disposition: marking the batch processed stops a zero-signal batch (e.g.
  one whose event logs are missing) from re-triggering the nudge forever.

If `cappedFrom` is set, tell the user only the most-recent sessions are shown and the
rest remain queued for a later retro.

## Step 2: Gather signals

Reuse the snapshot from Step 1 (read `retro-batch-${CLAUDE_SESSION_ID}.json` — do NOT
re-run the collector). Add live git state for the **current tree only** (older sessions
have no live diff):

```bash
START_FILE="${CLAUDE_PLUGIN_DATA}/session-start-${CLAUDE_SESSION_ID}.txt"
SESSION_START=$(cat "$START_FILE" 2>/dev/null || echo "4 hours ago")

echo "=== batch snapshot ==="
cat "${CLAUDE_PLUGIN_DATA}/retro-batch-${CLAUDE_SESSION_ID}.json" 2>/dev/null

echo "=== git status (current tree) ==="
git status --short 2>/dev/null || echo "(not a git repo)"
echo "=== git diff stat (current tree) ==="
git diff --stat 2>/dev/null
echo "=== git log since current session start ==="
git log --since="$SESSION_START" --oneline 2>/dev/null
```

If `git status` errors with "not a git repository", skip the diff steps and proceed
with interview-only mode. The event logs alone are enough signal.

Surface a **dated, per-session** recap in plain English. Example:

> "Batch of 3 sessions since your last retro:
> • 2026-07-14 — 6 edits across the codex-review plugin, 1 commit
> • 2026-07-15 — added `deep-dive.test.mjs`, ran tests twice
> • today — edited `auth.ts` 4 times; uncommitted changes in `config.yaml`
> Want me to walk through?"

## Step 3: Adaptive questions

Pick 3-5 specific moments **from anywhere in the batch**, prioritising the
highest-signal sessions. Ask **one question at a time**. Wait for the response before
the next.

- For the **current** session, seed questions from the live diff/log AND its event log.
- For **older** sessions there is **no live diff** — seed questions only from that
  session's event-log aggregates in the snapshot (files touched, edit/write counts, and
  its stored `reasons`). Do NOT invent diff-based questions for old sessions, and date
  the question so the user knows which session you mean.

Examples of good questions:

- "On 2026-07-14 you edited `codex-review.mjs` 6 times — what was that iteration about?"
- "You added `tests/auth.test.ts` today — what were you trying to verify?"
- "Your commit `fix: token bug` — what was the actual root cause?"
- "The 2026-07-15 session was flagged for 'committed during session' but touched 9 files — anything notable?"

Rules for the question set:

- Each question MUST reference something visible in a session's snapshot aggregates,
  the current diff, or the current log — and name the session's date when it's not today
- Do NOT ask generic questions ("what did you learn?", "any decisions?")
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

Run this on **both** paths: after a normal interview **and** after an accepted
Step-1 skip. It reads the Step-1 snapshot (`retro-batch-{sid}.json`) — no extra args.

```bash
CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/scripts/mark-retro-done.mjs" "${CLAUDE_SESSION_ID}"
```

(The env prefix matters: session shells don't inherit `CLAUDE_PLUGIN_DATA` the
way hooks do, and without it the script writes to an `os.tmpdir()` fallback the
hooks never read.)

This **appends** the interviewed sids (the snapshot's `processedSids`) to the
append-only `retro-processed.jsonl` ledger — the batch is cleared by *identity*, so
`retro-worthy.jsonl` and any session that became worthy during the interview are left
untouched. It also writes the per-session fired flag (suppressing further Stop-hook
suggestions this session) and the `last-retro.txt` days-cadence hint, so no
end-of-day offer fires until enough *new* worthy sessions accrue.

## Guidelines

- Ask ONE question at a time. Wait for the response.
- Focus on the "why" — decisions, rationale, trade-offs. Not the "what."
- Keep memory entries concise. One entry per distinct learning.
- Only write memories for things genuinely useful in future sessions.
- If the batch was routine with no notable decisions, say so. A short
  "clean batch, nothing to capture" is fine — but still run Step 6.
- Never fabricate learnings. If a session's aggregates don't show clear decision
  points, ask the user what they found valuable rather than inventing insights.
- The snapshot aggregates and the current diff are the question seeds. Avoid
  generic prompts.
