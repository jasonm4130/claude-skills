# docs-sync-guard

A Claude Code plugin that stops docs drift at the commit boundary: a `git commit`
that changes a plugin's executable code without touching that plugin's docs is
**denied with a reason**, so the docs update (or an explicit "no doc impact" call)
happens in the same commit — not never.

## Why the commit boundary

Docs drift is a silent failure: code lands, README/CLAUDE.md go stale, and the gap
is only discovered sessions later. Ecosystem research (2026-07) found the designs
that actually work block at a hard boundary, while passive nudges fail structurally:
Stop-hook stdout is printed to the terminal but **never injected into the model's
context**, and post-compaction "re-read the docs" reminders lose to the compaction
summary's momentum. A PreToolUse gate on the commit command is the cheapest point
where the change and its documentation are both still in working memory.

## When it fires

Only in repos with a `plugins/` monorepo layout (silent everywhere else). It denies
a `git commit` when the commit would include changes under
`plugins/<name>/{scripts,hooks,agents,workflows}/` without a staged
`plugins/<name>/README.md` or `plugins/<name>/CLAUDE.md` **for the same plugin**.

What the commit "includes" is the union of already-staged files, paths named in
`git add` segments of the same compound command, and modified tracked files when
committing with `-a`. Pathspecs passed directly to `git commit <paths>` are not
parsed (rare in agent usage).

Never flagged (the explicit not-to-flag list — noise kills commit gates):

- tests (`tests/` dirs, `*.test.*` files)
- version bumps (`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`)
- `skills/` and `commands/` markdown — those files are self-documenting prompt
  content, not code that a README describes
- doc-only commits, non-commit git commands, non-git Bash commands

## Escape hatch

Add `docs-sync:ack` anywhere in the commit command (conventionally in the message):

```
git commit -m "refactor internals, no behavior change docs-sync:ack"
```

The marker lands in the commit message, so the "no doc impact" judgment stays
auditable in history. Any git error, non-repo cwd, or unparseable payload fails
open — the guard never blocks a commit by accident.

## Install

```
/plugin install docs-sync-guard@jasonm4130-claude-skills
```

## How it works

One stateless PreToolUse hook (matcher `Bash`) — no flag files, no state.

```
docs-sync-guard/
├── .claude-plugin/plugin.json
├── hooks/hooks.json                          — PreToolUse, matcher "Bash"
├── scripts/
│   ├── lib.mjs                               — readStdin + safeJsonParse + emitPermissionDecision
│   └── pretooluse-guard-docs-sync.mjs        — the guard
└── tests/
    └── pretooluse-guard-docs-sync.test.mjs
```

## Development

```bash
node --test plugins/docs-sync-guard/tests/

# Manual smoke test — code staged, docs not → deny envelope on stdout
echo '{"tool_name":"Bash","tool_input":{"command":"git commit -m x"},"cwd":"<repo-with-staged-plugin-code>"}' \
  | node plugins/docs-sync-guard/scripts/pretooluse-guard-docs-sync.mjs
```

## Dependencies

- Node.js 18+ and git on PATH. No third-party packages.
- Claude Code >= 2.1.110 (hooks.json plugin registration).
