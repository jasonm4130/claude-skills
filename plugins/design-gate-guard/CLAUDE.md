# design-gate-guard — Claude Code Plugin

## What this is

A single `PreToolUse` hook (matcher `Bash`) that enforces the brainstorming
skill's HARD-GATE ("don't scaffold/implement before a design is approved") at its
most common break point: a new-project scaffold command. Any command segment that
**starts** with a scaffolder (`npm create`, `create-next-app`, `cargo new`,
`rails new`, `django-admin startproject`, …) → **`ask`**. Everything else → allow.

## Design decisions (2026-07-17)

- **Gate the action, not hidden state.** A PreToolUse hook can't see the
  conversation, so it can't know whether a design was approved (the session model
  / "approval" is **not** in stdin or env — same constraint `workflow-model-guard`
  documents). So we don't gate arbitrary edits on a "design approved?" flag; we
  gate the one high-signal, low-frequency action — a scaffold command — that
  strongly implies implementation-before-design.
- **`ask`, not `deny`.** The hook can't resolve a legitimate post-approval
  scaffold, so a deny would dead-end it. `ask` routes to the human, who *can* see
  whether design happened. Same rationale as `workflow-model-guard`'s `ask` on
  un-editable named workflows.
- **Stateless, no flag files.** A stateful "design in progress" flag has a
  catastrophic failure mode — a flag that never clears silently blocks *all*
  future editing on a live session. Every sibling guard is stateless for this
  reason; this one is too. The cost is that design-before-*editing* is not
  enforced, only design-before-*scaffolding* — an accepted, documented limit.
- **Anchor to command position.** Match `^` against each cleaned shell *segment*
  (split on `&&`, `||`, `;`, `|`, newlines) — so `create-react-app` inside a
  commit message / echo string does not fire (that segment starts with
  `git`/`echo`), but `mkdir app && cd app && npm create vite` does.
- **Name the skill plugin-qualified** — the `ask` reason says
  `superpowers-core:brainstorming`, not "the brainstorming skill". A bare name is
  one the model resolves by guessing, and it guesses wrong; `session-retro` lost 4
  nudges to exactly that before it was caught. Enforced by
  `scripts/repo-consistency.test.mjs`.
- **Ack bypass** — `design-gate:ack` anywhere in the command → allow (self-
  documents in history). Same pattern as `docs-sync:ack` / `model-guard:ack`.

## Gotchas

- **Segment cleaning order:** strip trailing `# comment` first (so an appended
  `# design-gate:ack` — and any trailing comment — doesn't pollute matching),
  then strip leading env-assignments + `sudo` (so `FOO=bar sudo npm create …`
  still matches at the head).
- **`npm init` is split by intent:** `npm init <initializer>` (a template) fires;
  bare `npm init` / `npm init -y` (package.json in an existing dir) does **not** —
  the pattern requires a non-flag argument.
- **`dotnet new` requires a template arg** (`dotnet new console`) — `dotnet new
  --list` does not fire.
- **`createdb` / `createuser` / `docker create`** do not fire: the `create-*`
  binary pattern requires a hyphen (`create-foo`), and `docker create`'s segment
  starts with `docker`, not `create-`.
- **Not caught (accepted):** `bash -c "npm create vite"`, `sh -c "…"`, and other
  scaffolds nested inside a `-c` string — the segment starts with `bash`/`sh`.
  Rare, and over-firing is the worse failure for an `ask` gate, so we err quiet.

## The compiled guard (0.2.0)

The hook now runs a committed Rust binary, with the `.mjs` as fallback:

```
"${CLAUDE_PLUGIN_ROOT}/bin/ccguard" design-gate "${CLAUDE_PLUGIN_ROOT}/scripts/pretooluse-guard-design-gate.mjs" || node "${CLAUDE_PLUGIN_ROOT}/scripts/pretooluse-guard-design-gate.mjs"
```

36.1ms → 2.9ms, because ~78% of the old cost was node's cold start rather than the
guard's ~7ms of work.

The `.mjs` path appears twice on purpose, covering two different failures. The
`||` catches a binary that never executes (127 missing, 126 wrong architecture),
where stdin is untouched and node just reads the payload. The **argv** catches a
binary that ran but hit a payload it cannot represent — a command carrying a lone
surrogate is the live case — where the `||` is useless because stdin has already
been drained and a shell cannot rewind a pipe; the binary spawns node itself and
forwards the answer. Since 0.2.2 — before it, one unpaired surrogate anywhere in a
command switched this gate off silently. Details in `rust/README.md`.

The binary exits non-zero only when it cannot execute at all
(127 missing, 126 wrong architecture), so Linux and Intel Macs fall through to the
node path and behave identically, just slower.

**The `.mjs` is not dead code — do not delete it.** It is both the fallback and
the reference implementation that `scripts/ccguard-differential.test.mjs` checks
the binary against. **Any behaviour change must land in BOTH**, or that test fails.
That is deliberate: two implementations kept in lockstep by a differential test is
the price of the fallback, and it is cheaper than the alternative of a guard that
silently disappears on unsupported hardware.

Source lives in `rust/` (shared across both compiled plugins); see `rust/README.md`
for the rebuild command, the staleness fingerprint, and why the tokenizer port is
not a line-by-line translation.

## Conventions

Same as the other guard plugins: ESM `.mjs` only, stdlib only, `// @ts-check` with
JSDoc typedefs, own `lib.mjs` copy (plugins can't share files), the
`hookSpecificOutput` envelope for the decision, graceful degradation (any parse
error / missing payload / empty command → `process.exit(0)`).

`bin/ccguard` is the one exception to "no build artifacts": the marketplace install
path is `git clone` + copy with no build step anywhere, so a compiled hook has to
ship pre-built. It is committed once per consuming plugin because plugins cannot
share files — the same constraint that duplicates `lib.mjs`.

## Development

```bash
node --test plugins/design-gate-guard/tests/*.test.mjs   # the .mjs reference
node --test scripts/ccguard-differential.test.mjs        # binary vs .mjs equivalence
cargo test --release --manifest-path rust/Cargo.toml     # the binary's own units
```

After editing `rust/src/`, rebuild and re-copy the binary (see `rust/README.md`) —
the differential test fails on a stale one rather than letting it ship.
