# handoff — Claude Code Plugin

## What this is

A Claude Code plugin that watches context fill via a `statusLine` command and
triggers a handoff suggestion at a configurable threshold, re-firing on every
10%-point band crossed at or above it (70 → 80 → 90; since 0.4.0) with
severity-tiered, agent-directed wording. Since 0.6.0 each band-nudge is
idempotent under concurrency via an atomic claim marker. When triggered, the `/handoff` skill
(agent-authored) writes a structured resume document to
`$PROJECT_ROOT/.claude/handoffs/`. The next session's `SessionStart` hook
auto-loads the document via `additionalContext` injection.

Since 0.8.0 the statusLine reads context from the transcript first (stable, once-per-turn)
instead of the volatile per-request stdin frame — the fix for a bar that filled and emptied
erratically mid-turn — and composes an adaptive line from up to four segments (identity/
branch/dirty, context bar, model, rate-limits), calm by default and best-effort width-fit to
the terminal.

`setup.mjs` wires `statusLine` into `~/.claude/settings.json` and (since 0.3.0)
writes a stable wrapper at `~/.claude/handoff-statusline.mjs` that resolves the
plugin version at run time, so plugin upgrades no longer break the statusLine.
Its contract: **the highest cached version that is not marked `.orphaned_at`.**
Resolution stays dynamic because `settings.json` points at the wrapper by
absolute path, but cache presence is not activation state — superseded and
rolled-back versions stay on disk, so an unfiltered max would silently undo a
rollback. All versions orphaned (i.e. uninstalled) renders `?`.

Since 0.9.1 the wrapper runs the resolved script **in-process** (`await import()`)
rather than spawning a child. Spawning cost a second Node cold start on every
render — measured 74.2ms → 40.1ms for byte-identical output, on the most frequently
invoked script in the plugin, with Node startup ~30ms of the total. The resolved
script reads stdin and writes stdout itself, so this is behaviourally equivalent to
the old `stdio: "inherit"`; the import is awaited inside a `try/catch` that still
renders `?`, preserving the old `child.on("error")` fallback, and the path is
converted with `pathToFileURL` because a bare absolute path is not a valid import
specifier on Windows.

## Plugin structure

```
handoff/
├── .claude-plugin/
│   └── plugin.json           — name, version, author, engines
├── hooks/
│   └── hooks.json            — UserPromptSubmit + SessionStart (exec form: spawns node with no shell)
├── scripts/
│   ├── lib.mjs               — shared stdin/env/flag helpers; the atomic band-claim (claimBand/resetBands), in-flight lock (acquireInflightLock), and cached transcript parse (cachedTranscriptUsage) primitives (since 0.6.0); and (since 0.8.0) the adaptive-render helpers: pickContextTokens (transcript-primary source selection), shouldResetBands (decrease-based band reset), gitBranchDirty (spawnSync branch/dirty, degrades to null), modelColor/selectRateLimits/tokensSuffix (segment formatters), and visibleWidth/truncateEnd/assembleStatusLine (ANSI-aware width fitting + line assembly)
│   ├── status-and-flag.mjs   — statusLine: renders the adaptive line (identity/branch/dirty, context bar, model, rate-limits — since 0.8.0, via lib.mjs's assembleStatusLine) and writes the nudge flag at threshold; nudges are idempotent per band (since 0.6.0, via an atomic claim marker, not a lock) and the ladder also resets on a real decrease in context, not just dropping below threshold (since 0.8.0); overlap guard replays the last render when another invocation is in flight — a performance guard, not a mutex, with no statusLine-timeout assumption
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
  Stdlib only. Claude Code ships a self-contained native binary and its documented system requirements do **not** include Node, so this is an external prerequisite the host does not provide — install it via Homebrew, WinGet, or your distro's package manager. Hooks use **exec form** (`command: "node"`, `args: [...]`), so Claude Code spawns node directly with no shell on any platform; without a shell there is no sh-vs-PowerShell dialect to get wrong. On a machine with no node the spawn fails and Claude Code shows a non-blocking `hook error` per event — loud and self-diagnosing by design.
- **Claude Code >= 2.1.110** — required for `hooks.json` plugin hook registration.

## Development

Test scripts:
```bash
# Run all tests
bash scripts/run-node-tests.sh

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
- No external services. Transcript JSONL parsing is permitted as a fallback for
  context-bar derivation (`lib.mjs: lastAssistantUsageFromTranscript`, cached via
  `cachedTranscriptUsage` on the transcript's path + mtime + size since 0.6.0) —
  stdlib only, no network.
- **Nudge concurrency (since 0.6.0):** correctness rests on `claimBand()` — an atomic
  exclusive-create marker per band, not a lock — so a band fires at most once no matter
  how many statusline invocations race. The in-flight overlap guard (`acquireInflightLock`)
  is a separate, explicitly best-effort **performance** guard (don't pile up; replay the
  cached render); it is never a mutex, never breaks a lock on age alone, and statusLine has
  no documented invocation timeout to lean on.
- **Adaptive render (since 0.8.0):** context is read transcript-primary
  (`pickContextTokens`) — the transcript's cached token sum when positive, else stdin's
  `current_usage`, else the render bails to `?`. Git branch/dirty is a `spawnSync`
  shell-out (`gitBranchDirty`, `GIT_TIMEOUT_MS`) that returns `null` on any failure (non-git
  dir, missing git, timeout), and the caller omits the whole git segment rather than let it
  take the bar down. Every segment — identity, model, rate-limits, dirty — degrades by
  omission, never by rendering an empty/dangling separator. Width fitting is best-effort:
  `COLUMNS` is only populated from Claude Code 2.1.153+, so an unset value falls back to a
  120-column budget; `assembleStatusLine` then drops rate-limits, then dirty, then shortens
  the model name, then clamps identity/branch — the context bar and `%` are never dropped.
