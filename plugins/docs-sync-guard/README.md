# docs-sync-guard

Two mechanisms against docs drift, sited by how confident each can be:

1. **The commit gate** (blocking) — a `git commit` that changes code without touching
   its covering docs is **denied with a reason**, so the docs update (or an explicit
   "no doc impact" call) happens in the same commit, not never.
2. **The consolidation trigger** (0.3.0, never blocking) — once a repo has moved far
   enough since anyone last checked its docs *against each other*, an in-session nudge
   suggests `/docs-consolidate`. Docs that were each updated correctly in isolation
   can still contradict one another.

The split is deliberate. Google sites its false-positive bar by pipeline position:
build-blocking checks must "produce no effective false positives (the analysis should
never stop the build for correct code)", while review-time checks tolerate under 10%.
A path comparison meets that bar; contradiction detection does not come close — so it
stays off the blocking path. But an out-of-band report is inert too: Facebook measured
a >70% fix rate for issues raised on the diff that introduced them versus "near
silence" for the same issues in an offline bug list. Hence a nudge that arrives in the
session and blocks nothing.

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
  LICENSE, `.gitignore`/`.gitattributes`/`.editorconfig`, `.docs-sync`
- doc-only commits, non-commit git commands, non-git Bash commands

## Escape hatch

Add `docs-sync:ack` anywhere in the commit command (conventionally in the message):

```
git commit -m "refactor internals, no behavior change docs-sync:ack"
```

The marker lands in the commit message, so the "no doc impact" judgment stays
auditable in history. Any git error, non-repo cwd, or unparseable payload fails
open — the guard never blocks a commit by accident.

## The consolidation trigger (0.3.0)

**Opt in by committing `.docs-sync` at the repo root; opt out by deleting it.**
`/docs-consolidate --init` creates it — note that adopting **starts the clock rather
than auditing**: the SHA it writes means "measure drift from here", not "these docs
were verified". Run a full pass straight after if the existing docs are of unknown
quality.

```
docs-sync: audited=<full-40-char-sha>
Recorded: <ISO-8601 UTC>
Run /docs-consolidate — do not hand-edit the audited= line.
```

Drift is `git rev-list --count <audited>..HEAD`. Past
`DOCS_SYNC_CONSOLIDATE_THRESHOLD` (default **50**) the `Stop` hook arms a flag and
the next `UserPromptSubmit` injects a one-off nudge — at most once per session,
re-armed only when HEAD moves. `/docs-consolidate --defer` silences it until the repo
has moved that far again.

`count` includes the record's own commit, so a fresh record reads 1 and the nudge
fires after `threshold − 1` further commits. The off-by-one is deliberate: excluding
the record with a pathspec would trigger git's history simplification, after which the
count silently stops meaning what it looks like.

**Every anomaly is silent, never "stale".** No record, an uncommitted record, an
unparseable `audited=` line, a SHA that no longer exists or is no longer an ancestor,
a shallow clone, a broken git — all of it exits 0 with no output. A nudge toward
optional work must never fire on "I cannot tell"; that is the effective false positive
that gets a tool switched off. It also means shallow clones need no special-casing at
all, because both shallow failure shapes land on paths that are already silent.

One consequence worth stating: a history rewrite that drops the audited commit
silences the trigger until someone runs `/docs-consolidate` or `--init` again. Silence
is a degradation; a false "audited" is a lie.

The record is trusted by convention. It defends against *incidental* touches — a merge
conflict resolution, a prose fix — which are likely and would otherwise reset drift
without an audit. It does not defend against someone deliberately writing a fresh
`audited=` and committing it. Nothing local can, and for a non-blocking nudge that is
the right place to stop.

## Install

```
/plugin install docs-sync-guard@jasonm4130-claude-skills
```

## How it works

The gate is one stateless PreToolUse hook (matcher `Bash`). The trigger adds a `Stop`
hook that measures and records, and a `UserPromptSubmit` hook that delivers — because
Stop-hook stdout is never injected into model context, so Stop cannot speak for itself.

```
docs-sync-guard/
├── .claude-plugin/plugin.json
├── hooks/hooks.json                          — PreToolUse (Bash), Stop, UserPromptSubmit
├── scripts/
│   ├── lib.mjs                               — hook I/O + the drift engine
│   ├── pretooluse-guard-docs-sync.mjs        — the commit gate
│   ├── stop-check-consolidation-drift.mjs    — measures drift, arms the flag
│   ├── check-consolidation-flag.mjs          — consumes the flag, injects the nudge
│   └── defer-consolidation.mjs               — /docs-consolidate --defer
├── skills/docs-consolidate/SKILL.md          — the audit itself
└── tests/
    ├── pretooluse-guard-docs-sync.test.mjs
    ├── consolidation-drift.test.mjs
    └── consolidation-hooks.test.mjs
```

The nudge flag and its throttle live in `CLAUDE_PLUGIN_DATA`, keyed
`<session>-<repoHash>` so a flag armed in one repo is never consumed by a prompt from
another.

**The deferral marker lives in `.git/docs-sync-defer` instead**, because
`CLAUDE_PLUGIN_DATA` is not exported to session shells — `/docs-consolidate --defer`
runs there, and a path derived from that variable would be written where the hook
never looks. `.git/` is per-clone, which is exactly the scope of "not now", and is
never committed.

## Development

```bash
node --test plugins/docs-sync-guard/tests/*.test.mjs

# Manual smoke test — code staged, docs not → deny envelope on stdout
echo '{"tool_name":"Bash","tool_input":{"command":"git commit -m x"},"cwd":"<repo-with-staged-plugin-code>"}' \
  | node plugins/docs-sync-guard/scripts/pretooluse-guard-docs-sync.mjs
```

## Dependencies

- Node.js 18+ and git on PATH. No third-party packages. Claude Code ships a self-contained native binary and its documented system requirements do **not** include Node, so this is an external prerequisite the host does not provide — install it via Homebrew, WinGet, or your distro's package manager. On a machine without it the hook cannot run and Claude Code shows a non-blocking `hook error` per matching event, so the guard fails open. There is no silent-skip: probing for node needs shell syntax that is not portable across the shells Claude Code picks per platform, and the exec-form alternative is unsupported before 2.1.139 with no way to enforce that floor (`engines` is not a recognised manifest field). See `scripts/hook-runtime-guard.test.mjs` for the full reasoning.
- Claude Code >= 2.1.110 (hooks.json plugin registration).
