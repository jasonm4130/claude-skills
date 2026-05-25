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
│   └── plugin.json           — name, version, author, engines
├── hooks/
│   └── hooks.json            — UserPromptSubmit + SessionStart
├── scripts/
│   ├── lib.mjs               — shared stdin/env/flag helpers
│   ├── status-and-flag.mjs   — statusLine: renders bar, writes flag at threshold
│   ├── check-handoff-flag.mjs— UserPromptSubmit: consumes flag → additionalContext
│   ├── load-pending-handoff.mjs — SessionStart: loads .pending handoff → additionalContext
│   └── setup.mjs             — one-time helper that wires statusLine into ~/.claude/settings.json
├── skills/
│   └── handoff/
│       └── SKILL.md          — /handoff skill definition
├── tests/
│   ├── lib.test.mjs
│   ├── status-and-flag.test.mjs
│   ├── check-handoff-flag.test.mjs
│   ├── load-pending-handoff.test.mjs
│   └── integration.test.mjs
├── README.md
└── CLAUDE.md                 — this file
```

## Dependencies

- **Node.js 18+ on PATH.** No third-party packages, no `package.json`.
  Stdlib only.
- **Claude Code >= 2.1.110** — required for `hooks.json` plugin hook registration.

## Development

Test scripts:
```bash
# Run all tests
node --test plugins/handoff/tests/

# Run a single test file
node --test plugins/handoff/tests/status-and-flag.test.mjs

# Manual statusLine smoke test
echo '{"session_id":"dev","context_window":{"used_percentage":75}}' \
  | node plugins/handoff/scripts/status-and-flag.mjs

# Manual check-flag smoke test
CLAUDE_PLUGIN_DATA=/tmp/test-handoff \
  echo '{"session_id":"dev"}' | node plugins/handoff/scripts/check-handoff-flag.mjs
```

## Configuration env vars

- `HANDOFF_THRESHOLD_PCT` — context % at which to fire the nudge (default `70`).
- `HANDOFF_EFFECTIVE_MAX_TOKENS` — when set to a positive number, pct is
  computed from `context_window.current_usage` input-token fields against
  this ceiling instead of using stdin's `used_percentage`. Workaround for
  upstream CC issue #62210 (stdin doesn't expose `autoCompactWindow`). See
  README for details.

## Conventions

- **ESM only.** Every script is `.mjs`. No CommonJS, no `package.json`,
  no `require`.
- **Stdlib only.** Allowed imports: `node:fs`, `node:fs/promises`,
  `node:path`, `node:os`, `node:process`, `node:child_process`, `node:url`,
  `node:test`, `node:assert/strict`.
- **`// @ts-check` at the top of every file**, with JSDoc `@typedef` for stdin
  payload shapes. Editors get IntelliSense without a build step.
- Graceful degradation: any JSON parse error or missing input → `process.exit(0)`
  silently (or `?` to stdout for the statusLine script).
- Flag files are plain text, not JSON; the on-disk format is wire-compatible
  with v0.1.0 bash scripts.
- `additionalContext` output uses the full `hookSpecificOutput` envelope
  (Claude Code issue #53682 safe form).
- Use `path.join`, never string concatenation, for cross-platform path
  correctness. Use `os.tmpdir()`, never `/tmp`.
- No external services, no transcript parsing.
