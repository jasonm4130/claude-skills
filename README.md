# claude-skills

![CI](https://github.com/jasonm4130/claude-skills/actions/workflows/ci.yml/badge.svg)

A Claude Code plugin **marketplace** hosting multiple independent plugins.
Add the marketplace once, then install the plugins you want.

## Scope

This repo ships **capability**: skills, guards, workflows and agents that anyone can
install. Every plugin is self-contained — a shipped file citing a path outside its own
payload is a test failure, not a style preference
(`scripts/repo-consistency.test.mjs`).

The machine-level half — `settings.json`, which plugins are enabled, MCP registration,
`CLAUDE.md`, lifecycle hooks — lives in
**[jasonm4130/dotfiles](https://github.com/jasonm4130/dotfiles)**, managed with chezmoi.

The test: *could a stranger install this and have it work?* If yes it belongs here. If it
references one machine's paths, prose calibration, or state, it belongs in dotfiles.

## Install

```
/plugin marketplace add jasonm4130/claude-skills
```

| Plugin | Description | Requirements | Install command |
|---|---|---|---|
| `adr` | Intent → grounded, cited, build-ready ADR, handed to the SDD loop | – | `/plugin install adr@jasonm4130-claude-skills` |
| `codex-review` | Cross-provider plan/design review via OpenAI Codex (Terra) | Node 18+ · [Codex CLI](https://github.com/openai/codex) | `/plugin install codex-review@jasonm4130-claude-skills` |
| `domain-modeling` | Ubiquitous-language `CONTEXT.md` glossary — challenge, sharpen, and pin down domain terms; offers one once per repo that lacks it | Node 18+ | `/plugin install domain-modeling@jasonm4130-claude-skills` |
| `frontend-design` | Light-inline design guidance, or a paste-ready browser brief for wide/detailed work | – | `/plugin install frontend-design@jasonm4130-claude-skills` |
| `gates` | Four PreToolUse gates — docs-drift commit gate, scaffold-before-design gate, Workflow and Agent model tiering — plus a non-blocking docs-consolidation nudge | Node 18+ | `/plugin install gates@jasonm4130-claude-skills` |
| `handoff` | On-demand `/handoff` resume doc, auto-loaded next session | Node 18+ | `/plugin install handoff@jasonm4130-claude-skills` |
| `landing-loop` | Outer loop for unattended delivery: lands every task of an approved plan as one PR each, CI-gated, merged through the repo's merge command | `subagent-driven-development` · `gh` | `/plugin install landing-loop@jasonm4130-claude-skills` |
| `session-retro` | Session retrospectives that capture learnings to memory | Node 18+ | `/plugin install session-retro@jasonm4130-claude-skills` |
| `ship-gate` | Turn-end nudge to review + push unshipped commits | Node 18+ | `/plugin install ship-gate@jasonm4130-claude-skills` |
| `subagent-driven-development` | Deterministic workflow-driven implement/review/fix loop | – | `/plugin install subagent-driven-development@jasonm4130-claude-skills` |
| `superpowers-core` | Owned fork of the superpowers process skills (brainstorming, writing-plans, TDD, systematic-debugging, writing-skills) | – | `/plugin install superpowers-core@jasonm4130-claude-skills` |
| `writing-artifacts` | Positive writing system for durable artifacts (READMEs, ADRs, docs, runbooks) | – | `/plugin install writing-artifacts@jasonm4130-claude-skills` |

Full details per plugin: see `plugins/<name>/README.md`.

> **Node.js note:** Node 18+ on `PATH` is needed by every plugin above marked `Node 18+`.
> Most register a hook (`hooks/hooks.json`) that shells out to `node` directly, and
> `codex-review`'s skill runs a `.mjs` script the same way via Bash — none of that is covered
> by Claude Code's own bundled runtime (the native installer does not bring Node — install
> via Homebrew, WinGet, or your distro's package manager). `codex-review` additionally needs
> the Codex CLI, authenticated. The `engines` field some `plugin.json` manifests carry is
> informational only — `claude plugin validate` confirms Claude Code does not read or
> enforce it, so it is not a substitute for this table.

## More

- **[Developing](docs/developing.md)** — repo layout, tests, local install, releasing
- **[Renamed and removed plugins](docs/migrations.md)** — where an old plugin went
- **[go/](go/README.md)** — the compiled guard binary and why it is committed

## License

MIT — see `LICENSE`.

## Acknowledgements

The retired `codebase-design` plugin (removed 2026-08-26, see the table above) was adapted from Matt Pocock's [`skills`](https://github.com/mattpocock/skills) (MIT).

The retired `adversarial-agents` plugin (removed 2026-08-03 after zero invocations in ten weeks — `codex-review` occupies the same niche cross-family) was prompted by Matt Pocock's [`grill-me`](https://github.com/mattpocock/skills/tree/main/skills/productivity/grill-me), and drew its panel-of-personas + severity-promotion pattern from Alireza Rezvani's [adversarial-reviewer](https://github.com/alirezarezvani/claude-skills) and zscole's [adversarial-spec](https://github.com/zscole/adversarial-spec).
