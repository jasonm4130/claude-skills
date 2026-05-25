# handoff

Context-fill-triggered handoff skill — writes a structured resume document
when your context window fills up, and auto-loads it in the next session.

## What it does

1. **Monitors context fill** via a statusLine command that renders a color-coded
   progress bar and detects when context crosses a configurable threshold (default 70%).
2. **Nudges at threshold** — on first crossing, the next user prompt receives an
   `additionalContext` injection telling the agent to suggest `/handoff`.
3. **`/handoff` skill** — the agent writes a structured `.claude/handoffs/<ts>-<slug>.md`
   document covering current state, failed approaches, key decisions, modified files,
   blockers, and the next concrete runnable step.
4. **Auto-loads on next session** — after `/handoff`, a `.pending` marker is written.
   The SessionStart hook reads it and injects the handoff as context so the next
   session resumes seamlessly. The marker expires after 24 hours.

## Install

```
/plugin install handoff@jasonm4130-claude-skills
```

## Required wiring: statusLine

The context-fill bar is NOT wired automatically — Claude Code's `statusLine` is a
singleton in your user settings and plugins cannot claim it. You must add it manually.

Add to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "${CLAUDE_PLUGIN_ROOT}/scripts/status-and-flag.sh"
  }
}
```

**IMPORTANT — Open Question on path resolution:**
`${CLAUDE_PLUGIN_ROOT}` substitution works inside plugin-registered hook commands
(e.g., `hooks/hooks.json`), but whether Claude Code also resolves it inside
user-level `settings.json` `statusLine` entries is **unverified** as of v0.1.0
(see spec Open Question #5).

If `${CLAUDE_PLUGIN_ROOT}` does NOT resolve in `statusLine`, use the explicit path:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/plugins/cache/jasonm4130-claude-skills/handoff/0.1.0/scripts/status-and-flag.sh"
  }
}
```

**Warning:** The explicit path includes the version segment (`0.1.0`). It will
break when you update the plugin and must be manually updated each time.

Verify and test this before relying on the statusLine wiring. Contributions
documenting the correct approach are welcome.

### Existing statusLine

If you already have a `statusLine` configured (e.g., a custom HUD), you will need
to merge the outputs. Composable statusLine (running multiple commands and combining
output) is not yet supported by Claude Code. For now, the options are:

- Replace your existing statusLine with this plugin's script, or
- Run your existing script from inside `status-and-flag.sh` and append its output

Composable statusLine support is tracked as a follow-up for v0.2.0.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `HANDOFF_THRESHOLD_PCT` | `70` | Context % at which to fire the nudge |
| `CLAUDE_PLUGIN_DATA` | `/tmp/handoff-data` | Where flag and last-pct state files are stored |

Set env vars in `~/.claude/settings.json` under `"env"`:

```json
{
  "env": {
    "HANDOFF_THRESHOLD_PCT": "65"
  }
}
```

## Example flow

1. You work through a session. Context climbs.
2. At 70%, the status bar turns red: `[███████░░░] 71%`
3. On your next prompt, the agent says:
   > "Context is at 71% — we're approaching the limit. Want me to write a
   > handoff doc with `/handoff` before you run `/compact` or `/clear`?"
4. You run `/handoff auth-token-bug`.
5. The agent writes `.claude/handoffs/2026-05-25T14-32-00-auth-token-bug.md`.
6. You run `/clear`.
7. Next session starts — the SessionStart hook auto-loads the handoff:
   > "[handoff] Loading pending handoff from previous session: ..."
8. The agent resumes in context.

## Troubleshooting

**No nudge firing even though context is high:**
- Check that `status-and-flag.sh` is being called (verify statusLine wiring).
- Check the last-pct file is updating: `cat /tmp/handoff-data/last-context-pct-<session-id>.txt`
- Make sure the threshold env var is not set higher than the current context %.

**Nudge fires repeatedly on every prompt:**
- The `UserPromptSubmit` hook (`check-handoff-flag.sh`) should delete the flag after consuming it.
- Check for errors in the hook: run `check-handoff-flag.sh` manually with test input.
- If `CLAUDE_PLUGIN_DATA` is unset and `/tmp/handoff-data` is not writable, the flag may
  not be created or deleted correctly.

**Handoff not auto-loading in new session:**
- Confirm `.claude/handoffs/.pending` was written (check after running `/handoff`).
- If more than 24 hours have passed since the handoff was written, `.pending` is
  deleted as stale. The handoff file itself still exists — `cat` it manually.
- The new session's events log starts empty. `/retro` will quick-skip (correct behavior).

**Note:** After a resumed session, the `session-retro` plugin's `/retro` quick-skip
gate will fire (no edits in the new session yet). This is expected — the handoff
gives you context, but the retro waits until you've actually done work in the new session.

## State files

| File | Location | Description |
|---|---|---|
| `last-context-pct-<sid>.txt` | `$CLAUDE_PLUGIN_DATA` | Tracks last seen context % for crossing detection |
| `handoff-nudge-<sid>.flag` | `$CLAUDE_PLUGIN_DATA` | One-shot nudge flag, consumed by UserPromptSubmit |
| `<ts>-<slug>.md` | `$PROJECT_ROOT/.claude/handoffs/` | The handoff document (agent-authored) |
| `.pending` | `$PROJECT_ROOT/.claude/handoffs/` | Auto-load marker for next session (24h TTL) |
