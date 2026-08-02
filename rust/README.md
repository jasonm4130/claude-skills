# ccguard — compiled PreToolUse guards

One Rust binary implementing three hooks, committed into the plugins that use it.
A **pilot**, deliberately scoped: `design-gate-guard` and `workflow-model-guard`
only. Every other plugin's hooks remain `.mjs` and are not affected.

```
ccguard design-gate      # design-gate-guard  — PreToolUse, matcher Bash
ccguard agent-model      # workflow-model-guard — PreToolUse, matcher Agent
ccguard workflow-model   # workflow-model-guard — PreToolUse, matcher Workflow
```

## Why compile these three

Measured on an M-series Mac, median of 20 runs, real payloads:

| | node `.mjs` | `ccguard` |
|---|---|---|
| `design-gate` | 36.1ms | **2.9ms** |
| `agent-model` | 35.7ms | **3.1ms** |

A `node -e ""` cold start alone is 24.9ms, so ~78% of what the JS guards cost was
paying for the interpreter, not doing the work. These two plugins were chosen
because they are the *lowest-churn* scripts in the repo (12 commits across 2.5
months) and the *highest fire-rate* hooks — `design-gate` runs on every Bash call,
`agent-model` on every Agent dispatch — and because neither shells out to git.
`docs-sync-guard` was excluded for the opposite reason: git subprocesses dominate
its 61ms, so compiling it would buy a third of what it buys here. `handoff` was
excluded because 25 of the repo's 58 script-touching commits are its, and every
one of those would mean rebuilding and re-committing a binary.

Speed is not the strongest argument, though. **Node is an undeclared prerequisite** —
Claude Code ships a self-contained binary whose documented requirements do not
include it, so on a machine without node every guard silently fails open. The
compiled path has no such dependency. That argument is only fully banked once
nothing shells out to node; see "What this pilot does not do".

## The binary is committed on purpose

There is no build step anywhere in the marketplace install path. Claude Code
`git clone`s this repo into `~/.claude/plugins/marketplaces/…` and copies each
plugin's subtree into `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`.
Nothing compiles. So whatever ships must already be built, which means the binary
lives in git.

Two consequences worth being explicit about:

- **It is committed once per consuming plugin** (`plugins/*/bin/ccguard`), because
  plugins cannot share files — the same constraint that forces six duplicated
  `lib.mjs` copies. At 377KB that is cheap, but it is why binary size, not compile
  ergonomics, drove the language and dependency choices.
- **Delivery via `git clone` means no `com.apple.quarantine` xattr**, so Gatekeeper's
  unidentified-developer path is not involved. The toolchain ad-hoc-signs the
  binary (arm64 macOS requires at least that) and the signature is embedded in the
  Mach-O, so it survives clone intact. Verified with `codesign -dv` and `xattr -l`.

## Staleness is the real hazard, and it is guarded

A build artifact in git means "I edited the source" and "the shipped guard
changed" are separate events. Forget the second and every guard silently runs old
logic while the source says otherwise.

`build.rs` bakes an FNV-1a fingerprint of `src/*.rs` into the binary, readable via
`ccguard --source-fingerprint`. Comparing *bytes* would not work — Rust builds are
not bit-reproducible across toolchains or build paths — but comparing fingerprints
does. Checked in two places: `scripts/ccguard-differential.test.mjs` recomputes it
locally, and the `rust-guards` CI job builds fresh and compares.

## Rebuilding

```bash
cargo build --release --manifest-path rust/Cargo.toml
TARGET=$(cargo metadata --format-version 1 --no-deps --manifest-path rust/Cargo.toml \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).target_directory))')
for p in design-gate-guard workflow-model-guard; do
  cp "$TARGET/release/ccguard" "plugins/$p/bin/ccguard"
  chmod +x "plugins/$p/bin/ccguard"
done
```

Then bump both plugins (`node scripts/bump-plugin.mjs <plugin> patch`) — `bin/` is
shipped payload, so the version-bump gate requires it.

## Equivalence with the `.mjs` guards

The `.mjs` guards are **kept, not deleted**. They are the fallback when the binary
cannot run, and they are the reference implementation the binary is tested against.

`hooks.json` runs `"${CLAUDE_PLUGIN_ROOT}/bin/ccguard" <sub> || node "…/scripts/….mjs"`.
The binary exits non-zero only when it fails to execute at all (127 missing, 126
wrong architecture), so on Linux or an Intel Mac the node path takes over and the
guard still works. Still shell form — the shell is what evaluates the `||` — so
every argument in `scripts/hook-runtime-guard.test.mjs` continues to apply.

`scripts/ccguard-differential.test.mjs` runs both implementations over the same
inputs and compares stdout byte-for-byte plus exit status: every case the existing
JS suites assert on, every malformed-payload shape, and 400 seeded-fuzz shell
commands built from quotes, escapes, heredocs, separators, comments and non-ASCII.
This matters because the port is not a line-by-line translation — the tokenizer
iterates `char`s where the JS iterates UTF-16 code units, output JSON is assembled
by hand to pin key order, and two negative lookaheads had to go because no Rust
regex engine has lookaround:

- `^npm\s+init\s+(?!-)[@\w]` → `^npm\s+init\s+[@\w]`. The lookahead was redundant;
  `[@\w]` cannot match `-` anyway. Identical language.
- `^dotnet\s+new\s+(?!-)` → `^dotnet\s+new\s+[^-]`. Load-bearing (it separates
  `dotnet new console` from `dotnet new --list`). The rewrite consumes the
  character the lookahead only peeked at, so the two differ solely on a head
  ending in whitespace — which cannot occur, since heads are built by joining
  tokens with single spaces. Asserted in `dotnet_trailing_whitespace_is_unreachable`.

## Dependencies

`serde_json` for parsing stdin, and `regex-lite` — **not** `regex`, whose Unicode
tables and DFA would add ~1.5MB to a binary that gets committed. Neither crate
supports lookaround. Output JSON is emitted by hand, so nothing depends on
serializer key ordering.

## What this pilot does not do

- **Does not remove node as a prerequisite.** Thirteen other hooks and every
  session-invoked CLI still run `.mjs`. Until none do, the undeclared-prerequisite
  argument stays unbanked.
- **Does not target Intel Macs or Linux.** The committed binary is
  `aarch64-apple-darwin`. Elsewhere the `||` fallback runs node, so nothing breaks
  — it is just not faster. A universal binary would double the committed size;
  worth revisiting only if someone actually needs it.
- **Does not touch `sdd.mjs` or `fanout.mjs`.** Those run inside Claude Code's
  embedded JS sandbox against an injected `agent()` global. They can never be
  compiled without Claude Code itself growing a second runtime.

## Tests

```bash
cargo test --release --manifest-path rust/Cargo.toml   # 16 unit tests
node --test scripts/ccguard-differential.test.mjs      # equivalence vs the .mjs
```

Both run in CI under the `rust-guards` job, on `macos-latest` because that is the
only runner where the arm64 binary executes rather than skipping.
