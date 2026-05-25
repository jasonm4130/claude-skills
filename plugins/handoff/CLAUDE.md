# handoff — Claude Code Plugin

## What this is

A Claude Code plugin that watches context fill via a `statusLine` command and
triggers a handoff suggestion at a configurable threshold. When triggered, the
`/handoff` skill (agent-authored) writes a structured resume document to
`$PROJECT_ROOT/.claude/handoffs/`. The next session's `SessionStart` hook
auto-loads the document via `additionalContext` injection.

## Plugin structure

```
handoff/
├── .claude-plugin/
│   └── plugin.json          — name, version, author, engines
├── hooks/
│   └── hooks.json           — UserPromptSubmit + SessionStart
├── scripts/
│   ├── status-and-flag.sh   — statusLine: renders bar, writes flag at threshold
│   ├── check-handoff-flag.sh — UserPromptSubmit: consumes flag → additionalContext
│   └── load-pending-handoff.sh — SessionStart: loads .pending handoff → additionalContext
├── skills/
│   └── handoff/
│       └── SKILL.md         — /handoff skill definition
├── tests/
│   ├── run-all.sh
│   └── test_*.sh            — per-script bash tests
├── README.md
└── CLAUDE.md                — this file
```

## Dependencies

- **jq** — required for JSON parsing in all three scripts. Install via
  `brew install jq` (macOS) or `apt install jq` (Debian/Ubuntu).
- **bash** — POSIX bash with `set -euo pipefail`. No Python, no Node.
- **Claude Code >= 2.1.110** — required for `hooks.json` plugin hook registration.

## Development

Test scripts:
```bash
# Run all tests
bash plugins/handoff/tests/run-all.sh

# Run a single test
bash plugins/handoff/tests/test_statusline_crossing.sh

# Manual statusLine test
echo '{"session_id":"dev","context_window":{"used_percentage":75}}' \
  | bash plugins/handoff/scripts/status-and-flag.sh

# Manual check-flag test
CLAUDE_PLUGIN_DATA=/tmp/test-handoff \
  echo '{"session_id":"dev"}' | bash plugins/handoff/scripts/check-handoff-flag.sh
```

## Open questions (as of v0.1.0)

**Open Question #5: statusLine path resolution.**
It is unverified whether `${CLAUDE_PLUGIN_ROOT}` is substituted by Claude Code
when it appears inside a user-level `settings.json` `statusLine` command (vs.
inside a plugin's own `hooks/hooks.json`). Plugin hooks use `${CLAUDE_PLUGIN_ROOT}`
and work correctly; statusLine lives in user settings and may not receive the same
substitution context.

Before v0.2.0: test `${CLAUDE_PLUGIN_ROOT}` substitution in a statusLine command
and document the result. If it does not work, evaluate:
- (a) Shipping a stable launcher symlink maintained by a SessionStart hook
- (b) Documenting the explicit version-segmented path and accepting manual-update cost

See `README.md` for current user-facing guidance on both forms.

## Conventions

- All scripts: `#!/usr/bin/env bash` + `set -euo pipefail`
- Graceful degradation: any JSON parse error or missing dependency → exit 0 silently
  (or output `?` for statusLine)
- Flag files are plain text, not JSON
- `additionalContext` output uses the full `hookSpecificOutput` envelope (issue #53682 safe)
- No external services, no transcript parsing
