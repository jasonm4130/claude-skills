# Hook latency benchmark — every hook entrypoint (2026-08-26)

Measured after the plugin consolidation, to decide whether any hook still on `.mjs`
earns a compiled port. **Outcome: nothing was ported.** No hook meets both halves of
the porting bar — the two hooks over 40ms are neither on a hot path nor
CPU-bound, and every hot-path hook lands between 20ms and 36ms.

## Method

`hyperfine 1.20.0`, 3 warmup runs, 30 timed runs per case, one representative stdin
payload per hook:

```bash
hyperfine --warmup 3 --runs 30 \
  --command-name gates/design-gate \
  "node '<repo>/plugins/gates/scripts/pretooluse-guard-design-gate.mjs' < payloads/bash-plain.json"
```

Payloads are the real hook envelopes (`hook_event_name`, `session_id`, `cwd`,
`tool_name`, `tool_input`) with `cwd` pointing at this repo, so the git-touching
hooks do real work against a real worktree rather than failing open on a missing
repo. `CLAUDE_PLUGIN_DATA` and `CLAUDE_HOME_OVERRIDE` were redirected to a scratch
directory so the benchmark's writes did not touch live plugin data. Every case was
run once by hand first and its exit status and stdout checked, so no row is timing
a script that silently no-ops on a payload it did not understand.

Two hooks are measured on two payloads because their cost depends on which branch
the payload takes: `docs-sync` shells out to git only for a `git commit` command,
and `append-event` clips a large `tool_input` only for a big one.

**Environment:** Apple M5 Max, macOS 26.5.1, node v24.19.0. Absolute numbers are
machine-specific — an earlier round on a different M-series Mac (recorded in
`rust/README.md`) put node startup at 24.9ms against 16.1ms here. Ratios and the
ranking are what carry over.

## Results

Median of 30 runs, milliseconds. "Hot path" means PreToolUse or PostToolUse with a
matcher covering tools Claude uses constantly (Bash, Edit, Write, Agent).

| Hook | Event (matcher) | Hot path | Median | Min | σ |
|---|---|---|---|---|---|
| gates/stop-check-consolidation-drift | Stop | no | **67.8** | 66.3 | 1.4 |
| ship-gate/stop-check-unshipped | Stop | no | **45.1** | 43.4 | 0.9 |
| gates/pretooluse-guard-docs-sync (`git commit`) | PreToolUse (Bash) | yes | 35.7 | 34.6 | 1.1 |
| gates/check-consolidation-flag | UserPromptSubmit | no | 34.7 | 33.4 | 1.0 |
| gates/pretooluse-guard-docs-sync (other command) | PreToolUse (Bash) | yes | 22.1 | 21.1 | 0.6 |
| gates/pretooluse-guard-agent-model | PreToolUse (Agent) | yes | 22.1 | 21.1 | 0.6 |
| gates/pretooluse-guard-design-gate | PreToolUse (Bash) | yes | 21.8 | 20.8 | 0.7 |
| gates/pretooluse-guard-workflow-model | PreToolUse (Workflow) | no | 21.6 | 20.7 | 0.7 |
| domain-modeling/check-context-md-flag | UserPromptSubmit | no | 21.3 | 20.1 | 0.8 |
| domain-modeling/stop-check-context-md | Stop | no | 21.3 | 20.5 | 0.8 |
| domain-modeling/posttooluse-mark-source-edit | PostToolUse (Edit\|Write\|…) | yes | 21.1 | 20.4 | 0.7 |
| session-retro/posttooluse-append-event (Bash) | PostToolUse (Edit\|Write\|Bash) | yes | 20.7 | 19.2 | 0.8 |
| session-retro/posttooluse-append-event (Edit) | PostToolUse (Edit\|Write\|Bash) | yes | 20.1 | 19.4 | 0.6 |
| session-retro/stop-write-retro-flag | Stop | no | 20.0 | 18.5 | 0.8 |
| handoff/load-pending-handoff | SessionStart | no | 20.0 | 19.3 | 0.6 |
| session-retro/mark-session-start | SessionStart | no | 19.9 | 18.9 | 0.6 |
| session-retro/precompact-write-retro-flag | PreCompact | no | 19.4 | 18.7 | 0.7 |
| session-retro/check-retro-flag | UserPromptSubmit | no | 19.4 | 18.4 | 0.8 |
| ship-gate/check-shipgate-flag | UserPromptSubmit | no | 19.4 | 18.2 | 0.8 |

The three `pretooluse-guard-*` rows measure the **node fallback path only**. Those
hooks already ship compiled: `hooks.json` invokes `bin/ccguard <subcommand>` first
and falls back to the `.mjs` script if the binary can't run, so on the committed
arm64 binary their real hot-path cost is the ~1.7ms in the reference table below,
not the ~22ms above. They are counted here for the fallback's sake, not as porting
candidates — they are already ported.

Reference points measured the same way:

| | Median |
|---|---|
| `node -e ''` (interpreter start, no script) | 16.1 |
| `ccguard design-gate` (committed Rust binary) | 1.7 |
| `ccguard agent-model` | 1.7 |
| `ccguard workflow-model` | 1.6 |
| `git -C <repo> diff --cached --name-only` | 6.0 |
| `git -C <repo> log --oneline -20` | 6.4 |

## What the numbers say

**Node startup is 16.1ms of every row.** The cheapest hook in the table costs 19.4ms,
so the script itself accounts for ~3ms. There is no hook whose *own logic* is slow;
the interpreter is the floor, and a port buys the floor, not the work.

**The two hooks over 40ms are git-bound, not CPU-bound.** `stop-check-consolidation-drift`
(67.8ms) and `stop-check-unshipped` (45.1ms) each spawn several `git` subprocesses,
and a single `git diff --cached` alone costs 6.0ms. Subtracting node's 16.1ms leaves
~50ms and ~29ms that a compiled implementation would still have to spend waiting on
the same subprocesses. Both also fire once per turn end, not per tool call.

**The hot-path hooks all sit at 20–22ms**, except `docs-sync` on an actual `git commit`
(35.7ms, five git calls). Every one is under the 40ms bar, and `docs-sync` is the same
git-bound shape as the Stop hooks — the branch that costs 35.7ms is the one that runs
git, and the branch that runs on every other Bash command costs 22.1ms.

## Porting decision: nothing ported

The bar was (a) PreToolUse/PostToolUse on a common tool **and** (b) above ~40ms. The
intersection is empty:

| Over 40ms | Hot path | Hooks |
|---|---|---|
| yes | no | `stop-check-consolidation-drift`, `stop-check-unshipped` |
| no | yes | `docs-sync`, `design-gate`, `agent-model`, `mark-source-edit`, `append-event` |
| yes | yes | — none — |

The nearest miss, `docs-sync` at 35.7ms, would recover at most the 16.1ms of node
startup and would keep its git cost — and it is the highest-churn guard in `gates`,
so every future edit would mean rebuilding and re-committing a binary. That trade was
already declined once when the three PreToolUse guards were compiled (see
`rust/README.md`, "Why compile these three"); nothing here changes it.

## A correction to the task's premise

The task brief assumed `ccguard` might be Go and said to add a Go binary otherwise.
`ccguard` is **Rust** — `rust/Cargo.toml`, `rust/src/*.rs`, built to
`plugins/gates/bin/ccguard` (`Mach-O 64-bit executable arm64`). So even if a hook had
crossed the bar, the correct move would have been a fourth subcommand on the existing
Rust binary, not a second toolchain and a second committed binary. No Go was added.

## Reproducing

The payload fixtures and the case list live outside the repo (they were scratch). To
rebuild them, one JSON file per row above with the fields named under **Method**, then
loop the `hyperfine` invocation shown there over each `(script, payload)` pair with
`CLAUDE_PLUGIN_DATA` and `CLAUDE_HOME_OVERRIDE` pointed at a throwaway directory.
