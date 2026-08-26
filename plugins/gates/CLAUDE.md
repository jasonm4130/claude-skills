# gates — Claude Code Plugin

## What this is

Four `PreToolUse` gates plus a two-hook consolidation trigger, in one plugin because
they are one design:

- **docs-sync** (matcher `Bash`) — gates `git commit` with two rules: (1)
  plugins-monorepo pairs — executable plugin code staged without that plugin's
  README.md/CLAUDE.md → **deny** with the offending plugin names; (2) generic
  nearest-covering-doc — any other code file whose nearest ancestor
  README.md/CLAUDE.md/AGENTS.md exists but isn't staged → **deny**. `docs-sync:ack`
  in the commit command bypasses (and self-documents in history).
- **design-gate** (matcher `Bash`) — any command segment that **starts** with a
  scaffolder (`npm create`, `create-next-app`, `cargo new`, `rails new`,
  `django-admin startproject`, …) → **`ask`**. Everything else → allow.
  `design-gate:ack` bypasses.
- **workflow-model** (matcher `Workflow`) — for a script it can read (inline `script`
  or one read from `scriptPath`), **denies** an expensive fan-out with no per-agent
  `model:` override; the reason is fed back to Claude, which tiers the workers and
  re-runs. For a `name:`-invoked built-in it can't edit, it **asks the user**, since a
  deny would dead-end. `model-guard:ack` bypasses.
- **agent-model** (matcher `Agent`) — **denies** an ad-hoc Agent dispatch that omits
  the `model` param, unless the type is `fork` (model param ignored by design) or the
  `subagent_type` resolves to a custom agent definition with pinned frontmatter
  `model:` (≠ `inherit`). Any explicit `model` — including `fable` — passes: setting it
  IS the ack. Design rationale + probe evidence:
  [`RESEARCH_delegation_model_tiering.md`](https://github.com/jasonm4130/claude-skills/blob/main/RESEARCH_delegation_model_tiering.md).
- **consolidation trigger** — `Stop` measures commits since the `.docs-sync` record's
  `audited=` SHA and arms a flag; `UserPromptSubmit` consumes it fire-once and suggests
  `gates:docs-consolidate`. Never blocks. See README.md for the user-facing contract.

Each gate names itself in its decision reason (`docs-sync-guard:`,
`design-gate-guard:`, `workflow-model-guard:`, `agent-model-guard:`). Those are guard
identifiers, not plugin names — three of the four are byte-locked to the committed
`bin/ccguard`, and the differential test fails on any drift between the two
implementations' output.

## The shared design

- **Stateless, no flag files** (except the trigger, which is deliberately out of the
  blocking path). A stateful "design in progress" or "docs approved" flag has a
  catastrophic failure mode: a flag that never clears silently blocks *all* future
  work on a live session. The cost is that design-before-*editing* and
  docs-before-*any-change* are not enforced — only at their one hard boundary.
- **`deny` when Claude can fix it, `ask` when only the human can.** A `deny` is meant
  to make Claude *rewrite* the offending thing. A scaffold whose design was already
  approved, and a built-in `name:` workflow that isn't editable from the session, are
  both unresolvable from inside the model's turn — so they get `ask`, which routes to
  someone who can see the state the hook cannot.
- **The session model is not available to a PreToolUse hook** (not in stdin, not in
  env; feature request closed not-planned, anthropics/claude-code#37817). Every
  "couldn't the hook just check X?" question about session state bottoms out here.
- **Fail open everywhere.** Non-repo cwd, git errors, malformed stdin, unreadable
  path → exit 0.
- **An ack marker per gate, landing in durable text** (commit message, shell history,
  the script itself), so a bypass is auditable rather than invisible.
- **Name skills plugin-qualified in hook output.** A bare name is one the model
  resolves by guessing, and it guesses wrong; `session-retro` lost 4 nudges to exactly
  that before it was caught. Enforced by `scripts/repo-consistency.test.mjs`.

## Design decisions — docs-sync (2026-07-11)

- **Commit gate, not turn-end nudge**: Stop-hook stdout is not injected into model
  context (verified community post-mortem); UserPromptSubmit/pre-commit blocking is
  what works. The commit is the last moment code and docs share working memory.
  *(The `Stop` hook the trigger adds does not contradict this — it is exactly why Stop
  writes a flag instead of printing, and `UserPromptSubmit` does the injecting. Do not
  "simplify" it into a Stop hook that prints.)*
- **Flag, don't rewrite**: the hook never edits docs; it feeds the deny reason back so
  Claude (or the human) makes the update deliberately.
- **Explicit not-to-flag list** (coder/coder doc-check pattern): tests, version bumps,
  skills/commands markdown. Noise makes ack reflexive and kills the gate.
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
  skipped. Present-but-unparseable is "cannot tell" and takes the silent path.
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

## Design decisions — design-gate (2026-07-17)

- **Gate the action, not hidden state.** The hook can't know whether a design was
  approved, so it gates the one high-signal, low-frequency action — a scaffold command
  — that strongly implies implementation-before-design.
- **Anchor to command position.** Match `^` against each cleaned shell *segment*
  (split on `&&`, `||`, `;`, `|`, newlines) — so `create-react-app` inside a commit
  message or echo string does not fire (that segment starts with `git`/`echo`), but
  `mkdir app && cd app && npm create vite` does.
- **Name the skill plugin-qualified** — the `ask` reason says
  `superpowers-core:brainstorming`, not "the brainstorming skill".

### design-gate gotchas

- **Segment cleaning order:** strip trailing `# comment` first (so an appended
  `# design-gate:ack` — and any trailing comment — doesn't pollute matching), then
  strip leading env-assignments + `sudo` (so `FOO=bar sudo npm create …` still matches
  at the head).
- **`npm init` is split by intent:** `npm init <initializer>` (a template) fires; bare
  `npm init` / `npm init -y` (package.json in an existing dir) does **not** — the
  pattern requires a non-flag argument.
- **`dotnet new` requires a template arg** (`dotnet new console`) — `dotnet new
  --list` does not fire.
- **`createdb` / `createuser` / `docker create`** do not fire: the `create-*` binary
  pattern requires a hyphen (`create-foo`), and `docker create`'s segment starts with
  `docker`, not `create-`.
- **Not caught (accepted):** `bash -c "npm create vite"`, `sh -c "…"`, and other
  scaffolds nested inside a `-c` string — the segment starts with `bash`/`sh`. Rare,
  and over-firing is the worse failure for an `ask` gate, so we err quiet.

## Design decisions — the model gates

**Why `ask` for `name:` but `deny` for scripts?** A `deny` is meant to make Claude
*rewrite* the offending script — but a built-in or saved `name:` workflow isn't
editable from the session, so a deny would dead-end (and there's nowhere to put a
`model-guard:ack` marker). `ask` routes the call to the human, who can switch the
session to Sonnet before running it, or proceed deliberately.

**What the `deep-research` denylist entry is, and is not.** It is a **cost speed-bump
on a high-fan-out built-in**: the workflow spawns many workers, pins no tier of its
own, and therefore inherits whatever the session is set to. It is **not** a claim that
the built-in is all-Opus — that rationale was carried in these docs and is false;
inheritance is not pinning, and the same run is cheap on a Sonnet session. Since the
hook cannot see the session model, it cannot make the call itself, so it surfaces the
run once per invocation and lets the user decide. Do not re-introduce an all-Opus
framing; if a named workflow is ever found to pin a tier, that is a different fact and
needs its own probe.

`agentCount` is a static lower bound (`/\bagent\s*\(/g`); loops and `.map()` over items
mean the real spawn count is higher, so fan-out/loop presence is the stronger signal.
The detection is heuristic on purpose: it errs toward silence on small workflows and
only speaks up on clearly-expensive ones, so it doesn't fight the Workflow tool's own
"omit `model` by default" guidance.

**The Agent gate's order of checks:** (1) `tool_input.model` set (any non-empty
string) → exit 0 — explicit is deliberate, and the model param itself is the ack;
(2) `subagent_type === "fork"` → exit 0 (forks always inherit; a deny would loop);
(3) scan `<cwd>/.claude/agents/*.md` then `~/.claude/agents/*.md` (that precedence,
mirroring Claude Code's own project-over-user resolution), matching frontmatter `name:`
first and filename second — first resolving definition decides, pinned `model:`
(≠ `inherit`) → exit 0; (4) deny with the tier calculus (sonnet for
search/mechanical/verify, haiku for enumeration, opus/fable deliberately). No scale
gate: one frontier dispatch is the unit of waste and the deny costs one round trip.

**Empirical grounding (probes re-run 2026-08-26 on Claude Code 2.1.246; first run
2026-07-11 on 2.1.206, sandboxed `claude -p`):** PreToolUse fires on `Agent`
dispatches (stale issue #56151 doesn't reproduce), `deny` is enforced — subagent never
spawns, reason reaches the model (#44534 doesn't reproduce) — and `updatedInput` can
silently rewrite the dispatch model (rejected as design: hides the decision). The
legacy `Task` matcher also fires for `Agent` calls — never register both, or the guard
double-fires. Re-verify after major Claude Code upgrades and move the stamp forward.

## Gotchas — docs-sync

- macOS symlinked cwds (`/var` → `/private/var`): git prints the REAL toplevel, so
  `cwd` is realpath'd before computing repo-relative paths for `git add` unions.
  Same trap bites the trigger's tests: state files are keyed off
  `git rev-parse --show-toplevel`, so a test using a raw `mkdtemp` path computes a
  different `repoHash` than the hook does and hunts for a flag that never existed.
- `git add X && git commit` in one command: X isn't in the index when the hook runs —
  `pathsFromGitAdd()` parses add segments and unions them in.
- `git commit <pathspec>` is NOT parsed (documented limitation).
- **Argument splitting is quote-aware (`splitArgs`), and it has to be.** A bare
  `.split(/\s+/)` fragments any quoted path containing a space:
  `git add "Daily/2026-08-03 - Daily.md"` yielded `Daily/2026-08-03` + `-` +
  `Daily.md"`. The `-` was dropped as a flag, `Daily.md` passed the markdown skip, and
  the extensionless `Daily/2026-08-03` was classified as CODE — so a markdown-only
  commit was denied. Found on an Obsidian vault, where every daily note has a space in
  its name. Both directions are tested: a quoted *code* path with a space must still be
  caught.
- **Heredoc bodies are stripped before anything parses the command
  (`stripHeredocs`).** A body is text being written, not commands to run, so
  `cat >> notes.md <<'EOF' … git add x && git commit … EOF` must not read as a commit.
  This bit twice for real while writing the quoting tests above — the fixture strings
  tripped the gate the tests exercise. Stripping happens first, so commit detection and
  the `git add` union always see the stripped form. The design gate solves a harder
  version of the same problem with a full tokenizer, because it needs segment *heads*;
  here only the bodies must go.

- **One carve-out: the stdin-message form.** `splitHeredocs` returns the bodies
  alongside the stripped command, and the `docs-sync:ack` check also scans them when
  the command is `git commit -F -` / `--file=-` / `--file -` — where the heredoc body
  *is* the commit message. Without it the marker's stated contract was unachievable:
  inside the heredoc it was stripped so the gate still denied, and outside it satisfied
  the gate while never reaching the message, which is a silent bypass with no audit
  trail. Scoping the scan to the stdin form keeps the original property — this plugin's
  own README documents the literal token and still cannot bypass, because a README is
  written with a file redirect, not a `commit -F -`.

  Each body is kept **with its introducer line**, and only the body whose own
  introducer is the `commit -F -` counts. `introIsGitCommitFromStdin` took **four**
  attempts to get there, each bypass found by review after the previous fix. The
  pattern is the lesson, not the regexes:

  | attempt | bypass it left open |
  |---|---|
  | scan every heredoc body | `cat >/dev/null <<'DOC'` decoy elsewhere in the command |
  | bind body to its introducer line, match tokens | `echo git commit -F - <<'DOC'` — tokens present, `echo` consumes the body |
  | split introducer on `;&&\|\|` for a git head | `echo 'note; git commit -F - '` — an unquoted split *fabricates* a git head from quoted text |
  | tokenise with `splitArgs`, operators must be their own token | — |

  Plus `git commit -F - <<'ACK' <<'MSG'`: bash applies the **last** redirection, so a
  marker in the discarded first body authorised a message that never had one. More than
  one `<<` token on the line now refuses outright. The same review surfaced a
  pre-existing parser bug — `splitHeredocs` consumed only the first heredoc per line,
  leaving B's body in the "stripped" command of `cat <<'A' <<'B'`, which fed the marker
  check, commit detection and the `git add` union alike. All introducers on a line are
  now consumed in order.

  The through-line: a regex cannot tell a command from text that looks like one. The
  fix that held reuses the quote-aware `splitArgs` already in this file and requires
  `seg[0]` to be exactly `git`. Anything unrecognised denies — a false deny costs one
  `-m` flag, a false allow is a silent bypass. All five variants have regression tests,
  as does `git -C <path> commit -F -`, and a commit split across lines matches neither
  binding and denies.

- **An unparseable payload exits before anything else.** Both consolidation hooks used
  to fall through to `process.cwd()` and `session_id: "unknown"` when stdin did not
  parse, so a malformed call armed and then consumed a nudge flag for whatever repo the
  hook was spawned in. It was invisible until that repo crossed the drift threshold —
  this repo's own suite went red at 52 commits and had passed at 39. The `PreToolUse`
  guard already exited on `!payload`; these two were the outliers. Fail-open means
  silent, not "assume the ambient shell".

## The compiled guards

Three of the four gates run a committed Rust binary, with the `.mjs` as fallback:

```
"${CLAUDE_PLUGIN_ROOT}/bin/ccguard" design-gate    "${CLAUDE_PLUGIN_ROOT}/scripts/pretooluse-guard-design-gate.mjs"    || node "${CLAUDE_PLUGIN_ROOT}/scripts/pretooluse-guard-design-gate.mjs"
"${CLAUDE_PLUGIN_ROOT}/bin/ccguard" agent-model    "${CLAUDE_PLUGIN_ROOT}/scripts/pretooluse-guard-agent-model.mjs"    || node "${CLAUDE_PLUGIN_ROOT}/scripts/pretooluse-guard-agent-model.mjs"
"${CLAUDE_PLUGIN_ROOT}/bin/ccguard" workflow-model "${CLAUDE_PLUGIN_ROOT}/scripts/pretooluse-guard-workflow-model.mjs" || node "${CLAUDE_PLUGIN_ROOT}/scripts/pretooluse-guard-workflow-model.mjs"
```

36.1ms → 2.9ms on the design gate, 35.7ms → 3.1ms on the Agent gate, which fires on
every dispatch. The docs-sync gate is **not** compiled: git subprocesses dominate its
61ms, so compiling it would buy a third of what it buys here.

Consolidating the three plugins into this one collapsed two byte-identical copies of
`ccguard` into one — plugins cannot share files, so each consuming plugin used to
carry its own. There is now exactly one committed binary in the repo.

The `.mjs` path appears twice on purpose: the `||` covers a binary that never executes
(127 missing, 126 wrong architecture), and the **argv** covers a binary that ran but
hit a payload it cannot represent, where the `||` is useless because stdin is already
drained. `rust/README.md` has the full argument.

**The `.mjs` files are not dead code — do not delete them.** They are both the
fallback and the reference implementation that `scripts/ccguard-differential.test.mjs`
checks the binary against. **Any behaviour change must land in BOTH**, or that test
fails — including the decision-reason strings, which is why those still say
`design-gate-guard:` / `workflow-model-guard:` / `agent-model-guard:`. Note the Agent
guard reads `~/.claude/agents/*.md` and the project's `.claude/agents/*.md`: the Rust
port sorts directory entries where `readdirSync` does not, which only becomes visible
if two definitions declare the same frontmatter `name` — sorted at least makes the
winner reproducible.

`bin/ccguard` is the one exception to "no build artifacts": the marketplace install
path is `git clone` + copy with no build step anywhere, so a compiled hook has to ship
pre-built. Source lives in `rust/`; see `rust/README.md` for the rebuild command and
the staleness fingerprint.

## Conventions

- **ESM only.** Every script is `.mjs`. No CommonJS, no `package.json`, no `require`.
- **Stdlib only.** Allowed imports: `node:fs`, `node:path`, `node:os`, `node:process`,
  `node:child_process`, `node:crypto`, `node:url`, `node:test`, `node:assert/strict`.
- **`// @ts-check` at the top of every file**, with JSDoc `@typedef` for stdin payload
  shapes. Editors get IntelliSense without a build step.
- **Graceful degradation.** Any JSON parse error or missing payload → `process.exit(0)`
  silently. The hook never crashes the session.
- **Decision output** uses the `hookSpecificOutput` envelope with `permissionDecision`
  / `permissionDecisionReason` (the reliably-documented PreToolUse feedback channel);
  the trigger uses `additionalContext`.
- **Own `lib.mjs`.** Its hook-I/O half duplicates the other plugins' copies — CC
  plugins can't share files across boundaries, so duplication is intentional, and
  `scripts/lib-drift.test.mjs` fails the build if any function exported by two or more
  plugins' `lib.mjs` differs by even a byte. The invariant exists because the real
  hazard of one copy per plugin is a bug fixed in one and left in all the others. This
  file's `emitAdditionalContext` was the first casualty: it had drifted to a
  semantically-identical but differently-formatted five-line form and was normalised
  back. If a divergence is ever genuinely wanted, rename the diverging copy so it stops
  claiming to be the shared primitive.

## Development

```bash
node --test plugins/gates/tests/*.test.mjs             # real temp git repos throughout
node --test scripts/ccguard-differential.test.mjs      # binary vs .mjs equivalence
cargo test --release --manifest-path rust/Cargo.toml   # the binary's own units
```

Glob the files — Node 24 regressed bare-directory invocation (`node --test <dir>` →
MODULE_NOT_FOUND); see the header of `scripts/run-node-tests.sh`, which is what CI runs.

The docs-sync boundary test builds 49 commits, so the suite takes ~1min. Filler commits
use `--allow-empty` — `rev-list --count` counts them identically and it avoids both the
file I/O and a per-call filename counter that collides across calls.

After editing `rust/src/`, rebuild and re-copy the binary (see `rust/README.md`) — the
differential test fails on a stale one rather than letting it ship.
