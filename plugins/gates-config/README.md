# gates-config

A `PostToolUse` guard that re-parses Claude Code's JSON config after a write and
reports a syntax error at once.

| Gate | Fires on | Decision | Ack marker |
|---|---|---|---|
| **json-config-guard** | a write that leaves `settings.json` / `settings.local.json` / `.mcp.json` unparseable | reports after the fact (exit 2) | fix the syntax |

Claude Code does not error on a malformed `settings.json`: it drops the block it
cannot parse and carries on. A stray comma in the `hooks` object silently disables
every hook, and the failure surfaces a session later as "the hook stopped firing",
with nothing to trace it back to. The edit that caused it is the cheapest place to
catch it.

PostToolUse runs after the write, so the guard cannot deny. It exits 2 with the parse
error on stderr, which Claude Code feeds back to Claude as something to fix now. Files
are matched by **basename**, so a project's `.claude/settings.json` is covered too.
`Bash` is in the matcher because a `sed -i`, a heredoc redirect or a `tee` rewrites a
config without the write tools ever being involved.

Part of the `gates` bundle. It installs on its own: nothing here needs another
gates unit.

## Install

```
/plugin install gates-config@jasonm4130-claude-skills
```

Or install `gates@jasonm4130-claude-skills`, the bundle, to take every gates unit.

---

## Turning it off

Add `json-config-guard` to `GATES_DISABLE` in the `env` block of a `settings.json`.
Every gates unit reads the same variable, so one list covers them all; the full table
is in the `gates` bundle's README.

```jsonc
// ~/.claude/settings.json — every session
// <repo>/.claude/settings.json — this project only
{
  "env": { "GATES_DISABLE": "json-config-guard" }
}
```

Matching is exact, and an unrecognised name is ignored in silence.

---

## How it works

```
gates-config/
├── .claude-plugin/plugin.json
├── bin/ccguard                                 — committed Go binary, universal
├── go/                                         — its source, and build.sh
├── hooks/hooks.json                            — PostToolUse (Edit|Write|MultiEdit|Bash)
├── scripts/
│   ├── lib.mjs                                 — GATES_DISABLE parsing
│   └── posttooluse-guard-json-config.mjs       — reference implementation
└── tests/
```

The hook runs `bin/ccguard json-config-guard` and nothing else. The guard signals by
exiting 2, so a shell `|| node …` fallback would swallow every finding, and there is
none. `go/README.md` covers the binary: why it is compiled, why it is committed, and
how CI proves it was built from this source.

The Go source also builds the `gates-models` plugin's two model guards. Both plugins
ship the same `bin/ccguard`, because a plugin cannot reach another plugin's install
directory; `go/build.sh` writes both copies.

## Dependencies

- **macOS.** The guard is the committed universal binary (arm64 and x86_64) and nothing
  else. On Linux and Windows it does not run.
- **Claude Code >= 2.1.110** — for `hooks.json` plugin hook registration.

## Development

```bash
plugins/gates-config/go/build.sh                         # rebuild both committed copies
(cd plugins/gates-config/go && go vet ./... && go test ./...)
node --test plugins/gates-config/tests/*.test.mjs
node --test scripts/ccguard-differential.test.mjs        # binary vs .mjs equivalence
```
