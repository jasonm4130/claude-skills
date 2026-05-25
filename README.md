# jm-skills

A Claude Code plugin **marketplace** hosting multiple independent plugins. Install the whole marketplace with one command, then pick which plugins to enable.

## Install

### Add the marketplace

```
/plugin marketplace add jasonm4130/claude-skills
```

### Install individual plugins

| Plugin | Description | Install command |
|---|---|---|
| `adversarial-agents` | Configurable adversarial panel review for any artefact | `/plugin install adversarial-agents@jasonm4130-claude-skills` |
| `deep-research` | Multi-source research via parallel sub-agents and synthesis | `/plugin install deep-research@jasonm4130-claude-skills` |
| `session-retro` | Interactive session retrospectives that capture learnings to memory | `/plugin install session-retro@jasonm4130-claude-skills` |
| `handoff` | Context-fill-triggered handoff skill that auto-loads on next session | `/plugin install handoff@jasonm4130-claude-skills` |

For full details on each plugin, see its own README:
- [`plugins/adversarial-agents/README.md`](plugins/adversarial-agents/README.md)
- [`plugins/deep-research/README.md`](plugins/deep-research/README.md)
- [`plugins/session-retro/README.md`](plugins/session-retro/README.md)
- [`plugins/handoff/README.md`](plugins/handoff/README.md)

> **Note for handoff + session-retro users:** Both plugins now require **Node.js 18+** on `PATH` (one-time install via Homebrew, WinGet, or your distro's package manager). The handoff plugin also needs a one-time `statusLine` wire-up — run `node "$(echo ~/.claude/plugins/cache/jasonm4130-claude-skills/handoff/0.2.0)/scripts/setup.mjs"` after install. See [`plugins/handoff/README.md`](plugins/handoff/README.md) for details.

## Skills

### `adversarial-agents`

Configurable adversarial panel review for any artefact — plans, code, design docs, prose, model outputs.

- **Panel auto-selection by artefact type** (plan → YAGNI/Premortem/Hidden Assumptions; code → Saboteur/New Hire/Security Auditor; prose → Clarity/Hostile Reader/Devil's Advocate; etc.)
- **Pre-commitment gate** — user defends the artefact before the panel attacks, neutralising leading-question sycophancy
- **Shared adversary contract** — mandatory ≥1 finding per persona, named anti-rationalization failure modes
- **`[CONVERGED]` overlap promotion** — critiques surfaced by 2+ personas walked first
- **Verbatim-substance standing rule** — parent quotes critic verbatim to resist capability-asymmetry drift
- **Dog-with-bone walk** with deadlock cap at 3 counter-pushes

Trigger phrases include `grill me`, `stress-test this`, `red-team`, `adversarial review`, `panel critique`, `find holes`.

### `deep-research`

Multi-source research with DAG-planned dispatch, cost-aware model selection (Haiku critics + Sonnet synthesis + Opus orchestrator), and three-pass synthesis (critic → citation-quality judge → final-judge).

Follows the lead-researcher → parallel sub-agents → synthesis pattern from [Anthropic's multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system), extended with 2025–26 patterns (plan-as-DAG, role-separated critic vs judge, asymmetric models).

## Install

This plugin uses the Claude Code plugin marketplace mechanism. Add to your `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "jasonm4130-claude-skills": {
      "source": { "source": "github", "repo": "jasonm4130/claude-skills" }
    }
  },
  "enabledPlugins": {
    "jm-skills@jasonm4130-claude-skills": true
  }
}
```

Then run `/plugins` in Claude Code to sync. Skills will be invokable as `jm-skills:adversarial-agents` and `jm-skills:deep-research`, plus by their natural trigger phrases.

## Repo layout

```
.claude-plugin/plugin.json       # plugin manifest
skills/
  adversarial-agents/
    SKILL.md                     # skill definition + frontmatter
    personas/
      yagni.md, premortem.md, hidden_assumptions.md   # plan panel
      saboteur.md, new_hire.md, security_auditor.md   # code panel
  deep-research/
    SKILL.md
```

## License

MIT — see `LICENSE`.

## Acknowledgements

`adversarial-agents` was prompted by Matt Pocock's [`grill-me`](https://github.com/mattpocock/skills/tree/main/skills/productivity/grill-me) skill. The panel-of-personas + severity-promotion pattern draws on Alireza Rezvani's [adversarial-reviewer](https://github.com/alirezarezvani/claude-skills) and zscole's [adversarial-spec](https://github.com/zscole/adversarial-spec). The full research synthesis behind the design decisions lives in the originating dotfiles plan (`docs/plans/2026-05-16-skills-overhaul-research.md`).
