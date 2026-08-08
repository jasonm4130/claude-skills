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
- **The defer marker lives in `.git/`, not in `CLAUDE_PLUGIN_DATA`.** That variable is
  **not exported to session shells** (verified: unset in the Bash tool's environment),
  and `--defer` runs from a session, so a data-dir path would have the writer and the
  reader disagreeing about the directory — deferral would silently never work. `.git/`
  is computable identically from both sides and is per-clone, which is the correct
  scope. The nudge flag and throttle stay in the data dir, keyed session+repo, because
  only hooks ever touch them. A session-keyed defer would silently mean "not this
  session", which is the one thing defer exists to prevent.
- **`--defer` is a shipped script, not skill prose.** Instructions telling the agent to
  "write the defer file" cannot work when the path depends on state the session cannot
  see; the script and the hook call the same helper. The skill resolves it relative to
  **its own base directory** — `${CLAUDE_PLUGIN_ROOT}` is unset in session shells too,
  so a command built from it expands to `node "/scripts/…"` and dies with
  MODULE_NOT_FOUND. A test pins the relative hop and forbids the variable.
- **A defer marker that exists but cannot be read is silence, not permission.** An
  unreadable (or empty) marker used to fall through and arm a nudge the user had
  explicitly deferred, because the catch set `deferred = null` and the block was
  skipped. Present-but-unparseable is "cannot tell" and takes the silent path, like
  everything else here.
- **UserPromptSubmit re-checks the record before speaking.** Stop arms at end of turn;
  the user may delete `.docs-sync` before the next prompt, and the documented opt-out
  is immediate. Consuming the flag and then staying silent is deliberate — opting out
  should also clear anything already armed.
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
- **Argument splitting is quote-aware (`splitArgs`), and it has to be.** A bare
  `.split(/\s+/)` fragments any quoted path containing a space:
  `git add "Daily/2026-08-03 - Daily.md"` yielded `Daily/2026-08-03` + `-` +
  `Daily.md"`. The `-` was dropped as a flag, `Daily.md` passed the markdown skip,
  and the extensionless `Daily/2026-08-03` was classified as CODE — so a
  markdown-only commit was denied. Found on an Obsidian vault, where every daily
  note has a space in its name. Both directions are tested: a quoted *code* path
  with a space must still be caught.
- **Heredoc bodies are stripped before anything parses the command
  (`stripHeredocs`).** A body is text being written, not commands to run, so
  `cat >> notes.md <<'EOF' … git add x && git commit … EOF` must not read as a
  commit. This bit twice for real while writing the quoting tests above — the
  fixture strings tripped the gate the tests exercise. Stripping happens first, so
  commit detection and the `git add` union always see the stripped form.
  `design-gate-guard` solves a harder version of this with a full tokenizer,
  because it needs segment *heads*; here only the bodies must go.

- **One carve-out: the stdin-message form (0.3.9).** `splitHeredocs` now returns
  the bodies alongside the stripped command, and the `docs-sync:ack` check also
  scans them when the command is `git commit -F -` / `--file=-` / `--file -` —
  where the heredoc body *is* the commit message. Without it the marker's stated
  contract was unachievable: inside the heredoc it was stripped so the gate still
  denied, and outside it satisfied the gate while never reaching the message,
  which is a silent bypass with no audit trail. Scoping the scan to the stdin
  form keeps the original property — this plugin's own README documents the
  literal token and still cannot bypass, because a README is written with a file
  redirect, not a `commit -F -`.

  Each body is kept **with its introducer line**, and only the body whose own
  introducer is the `commit -F -` counts. Scanning every body in the compound
  command was the first attempt and it opened a fresh bypass: a decoy
  `cat >/dev/null <<'DOC' … docs-sync:ack … DOC` ahead of a real
  `git commit -F - <<'MSG'` authorised a commit whose message had no marker.
  A commit split across lines won't match either binding and denies — fail-closed
  is the right direction here.

  The binding checks the segment **head**, not tokens. Matching `commit` and
  `-F -` as text was the second attempt and left `echo git commit -F - <<'DOC'`
  open: every token present, but `echo` consumes the heredoc and the real commit
  goes unmarked. `introIsGitCommitFromStdin` splits the introducer on `;`, `&&`,
  `||`, `|`, `&` and requires a segment whose head is `git`. That split ignores
  quoting, which can only over-split and therefore only ever denies. All three
  bypass variants have regression tests, as does `git -C <path> commit -F -`.

- **An unparseable payload exits before anything else (0.3.7).** Both consolidation
  hooks used to fall through to `process.cwd()` and `session_id: "unknown"` when stdin
  did not parse, so a malformed call armed and then consumed a nudge flag for whatever
  repo the hook was spawned in. It was invisible until that repo crossed the drift
  threshold — this repo's own suite went red at 52 commits and had passed at 39. The
  `PreToolUse` guard already exited on `!payload`; these two were the outliers.
  Fail-open means silent, not "assume the ambient shell".

## Conventions

Same as the other guard plugins: ESM `.mjs` only, stdlib only, `// @ts-check` with
JSDoc typedefs, own `lib.mjs` copy (plugins can't share files), deny via the
`hookSpecificOutput` envelope, graceful degradation on any parse error.

**The duplicated half of `lib.mjs` is enforced identical.** `scripts/lib-drift.test.mjs`
fails the build if any function exported by two or more plugins' `lib.mjs` differs
by even a byte — the invariant exists because the real hazard of one copy per plugin
is a bug fixed in one and left in all the others. This file's `emitAdditionalContext` was the
first casualty: it had drifted to a semantically-identical but differently-formatted
five-line form and was normalised back. If a divergence is ever genuinely wanted,
rename the diverging copy so it stops claiming to be the shared primitive.

## Development

```bash
node --test plugins/docs-sync-guard/tests/*.test.mjs   # real temp git repos throughout
```

Glob the files — Node 24 regressed bare-directory invocation (`node --test <dir>` →
MODULE_NOT_FOUND); see the header of `scripts/run-node-tests.sh`, which is what CI runs.

The boundary test builds 49 commits, so the suite takes ~1min. Filler commits use
`--allow-empty` — `rev-list --count` counts them identically and it avoids both the
file I/O and a per-call filename counter that collides across calls.
