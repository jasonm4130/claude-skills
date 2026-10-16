# gates-signing

A `PostToolUseFailure` nudge for a `git commit` or SSH push that failed because the
1Password SSH agent is locked or unreachable.

| Gate | Fires on | Decision | Ack marker |
|---|---|---|---|
| **signing-nudge** | a Bash failure caused by a locked 1Password SSH agent (git signing, SSH push) | adds context telling Claude to ask you to unlock instead of retrying | none needed |

Left alone, Claude retries the command, re-signs, or starts changing git and SSH
config. None of that helps: the fix is always a human unlocking 1Password. The nudge
says so once, and never blocks.

It matches the error text 1Password's SSH agent and git signing produce
(`sign_and_send_pubkey: signing failed`, `1Password: Could not connect to socket`,
`agent refused operation`, and similar). Without 1Password it never fires.

Part of the `gates` bundle. It installs on its own: nothing here needs another
gates unit.

## Install

```
/plugin install gates-signing@jasonm4130-claude-skills
```

Or install `gates@jasonm4130-claude-skills`, the bundle, to take every gates unit.

## Turning it off

Add `signing-nudge` to `GATES_DISABLE` in the `env` block of a `settings.json`. The
full table is in the `gates` bundle's README.

## How it works

```
gates-signing/
├── .claude-plugin/plugin.json
├── hooks/hooks.json                            — PostToolUseFailure (Bash)
├── scripts/
│   ├── lib.mjs                                 — hook I/O
│   └── posttoolusefailure-signing-nudge.mjs    — the nudge
└── tests/
```

## Dependencies

- **Node.js 18+ on PATH.** Without it the hook cannot run and the nudge does not fire.
- **Claude Code >= 2.1.110** — for `hooks.json` plugin hook registration.

## Development

```bash
node --test plugins/gates-signing/tests/*.test.mjs
```
