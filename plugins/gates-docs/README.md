# gates-docs

A `PreToolUse` commit gate and a never-blocking consolidation trigger: one keeps
code and its covering docs in the same commit, the other notices when the docs have
drifted apart from each other since anyone last checked.

| Gate | Fires on | Decision | Ack marker |
|---|---|---|---|
| **docs-sync** | `git commit` that changes code without staging its covering docs | deny | `docs-sync:ack` |
| **consolidation trigger** | a repo that has moved far since its docs were last checked *against each other* | in-session nudge, never blocks | `/docs-consolidate --defer` |

Part of the `gates` bundle. It installs on its own: nothing here needs another
gates unit.

## Install

```
/plugin install gates-docs@jasonm4130-claude-skills
```

Or install `gates@jasonm4130-claude-skills`, the bundle, to take every gates unit.

---

## Turning a gate off

`GATES_DISABLE` names the gates that must not run, comma separated. Put it in the
`env` block of a `settings.json`. Claude Code applies that block to the session,
and hook subprocesses inherit it. Every gates unit reads the same variable, so one
list covers them all; the full table is in the `gates` bundle's README.

```jsonc
// ~/.claude/settings.json — every session
// <repo>/.claude/settings.json — this project only
{
  "env": { "GATES_DISABLE": "docs-sync" }
}
```

| Name | Turns off |
|---|---|
| `docs-sync` | the docs-sync gate |
| `docs-consolidate` | the consolidation trigger, both of its hooks |

Matching is exact, so a name in the wrong case or with `_` for `-` disables nothing,
and an unrecognised name is ignored in silence.

---

## The docs-sync gate

A `git commit` that changes code without touching its covering docs is **denied with
a reason**, so the docs update — or an explicit "no doc impact" call — happens in the
same commit, not never.

Docs drift is a silent failure: code lands, README/CLAUDE.md go stale, and the gap is
only discovered sessions later. Ecosystem research (2026-07) found that the designs
which actually work block at a hard boundary, while passive nudges fail structurally:
Stop-hook stdout is printed to the terminal but **never injected into the model's
context**, and post-compaction "re-read the docs" reminders lose to the compaction
summary's momentum. A PreToolUse gate on the commit command is the cheapest point
where the change and its documentation are both still in working memory.

### When it fires

Two rules, checked on every `git commit` in any repo:

**Plugins-monorepo rule** — changes under
`plugins/<name>/{scripts,hooks,agents,workflows}/` without a staged
`plugins/<name>/README.md` or `plugins/<name>/CLAUDE.md` **for the same plugin**.

**Generic nearest-covering-doc rule** — for any other changed code file, walk up from
its directory to the repo root; the nearest level holding a `README.md`, `CLAUDE.md`,
or `AGENTS.md` is that file's covering doc set. A doc at the **repo root** covers a
file only when it mentions it — by basename, stem, top-level directory, or chezmoi
target name (`dot_zshenv` → `.zshenv`) — because the root README is every file's
nearest doc and otherwise gated every commit (256 denials in 33 sessions, mostly
acked reflexively). Nested docs cover their whole subtree as before. If none of the
covering docs are in the commit, the commit is denied — this is the general failure path where the system
changes, the docs don't, and a future agent session reads the stale docs as the source
of truth. A repo with no such docs anywhere above the changed file has nothing to
drift and stays silent.

What the commit "includes" is the union of already-staged files, paths named in
`git add` segments of the same compound command, and modified tracked files when
committing with `-a`. Pathspecs passed directly to `git commit <paths>` are not parsed
(rare in agent usage).

Paths are split quote-aware, so `git add "My Notes/2026-08-03 - Daily.md"` is one path
rather than three fragments — without that, a quoted name containing a space loses its
extension and gets misread as code, denying an ordinary markdown commit. Heredoc
bodies are stripped before any of this runs: a `cat <<EOF … EOF` block that merely
*documents* `git commit` is text being written, not a commit.

Never flagged (the explicit not-to-flag list — noise kills commit gates):

- tests (`tests/` dirs, `*.test.*` files)
- version bumps (`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`)
- `skills/` and `commands/` markdown — those files are self-documenting prompt
  content, not code that a README describes
- all markdown, lockfiles (`package-lock.json`, `Cargo.lock`, `uv.lock`, …),
  LICENSE, `.gitignore`/`.gitattributes`/`.editorconfig`, `.docs-sync`
- doc-only commits, non-commit git commands, non-git Bash commands

### Escape hatch

Add `docs-sync:ack` anywhere in the commit command (conventionally in the message):

```
git commit -m "refactor internals, no behavior change docs-sync:ack"
```

Multi-paragraph messages work too — for the stdin form the marker goes in the heredoc
body, because that body *is* the message:

```
git commit -F - <<'EOF'
refactor(p): rename an internal helper

No behavioural or usage change: docs-sync:ack
EOF
```

**Only `-F -` / `--file=-` / `--file -` heredocs are scanned.** Every other heredoc
body is stripped before the check, so writing documentation that *mentions* the marker
— as this README does — cannot bypass the gate. Putting the marker after a heredoc
terminator would satisfy the hook while leaving no trace in history; that is the
failure this carve-out exists to prevent.

The marker lands in the commit message, so the "no doc impact" judgment stays
auditable in history. Any git error, non-repo cwd, or unparseable payload fails open —
the guard never blocks a commit by accident.


---

## The consolidation trigger

The docs-sync gate answers "did this change update its covering docs?". This answers
"have these docs drifted apart since anyone last checked them against each other?",
and it **never blocks**.

Google sites its false-positive bar by pipeline position: build-blocking checks must
"produce no effective false positives (the analysis should never stop the build for
correct code)", while review-time checks tolerate under 10%. A path comparison meets
that bar; contradiction detection does not come close — so it stays off the blocking
path. But an out-of-band report is inert too: Facebook measured a >70% fix rate for
issues raised on the diff that introduced them versus "near silence" for the same
issues in an offline bug list. Hence a nudge that arrives in the session and blocks
nothing.

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
`DOCS_SYNC_CONSOLIDATE_THRESHOLD` (default **50**) the `Stop` hook arms a flag and the
next `UserPromptSubmit` injects a one-off nudge toward the
`gates-docs:docs-consolidate` skill — at most once per session, re-armed only when HEAD
moves. `/docs-consolidate --defer` silences it until the repo has moved that far again.

The skill is named plugin-qualified in the nudge, because a bare name is one the model
resolves by guessing and it guesses wrong; `scripts/repo-consistency.test.mjs` enforces
that across every hook in the repo.

`count` includes the record's own commit, so a fresh record reads 1 and the nudge fires
after `threshold − 1` further commits. The off-by-one is deliberate: excluding the
record with a pathspec would trigger git's history simplification, after which the
count silently stops meaning what it looks like.

**Every anomaly is silent, never "stale".** No record, an uncommitted record, an
unparseable `audited=` line, a SHA that no longer exists or is no longer an ancestor, a
shallow clone, a broken git, a hook payload that does not parse as a JSON object — all
of it exits 0 with no output. A nudge toward optional work must never fire on "I cannot
tell"; that is the effective false positive that gets a tool switched off. It also
means shallow clones need no special-casing at all, because both shallow failure shapes
land on paths that are already silent.

One consequence worth stating: a history rewrite that drops the audited commit silences
the trigger until someone runs `/docs-consolidate` or `--init` again. Silence is a
degradation; a false "audited" is a lie.

The record is trusted by convention. It defends against *incidental* touches — a merge
conflict resolution, a prose fix — which are likely and would otherwise reset drift
without an audit. It does not defend against someone deliberately writing a fresh
`audited=` and committing it. Nothing local can, and for a non-blocking nudge that is
the right place to stop.


---

## How it works

```
gates-docs/
├── .claude-plugin/plugin.json
├── hooks/hooks.json                            — PreToolUse (Bash), Stop, UserPromptSubmit
├── scripts/
│   ├── lib.mjs                                 — hook I/O + the drift engine
│   ├── pretooluse-guard-docs-sync.mjs          — the commit gate
│   ├── stop-check-consolidation-drift.mjs      — measures drift, arms the flag
│   ├── check-consolidation-flag.mjs            — consumes the flag, injects the nudge
│   └── defer-consolidation.mjs                 — /docs-consolidate --defer
├── skills/docs-consolidate/SKILL.md            — the audit itself
└── tests/                                      — one suite per script
```

The trigger needs two hooks rather than one because Stop-hook stdout is never injected
into model context: `Stop` measures and records, `UserPromptSubmit` delivers.

The nudge flag and its throttle live in `CLAUDE_PLUGIN_DATA`, keyed
`<session>-<repoHash>` so a flag armed in one repo is never consumed by a prompt from
another. **The deferral marker lives in `.git/docs-sync-defer` instead**, because
`CLAUDE_PLUGIN_DATA` is not exported to session shells — `/docs-consolidate --defer`
runs there, and a path derived from that variable would be written where the hook never
looks. `.git/` is per-clone, which is exactly the scope of "not now", and is never
committed.

The docs-sync gate names itself in its decision reason (`docs-sync-guard:`), so a
denial says which gate spoke.

Before the split (gates 0.6.x and earlier) these hooks lived in the `gates` plugin, so
their data dir was `gates`'s. A `gates-docs` install starts with an empty one. That
costs at most one repeat nudge per repo and session: the data dir holds only the nudge
flag and its throttle, and the defer marker in `.git/` carries over.

## Dependencies

- **Node.js 18+ on PATH**, and git. Node is an external prerequisite Claude Code does
  not ship — install it via Homebrew, WinGet, or your distro's package manager. Without
  it the hooks cannot run and the gate fails open (a non-blocking `hook error` per
  matching event). Why there is no silent-skip: `scripts/hook-runtime-guard.test.mjs`.
- **Claude Code >= 2.1.110** — for `hooks.json` plugin hook registration.

## Development

```bash
node --test plugins/gates-docs/tests/*.test.mjs     # real temp git repos throughout

# Manual smoke test — code staged, docs not → deny envelope on stdout
echo '{"tool_name":"Bash","tool_input":{"command":"git commit -m x"},"cwd":"<repo-with-staged-plugin-code>"}' \
  | node plugins/gates-docs/scripts/pretooluse-guard-docs-sync.mjs
```
