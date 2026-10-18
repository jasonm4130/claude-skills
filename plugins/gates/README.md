# gates

A bundle. Installing `gates` installs every gates unit; `gates` itself ships no hooks,
only a `dependencies` list. Install a unit on its own to take only that guard.

| Unit | What it gates | Runs on |
|---|---|---|
| [`gates-docs`](https://github.com/jasonm4130/claude-skills/blob/main/plugins/gates-docs/README.md) | a `git commit` that changes code without its covering docs; a nudge when docs drift apart | Node |
| [`gates-models`](https://github.com/jasonm4130/claude-skills/blob/main/plugins/gates-models/README.md) | a fan-out `Workflow` script or an `Agent` dispatch with no explicit model | macOS binary, Node elsewhere |
| [`gates-config`](https://github.com/jasonm4130/claude-skills/blob/main/plugins/gates-config/README.md) | a write that leaves `settings.json` / `.mcp.json` unparseable | macOS binary only |
| [`gates-signing`](https://github.com/jasonm4130/claude-skills/blob/main/plugins/gates-signing/README.md) | a git or SSH failure caused by a locked 1Password agent | Node |

| Gate | Fires on | Decision | Ack marker |
|---|---|---|---|
| **docs-sync** | `git commit` that changes code without staging its covering docs | deny | `docs-sync:ack` |
| **workflow-model** | a `Workflow` script that fans out with no per-agent `model:` | deny | `model-guard:ack` |
| **agent-model** | an `Agent` dispatch that omits `model` | deny | set `model` |
| **json-config-guard** | a write that leaves `settings.json` / `.mcp.json` unparseable | reports after the fact (exit 2) | fix the syntax |
| **signing-nudge** | a Bash failure caused by a locked 1Password SSH agent (git signing, SSH push) | adds context telling Claude to ask you to unlock instead of retrying | none needed |
| **consolidation trigger** | a repo that has moved far since its docs were last checked *against each other* | in-session nudge, never blocks | `/docs-consolidate --defer` |

They share a design: no flag files, no session state,
fail open on anything they cannot decide, and route the decision to whoever can
actually resolve it — `deny` when Claude can fix the thing itself, `ask` when only
the human can see what the hook cannot.

## Install

```
/plugin install gates@jasonm4130-claude-skills          # every unit
/plugin install gates-models@jasonm4130-claude-skills   # or one unit alone
```

A fresh install of the bundle installs all four units.

### Upgrading from gates 0.6.x

Up to 0.6.x, `gates` carried every hook itself. From 0.7.0 it carries none and depends
on the units instead. `claude plugin update gates@jasonm4130-claude-skills` fetches the
new bundle but does not install the units, so `gates` shows "failed to load" and no
gate runs until they are installed. Each `claude plugin install
gates@jasonm4130-claude-skills` or `/reload-plugins` adds one missing unit (measured on
Claude Code 2.1.301), so either run that until `claude plugin list` shows `gates`
enabled, or install the units directly:

```
claude plugin install gates-docs@jasonm4130-claude-skills
claude plugin install gates-models@jasonm4130-claude-skills
claude plugin install gates-config@jasonm4130-claude-skills
claude plugin install gates-signing@jasonm4130-claude-skills
```

`scripts/update-plugins.sh` in the repo does this for you. The consolidation trigger's
nudge flag and throttle lived in `gates`'s plugin data directory and do not carry over
to `gates-docs`; the cost is at most one repeat nudge. `GATES_DISABLE` keeps working
unchanged.

---

## Turning a gate off

`GATES_DISABLE` names the gates that must not run, comma separated. Put it in the
`env` block of a `settings.json`. Claude Code applies that block to the session,
and hook subprocesses inherit it.

```jsonc
// ~/.claude/settings.json — every session
// <repo>/.claude/settings.json — this project only
{
  "env": { "GATES_DISABLE": "docs-sync,agent-model" }
}
```

| Name | Turns off |
|---|---|
| `docs-sync` | the docs-sync gate |
| `workflow-model` | the `Workflow` model gate |
| `agent-model` | the `Agent` model gate |
| `json-config-guard` | the JSON config guard |
| `docs-consolidate` | the consolidation trigger, both of its hooks |
| `signing-nudge` | the 1Password signing nudge |

Matching is exact, so `DOCS-SYNC` and `docs_sync` disable nothing. An
unrecognised name is ignored in silence, because a guard that shouts about its own
configuration is worse than one that misses. If a gate still fires, check the
spelling against this table first.

There is no per-gate file to edit and no restart. A disabled gate exits 0 before it
reads anything, so it costs one process start and nothing else.
