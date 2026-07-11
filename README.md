# claude-skills

![CI](https://github.com/jasonm4130/claude-skills/actions/workflows/ci.yml/badge.svg)

A Claude Code plugin **marketplace** hosting multiple independent plugins.
Add the marketplace once, then install the plugins you want.

## Install

```
/plugin marketplace add jasonm4130/claude-skills
```

| Plugin | Description | Install command |
|---|---|---|
| `adr` | Intent → grounded, cited, build-ready ADR, handed to the SDD loop | `/plugin install adr@jasonm4130-claude-skills` |
| `adversarial-agents` | Configurable adversarial panel review for any artefact | `/plugin install adversarial-agents@jasonm4130-claude-skills` |
| `deep-dive` | Model-tiered, adversarially-verified multi-source research | `/plugin install deep-dive@jasonm4130-claude-skills` |
| `handoff` | Context-fill-triggered handoff doc, auto-loaded next session | `/plugin install handoff@jasonm4130-claude-skills` |
| `session-retro` | Session retrospectives that capture learnings to memory | `/plugin install session-retro@jasonm4130-claude-skills` |
| `ship-gate` | Turn-end nudge to review + push unshipped commits | `/plugin install ship-gate@jasonm4130-claude-skills` |
| `subagent-driven-development` | Deterministic workflow-driven implement/review/fix loop | `/plugin install subagent-driven-development@jasonm4130-claude-skills` |
| `visual-plan` | Markdown-canonical ADR/plan, optional rich HTML companion | `/plugin install visual-plan@jasonm4130-claude-skills` |
| `workflow-model-guard` | PreToolUse guard nudging model tiering in high-fan-out Workflows | `/plugin install workflow-model-guard@jasonm4130-claude-skills` |

Full details per plugin: see `plugins/<name>/README.md`.

> **Node.js note:** `handoff`, `session-retro`, and `subagent-driven-development`
> require **Node.js 18+** on `PATH`. The handoff plugin also needs a one-time
> `statusLine` wire-up:
> `node "$(ls -d ~/.claude/plugins/cache/jasonm4130-claude-skills/handoff/*/scripts/setup.mjs | sort -V | tail -1)"`
> (the setup script installs a version-agnostic wrapper, so upgrades don't break it).

## Repo layout

```
.claude-plugin/marketplace.json   # marketplace manifest (all plugins registered here)
plugins/<name>/
  .claude-plugin/plugin.json      # per-plugin manifest
  skills/<skill>/SKILL.md         # skill definition + frontmatter
  hooks/hooks.json                # hook registrations (where applicable)
  scripts/ tests/                 # stdlib-only .mjs + node:test suites
docs/superpowers/{specs,plans}/   # design specs and implementation plans
scripts/run-node-tests.sh         # CI test runner
```

## Development

```bash
bash scripts/run-node-tests.sh    # run every *.test.mjs in one process
```

CI (`.github/workflows/ci.yml`) validates all JSON manifests, runs the node
test suite on ubuntu+macos (Node 24), and runs the SDD bash smoke tests.

## License

MIT — see `LICENSE`.

## Acknowledgements

`adversarial-agents` was prompted by Matt Pocock's [`grill-me`](https://github.com/mattpocock/skills/tree/main/skills/productivity/grill-me) skill. The panel-of-personas + severity-promotion pattern draws on Alireza Rezvani's [adversarial-reviewer](https://github.com/alirezarezvani/claude-skills) and zscole's [adversarial-spec](https://github.com/zscole/adversarial-spec). The full research synthesis behind the original design decisions lives in the originating (private) dotfiles repo's plan doc, `docs/plans/2026-05-16-skills-overhaul-research.md` — not in this repo.
