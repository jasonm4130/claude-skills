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

## Prerequisites

- **Node.js 18+** on `PATH`. The Claude Code installer does not bring Node — install
  it via your platform package manager (Homebrew, WinGet, your distro's apt/dnf/pacman,
  or [nodejs.org](https://nodejs.org)).
- Claude Code `>= 2.1.110`.

## Install

```
/plugin install handoff@jasonm4130-claude-skills
```

After install, run the one-time `setup.mjs` helper to wire the context-fill bar into
your user-level `statusLine`:

```bash
node "$(echo ~/.claude/plugins/cache/jasonm4130-claude-skills/handoff/*/scripts/setup.mjs | tr ' ' '\n' | sort -V | tail -n1)"
```

The setup script:

1. Reads (or creates) `~/.claude/settings.json`.
2. Backs the current file up to `~/.claude/settings.json.pre-handoff.bak`.
3. Writes a stable wrapper at `~/.claude/handoff-statusline.mjs` that
   auto-resolves the highest installed plugin version at run time.
4. Writes a `statusLine` entry pointing at that stable wrapper.
5. Tells you to restart Claude Code.

Because the statusLine now points at the stable wrapper rather than a
version-specific path, **plugin upgrades no longer require re-running setup**.
The wrapper picks up the new version automatically on the next Claude Code restart.

If you already have a custom `statusLine` configured, setup will refuse to overwrite
it. Re-run with `--force` if you want to replace it, or merge manually — see "Existing
statusLine" below.

### Existing statusLine

If you already have a `statusLine` configured (e.g., a custom HUD), you will need
to merge the outputs. Composable statusLine (running multiple commands and combining
output) is not yet supported by Claude Code. For now, the options are:

- Replace your existing statusLine with this plugin's script, or
- Run your existing script from inside `status-and-flag.mjs` and append its output.

Composable statusLine support is tracked as a follow-up.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `HANDOFF_THRESHOLD_PCT` | `70` | Context % at which to fire the nudge |
| `HANDOFF_EFFECTIVE_MAX_TOKENS` | _(unset)_ | Token ceiling to compute pct against — mirror your `autoCompactWindow` setting. When set, a JSONL transcript fallback (added in 0.3.0) is used if `current_usage` is absent or all-zero in stdin. |
| `CLAUDE_PLUGIN_DATA` | `<os.tmpdir>/handoff-data` | Where flag and last-pct state files are stored |

Set env vars in `~/.claude/settings.json` under `"env"`:

```json
{
  "env": {
    "HANDOFF_THRESHOLD_PCT": "65",
    "HANDOFF_EFFECTIVE_MAX_TOKENS": "400000"
  }
}
```

### Why `HANDOFF_EFFECTIVE_MAX_TOKENS`?

Claude Code's statusLine stdin reports `used_percentage` against the model's
**full context window** (e.g. 1M tokens for extended-context Sonnet), not
against your `autoCompactWindow` setting. If you have
`"autoCompactWindow": 400000` and you're 96% through your effective window,
the bar would otherwise show ~35% and the nudge would fire far too late
(or never).

Setting `HANDOFF_EFFECTIVE_MAX_TOKENS` to match your `autoCompactWindow`
makes the plugin compute pct from the input-only token fields in stdin's
`context_window.current_usage` against your effective ceiling. The bar and
nudge then track CC's native "% until auto-compact" indicator.

When unset (or 0 / non-numeric / negative), the plugin falls back to the raw
`used_percentage` field — same behavior as v0.2.0.

This is a workaround for upstream
[anthropics/claude-code#62210](https://github.com/anthropics/claude-code/issues/62210)
(stdin doesn't expose `autoCompactWindow` or a pre-computed
"% until auto-compact"). Tracked locally as
[issue #4](https://github.com/jasonm4130/claude-skills/issues/4).

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
- Check that `status-and-flag.mjs` is being called (verify statusLine wiring;
  re-run `setup.mjs` if unsure).
- Check the last-pct file is updating: `cat $TMPDIR/handoff-data/last-context-pct-<session-id>.txt`
  (or wherever `CLAUDE_PLUGIN_DATA` points).
- Make sure the threshold env var is not set higher than the current context %.
- If the bar shows a much lower % than CC's native "% until auto-compact",
  set `HANDOFF_EFFECTIVE_MAX_TOKENS` to match your `autoCompactWindow` — see
  Configuration above.
- If `current_usage` is missing from stdin (can happen early in a session),
  the bar will fall back to reading the transcript JSONL for the last assistant
  turn's token count. If both are unavailable (no assistant turns yet), the bar
  renders `?`.

**Nudge fires repeatedly on every prompt:**
- The `UserPromptSubmit` hook (`check-handoff-flag.mjs`) should delete the flag after consuming it.
- Check for errors in the hook: run `check-handoff-flag.mjs` manually with test input.
- If `CLAUDE_PLUGIN_DATA` is unset and the tmpdir fallback is not writable, the flag may
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
| `handoff-statusline.mjs` | `~/.claude/` | Stable wrapper script that auto-resolves the latest installed plugin version (written by setup.mjs) |
| `last-context-pct-<sid>.txt` | `$CLAUDE_PLUGIN_DATA` | Tracks last seen context % for crossing detection |
| `handoff-nudge-<sid>.flag` | `$CLAUDE_PLUGIN_DATA` | One-shot nudge flag, consumed by UserPromptSubmit |
| `<ts>-<slug>.md` | `$PROJECT_ROOT/.claude/handoffs/` | The handoff document (agent-authored) |
| `.pending` | `$PROJECT_ROOT/.claude/handoffs/` | Auto-load marker for next session (24h TTL) |
