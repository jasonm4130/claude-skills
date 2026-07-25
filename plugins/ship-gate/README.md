# ship-gate

Claude Code plugin that catches trail-off: sessions that commit work and then
end without pushing or opening a PR.

## Why

An audit of session history found that 28% of sessions commit work then trail
off unpushed — the commit exists, but nothing tells the agent (or the user)
that the branch is unfinished business. ship-gate closes that gap with a
`Stop` hook that detects unshipped commits at turn end and an
`UserPromptSubmit` hook that surfaces the nudge in the agent's own voice on
the next prompt.

## Trigger conditions

The `Stop` hook checks the current branch against its upstream:

- **Commits ahead of upstream** — `git rev-list --count @{upstream}..HEAD` > 0.
- **Non-`main`/`master` branch with no upstream at all** — nothing has ever
  been pushed.

Working-tree dirtiness is **deliberately not** a trigger — uncommitted changes
mid-feature are normal and noisy; unpushed *commits* are the actual trail-off
signal.

## Throttle semantics

The nudge fires once per HEAD SHA per session: a flag is written keyed to the
session ID, and a companion `shipgate-last-sha-{sid}.txt` records the SHA the
nudge was last armed for. If HEAD hasn't moved since the last nudge, the hook
stays silent. Any new commit re-arms it.

## Hooks

| Hook | Script | What it does |
|---|---|---|
| `Stop` | `stop-check-unshipped.mjs` | Checks the branch/upstream state; writes `shipgate-nudge-{sid}.flag` if unshipped work is detected and HEAD has changed since the last nudge |
| `UserPromptSubmit` | `check-shipgate-flag.mjs` | Consumes the flag (fire-once) and injects `additionalContext` directing the agent to run `/code-review` and finish the branch (push + PR), or explain to the user what's unshipped |

Both hooks are stdlib-only Node `.mjs` scripts sharing `scripts/lib.mjs`
(`readStdin`, `safeJsonParse`, `resolveSessionId`, `resolveDataDir`,
`emitAdditionalContext`).

## Data dir

Flag files live under `resolveDataDir("ship-gate-data")` — `CLAUDE_PLUGIN_DATA`
if set, otherwise `os.tmpdir()/ship-gate-data`. Flags are plain text, not JSON.

## Install

```
/plugin marketplace add jasonm4130/claude-skills
/plugin install ship-gate@jasonm4130-claude-skills
/reload-plugins
```

## Requirements

- Claude Code ≥ 2.1.110
- **Node.js 18+ on PATH.** Claude Code ships a self-contained native binary and its documented system requirements do not include Node, so this is an external prerequisite, not something the host provides. If `node` is missing the hook **skips silently** (exit 0) instead of erroring on every event; the reason goes to stderr, visible under `claude --debug`.
- git (silent no-op outside a git repo)

## Tests

```
node --test plugins/ship-gate/tests/
```

## License

MIT
