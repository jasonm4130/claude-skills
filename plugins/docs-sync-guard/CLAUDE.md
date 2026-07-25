# docs-sync-guard — Claude Code Plugin

## What this is

Two mechanisms, sited by how confident each can be.

**The commit gate** — a `PreToolUse` hook (matcher `Bash`) gating `git commit` with
two rules: (1) plugins-monorepo pairs — executable plugin code staged without that
plugin's README.md/CLAUDE.md → **deny** with the offending plugin names; (2)
generic nearest-covering-doc (0.2.0) — any other code file whose nearest ancestor
README.md/CLAUDE.md/AGENTS.md exists but isn't staged → **deny**, because a future
agent session reads those docs as the source of truth. The `docs-sync:ack` marker
in the commit command bypasses (and self-documents in history).

**The consolidation trigger (0.3.0)** — `Stop` measures commits since the
`.docs-sync` record's `audited=` SHA and arms a flag; `UserPromptSubmit` consumes it
fire-once and suggests `/docs-consolidate`. Never blocks. See README.md for the
user-facing contract.

## Design decisions (research-grounded, 2026-07-11)

- **Commit gate, not turn-end nudge**: Stop-hook stdout is not injected into model
  context (verified community post-mortem); UserPromptSubmit/pre-commit blocking is
  what works. The commit is the last moment code and docs share working memory.
  *(0.3.0 note: the `Stop` hook added for the trigger does not contradict this — it
  is exactly why Stop writes a flag instead of printing, and `UserPromptSubmit` does
  the injecting. Do not "simplify" it into a Stop hook that prints.)*
- **Flag, don't rewrite**: the hook never edits docs; it feeds the deny reason back
  so Claude (or the human) makes the update deliberately.
- **Explicit not-to-flag list** (coder/coder doc-check pattern): tests, version
  bumps, skills/commands markdown. Noise makes ack reflexive and kills the gate.
- **Fail open everywhere**: non-repo cwd, git errors, malformed stdin → exit 0.
- **`skills/`+`commands/` are docs, not code**: SKILL.md content is the feature and
  self-describes; only `scripts|hooks|agents|workflows` count as executable surface.

## Design decisions — consolidation trigger (2026-07-25)

Codex-reviewed: 3 rounds + audit, chain `881f87716802`, 14 unique findings.

- **Contradiction detection stays OFF the blocking path.** Google requires
  build-blocking checks to "produce no effective false positives"; review-time checks
  tolerate <10%, and Tricorder puts an analyzer on probation at a 10% not-useful rate,
  off at 25%. A secret-detection gate that missed that bar saw 44.2% one-time and 7.2%
  permanent bypass, with developers calling 50% of warnings false positives regardless
  of accuracy. An LLM contradiction check on the gate would be bypassed about half the
  time *and* spend the credibility the deterministic path check has.
- **But the nudge must arrive in-session.** Facebook: >70% fix rate for issues raised
  on the introducing diff, "near silence" for an offline bug list. A report written to
  a file would be inert.
- **Every anomaly is silent, never stale.** This one choice removes shallow-clone
  special-casing entirely: `--depth 1` (audited commit unfetched) and
  `--depth 1 --no-single-branch` (object alive via another branch, path to HEAD cut)
  both land on already-silent paths. The predecessor design warned on ambiguity and
  needed an explicit `--is-shallow-repository` check plus two separate fixes, the
  second of which hid behind the first. Both variants have their own regression test.
- **`audited=` is explicit, not derived from the record's last-touched commit.**
  `git log -1 -- .docs-sync` is elegant — the SHA always exists and is always an
  ancestor — but then *any* touch of the file records an audit, and merge-conflict
  resolution on the record is likely, not contrived. An explicit SHA survives that:
  conflict resolution picks one side's real audit SHA, a prose fix touches nothing.
- **Read existence from the working tree, the SHA from `HEAD:.docs-sync`.** Deleting
  the record is the opt-out and must work before it is committed; an abandoned
  `--init` or a hand-edited line must not silence a stale repo. Two reads, two
  distinct failures — do not collapse them.
- **`isAncestor` uses `rev-parse --verify --quiet`, not `cat-file -e`.** Callers
  delete state on a verified `false`, so "object is gone" (exit 1) and "git could not
  answer" (exit 128) must not collapse. `cat-file -e <missing>^{commit}` returns 128
  for both, because peeling an absent object is fatal rather than a negative answer.
  Verify exit codes by spawning git directly; a shell can mangle `^{commit}`.
- **No pathspec on the count.** `rev-list --count A..HEAD -- ':(exclude)path'`
  triggers history simplification and stops meaning `total − excluded`. The cost is
  that a fresh record reads 1; that is asserted in the tests so nobody "fixes" it.
- **Defer is keyed by repo only**; the nudge flag and throttle are session+repo. A
  session-keyed defer would silently mean "not this session".
- **`.docs-sync` is in `SKIP_RE`.** Without it the gate denies its own record file
  (not Markdown → treated as code → nearest covering doc is the root README, unstaged),
  which would block `--init` and every re-stamp in every repo that has a root README.
- **No dismissal registry.** An intentional contradiction gets its rationale written
  into the doc, which silences future passes by giving them the reason to read. A
  suppression list that grows is how a not-useful rate climbs invisibly.

## Gotchas

- macOS symlinked cwds (`/var` → `/private/var`): git prints the REAL toplevel, so
  `cwd` is realpath'd before computing repo-relative paths for `git add` unions.
  Same trap bites the trigger's tests: state files are keyed off
  `git rev-parse --show-toplevel`, so a test using a raw `mkdtemp` path computes a
  different `repoHash` than the hook does and hunts for a flag that never existed.
- `git add X && git commit` in one command: X isn't in the index when the hook
  runs — `pathsFromGitAdd()` parses add segments and unions them in.
- `git commit <pathspec>` is NOT parsed (documented limitation).

## Conventions

Same as the other guard plugins: ESM `.mjs` only, stdlib only, `// @ts-check` with
JSDoc typedefs, own `lib.mjs` copy (plugins can't share files), deny via the
`hookSpecificOutput` envelope, graceful degradation on any parse error.

## Development

```bash
node --test plugins/docs-sync-guard/tests/   # real temp git repos throughout
```

The boundary test builds 49 real commits, so the suite takes ~40s. Filler commits use
`--allow-empty` — `rev-list --count` counts them identically and it avoids both the
file I/O and a per-call filename counter that collides across calls.
