# gates

Five stateless `PreToolUse` gates and one never-blocking nudge, in one plugin.
Each intercepts a *specific, high-signal action* at the moment it is about to
happen, and each carries an ack marker so a deliberate override costs one token in
history rather than a disabled hook.

| Gate | Fires on | Decision | Ack marker |
|---|---|---|---|
| **docs-sync** | `git commit` that changes code without staging its covering docs | deny | `docs-sync:ack` |
| **design-gate** | a new-project scaffold command (`npm create vite`, `cargo new`, `rails new`, …) | ask | `design-gate:ack` |
| **workflow-model** | a `Workflow` script that fans out with no per-agent `model:` | deny | `model-guard:ack` |
| **agent-model** | an `Agent` dispatch that omits `model` | deny | set `model` |
| **lsp-first** | a shell or `Grep` search for a code symbol, when its language server resolves | deny | append `(?:)` to the pattern |
| **json-config-guard** | a write that leaves `settings.json` / `.mcp.json` unparseable | reports after the fact (exit 2) | fix the syntax |
| **consolidation trigger** | a repo that has moved far since its docs were last checked *against each other* | in-session nudge, never blocks | `/docs-consolidate --defer` |

They share a plugin because they share a design: no flag files, no session state,
fail open on anything they cannot decide, and route the decision to whoever can
actually resolve it — `deny` when Claude can fix the thing itself, `ask` when only
the human can see what the hook cannot.

## Install

```
/plugin install gates@jasonm4130-claude-skills
```

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
or `AGENTS.md` is that file's covering doc set. If none of the covering docs are in
the commit, the commit is denied — this is the general failure path where the system
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

## The design gate

The brainstorming skill says, in prose:

> Do NOT ... write any code, scaffold any project, or take any implementation
> action until you have presented a design and the user has approved it.

Prose doesn't intercept anything. The classic failure is the model, on autopilot,
running `npm create vite` (or `create-next-app`, `rails new`, …) the moment a project
is mentioned — skipping the design entirely. This gate catches exactly that action and
turns it into a checkpoint: any command *segment* starting with a new-project
scaffolder emits an **`ask`**, and the user confirms whether a design was approved. It
never denies and never edits anything; a scaffold you meant to run is one keystroke
away.

### Commands it asks about

| Ecosystem | Examples |
|---|---|
| JS/TS package managers | `npm create vite`, `pnpm create`, `yarn create next-app`, `bun create`, `npm init vite` |
| `create-*` CLIs | `npx create-next-app`, `npx create-react-app`, `pnpm dlx create-astro`, `create-react-app my-app` |
| Rust | `cargo new`, `cargo init` |
| Python | `django-admin startproject`, `django-admin startapp` |
| Ruby | `rails new` |
| Angular / NestJS / Vue | `ng new`, `nest new`, `vue create` |
| Mobile | `expo init`, `flutter create` |
| .NET | `dotnet new <template>` |
| Elixir/Phoenix | `mix new`, `mix phx.new` |
| PHP | `laravel new`, `composer create-project` |
| Static site | `gatsby new`, `hugo new site`, `jekyll new` |

The match is anchored to the **start of each command segment**, so it fires on
`mkdir app && cd app && npm create vite` (later segment) and on
`FOO=bar sudo npm create vite` (env / `sudo` prefix), but **not** on a scaffold name
that only appears inside a commit message (`git commit -m "add create-react-app
docs"`), an `echo`/`printf` string, or a `dotnet new --list`.

### Why `ask`, and why only scaffolds

A PreToolUse hook can't see the conversation, so it **cannot know** whether a design
was approved — the session model and any "approval" are not in the hook's stdin or
environment. A hard `deny` would therefore dead-end a *legitimate* post-approval
scaffold with no way for the model to resolve it. `ask` routes the decision to the
human, who *can* see whether the design happened.

Gating arbitrary `Write`/`Edit` on hidden "is a design approved?" state would need a
stateful flag whose worst failure — a flag that never clears — silently blocks *all*
future editing. Every gate here is stateless for that reason. Scaffold commands are
the **high-signal, low-frequency** slice: distinctive, rare (you scaffold a project
once), and the exact documented incident. An occasional confirmation on a command you
run once per project is a cheap price; a guard that blocks your live editing is not.

Bypass with `design-gate:ack` anywhere in the command:

```bash
npm create vite@latest my-app   # design-gate:ack
```

---

## The model gates

The `Workflow` tool spawns sub-agents that **inherit the main-loop model** unless each
`agent()` call passes `opts.model`. The tool's own guidance says "omit `model` by
default" — fine for a 1–3 agent workflow, but a `parallel`/`pipeline` fan-out or a
loop-until-budget runs *every* spawned agent on whatever the session is set to, and on
a frontier-tier session that burns usage limits fast. The same applies one dispatch at
a time to `Agent`.

### Workflow (matcher `Workflow`)

**Inline `script` or `scriptPath`** (a script it can read) — **denies** only when
**both** hold:

- the script sets **no** `model:` override anywhere, **and**
- the script looks **expensive**: `parallel(`/`pipeline(` fan-out, OR ≥ 4 static
  `agent(` calls, OR a `while`/`for`/`budget.remaining` loop with at least one agent.

Small workflows (1–3 plain `agent()` calls, no fan-out, no loop) pass silently, so the
gate never fights the "omit by default" norm. An unreadable `scriptPath` passes
silently. The deny is self-clearing: once any `model:` appears, the call passes.

**Named `name:` workflows** — the hook can't read or rewrite a built-in or saved
workflow, so a `deny` (which exists to make Claude *edit the script*) would dead-end.
For names on its denylist (currently just `deep-research`) it emits an **`ask`** so
*you* decide.

That `ask` is a **cost speed-bump on a high-fan-out built-in**, not a claim about
which model the built-in runs. `deep-research` spawns many workers and pins no tier of
its own, so each one inherits the session model: cheap on a Sonnet session, expensive
on a frontier-tier one, and invisible either way until the usage graph moves. The hook
cannot see the session model (see below), so it cannot make that call for you — it
puts the run in front of you once, and you either proceed or `/model sonnet` first.

### Agent (matcher `Agent`)

An `Agent` call with no `model` param inherits the session model, and measured usage
showed 73% of 477 dispatches doing exactly that (the built-in Explore agent inherited
in 71/75). The gate **denies** a dispatch that omits `model`, unless:

- `model` is set — **any** tier, including `opus`/`fable`. Setting it *is* the ack; the
  goal is a deliberate per-dispatch choice, not a cheap-only policy.
- `subagent_type` is `fork` — forks always inherit; the `model` param is ignored for
  them, so a deny could never be resolved.
- the `subagent_type` resolves to a custom agent definition (project `.claude/agents/`
  over `~/.claude/agents/`, matched by frontmatter `name:` then filename) whose
  frontmatter pins `model:` (≠ `inherit`) — Claude Code applies that tier on its own.

There is no scale gate here: a single frontier dispatch is the unit of waste, and the
fix costs one round trip. Known limitation: the session model isn't visible to hooks,
so a Sonnet-driven session pays the same one-round-trip nudge — the explicit tier is
correct hygiene there anyway. To exempt an agent type permanently, pin `model:` in its
definition's frontmatter.

Verified on Claude Code 2.1.246 (probes re-run 2026-08-26; first run on 2.1.206,
2026-07-11): the hook fires on `Agent` calls, sees `subagent_type`/`model`, and `deny`
is enforced; older reports of Agent-matcher hooks not firing (#56151) or deny being
ignored (#44534) don't reproduce. Note the legacy `Task` matcher *also* fires for Agent
calls — register one matcher, never both. Re-verify after major Claude Code upgrades
and refresh this stamp.

### Why not a cleaner auto-fix

The tempting alternatives were researched and tested, and each has a disqualifying
catch:

- **Shadow the built-in with a same-named saved workflow** — *doesn't work.* Tested
  (2026-06-15): a uniquely-named `.claude/workflows/<x>.js` resolves fine via
  `Workflow({name})`, but a same-named `deep-research.js` does **not** shadow the
  built-in. Name resolution checks built-ins **first**, then falls through to saved
  files, so `Workflow({name:"deep-research"})` always reaches the built-in.
- **`CLAUDE_CODE_SUBAGENT_MODEL=sonnet` in your shell profile** — the only
  session-level lever, and it sits at layer 1 of model resolution (overrides
  per-invocation `model:` and subagent frontmatter). It's a real fix **if you don't run
  frontier subagents elsewhere**, but it's blunt: it forces *every* subagent in *every*
  session to that model — Explore, Plan, general-purpose, and your own `Agent`
  dispatches included — and it's read at **startup** (needs a restart). A known edge
  case (anthropics/claude-code#54430) showed a team-agent spawn path ignoring it, so
  verify it reaches your workers on next launch:

  ```bash
  # add to ~/.zshrc, then restart Claude Code and confirm a worker transcript shows sonnet
  export CLAUDE_CODE_SUBAGENT_MODEL=sonnet
  ```

- **Auto-detect the session model in the hook and gate only on the expensive tier** —
  *not possible.* The session model isn't exposed to a `PreToolUse` hook (not in stdin,
  not in any env var); the feature request was closed not-planned
  (anthropics/claude-code#37817). Only the `SessionStart` hook gets a `model` field, and
  even that is optional (absent after `/clear`/`compact`) and goes stale the moment you
  `/model`-switch mid-session.
- **A `--workflow-model` flag or per-workflow model config key** — doesn't exist.
  Official cost guidance is "check `/model` before a large run" or set `opts.model` per
  stage in an editable script.

A `SessionStart`→disk→`PreToolUse` bridge could upgrade the `ask` to an auto-`deny`,
but it adds a stateful hook and is stale across mid-session model switches — which is
exactly the failure mode every gate here is built to avoid.

---

## The consolidation trigger

The gates above answer "did this change update its covering docs?". This answers
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
`gates:docs-consolidate` skill — at most once per session, re-armed only when HEAD
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
gates/
├── .claude-plugin/plugin.json
├── bin/ccguard                                 — committed Go binary, universal
│                                                 (design-gate, workflow-model,
│                                                 agent-model, lsp-first,
│                                                 json-config-guard)
├── hooks/hooks.json                            — PreToolUse (Bash, Workflow, Agent),
│                                                 Stop, UserPromptSubmit
├── scripts/
│   ├── lib.mjs                                 — hook I/O + the drift engine
│   ├── pretooluse-guard-docs-sync.mjs          — the commit gate
│   ├── pretooluse-guard-design-gate.mjs        — the scaffold gate
│   ├── pretooluse-guard-workflow-model.mjs     — the Workflow gate
│   ├── pretooluse-guard-agent-model.mjs        — the Agent gate
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

Each gate names itself in its decision reason (`docs-sync-guard:`, `design-gate-guard:`,
`workflow-model-guard:`, `agent-model-guard:`), so a denial says which gate spoke.

## Dependencies

- **The design-gate, workflow-model and agent-model gates on arm64 macOS: nothing.**
  They run `bin/ccguard`, a committed static binary with no runtime dependency at all
  (36.1ms → 2.9ms; see `go/README.md` in the repo).
- **Everywhere else, and the docs-sync gate and consolidation trigger everywhere:
  Node.js 18+ on PATH**, plus git for the docs-sync gate and the trigger. The compiled
  hook commands are `bin/ccguard <sub> "…/scripts/….mjs" || node "…/scripts/….mjs"`, so
  on Linux or an Intel Mac the binary fails to exec and the original `.mjs` guard runs
  instead — same behaviour, just without the speedup. (The path is passed twice
  deliberately; `go/README.md` explains which failure each copy covers.) Node is an
  external prerequisite Claude Code does not ship — install it via Homebrew, WinGet, or
  your distro's package manager. With neither the binary nor Node the hook cannot run
  and the gate fails open (a non-blocking `hook error` per matching event). Why there is
  no silent-skip: `scripts/hook-runtime-guard.test.mjs`.
- **Claude Code >= 2.1.110** — for `hooks.json` plugin hook registration.

## Development

```bash
node --test plugins/gates/tests/*.test.mjs          # real temp git repos throughout
node --test scripts/ccguard-differential.test.mjs   # binary vs .mjs equivalence

# Manual smoke test — code staged, docs not → deny envelope on stdout
echo '{"tool_name":"Bash","tool_input":{"command":"git commit -m x"},"cwd":"<repo-with-staged-plugin-code>"}' \
  | node plugins/gates/scripts/pretooluse-guard-docs-sync.mjs

# Manual smoke test — scaffold → ask envelope
echo '{"tool_name":"Bash","tool_input":{"command":"npm create vite@latest app"}}' \
  | node plugins/gates/scripts/pretooluse-guard-design-gate.mjs

# Manual smoke test — expensive workflow, no model → deny envelope
echo '{"tool_name":"Workflow","tool_input":{"script":"await parallel(items.map(i => () => agent(\"do\")))"}}' \
  | node plugins/gates/scripts/pretooluse-guard-workflow-model.mjs

# Manual smoke test — untiered Agent dispatch → deny envelope
echo '{"tool_name":"Agent","tool_input":{"description":"d","prompt":"p","subagent_type":"Explore"}}' \
  | node plugins/gates/scripts/pretooluse-guard-agent-model.mjs
```
