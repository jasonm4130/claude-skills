# workflow-model-guard

A Claude Code plugin that stops high-fan-out **Workflow** runs from silently spending
Opus 4.8 on every worker agent.

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

It denies a `Workflow` call only when **both** hold:

- The script sets **no** `model:` override anywhere, **and**
- The script looks **expensive**: `parallel(`/`pipeline(` fan-out, OR ≥ 4 static
  `agent(` calls, OR a `while`/`for`/`budget.remaining` loop with at least one agent.

Small workflows (1–3 plain `agent()` calls, no fan-out, no loop) pass silently, so the
hook never fights the "omit by default" norm.

## Escape hatches

Two ways to proceed past the guard:

1. **Add a `model:` override** to your worker agents (the intended fix).
2. **Add a `// model-guard:ack` comment** to the script — asserts that all-Opus is
   genuinely wanted, so the workflow runs without being re-blocked.

## Install

This plugin ships in the `jasonm4130-claude-skills` marketplace. Enable it like the
other plugins in this repo (`/plugin`), or point Claude Code at the marketplace and
add `workflow-model-guard`.

## How it works

One stateless hook — no flag files, no event log, no external services.

```
workflow-model-guard/
├── .claude-plugin/plugin.json
├── hooks/hooks.json                                  — PreToolUse, matcher "Workflow"
├── scripts/
│   ├── lib.mjs                                       — readStdin + safeJsonParse + emitPermissionDecision
│   └── pretooluse-guard-workflow-model.mjs           — the guard
└── tests/
    └── pretooluse-guard-workflow-model.test.mjs
```

On each `Workflow` call the hook reads `tool_input.script`, applies the bypass checks
and the scale gate, and either exits silently (allow) or emits a `deny`
`hookSpecificOutput` envelope whose `permissionDecisionReason` is fed back to Claude.

## Development

```bash
# Run the test suite
node --test plugins/workflow-model-guard/tests/

# Manual smoke test — expensive workflow, no model → deny envelope on stdout
echo '{"tool_name":"Workflow","tool_input":{"script":"await parallel(items.map(i => () => agent(\"do\")))"}}' \
  | node plugins/workflow-model-guard/scripts/pretooluse-guard-workflow-model.mjs
```

## Dependencies

- **Node.js 18+ on PATH.** No third-party packages, no `package.json`. Stdlib only.
- **Claude Code >= 2.1.110** — for `hooks.json` plugin hook registration.
