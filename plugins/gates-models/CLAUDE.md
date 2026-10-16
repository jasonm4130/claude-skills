# gates-models — Claude Code Plugin

## What this is

Two `PreToolUse` gates on sub-agent model choice. Part of the `gates` bundle; the
bundle's CLAUDE.md has the split rationale and the `GATES_DISABLE` design.

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

Each gate names itself in its decision reason (`workflow-model-guard:`,
`agent-model-guard:`). Those are guard identifiers, not plugin names — both are
byte-locked to the committed `bin/ccguard`, and the differential test fails on any
drift between the two implementations' output.

## The shared design

- **Stateless, no flag files** (except the trigger, which is deliberately out of the
  blocking path). A stateful "design in progress" or "docs approved" flag has a
  catastrophic failure mode: a flag that never clears silently blocks *all* future
  work on a live session. The cost is that design-before-*editing* and
  docs-before-*any-change* are not enforced — only at their one hard boundary.
- **`deny` when Claude can fix it, `ask` when only the human can.** A `deny` is meant
  to make Claude *rewrite* the offending thing. A built-in `name:` workflow that is
  not editable from the session is unresolvable from inside the model's turn — so it
  gets `ask`, which routes to someone who can see the state the hook cannot.
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

## The compiled guards

Both guards run the committed **Go** binary and keep the `.mjs` as fallback and
reference implementation:

```
"${CLAUDE_PLUGIN_ROOT}/bin/ccguard" agent-model    "${CLAUDE_PLUGIN_ROOT}/scripts/pretooluse-guard-agent-model.mjs"    || node "${CLAUDE_PLUGIN_ROOT}/scripts/pretooluse-guard-agent-model.mjs"
"${CLAUDE_PLUGIN_ROOT}/bin/ccguard" workflow-model "${CLAUDE_PLUGIN_ROOT}/scripts/pretooluse-guard-workflow-model.mjs" || node "${CLAUDE_PLUGIN_ROOT}/scripts/pretooluse-guard-workflow-model.mjs"
```

35.7ms → 3.1ms on the Agent gate, which fires on every dispatch.

The binary's source is `go/` in the `gates-config` plugin, which runs the same binary
for its JSON-config guard. A plugin cannot reach another plugin's install directory, so
each ships a byte-identical copy of `bin/ccguard`; `go/build.sh` there writes both, and
CI and `scripts/gates-units.test.mjs` fail if they differ. Changing a model guard's Go
code therefore bumps both plugins.

The `.mjs` path appears twice on purpose: the `||` covers a binary that never executes
(127 missing, 126 wrong architecture), and the **argv** covers a binary that ran but
hit a payload it cannot represent, where the `||` is useless because stdin is already
drained. `go/README.md` in gates-config has the full argument.

**The `.mjs` files are not dead code — do not delete them.** They are both the
fallback and the reference implementation that `scripts/ccguard-differential.test.mjs`
checks the binary against. **Any behaviour change must land in BOTH**, or that test
fails — including the decision-reason strings, which is why those still say
`workflow-model-guard:` / `agent-model-guard:`. Note the Agent guard reads
`~/.claude/agents/*.md` and the project's `.claude/agents/*.md`: the Go port sorts
directory entries where `readdirSync` does not, which only becomes visible
if two definitions declare the same frontmatter `name` — sorted at least makes the
winner reproducible.

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
node --test plugins/gates-models/tests/*.test.mjs
node --test scripts/ccguard-differential.test.mjs      # binary vs .mjs equivalence
plugins/gates-config/go/build.sh                       # after a Go change: rebuild both copies
```
