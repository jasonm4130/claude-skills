# ccguard — compiled hook guards

One Go binary implementing five of this repo's hook guards, committed into the
plugins that consume them.

```
ccguard <subcommand> [fallback.mjs]

ccguard design-gate        # gates — PreToolUse, matcher Bash
ccguard agent-model        # gates — PreToolUse, matcher Agent
ccguard workflow-model     # gates — PreToolUse, matcher Workflow
ccguard lsp-first          # gates — PreToolUse, matcher Grep
ccguard json-config-guard  # gates — PostToolUse, matcher Edit|Write|MultiEdit|Bash
```

The optional second argument is the `.mjs` guard to hand a payload to when the
binary cannot decide it itself — see [Equivalence](#equivalence-with-the-mjs-guards).

## Why compile these

A hook is spawned per matching tool call, so what costs is process start, not the
work. Measured on an M-series Mac, median of 20 runs, real payloads: `design-gate`
36.1 ms under node against 2.9 ms compiled; `agent-model` 35.7 ms against 3.1 ms. A
bare `node -e ""` cold start alone is 24.9 ms, so ~78% of what the JS guards cost
was paying for the interpreter rather than doing the work.

**Node is also an undeclared prerequisite** — Claude Code ships a self-contained
binary whose documented requirements do not include node, so a guard that needs it
is a guard that can silently not run.

## The binary is committed on purpose

The marketplace install path is `git clone` + copy, with no build step anywhere in
it. A plugin that needed compiling at install time would simply not work, so the
artifact lives in git.

It is a **macOS universal binary** (`arm64` + `x86_64`, via `lipo`). Shipping arm64
only would mean every Intel-Mac installer silently fell through to the `|| node`
fallback and paid full interpreter start per tool call, with nothing anywhere
reporting it. `ccguard-differential.test.mjs` asserts both architectures are
present. Linux is not shipped and falls back to node.

## Staleness is guarded by comparing the artifact

The binary being a build artifact in git means "I edited the source" and "the
shipped guard changed" are two different events, and nothing about the committed
bytes reveals a gap between them.

Go builds with `-trimpath` are bit-reproducible, so CI rebuilds and compares the
real artifact. Its Rust predecessor could not do this — Rust builds are not
reproducible across toolchain versions or build paths, so it compared an FNV-1a
source fingerprint baked in by `build.rs`. Comparing the artifact is strictly
stronger: it catches a stale binary *and* one built from something other than this
source, and it deletes the whole fingerprint apparatus.

## Rebuilding

```sh
cd go
GOOS=darwin GOARCH=arm64 go build -ldflags="-s -w" -trimpath -o /tmp/cc-arm64 .
GOOS=darwin GOARCH=amd64 go build -ldflags="-s -w" -trimpath -o /tmp/cc-amd64 .
lipo -create -output ../plugins/gates/bin/ccguard /tmp/cc-arm64 /tmp/cc-amd64
```

## Equivalence with the `.mjs` guards

The `.mjs` guards are **kept, not deleted**. They are the fallback when the binary
cannot run, and the reference implementation the binary is tested against.

`hooks.json` runs
`"${CLAUDE_PLUGIN_ROOT}/bin/ccguard" <sub> "…/scripts/….mjs" || node "…/scripts/….mjs"`.
The `.mjs` path appears twice because there are two different failures to cover.

The `||` covers a binary that never executes (127 missing, 126 wrong
architecture). Stdin is untouched, so node reads the payload and the guard works
normally — this is what keeps the plugin working on Linux.

The **argv** covers a binary that ran fine but hit a payload it cannot represent:
a JSON string carrying a lone surrogate, which `JSON.parse` accepts. The `||`
cannot help — by the time the binary knows, it has drained stdin, and a shell
cannot rewind a pipe, so the node on the right-hand side reads zero bytes and
decides nothing. So the binary delegates itself: it spawns node on the payload it
is holding and forwards the answer. If node is missing too, it fails open.

Go makes this hazard quieter than Rust did, which is why it is detected up front
rather than relied on to error. `serde_json` *rejects* a lone-surrogate escape;
Go's `encoding/json` silently substitutes U+FFFD, which would make the binary
answer a different question than node on the same bytes without failing.
`hasLoneSurrogateEscape` (`hook.go`) spots it before decoding and declines to node.

The net contract: **there is no payload on which the guard is allowed to differ
from the `.mjs` reference.** Delegation is an implementation detail of holding that
line, not a licensed divergence.

### Where the port is not a literal translation

`scripts/ccguard-differential.test.mjs` runs both implementations over the same
inputs and compares stdout byte-for-byte plus exit status — every case the JS
suites assert on, every malformed-payload shape, and 400 seeded-fuzz shell commands.
That matters because three things had to be rewritten rather than transcribed:

- **No lookaround.** RE2 has none, same constraint as `regex-lite`.
  `^npm\s+init\s+(?!-)[@\w]` → `^npm\s+init\s+[@\w]` (redundant; `[@\w]` cannot
  match `-`). `^dotnet\s+new\s+(?!-)` → `^dotnet\s+new\s+[^-]` (load-bearing — it
  separates `dotnet new console` from `dotnet new --list`); the rewrite consumes
  the character the lookahead only peeked at, so the two differ solely on a head
  ending in whitespace, which cannot occur since heads are built by joining tokens
  with single spaces.

- **`\s` is ASCII-only in Go, exactly as in `regex-lite`.** Go's `\s` is the Perl
  class `[\t\n\f\r ]`; JS `\s` also matches U+00A0, U+FEFF and the Unicode space
  separators. The hand-spelled JS whitespace set (`jsregex.go`) is therefore still
  required — this is the bug that once let fan-out scripts through when `agent (`
  carried a U+00A0, and moving to Go does **not** fix it.

- **`(?i)` folds over Unicode in Go, and this is a hazard Rust did not have.**
  `regex-lite`'s case-insensitivity is ASCII-only; Go's is not, so `(?i)k` matches
  U+212A KELVIN SIGN and `(?i)s` matches U+017F LATIN SMALL LETTER LONG S — neither
  of which a JS regex without the `u` flag matches. Left alone, `Kargo new x` would
  gate in Go and not in node. `(?i)` is replaced throughout by a per-letter `[aA]`
  expansion (`asciiFold` in `jsregex.go`), pinned by
  `TestASCIIFoldDoesNotMatchUnicodeCaseEquivalents`.

`\w` and `\b` are left as-is: ASCII in both engines, matching JS.

## Dependencies

None. `encoding/json` for parsing stdin and `regexp` for matching, both stdlib.
Output JSON is assembled by hand rather than marshalled, to pin key order
byte-for-byte against the `.mjs` implementations.

## Tests

```sh
cd go && go vet ./... && go test ./...        # unit tests and port invariants
node --test scripts/ccguard-differential.test.mjs   # the acceptance gate
```

The differential test is the one that matters. The unit tests check invariants the
differential corpus cannot reach — notably the plugin-agent lookup in
`agent-model`, which no corpus case exercises because no scoped `subagent_type`
appears in the inputs.
