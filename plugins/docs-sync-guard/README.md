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

Two rules, checked on every `git commit` in any repo:

**Plugins-monorepo rule** — changes under
`plugins/<name>/{scripts,hooks,agents,workflows}/` without a staged
`plugins/<name>/README.md` or `plugins/<name>/CLAUDE.md` **for the same plugin**.

**Generic nearest-covering-doc rule (0.2.0)** — for any other changed code file,
walk up from its directory to the repo root; the nearest level holding a
`README.md`, `CLAUDE.md`, or `AGENTS.md` is that file's covering doc set. If none
of the covering docs are in the commit, the commit is denied — this is the general
failure path where the system changes, the docs don't, and a future agent session
reads the stale docs as the source of truth. A repo with no such docs anywhere
above the changed file has nothing to drift and stays silent.

What the commit "includes" is the union of already-staged files, paths named in
`git add` segments of the same compound command, and modified tracked files when
committing with `-a`. Pathspecs passed directly to `git commit <paths>` are not
parsed (rare in agent usage).

Never flagged (the explicit not-to-flag list — noise kills commit gates):

- tests (`tests/` dirs, `*.test.*` files)
- version bumps (`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`)
- `skills/` and `commands/` markdown — those files are self-documenting prompt
  content, not code that a README describes
- all markdown, lockfiles (`package-lock.json`, `Cargo.lock`, `uv.lock`, …),
  LICENSE, `.gitignore`/`.gitattributes`/`.editorconfig`
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

- Node.js 18+ and git on PATH. No third-party packages. Claude Code ships a self-contained native binary and its documented system requirements do **not** include Node, so this is an external prerequisite the host does not provide — install it via Homebrew, WinGet, or your distro's package manager. Hooks use **exec form** (`command: "node"`, `args: [...]`), so Claude Code spawns node directly with no shell on any platform; without a shell there is no sh-vs-PowerShell dialect to get wrong. On a machine with no node the spawn fails and Claude Code shows a non-blocking `hook error` per event — loud and self-diagnosing by design.
- Claude Code >= 2.1.110 (hooks.json plugin registration).
