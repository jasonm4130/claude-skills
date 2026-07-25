# workflow-model-guard

A Claude Code plugin that stops high-fan-out **Workflow** runs — and, since 0.3.0,
ad-hoc **Agent** dispatches — from silently spending the frontier-tier session model
on every worker agent.

## Why

The `Workflow` tool spawns sub-agents that **inherit the main-loop model** unless each
`agent()` call passes `opts.model`. The tool's own guidance says "omit `model` by
default" — fine for a 1–3 agent workflow, but a `parallel`/`pipeline` fan-out or a
loop-until-budget runs *every* spawned agent on Opus 4.8 and burns usage limits fast.

This plugin adds a single `PreToolUse` hook that inspects the workflow script and, when
it looks expensive and sets no model tiers, **denies the call with a reason**. Claude
then revises the script — giving workers `model:'claude-sonnet-4-6'` or
`'claude-haiku-4-5'` — and re-runs. The deny is self-clearing: once any `model:` appears,
the call passes.

## When it fires

The hook handles all three `Workflow` invocation forms:

**Inline `script` or `scriptPath`** (a script it can read) — it **denies** the call only
when **both** hold:

- The script sets **no** `model:` override anywhere, **and**
- The script looks **expensive**: `parallel(`/`pipeline(` fan-out, OR ≥ 4 static
  `agent(` calls, OR a `while`/`for`/`budget.remaining` loop with at least one agent.

Small workflows (1–3 plain `agent()` calls, no fan-out, no loop) pass silently, so the
hook never fights the "omit by default" norm. An unreadable `scriptPath` passes silently.

**Named `name:` workflows** — the hook can't read or rewrite a built-in/saved workflow,
so a `deny` (which exists to make Claude *edit the script*) would dead-end. For names on
its denylist (currently just `deep-research`, the all-Opus built-in harness) it emits an
**`ask`** so *you* decide; every other named workflow passes silently.

**Ad-hoc `Agent` dispatches** (second hook, matcher `Agent`) — an Agent call with no
`model` param inherits the session model, and measured usage showed 73% of 477 dispatches
doing exactly that (the built-in Explore agent inherited in 71/75). The hook **denies**
a dispatch that omits `model`, unless:

- `model` is set — **any** tier, including `opus`/`fable`. Setting it *is* the ack; the
  goal is a deliberate per-dispatch choice, not a cheap-only policy.
- `subagent_type` is `fork` — forks always inherit; the `model` param is ignored for
  them, so a deny could never be resolved.
- the `subagent_type` resolves to a custom agent definition (project `.claude/agents/`
  over `~/.claude/agents/`, matched by frontmatter `name:` then filename) whose
  frontmatter pins `model:` (≠ `inherit`) — Claude Code applies that tier on its own.

There is no scale gate here: a single frontier dispatch is the unit of waste, and the
fix costs one round trip (Claude re-dispatches with an explicit tier). Known
limitation: the session model isn't visible to hooks, so a Sonnet-driven session pays
the same one-round-trip nudge — the explicit tier is correct hygiene there anyway.
Verified on Claude Code 2.1.206 (2026-07-11 probes): the hook fires on `Agent` calls,
sees `subagent_type`/`model`, and `deny` is enforced; older reports of Agent-matcher
hooks not firing (#56151) or deny being ignored (#44534) don't reproduce. Note the
legacy `Task` matcher *also* fires for Agent calls — register one matcher, never both.

## Escape hatches

For an inline/`scriptPath` workflow (a `deny`), two ways to proceed:

1. **Add a `model:` override** to your worker agents (the intended fix).
2. **Add a `// model-guard:ack` comment** to the script — asserts that all-Opus is
   genuinely wanted, so the workflow runs without being re-blocked.

For a denylisted `name:` workflow (an `ask`), you can't edit the script, so the prompt
routes to you: approve to run it as-is, or switch the session to Sonnet first
(`/model sonnet`) so every inherited-model agent is cheap.

For an `Agent` dispatch (a `deny`), set `model` explicitly — that's both the fix and
the escape hatch (`model: 'fable'` passes if frontier reasoning is genuinely needed).
To exempt an agent type permanently, pin `model:` in its definition's frontmatter.

## Alternatives & limitations

The `ask` on a built-in `name:` workflow (e.g. `deep-research`) is a one-click-per-run
nudge, not a silent auto-fix. That's deliberate — the cleaner-sounding alternatives were
researched and tested, and each has a disqualifying catch:

- **Shadow the built-in with a same-named saved workflow** — *doesn't work.* Tested
  (2026-06-15): a uniquely-named `.claude/workflows/<x>.js` resolves fine via
  `Workflow({name})`, but a same-named `deep-research.js` does **not** shadow the built-in.
  Name resolution checks built-ins **first**, then falls through to saved files, so
  `Workflow({name:"deep-research"})` always reaches the built-in. No transparent intercept.
- **`CLAUDE_CODE_SUBAGENT_MODEL=sonnet` in your shell profile** — the only session-level
  lever, and it sits at layer 1 of model resolution (overrides per-invocation `model:` and
  subagent frontmatter). It's a real fix **if you don't run Opus subagents elsewhere**, but
  it's blunt: it forces *every* subagent in *every* session to that model — Explore, Plan,
  general-purpose, and your own `Agent` dispatches included — and it's read at **startup**
  (needs a restart). A known edge case (anthropics/claude-code#54430) showed a team-agent
  spawn path ignoring it, so verify it reaches your workers on next launch:

  ```bash
  # add to ~/.zshrc, then restart Claude Code and confirm a worker transcript shows sonnet
  export CLAUDE_CODE_SUBAGENT_MODEL=sonnet
  ```

- **Auto-detect the session model in the hook and only block on Opus** — *not possible.*
  The session model isn't exposed to a `PreToolUse` hook (not in stdin, not in any env var);
  the feature request was closed not-planned (anthropics/claude-code#37817). Only the
  `SessionStart` hook gets a `model` field, and even that is optional (absent after
  `/clear`/`compact`) and goes stale the moment you `/model`-switch mid-session.
- **A `--workflow-model` flag or per-workflow model config key** — doesn't exist. Official
  cost guidance is "check `/model` before a large run" or set `opts.model` per stage in an
  editable script.

So for an Opus-default user who wants Opus everywhere *except* the wasteful built-in
fan-out, the surgical `ask` (decline → `/model sonnet` for that run, or run this repo's
model-tiered `deep-dive` plugin instead) is the least-bad option. A
`SessionStart`→disk→`PreToolUse` bridge could upgrade the `ask` to an auto-`deny` on Opus
sessions, but it adds a stateful hook and is stale across mid-session model switches.

## Install

This plugin ships in the `jasonm4130-claude-skills` marketplace. Enable it like the
other plugins in this repo (`/plugin`), or point Claude Code at the marketplace and
add `workflow-model-guard`.

## How it works

Two stateless hooks — no flag files, no event log, no external services.

```
workflow-model-guard/
├── .claude-plugin/plugin.json
├── hooks/hooks.json                                  — PreToolUse, matchers "Workflow" + "Agent"
├── scripts/
│   ├── lib.mjs                                       — readStdin + safeJsonParse + emitPermissionDecision
│   ├── pretooluse-guard-workflow-model.mjs           — the Workflow guard
│   └── pretooluse-guard-agent-model.mjs              — the Agent guard
└── tests/
    ├── pretooluse-guard-workflow-model.test.mjs
    └── pretooluse-guard-agent-model.test.mjs
```

On each `Workflow` call the hook resolves a script to inspect — `tool_input.script`
inline, or read from `tool_input.scriptPath` — then applies the bypass checks and the
scale gate, and either exits silently (allow) or emits a `deny` `hookSpecificOutput`
envelope whose `permissionDecisionReason` is fed back to Claude. A `name:`-only call has
no script to read: denylisted names get an `ask` envelope (routed to the user), all
others pass.

## Development

```bash
# Run the test suite
node --test plugins/workflow-model-guard/tests/

# Manual smoke test — expensive workflow, no model → deny envelope on stdout
echo '{"tool_name":"Workflow","tool_input":{"script":"await parallel(items.map(i => () => agent(\"do\")))"}}' \
  | node plugins/workflow-model-guard/scripts/pretooluse-guard-workflow-model.mjs

# Manual smoke test — untiered Agent dispatch → deny envelope on stdout
echo '{"tool_name":"Agent","tool_input":{"description":"d","prompt":"p","subagent_type":"Explore"}}' \
  | node plugins/workflow-model-guard/scripts/pretooluse-guard-agent-model.mjs
```

## Dependencies

- **Node.js 18+ on PATH.** No third-party packages, no `package.json`. Stdlib only.
  Claude Code ships a self-contained native binary and its documented system requirements do not include Node, so this is an external prerequisite, not something the host provides. If `node` is missing the hook **skips silently** (exit 0) instead of erroring on every event; the reason goes to stderr, visible under `claude --debug`.
- **Claude Code >= 2.1.110** — for `hooks.json` plugin hook registration.
