# gates-models

Two `PreToolUse` gates that make every sub-agent's model a deliberate choice: one on
`Workflow` scripts that fan out, one on `Agent` dispatches.

| Gate | Fires on | Decision | Ack marker |
|---|---|---|---|
| **workflow-model** | a `Workflow` script that fans out with no per-agent `model:` | deny | `model-guard:ack` |
| **agent-model** | an `Agent` dispatch that omits `model` | deny | set `model` |

Part of the `gates` bundle. It installs on its own: nothing here needs another
gates unit.

## Install

```
/plugin install gates-models@jasonm4130-claude-skills
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
  "env": { "GATES_DISABLE": "agent-model" }
}
```

| Name | Turns off |
|---|---|
| `agent-model` | the `Agent` model gate |
| `workflow-model` | the `Workflow` model gate |

Matching is exact, so a name in the wrong case or with `_` for `-` disables nothing,
and an unrecognised name is ignored in silence.

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

## How it works

```
gates-models/
├── .claude-plugin/plugin.json
├── bin/ccguard                                 — committed Go binary, universal
│                                                 (workflow-model, agent-model)
├── hooks/hooks.json                            — PreToolUse (Workflow, Agent)
├── scripts/
│   ├── lib.mjs                                 — hook I/O
│   ├── pretooluse-guard-workflow-model.mjs     — the Workflow gate: fallback + reference
│   └── pretooluse-guard-agent-model.mjs        — the Agent gate: fallback + reference
└── tests/                                      — one suite per script
```

Each gate names itself in its decision reason (`workflow-model-guard:`,
`agent-model-guard:`), so a denial says which gate spoke.

`bin/ccguard` is built from the Go source that ships in the `gates-config` plugin, which
runs the same binary for its JSON-config guard. A plugin cannot reach another plugin's
install directory, so each carries a byte-identical copy.

## Dependencies

- **On macOS: nothing.** The gates run `bin/ccguard`, a committed universal binary with
  no runtime dependency at all (35.7ms → 3.1ms on the Agent gate).
- **Elsewhere: Node.js 18+ on PATH.** The hook commands are
  `bin/ccguard <sub> "…/scripts/….mjs" || node "…/scripts/….mjs"`, so on Linux the
  binary fails to exec and the original `.mjs` guard runs instead — same behaviour,
  just without the speedup. (The path is passed twice deliberately; `go/README.md` in
  `gates-config` explains which failure each copy covers.) With neither the binary nor
  Node the hook cannot run and the gate fails open. Why there is no silent-skip:
  `scripts/hook-runtime-guard.test.mjs`.
- **Claude Code >= 2.1.110** — for `hooks.json` plugin hook registration.

## Development

```bash
node --test plugins/gates-models/tests/*.test.mjs
node --test scripts/ccguard-differential.test.mjs   # binary vs .mjs equivalence

# Manual smoke test — expensive workflow, no model → deny envelope
echo '{"tool_name":"Workflow","tool_input":{"script":"await parallel(items.map(i => () => agent(\"do\")))"}}' \
  | node plugins/gates-models/scripts/pretooluse-guard-workflow-model.mjs

# Manual smoke test — untiered Agent dispatch → deny envelope
echo '{"tool_name":"Agent","tool_input":{"description":"d","prompt":"p","subagent_type":"Explore"}}' \
  | node plugins/gates-models/scripts/pretooluse-guard-agent-model.mjs
```
