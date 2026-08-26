# claude-skills

![CI](https://github.com/jasonm4130/claude-skills/actions/workflows/ci.yml/badge.svg)

A Claude Code plugin **marketplace** hosting multiple independent plugins.
Add the marketplace once, then install the plugins you want.

## Install

```
/plugin marketplace add jasonm4130/claude-skills
```

| Plugin | Description | Requirements | Install command |
|---|---|---|---|
| `adr` | Intent → grounded, cited, build-ready ADR, handed to the SDD loop | – | `/plugin install adr@jasonm4130-claude-skills` |
| `claude-design` | Paste-ready Claude Design brief + the Claude Code driving path (`/design`, `/design-sync`) | – | `/plugin install claude-design@jasonm4130-claude-skills` |
| `codex-review` | Cross-provider plan/design review via OpenAI Codex (Terra) | Node 18+ · [Codex CLI](https://github.com/openai/codex) | `/plugin install codex-review@jasonm4130-claude-skills` |
| `design-gate-guard` | PreToolUse gate asking before a new-project scaffold runs ahead of an approved design | – on arm64 macOS · Node 18+ elsewhere | `/plugin install design-gate-guard@jasonm4130-claude-skills` |
| `docs-sync-guard` | Blocking git-commit gate against docs drift, plus a non-blocking consolidation audit triggered by accumulated commits | Node 18+ | `/plugin install docs-sync-guard@jasonm4130-claude-skills` |
| `domain-modeling` | Ubiquitous-language `CONTEXT.md` glossary — challenge, sharpen, and pin down domain terms; offers one once per repo that lacks it | Node 18+ | `/plugin install domain-modeling@jasonm4130-claude-skills` |
| `frontend-design` | Light-inline design guidance, or a paste-ready browser brief for wide/detailed work | – | `/plugin install frontend-design@jasonm4130-claude-skills` |
| `handoff` | On-demand `/handoff` resume doc, auto-loaded next session | Node 18+ | `/plugin install handoff@jasonm4130-claude-skills` |
| `session-retro` | Session retrospectives that capture learnings to memory | Node 18+ | `/plugin install session-retro@jasonm4130-claude-skills` |
| `ship-gate` | Turn-end nudge to review + push unshipped commits | Node 18+ | `/plugin install ship-gate@jasonm4130-claude-skills` |
| `subagent-driven-development` | Deterministic workflow-driven implement/review/fix loop | – | `/plugin install subagent-driven-development@jasonm4130-claude-skills` |
| `superpowers-core` | Owned fork of the superpowers process skills + the `using-skills` dispatcher | Node 18+ | `/plugin install superpowers-core@jasonm4130-claude-skills` |
| `workflow-model-guard` | PreToolUse guard nudging model tiering in high-fan-out Workflows | – on arm64 macOS · Node 18+ elsewhere | `/plugin install workflow-model-guard@jasonm4130-claude-skills` |
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

## Renamed and removed plugins

A plugin that leaves the marketplace stops receiving updates but stays installed:
its `<name>@jasonm4130-claude-skills` key remains in `enabledPlugins`, and anything
it wrote under `~/.claude/plugins/data/<name>/` stays on disk. Nothing in this repo
deletes that data — uninstall with `/plugin uninstall <name>@jasonm4130-claude-skills`
and remove the data directory by hand if you want it gone.

| Removed | Date | Replaced by | What to do |
|---|---|---|---|
| `deep-dive` (and its earlier name `deep-research`) | 2026-08-26 | Claude Code's built-in `/deep-research` | Uninstall. The built-in now inherits the session model instead of pinning Opus, and votes on claims adversarially — the two things this plugin existed to add (verified 2026-08-26). |
| `codebase-design` | 2026-08-26 | Nothing | Uninstall. The 2026-08-03 ADR kept it on the condition that an imperative hand-off from `brainstorming` produce invocations by 2026-08-24; it was still at zero, so the review clause fired. The design vocabulary it carried is native to Claude — `brainstorming` and `test-driven-development` now make their boundary and seam points directly. |

## Repo layout

```
.claude-plugin/marketplace.json   # marketplace manifest (all plugins registered here)
plugins/<name>/
  .claude-plugin/plugin.json      # per-plugin manifest
  skills/<skill>/SKILL.md         # skill definition + frontmatter
  hooks/hooks.json                # hook registrations (where applicable)
  scripts/ tests/                 # stdlib-only .mjs + node:test suites
  bin/ccguard                     # committed Rust guard binary (compiled plugins only;
                                  #   the .mjs stays as fallback AND reference impl)
rust/                             # source for bin/ccguard, shared across those plugins
docs/superpowers/{specs,plans}/   # design specs and implementation plans
docs/research/                    # dated research + triage records
RESEARCH_*.md                     # standalone research write-ups
scripts/run-node-tests.sh         # CI test runner (globs files — `node --test <dir>`
                                  #   is broken on Node 24)
```

## Development

```bash
bash scripts/run-node-tests.sh    # run every *.test.mjs in one process
```

Local Node is pinned to 24 (`mise.toml`), matching the version CI tests on.

The whole `plugins/<name>/` tree is copied into the install cache — `README.md`,
`CLAUDE.md` and `tests/` included — so anything a shipped file cites must resolve
for someone who installed the plugin rather than cloning the repo. Cite `docs/`,
a repo-root `RESEARCH_*.md`, or another repo by **github.com URL**, not by path.
`repo-consistency.test.mjs` fails the build on a bare path, and also resolves
every `blob/main/…` link against the working tree, so a link left behind by a
file move is caught rather than silently 404ing.

Two things are deliberately not flagged: instructional templates naming where to
*save* a file (a citation carries a concrete date, a template carries
`YYYY-MM-DD`), and paths that exist nowhere in the repo, which are test fixtures
rather than references anyone can follow.

CI (`.github/workflows/ci.yml`) validates all JSON manifests, runs `claude plugin
validate` against every `plugins/<name>/` directory (catches malformed skill
frontmatter that the JSON check above doesn't reach), runs the node test suite
on ubuntu+macos (Node 24), runs the SDD bash smoke tests, runs `rust-guards`
(the `rust/` unit tests plus the differential test that fails on a stale
committed `bin/ccguard`), and runs `version-bump-check` (see Releasing).

## Updating an installed plugin

Claude Code keys "update available" off a plugin's **version**, so an update only
reaches you once the version is bumped (that's enforced — see Releasing). To pick up
a new version:

- **Fastest** — `bash scripts/update-plugins.sh`, then `/reload-plugins`. The script
  refreshes the marketplace metadata and fetches new versions of your installed plugins
  in one shot; `/reload-plugins` then applies them without a restart.
- **Usually nothing** — session-start autoUpdate pulls new versions of installed
  plugins on the next launch.
- **By hand:** `/plugin marketplace add jasonm4130/claude-skills` (refresh the
  marketplace metadata), then **either** open `/plugin` and update from the menu, **or**
  run `claude plugin update <name>@jasonm4130-claude-skills` (restart to apply).

Three traps worth knowing: `/reload-plugins` only re-reads the *installed* cache — it does
**not** fetch new versions; a bare `/plugin install <name>@jasonm4130-claude-skills`
**no-ops** when the plugin is already installed; and `claude plugin update <name>` is not
scoped to that name — it refreshes the whole marketplace payload, so one call can pull
several plugins at once. `update-plugins.sh` reports what actually landed in the cache
rather than how many calls it made, so its summary stays accurate either way.

## Releasing (maintainer)

1. Make the change under `plugins/<name>/`.
2. Bump in one step: `node scripts/bump-plugin.mjs <name> <patch|minor|major>` — it updates
   `plugins/<name>/.claude-plugin/plugin.json` **and** the matching `.claude-plugin/marketplace.json`
   entry together (they must stay in sync).
3. Pre-check locally: `node scripts/check-version-bumps.mjs main` (expect no violations).
4. Open a PR. CI's **`version-bump-check`** fails the PR if any plugin's shipped content
   changed without a strict semver increase — so the bump can't be forgotten.
5. Merge with a merge commit once checks pass. Installed users get it per *Updating* above.

## License

MIT — see `LICENSE`.

## Acknowledgements

The retired `codebase-design` plugin (removed 2026-08-26, see the table above) was adapted from Matt Pocock's [`skills`](https://github.com/mattpocock/skills) (MIT).

The retired `adversarial-agents` plugin (removed 2026-08-03 after zero invocations in ten weeks — `codex-review` occupies the same niche cross-family) was prompted by Matt Pocock's [`grill-me`](https://github.com/mattpocock/skills/tree/main/skills/productivity/grill-me), and drew its panel-of-personas + severity-promotion pattern from Alireza Rezvani's [adversarial-reviewer](https://github.com/alirezarezvani/claude-skills) and zscole's [adversarial-spec](https://github.com/zscole/adversarial-spec).
