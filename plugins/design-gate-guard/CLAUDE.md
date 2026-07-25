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

## Conventions

Same as the other guard plugins: ESM `.mjs` only, stdlib only, `// @ts-check` with
JSDoc typedefs, own `lib.mjs` copy (plugins can't share files), the
`hookSpecificOutput` envelope for the decision, graceful degradation (any parse
error / missing payload / empty command → `process.exit(0)`).

## Development

```bash
node --test plugins/design-gate-guard/tests/*.test.mjs
```
