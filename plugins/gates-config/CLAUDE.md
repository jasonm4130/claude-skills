# gates-config — Claude Code Plugin

## What this is

One `PostToolUse` guard, and the home of the `ccguard` Go source. Part of the `gates`
bundle; the bundle's CLAUDE.md has the split rationale and the `GATES_DISABLE` design.

- **json-config-guard** (`PostToolUse`, matcher `Edit|Write|MultiEdit|Bash`) — re-parses
  `settings.json` / `settings.local.json` / `.mcp.json` after a write and **exits 2 with
  the parse error on stderr**. PostToolUse runs after the write, so it cannot deny; the
  point is that Claude Code silently drops config it cannot parse, so a stray comma
  disables every hook here with nothing to trace it back to. Matched by **basename**, so
  it covers a project's `.claude/settings.json` too. `Bash` is in the matcher because a
  `sed -i`, heredoc redirect or `tee` rewrites a config without the write tools ever
  being involved. Adopted from jasonm4130/dotfiles, where it was machine-level; it guards
  by basename rather than by absolute path, which is what makes it distributable.

## The compiled guard

`json-config-guard` is Go only. The hook runs `"${CLAUDE_PLUGIN_ROOT}/bin/ccguard"
json-config-guard` with no `||` clause, so on Linux and Windows it simply does not run.
A `|| node …` fallback would be wrong here, not just missing: the guard signals by
exiting 2, so the shell would run node after every genuine finding, on drained stdin,
and report success. `scripts/posttooluse-guard-json-config.mjs` is the reference
implementation; its tests and `GATES_DISABLE` case run in `tests/`.

**`go/` builds one binary for two plugins.** The same `ccguard` also carries the
`agent-model` and `workflow-model` subcommands that the `gates-models` plugin runs. A
plugin cannot reach another plugin's install directory, so both ship a copy of
`bin/ccguard`. `go/build.sh` with no argument writes this plugin's copy and then
`../gates-models/bin/ccguard`; the copies are the same bytes, so git stores them once.
CI's `go-guards` job rebuilds and compares both, and `scripts/gates-units.test.mjs`
fails when they differ. A rebuild that changes the bytes therefore bumps both plugins'
versions.

The source sits here rather than in `gates-models` because this guard has no `.mjs`
fallback: the binary is all a `gates-config` user runs, so its source should ship
beside it.

`go/build.sh` is the one definition of the build flags. CI and the staleness test in
`scripts/ccguard-differential.test.mjs` both call it, so a flag change cannot leave the
committed binary disagreeing with what the checks rebuild. Rebuild with `go/build.sh`,
never by retyping the flags. It also pins `GOTOOLCHAIN` to go.mod's exact
`toolchain` line, because that line alone lets a newer local Go do the build.

`bin/ccguard` is the one exception to "no build artifacts": the marketplace install
path is `git clone` + copy with no build step anywhere, so a compiled hook has to ship
pre-built. Source lives in `go/`; see `go/README.md` for the rebuild command and
the staleness fingerprint.

## Conventions

- **ESM only, stdlib only, `// @ts-check`** for the `.mjs` side, as in every plugin here.
- **Go: stdlib only.** `encoding/json` and `regexp`; output JSON is assembled by hand to
  pin key order byte-for-byte against the `.mjs` implementations.
- **Own `lib.mjs`.** It carries only `isGuardDisabled`, which
  `scripts/lib-drift.test.mjs` keeps byte-identical with every other plugin's copy.

## Development

```bash
plugins/gates-config/go/build.sh                         # rebuild both committed copies
(cd plugins/gates-config/go && go vet ./... && go test ./...)
node --test plugins/gates-config/tests/*.test.mjs
node --test scripts/ccguard-differential.test.mjs        # binary vs .mjs equivalence
```

After editing `go/`, rebuild — the differential test rebuilds and compares bytes, so a
stale binary cannot ship.
