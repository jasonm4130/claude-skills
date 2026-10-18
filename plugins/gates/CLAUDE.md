# gates — Claude Code Plugin

## What this is

A bundle. `plugin.json` holds a `dependencies` list naming the four units and nothing
else: no hooks, no scripts, no binary. `scripts/gates-units.test.mjs` fails if a
component lands here.

| Unit | Hooks |
|---|---|
| `gates-docs` | PreToolUse `Bash` (docs-sync), Stop + UserPromptSubmit (consolidation trigger), the `docs-consolidate` skill |
| `gates-models` | PreToolUse `Workflow` and `Agent`, `bin/ccguard` with `.mjs` fallbacks |
| `gates-config` | PostToolUse `Edit\|Write\|MultiEdit\|Bash` (json-config-guard), `bin/ccguard`, and the Go source in `go/` |
| `gates-signing` | PostToolUseFailure `Bash` (signing-nudge) |

## Why it was split (gates 0.7.0, 2026-10-16)

Up to 0.6.x every guard lived in this one plugin. A user who wanted only the Agent
model guard also took the docs commit gate, the consolidation trigger, the JSON-config
guard and the signing nudge, because Claude Code enables and disables whole plugins and
has no per-hook switch. `GATES_DISABLE` turns a guard off, but the user still has to
learn the list exists.

The 2026-09-04 guards packaging verdict (under `docs/research/` in the repo) chose one
plugin, partly because "Claude Code has no dependency field" and a unit installed
without its shared binary plugin would sit silently inert. Both premises changed:
`plugin.json` now takes `dependencies`, and no unit depends on another. Each carries its
own `lib.mjs` and, where it needs one, its own `bin/ccguard`. The verdict's version-churn
point still holds for the binary: `gates-models` and `gates-config` ship the same bytes,
so a rebuild that changes them bumps both.

**Updating an existing install does not install new dependencies in one step.**
Measured on Claude Code 2.1.301 in a scratch `CLAUDE_CONFIG_DIR` against a local
marketplace: a fresh `claude plugin install` of a bundle installs every dependency, but
`claude plugin update` of an installed plugin that gains dependencies installs none, and
the plugin shows "failed to load". Each later `claude plugin install <bundle>` or
`/reload-plugins` adds one missing dependency. The bundle ships no hooks, so between
the update and the last unit landing, the missing units' gates do not run.
`scripts/update-plugins.sh` re-runs the install until no dependency is reported missing,
and the README gives the per-unit install commands.

**Plugin data does not carry over.** `CLAUDE_PLUGIN_DATA` is keyed by plugin id, so
`gates-docs` starts with an empty data dir. Only the consolidation trigger used
`gates`'s: its nudge flag and per-session throttle. Losing them costs at most one repeat
nudge. The defer marker lives in `.git/`, not the data dir, so it is unaffected.

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

## Design decisions — per-gate disable (2026-09-14)

`GATES_DISABLE` is a comma-separated list of gate names, read from the environment.
The 2026-09-04 guards packaging verdict deferred this as amendment 4, "until someone
asks for it". Someone asked. The verdict lives in the repo under `docs/research/`:
https://github.com/jasonm4130/claude-skills

**Why an environment variable and not a config file.** A Claude Code `settings.json`
`env` block reaches hook subprocesses, verified by running a hook that echoed the
variable back. That gives per-project and per-user scope for free, from machinery
that already exists. A config file would need a path convention, a parser, a
precedence chain and a fail-open posture for malformed input, and would buy nothing
the `env` block does not already give. `resolveConsolidateThreshold` set the
precedent here in 2026-07-25.

**Why the list and not one variable per gate.** Seven booleans is seven names to
remember and seven to keep documented. One list adds a gate by adding a row to the
README table.

**Why both implementations carry the parser.** `go/config.go` (in gates-config) and
each unit's `lib.mjs` read the same variable the same way, and that duplication is
deliberate. The binary exits 0 when a gate is disabled, so `|| node` never fires on a
machine that runs the binary.
It fires on every machine that does not — Linux, Intel Mac, a stripped install — and
`docs-sync` and `docs-consolidate` have no binary path at all. Disable in Go alone
and the gate comes back wherever the fallback runs.

That duplication is the reason the disabled cases live in
`scripts/ccguard-differential.test.mjs` rather than only in the per-side suites. A
Mac is arm64, the binary always wins locally, and a Go-only test passes while the
node path stays live. The corpus runs both.

**Why the check sits after the stdin drain, not before it.** `go/main.go` already
drains stdin before dispatch so an unknown subcommand cannot hand the writer an
EPIPE. A disabled gate has the same obligation, so the node guards match that
ordering rather than exiting first.

**Why an unrecognised name is silent.** Same fail-open posture as the guards. These
hooks run on every matching tool call, so a warning about a typo would be a warning
on every call. The README table is the reference.

## Development

Each unit has its own suite under `plugins/<unit>/tests/`. `bash scripts/run-node-tests.sh`
runs every one, and `scripts/gates-units.test.mjs` pins which unit owns which hook.
