# gates-signing — Claude Code Plugin

## What this is

One never-blocking `PostToolUseFailure` hook. Part of the `gates` bundle; the bundle's
CLAUDE.md has the split rationale and the `GATES_DISABLE` design.

- **signing-nudge** (`PostToolUseFailure`, matcher `Bash`) — when the error text is a
  locked or unreachable 1Password SSH agent, adds `additionalContext` telling Claude to
  ask the user to unlock rather than retry or touch git/SSH config. Never blocks.

The session-retro corpus (2026-08-22..09-25) held about 51 of these failures, recurring
across sessions; the fix is always a human unlocking 1Password.

## Design

- **Adds context only.** It never blocks and never exits non-zero. A failed command has
  already failed; the point is to stop the retry loop, not to gate anything.
- **"Ask the user", not a name.** It shipped asking for the maintainer by name, which
  only made sense on one machine. A stranger who installs it must get a nudge that is
  true for them.
- **Matched on error text.** `LOCKED_RE` holds the strings 1Password's SSH agent and git
  signing produce. A new 1Password error wording means a new alternative there and a new
  case in the test.

## Conventions

- **ESM only, stdlib only, `// @ts-check`**, as in every plugin here.
- **Graceful degradation.** A payload that does not parse, another tool, or an
  unrelated error exits 0 with no output.
- **Own `lib.mjs`.** Its hook-I/O helpers duplicate the other plugins' copies, and
  `scripts/lib-drift.test.mjs` keeps every copy byte-identical.

## Development

```bash
node --test plugins/gates-signing/tests/*.test.mjs
```
