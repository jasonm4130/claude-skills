# handoff — Claude Code Plugin

## What this is

A Claude Code plugin with one skill and one hook. The `/handoff` skill (agent-authored)
writes a structured resume document to `$PROJECT_ROOT/.claude/handoffs/` and drops a
`.pending` marker naming it; the next session's `SessionStart` hook auto-loads that
document via `additionalContext` injection, subject to containment and provenance
checks.

Nothing here fires on its own. Through 0.10.3 the plugin also shipped a statusLine
script (`status-and-flag.mjs`), a `UserPromptSubmit` nudge hook
(`check-handoff-flag.mjs`), and a `setup.mjs` that wired the statusLine into
`~/.claude/settings.json`. That trigger could only ever fire through a user-configured
statusLine, and it never ran end-to-end. It was removed in 0.11.0. If a context-fill
trigger is ever wanted again, it needs a mechanism that does not depend on the user's
statusLine.

## Plugin structure

```
handoff/
├── .claude-plugin/
│   └── plugin.json           — name, version, author, engines
├── hooks/
│   └── hooks.json            — SessionStart only
├── scripts/
│   ├── lib.mjs               — stdin/JSON/additionalContext helpers plus the containment
│   │                           and provenance primitives (readContainedFile, dirContainedIn,
│   │                           gitTracksFile)
│   └── load-pending-handoff.mjs — SessionStart: loads .pending handoff → additionalContext
├── skills/
│   └── handoff/
│       └── SKILL.md          — /handoff skill definition
├── tests/
│   ├── lib.test.mjs
│   └── load-pending-handoff.test.mjs
├── README.md
└── CLAUDE.md                 — this file
```

Nudge text names a skill **plugin-qualified** (`handoff:handoff`). An unqualified name
is one the model has to guess and it guesses wrong — `Skill(handoff)` returns
`Unknown skill: handoff`. Enforced repo-wide by `scripts/repo-consistency.test.mjs`.

## Dependencies

- **Node.js 18+ on PATH.** No third-party packages, no `package.json`.
  Stdlib only. Node is an external prerequisite Claude Code does not ship — install it via Homebrew, WinGet, or your distro's package manager. Without it the hook cannot run and the guard fails open (Claude Code shows a non-blocking `hook error` per matching event). Why there is no silent-skip: `scripts/hook-runtime-guard.test.mjs`.
- **Claude Code >= 2.1.110** — required for `hooks.json` plugin hook registration.

## Development

Test scripts:
```bash
# Run all tests
bash scripts/run-node-tests.sh

# Run a single test file
node --test plugins/handoff/tests/load-pending-handoff.test.mjs

# Manual loader smoke test (writes nothing unless .pending exists in <project>)
echo '{"cwd":"/path/to/project"}' | node plugins/handoff/scripts/load-pending-handoff.mjs
```

## Conventions

- **ESM only.** Every script is `.mjs`. No CommonJS, no `package.json`,
  no `require`.
- **Stdlib only.** Allowed imports: `node:fs`, `node:fs/promises`,
  `node:path`, `node:os`, `node:process`, `node:child_process`, `node:url`,
  `node:test`, `node:assert/strict`.
- **`// @ts-check` at the top of every file**, with JSDoc `@typedef` for stdin
  payload shapes. Editors get IntelliSense without a build step.
- Graceful degradation: any JSON parse error or missing input → `process.exit(0)`
  silently.
- `additionalContext` output uses the full `hookSpecificOutput` envelope
  (Claude Code issue #53682 safe form).
- Use `path.join`, never string concatenation, for cross-platform path
  correctness. Use `os.tmpdir()`, never `/tmp`.
- No external services and no network.
- **Loader safety is two independent checks, and both must stay.** `readContainedFile` /
  `dirContainedIn` stop a marker reading files outside `.claude/handoffs/`;
  `gitTracksFile` refuses anything the repo itself shipped, because a committed handoff
  would otherwise be announced as the user's own prior session. The provenance check
  resolves git from the handoffs directory, never from the project root — a hostile
  parent can ship `.claude/handoffs/` as a submodule.
