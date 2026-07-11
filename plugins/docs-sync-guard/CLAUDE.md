# docs-sync-guard — Claude Code Plugin

## What this is

A single `PreToolUse` hook (matcher `Bash`) that gates `git commit` commands with
two rules: (1) plugins-monorepo pairs — executable plugin code staged without that
plugin's README.md/CLAUDE.md → **deny** with the offending plugin names; (2)
generic nearest-covering-doc (0.2.0) — any other code file whose nearest ancestor
README.md/CLAUDE.md/AGENTS.md exists but isn't staged → **deny**, because a future
agent session reads those docs as the source of truth. The `docs-sync:ack` marker
in the commit command bypasses (and self-documents in history). See README.md for
the user-facing contract.

## Design decisions (research-grounded, 2026-07-11)

- **Commit gate, not turn-end nudge**: Stop-hook stdout is not injected into model
  context (verified community post-mortem); UserPromptSubmit/pre-commit blocking is
  what works. The commit is the last moment code and docs share working memory.
- **Flag, don't rewrite**: the hook never edits docs; it feeds the deny reason back
  so Claude (or the human) makes the update deliberately.
- **Explicit not-to-flag list** (coder/coder doc-check pattern): tests, version
  bumps, skills/commands markdown. Noise makes ack reflexive and kills the gate.
- **Fail open everywhere**: non-repo cwd, git errors, malformed stdin → exit 0.
- **`skills/`+`commands/` are docs, not code**: SKILL.md content is the feature and
  self-describes; only `scripts|hooks|agents|workflows` count as executable surface.

## Gotchas

- macOS symlinked cwds (`/var` → `/private/var`): git prints the REAL toplevel, so
  `cwd` is realpath'd before computing repo-relative paths for `git add` unions.
- `git add X && git commit` in one command: X isn't in the index when the hook
  runs — `pathsFromGitAdd()` parses add segments and unions them in.
- `git commit <pathspec>` is NOT parsed (documented limitation).

## Conventions

Same as the other guard plugins: ESM `.mjs` only, stdlib only, `// @ts-check` with
JSDoc typedefs, own `lib.mjs` copy (plugins can't share files), deny via the
`hookSpecificOutput` envelope, graceful degradation on any parse error.

## Development

```bash
node --test plugins/docs-sync-guard/tests/   # 15 tests, real temp git repos
```
