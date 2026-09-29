# session-retro

Capture layer for a weekly, human-reviewed failure review. One hook script,
`scripts/capture.mjs`, writes one JSON line per tool outcome, denial, API stop
failure and session start. It stores no tool input, output, prompt or path: only
the tool, a two-token command head, a file extension, a redacted first line of
the error, and context (`harness` = chezmoi HEAD + plugin version, `cc`,
`model`, `pstart`, `arm` from `CLAUDE_HEAL_ARM`).

```
/plugin marketplace add jasonm4130/claude-skills
/plugin install session-retro@jasonm4130-claude-skills
```

Records land in `$CLAUDE_PLUGIN_DATA/v3/events/<UTC day>/<session>.jsonl`;
day folders older than 42 days are deleted. `ok` comes only from which event
fired. PostToolBatch rows (`denied_or_invalid`) are advisory: dedupe by `id`.

Heartbeat: pipe `{"hook_event_name":"SessionStart","session_id":"canary-<day>","source":"canary"}`
through the hook command and check for the record.

The hook always exits 0 with empty stdout. It needs Node 18+ on PATH.
Tests: `node --test plugins/session-retro/tests/*.test.mjs`.
