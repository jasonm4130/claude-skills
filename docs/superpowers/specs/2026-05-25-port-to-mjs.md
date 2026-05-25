# Port handoff + session-retro hooks from bash to Node `.mjs`

**Status:** Approved 2026-05-25
**Plugins affected:** `handoff` (0.1.0 → 0.2.0), `session-retro` (0.4.0 → 0.5.0)
**Branch:** `feat/port-hooks-to-mjs`

## Why

v0.1 ships bash + `jq` + `awk`. Windows users are broken three ways:
- CRLF + path-separator handling in bash (`${CLAUDE_PLUGIN_ROOT}` backslash stripping — CC issue #54640)
- `jq` and `awk` not in PATH on Windows
- `.sh` invocation opens scripts in editor on Windows (CC issue #17257)

Anthropic's own `ralph-loop` carries the same wound and tells users to manually edit `hooks.json` to point at Git Bash. That UX cliff is not what we ship.

CC has no per-OS routing in `hooks.json`. The community pattern that survives the matrix is **invoke through `node`**. CC docs confirm `${CLAUDE_PLUGIN_ROOT}` substitutes in hook commands. Node 18+ is CC's documented minimum for its npm install path, which we adopt as our plugin prereq.

## Non-goals

- No behavior changes. Same triggers, same nudge surfaces, same flag-file contracts.
- No new features. Threshold values, trigger conditions, additionalContext envelopes — all preserved.
- No build step. `.mjs` ships as source; no TypeScript, no `tsc`, no bundling.
- No npm dependencies. Stdlib only.

## Compatibility contract

Anything written to disk in v0.1 must be readable by v0.2 and vice versa. Specifically:

| Artifact | Format | Owner |
|---|---|---|
| `${CLAUDE_PLUGIN_DATA}/handoff-nudge-{sid}.flag` | plain-text trigger reason | handoff |
| `${CLAUDE_PLUGIN_DATA}/last-context-pct-{sid}.txt` | plain text, decimal pct | handoff |
| `${CLAUDE_PLUGIN_DATA}/retro-nudge-{sid}.flag` | plain-text trigger reason | session-retro |
| `${CLAUDE_PLUGIN_DATA}/retro-fired-{sid}.flag` | sentinel (empty file) | session-retro |
| `${CLAUDE_PLUGIN_DATA}/events-{sid}.jsonl` | NDJSON: `{ts, tool, input}` per line | session-retro |
| `${CLAUDE_PLUGIN_DATA}/session-start-{sid}.txt` | ISO-8601 UTC timestamp | session-retro |
| `${CLAUDE_PROJECT_DIR}/.claude/handoffs/.pending` | basename of handoff file | handoff |
| `${CLAUDE_PROJECT_DIR}/.claude/handoffs/<iso>-<slug>.md` | markdown handoff doc | handoff |

All filenames and content schemas remain identical. Plugin updates mid-session do not break in-flight nudges.

## File layout after port

```
plugins/handoff/
├── .claude-plugin/plugin.json          # version → 0.2.0
├── CLAUDE.md                            # update Deps section: node 18+ instead of jq/bash
├── README.md                            # update install steps; add setup.mjs note
├── hooks/hooks.json                     # command: node <path> for each entry
├── scripts/
│   ├── lib.mjs                          # NEW: shared stdin/env/flag helpers
│   ├── status-and-flag.mjs              # statusLine
│   ├── check-handoff-flag.mjs           # UserPromptSubmit
│   ├── load-pending-handoff.mjs         # SessionStart
│   └── setup.mjs                        # NEW: one-time statusLine wiring helper
├── skills/handoff/SKILL.md              # unchanged
└── tests/
    ├── lib.test.mjs                     # NEW
    ├── status-and-flag.test.mjs
    ├── check-handoff-flag.test.mjs
    ├── load-pending-handoff.test.mjs
    └── integration.test.mjs

plugins/session-retro/
├── .claude-plugin/plugin.json          # version → 0.5.0
├── CLAUDE.md                            # rewrite — current copy still mentions claude-mem
├── README.md                            # update install/dev instructions
├── hooks/hooks.json
├── scripts/
│   ├── lib.mjs                          # NEW
│   ├── mark-session-start.mjs
│   ├── posttooluse-append-event.mjs
│   ├── stop-write-retro-flag.mjs
│   ├── precompact-write-retro-flag.mjs
│   └── check-retro-flag.mjs
├── skills/retro/SKILL.md                # unchanged
└── tests/
    ├── lib.test.mjs                     # NEW
    ├── mark-session-start.test.mjs
    ├── posttooluse-append-event.test.mjs
    ├── stop-write-retro-flag.test.mjs
    ├── precompact-write-retro-flag.test.mjs
    ├── check-retro-flag.test.mjs
    └── integration.test.mjs

# Repo root
.github/workflows/ci.yml                 # add windows-latest; install node not jq
mise.toml                                 # NEW: pin node version (e.g. 20)
.claude-plugin/marketplace.json          # bump plugin version references
```

Bash files under `scripts/` and `tests/` are deleted in the same PR. No coexistence period.

## Code conventions

- **ESM only.** Every file is `.mjs`. No `package.json`, no CommonJS, no `require`.
- **Stdlib only.** Allowed imports: `node:fs`, `node:fs/promises`, `node:path`, `node:os`, `node:process`, `node:child_process`, `node:url`, `node:test`, `node:assert/strict`. No third-party packages.
- **`// @ts-check` at the top of every file.** Use JSDoc `@typedef` for stdin payload shapes (e.g. `StatusInput`, `UserPromptSubmitInput`). Editors get full IntelliSense; no build step.
- **Graceful degradation.** Invalid stdin JSON → `process.exit(0)` silently (or `?` for statusLine). Missing `CLAUDE_PLUGIN_DATA` → fall back to `os.tmpdir() + "/<plugin-name>-data"`. Mirrors v0.1 behavior.
- **Top-level await** for stdin reads. No callback pyramids.
- **Path joins** via `path.join` — never string concatenation. Required for Windows backslash correctness.
- **JSON output** must use `JSON.stringify` and a single trailing newline. The `hookSpecificOutput` envelope (issue #53682) is mandatory for any `additionalContext` emission.

## Shared `lib.mjs` surface

Identical file duplicated in both plugins. Plugins can't share files per CC's install isolation; the duplication is ~80 lines of pure helpers and is cheaper than maintaining a sidecar package.

```js
// @ts-check

/** @returns {Promise<string>} all of stdin as utf8 string */
export async function readStdin() { ... }

/**
 * @param {string} raw
 * @returns {object | null}  parsed JSON or null on any error
 */
export function safeJsonParse(raw) { ... }

/**
 * Resolve session_id from a parsed hook payload, with env fallback.
 * @param {object | null} payload
 * @returns {string}  session id or "unknown"
 */
export function resolveSessionId(payload) { ... }

/**
 * Resolve CLAUDE_PLUGIN_DATA, creating the directory if needed.
 * @param {string} fallbackName  used to compose tmpdir fallback path
 * @returns {string}  absolute path to data dir
 */
export function resolveDataDir(fallbackName) { ... }

/**
 * Emit a hookSpecificOutput envelope to stdout.
 * @param {string} eventName  e.g. "UserPromptSubmit"
 * @param {string} additionalContext
 */
export function emitAdditionalContext(eventName, additionalContext) { ... }

/**
 * ISO-8601 UTC timestamp ("YYYY-MM-DDTHH:MM:SSZ").
 * @returns {string}
 */
export function nowIso() { ... }
```

## Per-script port notes

### handoff/scripts/status-and-flag.mjs

- Read stdin → parse JSON → extract `context_window.used_percentage` (number) and `session_id` (string)
- On any failure: `console.log("?"); process.exit(0)`
- Resolve `${CLAUDE_PLUGIN_DATA}` (fallback `os.tmpdir() + "/handoff-data"`)
- Read `last-context-pct-{sid}.txt`, parse as float, default 0
- Threshold = `parseFloat(process.env.HANDOFF_THRESHOLD_PCT ?? "70")`
- If `current >= threshold && last < threshold`: write `handoff-nudge-{sid}.flag` with body `"context at <pct>% (threshold <thr>%)"`
- Always overwrite `last-context-pct-{sid}.txt` with current
- Render 10-char block bar (filled = `Math.floor(pct/10)` clamped to [0,10], rest empty). ANSI color: green <50, yellow 50–69, red ≥70
- Output: `${COLOR}[${BAR}] ${pctInt}%${RESET}\n`

### handoff/scripts/check-handoff-flag.mjs

- Read stdin → parse → resolve session id
- If `handoff-nudge-{sid}.flag` does not exist: silent exit
- Read flag content (trigger reason), then `fs.unlinkSync` it (consume)
- Emit `additionalContext`: `"[handoff] <reason>. Consider running /handoff to write a resume doc before /compact or /clear, or /compact if you want to keep the session going."`

### handoff/scripts/load-pending-handoff.mjs

- Read stdin → parse → extract `cwd` (fallback `process.cwd()`)
- Path = `<cwd>/.claude/handoffs/.pending`. If missing: silent exit.
- Stat the file: if `mtime` older than 24h, delete and silent exit
- Read content as trimmed string. If empty: delete and silent exit
- Build `<cwd>/.claude/handoffs/<content>`. If missing: delete `.pending` and silent exit
- Read handoff doc content. Delete `.pending`. Emit `additionalContext`: `"[handoff] Loading pending handoff from previous session:\n\n<content>"`

### handoff/scripts/setup.mjs (NEW)

- Resolve own absolute path via `import.meta.url`
- Compute statusLine script path = `<dirname>/status-and-flag.mjs`
- Read `~/.claude/settings.json` (or create `{}` if absent). Parse loosely; abort with friendly error if JSON invalid
- Backup current file to `~/.claude/settings.json.pre-handoff.bak` (skip if no settings.json existed)
- Set `settings.statusLine = { type: "command", command: \`node "${statusLinePath}"\` }`
- Write back with 2-space indent
- Print: what changed, where the backup is, and the next step (restart CC)
- Exit 0

### session-retro/scripts/mark-session-start.mjs

- Read stdin → resolve session id → resolve data dir → ensure dir exists
- Write `nowIso()` to `session-start-{sid}.txt`

### session-retro/scripts/posttooluse-append-event.mjs

- Read stdin → parse. Extract `tool_name`, `tool_input`, `session_id`. If no `tool_name`: silent exit.
- Build `{ ts: nowIso(), tool: tool_name, input: tool_input }`
- `fs.appendFileSync` to `events-{sid}.jsonl` with `JSON.stringify(event) + "\n"`. `appendFileSync` uses `O_APPEND` on POSIX (atomic per PIPE_BUF; one event ≪ 4KB) and is safe enough on Windows for our concurrency (statusLine isn't writing to this file).

### session-retro/scripts/stop-write-retro-flag.mjs

- Read stdin → resolve session id
- If `retro-fired-{sid}.flag` exists: silent exit
- If `events-{sid}.jsonl` missing: silent exit
- Read file, split lines, JSON-parse each (skip blanks/parse errors)
- Aggregate: edits, writes, bash_calls, files_touched (unique edited+written file_paths), first_ts, last_ts, ran_tests (any Bash command matching `/pytest|jest |go test|cargo test|npm test|npm run test|bun test|yarn test/`), ran_commit (any Bash command matching `/git commit/`)
- Duration: parse first_ts/last_ts via `Date.parse` (handles ISO-8601 natively cross-platform — replaces the BSD/GNU `date` branching from v0.1)
- Threshold logic, identical to v0.1:
  - edit_write ≥ 3 AND files_touched ≥ 2 → `"${edit_write} edits across ${files} files"`
  - duration_sec ≥ 1200 → `"${duration_min} minutes of work"`
  - ran_commit → `"committed during session"`
  - ran_tests AND edit_write ≥ 2 AND NOT (edit_write ≥ 3 AND files ≥ 2) → `"ran tests + ${edit_write} edits"`
  - total_tools ≥ 30 → `"${total_tools} tool calls"`
- If no reasons: silent exit
- Join reasons with `" + "`. Write to `retro-nudge-{sid}.flag`

### session-retro/scripts/precompact-write-retro-flag.mjs

- Read stdin → resolve session id → write `"compact imminent"` to `retro-nudge-{sid}.flag`

### session-retro/scripts/check-retro-flag.mjs

- Read stdin → resolve session id
- If `retro-nudge-{sid}.flag` missing: silent exit
- Read content (reasons). Delete flag.
- Emit `additionalContext`: `"[session-retro] This session: <reasons>. Consider running /retro to capture decisions/learnings before /clear."`

## hooks.json wiring

Every entry takes the form:
```json
{
  "type": "command",
  "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/<name>.mjs\"",
  "timeout": 5
}
```

Double-quote `${CLAUDE_PLUGIN_ROOT}` to survive paths with spaces (Windows `Program Files`, macOS user dirs with spaces).

## Tests

- **Runner:** `node --test` (built-in, Node 18+). Assertions via `node:assert/strict`.
- **Style:** ESM, top-level `import`, async `test()` blocks.
- **Pattern:** each test sets `CLAUDE_PLUGIN_DATA` to a unique `os.tmpdir() + "/test-<plugin>-<uuid>"`, runs the script under test as a child process (`child_process.spawn` with stdin piped) when testing the integration shape, or imports the function directly when testing pure logic.
- **Coverage parity:** every test case in the v0.1 `test_*.sh` suite must have a matching `test_*.mjs` case. Names and assertions preserved; the bash test inventory is the test backlog.
- **Cleanup:** every test removes its temp dir in `t.after`.

Run from repo root: `node --test plugins/*/tests/*.test.mjs`.

## CI workflow changes

Edit `.github/workflows/ci.yml`:

- Drop `jq` install steps
- Drop `bats` / shellcheck if present
- Add `actions/setup-node@v4` with `node-version: 20` (matches pinned `mise.toml`)
- Matrix becomes `[ubuntu-latest, macos-latest, windows-latest]` for both `test-handoff` and `test-session-retro` jobs
- Run command becomes `node --test tests/` (working-directory pinned per job)

## Release flow

1. Bump version in `plugins/handoff/.claude-plugin/plugin.json` to `0.2.0`
2. Bump version in `plugins/session-retro/.claude-plugin/plugin.json` to `0.5.0`
3. Bump corresponding `version` fields in `.claude-plugin/marketplace.json`
4. Commit. Open PR. Merge after CI green.
5. `git tag v0.2.0-handoff v0.5.0-session-retro && git push --tags` (tag naming is optional convention; marketplace doesn't read tags)

No build step. No artifacts. No goreleaser.

## Repo-root additions

**`mise.toml`** (NEW):
```toml
[tools]
node = "20"
```

Pinning to LTS 20 (current LTS as of 2026-05). Future bumps when CC's documented minimum changes.

## Migration notes for users

In the v0.2.0 release notes (CHANGELOG entry or PR body):

- Plugin now requires **Node.js 18+** on PATH. The native CC installer does not bring Node — users without it should install via Homebrew / WinGet / their distro's package manager.
- `jq` no longer required.
- StatusLine wiring: run `node "$(echo ~/.claude/plugins/cache/jasonm4130-claude-skills/handoff/0.2.0)/scripts/setup.mjs"` once after install. This patches `~/.claude/settings.json` with an absolute path to the statusLine script (the `${CLAUDE_PLUGIN_ROOT}` variable doesn't substitute in user settings, only in plugin hooks).
- All flag files, event logs, and handoff documents are wire-compatible with v0.1. Mid-session upgrades don't break in-flight nudges.

## Open questions to verify during implementation

1. **`claude plugin path <name>` CLI command** — does it exist? If yes, simpler setup invocation; if no, README documents the cache-path form. Grep the CC docs in the implementation pass.
2. **Settings.json setup helper edge cases** — what if user already has a custom `statusLine`? The setup script should detect this and prompt rather than overwrite. Implementation detail; ship a `--force` flag for "yes overwrite."

Both are inline-fixable during implementation, not blockers.

## Success criteria

- All `node --test plugins/*/tests/*.test.mjs` pass on Ubuntu + macOS + Windows in CI
- Manual end-to-end test on Mac: install plugin fresh, run `setup.mjs`, push a session past 70%, see the bar render, see `[handoff]` `additionalContext` injection on next prompt
- `git diff main..feat/port-hooks-to-mjs --stat` shows: all old `.sh` files deleted, new `.mjs` files added, plugin.json versions bumped, marketplace.json versions bumped, CI workflow updated, `mise.toml` added
- No new dependencies in either plugin (no `package.json`, no `node_modules`)
