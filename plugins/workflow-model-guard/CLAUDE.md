# workflow-model-guard — Claude Code Plugin

## What this is

Two `PreToolUse` hooks that keep sub-model choices deliberate:

- **Workflow guard** (matcher `Workflow`): stops a high-fan-out Workflow run from
  silently defaulting every worker agent to the main-loop model. For a script it can
  read — inline `script` or one read from `scriptPath` — it **denies** when there's no
  per-agent `model:` override; the reason is fed back to Claude, which tiers the workers
  and re-runs. For a `name:`-invoked built-in it can't edit (e.g. the `deep-research`
  harness), it **asks the user** instead, since a deny would dead-end.
- **Agent guard** (matcher `Agent`, since 0.3.0): **denies** an ad-hoc Agent dispatch
  that omits the `model` param, unless the type is `fork` (model param ignored by
  design) or the `subagent_type` resolves to a custom agent definition with pinned
  frontmatter `model:` (≠ `inherit`). Any explicit `model` — including `fable` — passes:
  setting it IS the ack. Design rationale + probe evidence:
  [`RESEARCH_delegation_model_tiering.md`](https://github.com/jasonm4130/claude-skills/blob/main/RESEARCH_delegation_model_tiering.md).

## Plugin structure

```
workflow-model-guard/
├── .claude-plugin/
│   └── plugin.json                          — name, version, author, engines
├── hooks/
│   └── hooks.json                           — PreToolUse, matchers "Workflow" + "Agent"
├── scripts/
│   ├── lib.mjs                              — readStdin + safeJsonParse + emitPermissionDecision
│   ├── pretooluse-guard-workflow-model.mjs  — the Workflow guard
│   └── pretooluse-guard-agent-model.mjs     — the Agent guard
├── tests/
│   ├── pretooluse-guard-workflow-model.test.mjs
│   └── pretooluse-guard-agent-model.test.mjs
├── README.md
└── CLAUDE.md                                — this file
```

## How it works

The hook is **stateless** — no JSONL log, no flag files, no external services. On each
`Workflow` call it first resolves a script to inspect:

- **inline `tool_input.script`** → inspect it directly.
- **`tool_input.scriptPath`** → read the file off disk and inspect it the same way. An
  unreadable path → `exit 0`.
- **`tool_input.name`** (no script to read or rewrite) → if the name is on `NAME_DENYLIST`
  (known all-Opus built-ins like `deep-research`) emit an **`ask`** envelope so the *user*
  decides; otherwise → `exit 0`.

With a script in hand (inline or from `scriptPath`):

1. **Bypass** — `script` contains `model:` (tiers already considered) OR the marker
   `model-guard:ack` (all-Opus intent asserted) → `exit 0`.
2. **Scale gate** — `expensive = agentCount >= 4 OR parallel(/pipeline( OR
   (while/for/budget.remaining AND agentCount >= 1)`. If not expensive → `exit 0`.
3. **Otherwise** → emit a `deny` `hookSpecificOutput` envelope; Claude gets the reason and
   revises the script (inline or the `scriptPath` file) + re-runs.

**Why `ask` for `name:` but `deny` for scripts?** A `deny` is meant to make Claude
*rewrite* the offending script — but a built-in/saved `name:` workflow isn't editable from
the session, so a deny would dead-end (and there's nowhere to put a `model-guard:ack`
marker). `ask` routes the call to the human, who can switch the session to Sonnet
(`/model sonnet`) so the inherited model is cheap, or proceed on Opus deliberately. The
session model is **not** available to a PreToolUse hook (not in stdin or env), so the hook
can't auto-detect Opus-vs-Sonnet and gate on it — hence the denylist + `ask`.

**Why not a cleaner auto-fix?** The tempting alternatives were researched and tested
(2026-06-15); see README's "Alternatives & limitations" for the full write-up. Short version:
shadowing the built-in with a same-named `.claude/workflows/deep-research.js` **does not work**
(name resolution hits the built-in first; verified empirically), `CLAUDE_CODE_SUBAGENT_MODEL`
is the only session lever but is global/blunt + startup-read, and there's no `--workflow-model`
flag. The `ask` stays the least-bad surgical option.

`agentCount` is a static lower bound (`/\bagent\s*\(/g`); loops and `.map()` over items
mean the real spawn count is higher, so fan-out/loop presence is the stronger signal.

The detection is heuristic on purpose: it errs toward silence on small workflows and
only speaks up on clearly-expensive ones, so it doesn't fight the Workflow tool's own
"omit `model` by default" guidance.

### The Agent guard

Stateless like the Workflow guard. On each `Agent` call:

1. `tool_input.model` set (any non-empty string) → `exit 0`. Explicit = deliberate;
   there is no separate ack marker because the model param itself is the ack.
2. `subagent_type === "fork"` → `exit 0` (forks always inherit; a deny would loop).
3. Scan `<cwd>/.claude/agents/*.md` then `~/.claude/agents/*.md` (that precedence,
   mirroring Claude Code's own project-over-user resolution); match frontmatter `name:`
   first, filename second. First resolving definition decides: pinned `model:`
   (≠ `inherit`) → `exit 0`, otherwise fall through.
4. Deny with the tier calculus (sonnet for search/mechanical/verify, haiku for
   enumeration, opus/fable deliberately).

No scale gate — one frontier dispatch is the unit of waste, and the deny costs one
round trip. The session model still isn't visible to hooks, so Sonnet-driven sessions
pay the same nudge; accepted (explicit tiers are correct hygiene there too).

**Empirical grounding (2026-07-11, Claude Code 2.1.206, sandboxed `claude -p` probes):**
PreToolUse fires on `Agent` dispatches (stale issue #56151 doesn't reproduce), `deny` is
enforced — subagent never spawns, reason reaches the model (#44534 doesn't reproduce),
and `updatedInput` can silently rewrite the dispatch model (rejected as design: hides
the decision). The legacy `Task` matcher also fires for `Agent` calls — never register
both, or the guard double-fires. Re-verify after major Claude Code upgrades.

## The compiled guards (0.4.0)

Both hooks now run a committed Rust binary, with the `.mjs` as fallback:

```
"${CLAUDE_PLUGIN_ROOT}/bin/ccguard" agent-model    "${CLAUDE_PLUGIN_ROOT}/scripts/pretooluse-guard-agent-model.mjs"    || node "${CLAUDE_PLUGIN_ROOT}/scripts/pretooluse-guard-agent-model.mjs"
"${CLAUDE_PLUGIN_ROOT}/bin/ccguard" workflow-model "${CLAUDE_PLUGIN_ROOT}/scripts/pretooluse-guard-workflow-model.mjs" || node "${CLAUDE_PLUGIN_ROOT}/scripts/pretooluse-guard-workflow-model.mjs"
```

35.7ms → 3.1ms on the Agent guard, which fires on every dispatch.

The `.mjs` path appears twice on purpose, covering two different failures. The
`||` catches a binary that never executes (127 missing, 126 wrong architecture),
where stdin is untouched and node just reads the payload — that is what keeps
Linux and Intel Macs working. The **argv** catches a binary that ran but hit a
payload it cannot represent, where the `||` is useless because stdin has already
been drained and a shell cannot rewind a pipe; the binary spawns node itself and
forwards the answer. Since 0.4.2 — before it, an `$HOME`-less environment made the
Agent guard deny dispatches node allows, with no way to hand the question over.
Details in `rust/README.md`.

**The `.mjs` files are not dead code — do not delete them.** They are both the
fallback and the reference implementation that
`scripts/ccguard-differential.test.mjs` checks the binary against. **Any behaviour
change must land in BOTH**, or that test fails. Note the Agent guard reads
`~/.claude/agents/*.md` and the project's `.claude/agents/*.md`: the Rust port
sorts directory entries where `readdirSync` does not, which only becomes visible
if two definitions declare the same frontmatter `name` — sorted at least makes the
winner reproducible.

Source lives in `rust/` (shared with `design-gate-guard`); see `rust/README.md`.

## Dependencies

- **On arm64 macOS: nothing.** Since 0.4.0 both hooks run the committed `bin/ccguard`
  binary (see "The compiled guards" above); the `.mjs` fallback is what needs Node.
- **Everywhere else: Node.js 18+ on PATH.** No third-party packages, no `package.json`. Stdlib only.
  Node is an external prerequisite Claude Code does not ship — install it via Homebrew, WinGet, or your distro's package manager. Without it the hook cannot run and the guard fails open (Claude Code shows a non-blocking `hook error` per matching event). Why there is no silent-skip: `scripts/hook-runtime-guard.test.mjs`.
- **Claude Code >= 2.1.110** — required for `hooks.json` plugin hook registration.

## Development

```bash
# Run all tests
node --test plugins/workflow-model-guard/tests/*.test.mjs
node --test scripts/ccguard-differential.test.mjs        # binary vs .mjs equivalence
cargo test --release --manifest-path rust/Cargo.toml     # the binary's own units

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
