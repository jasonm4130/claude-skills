# workflow-model-guard — Claude Code Plugin

## What this is

A single `PreToolUse` hook (matcher `Workflow`) that denies a high-fan-out Workflow
call when the script sets no per-agent `model:` override — so worker agents don't
silently all default to the main-loop model (Opus 4.8) and burn usage limits. The deny
reason is fed back to Claude, which revises the script to tier its workers and re-runs.

## Plugin structure

```
workflow-model-guard/
├── .claude-plugin/
│   └── plugin.json                          — name, version, author, engines
├── hooks/
│   └── hooks.json                           — PreToolUse, matcher "Workflow"
├── scripts/
│   ├── lib.mjs                              — readStdin + safeJsonParse + emitPermissionDecision
│   └── pretooluse-guard-workflow-model.mjs  — the guard
├── tests/
│   └── pretooluse-guard-workflow-model.test.mjs
├── README.md
└── CLAUDE.md                                — this file
```

## How it works

The hook is **stateless** — no JSONL log, no flag files, no external services. On each
`Workflow` call it reads the inline `tool_input.script` and decides:

1. **Not a Workflow call, or no inline `script`** (a `scriptPath`/`name` re-run) → `exit 0`.
2. **Bypass** — `script` contains `model:` (tiers already considered) OR the marker
   `model-guard:ack` (all-Opus intent asserted) → `exit 0`.
3. **Scale gate** — `expensive = agentCount >= 4 OR parallel(/pipeline( OR
   (while/for/budget.remaining AND agentCount >= 1)`. If not expensive → `exit 0`.
4. **Otherwise** → emit a `deny` `hookSpecificOutput` envelope; Claude gets the reason
   and revises.

`agentCount` is a static lower bound (`/\bagent\s*\(/g`); loops and `.map()` over items
mean the real spawn count is higher, so fan-out/loop presence is the stronger signal.

The detection is heuristic on purpose: it errs toward silence on small workflows and
only speaks up on clearly-expensive ones, so it doesn't fight the Workflow tool's own
"omit `model` by default" guidance.

## Dependencies

- **Node.js 18+ on PATH.** No third-party packages, no `package.json`. Stdlib only.
- **Claude Code >= 2.1.110** — required for `hooks.json` plugin hook registration.

## Development

```bash
# Run all tests
node --test plugins/workflow-model-guard/tests/

# Manual smoke test (expensive workflow, no model → deny envelope)
echo '{"tool_name":"Workflow","tool_input":{"script":"await parallel(items.map(i => () => agent(\"do\")))"}}' \
  | node plugins/workflow-model-guard/scripts/pretooluse-guard-workflow-model.mjs
```

## Conventions

- **ESM only.** Every script is `.mjs`. No CommonJS, no `package.json`, no `require`.
- **Stdlib only.** Allowed imports: `node:fs`, `node:path`, `node:os`, `node:process`,
  `node:child_process`, `node:url`, `node:test`, `node:assert/strict`.
- **`// @ts-check` at the top of every file**, with JSDoc `@typedef` for stdin payload
  shapes. Editors get IntelliSense without a build step.
- **Graceful degradation.** Any JSON parse error or missing payload → `process.exit(0)`
  silently. The hook never crashes the session.
- **Own `lib.mjs`.** Duplicates the `readStdin`/`safeJsonParse` surface of the other
  plugins — CC plugins can't share files across boundaries, so duplication is intentional.
- **Deny output** uses the `hookSpecificOutput` envelope with `permissionDecision` /
  `permissionDecisionReason` (the reliably-documented PreToolUse feedback channel).
