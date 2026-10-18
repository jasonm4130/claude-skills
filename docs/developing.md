# Developing

Working on the plugins in this repo: layout, units and bundles, tests, local install, and releasing.

## Repo layout

```
.claude-plugin/marketplace.json   # marketplace manifest (all plugins registered here)
plugins/<name>/
  .claude-plugin/plugin.json      # per-plugin manifest
  skills/<skill>/SKILL.md         # skill definition + frontmatter
  hooks/hooks.json                # hook registrations (where applicable)
  scripts/ tests/                 # stdlib-only .mjs + node:test suites
  bin/ccguard                     # committed Go guard binary, macOS universal
                                  #   (plugins/gates only). agent-model and
                                  #   workflow-model keep their .mjs as both
                                  #   fallback and reference impl; json-config-guard
                                  #   is Go only and simply does not run where the
                                  #   binary cannot
  go/                             # source for bin/ccguard, and build.sh, the one
                                  #   definition of the build (plugins/gates only)
docs/superpowers/{specs,plans}/   # design specs and implementation plans
docs/research/                    # dated research + triage records
RESEARCH_*.md                     # standalone research write-ups
scripts/run-node-tests.sh         # CI test runner (globs files — `node --test <dir>`
                                  #   is broken on Node 24)
```

## Units and bundles

A user picks from this marketplace one plugin at a time. Claude Code enables and
disables a whole plugin. The docs describe no switch for a single hook. So a plugin
is the smallest thing anyone can choose, and whatever it holds, they get all of it.

- **A unit** is one capability: one skill, one hook set, or one skill together
  with the hooks it cannot work without. Installing it adds nothing the user did
  not ask for.
- **A bundle** is a plugin whose `plugin.json` lists other plugins in
  `dependencies`. It ships no skills or hooks of its own. Installing it installs
  and enables every unit it names, so one command gives a curated set.

Put a hook in the same unit as a skill only when one does not work without the
other. Two do this today, by design:

- `domain-modeling`: its hooks are the skill's only inbound trigger (ADR
  [2026-08-03](adr/2026-08-03-skill-topology-and-gate-integrity.md)).
- `handoff`: the skill writes the resume doc, and the `SessionStart` hook loads it.

Every other skill or hook set gets its own unit. Each enabled plugin's skill names and
descriptions sit in context on every turn, so an unwanted unit costs tokens as well as
hooks.

Today every plugin here is a unit, and the README install table says so in its Kind
column. `gates` is the exception in practice. It holds several independent guards
behind one plugin, and `GATES_DISABLE` is how a user switches one guard off.

What Claude Code does with a bundle (plugin manifest reference and plugin
dependencies docs, checked 2026-10-16):

- `dependencies` entries are `"name"`, `"name@marketplace"` or
  `{ "name", "marketplace", "version" }`. A bare name resolves in this marketplace.
- Install, `/reload-plugins`, a marketplace auto-update and re-running
  `claude plugin install` all install any missing dependency. So a new bundle
  version that adds a unit reaches users through the normal update path.
- If a user disables a unit that an enabled bundle depends on, the bundle is
  disabled at the next plugin load. Uninstalling the bundle leaves its units installed.
  `claude plugin prune` removes auto-installed dependencies that no plugin needs.

### Splitting a plugin into units

1. Keep the old name as the bundle. Its `<name>@jasonm4130-claude-skills` key
   stays in users' `enabledPlugins`, so existing installs keep working and pull in
   the new units on their next update. Bump the bundle's version (major, since it
   no longer ships the components itself).
2. Give each new unit its own `plugins/<unit>/`, marketplace entry, version and
   README row.
3. Move state on purpose. `${CLAUDE_PLUGIN_DATA}` is keyed by plugin id, so a new
   unit starts with an empty `~/.claude/plugins/data/<unit>/`. Either read the old
   bundle's directory once, or say in the migration row what is left behind.
4. Add a row per unit to [docs/migrations.md](migrations.md): what moved, from
   which plugin, and whether the user has to do anything.

## Development

```bash
bash scripts/run-node-tests.sh    # run every *.test.mjs in one process
```

Local Node is pinned to 24 (`mise.toml`), matching the version CI tests on.

Go is pinned to 1.27.1 in both `mise.toml` and `plugins/gates/go/go.mod`'s `toolchain` line. The
two must match: CI rebuilds `plugins/gates/bin/ccguard` from source and compares
bytes against the committed binary, so a patch mismatch fails the `go-guards` job.
`scripts/go-toolchain-pin.test.mjs` fails sooner, in the node tests, when the two
pins disagree, when CI stops taking its Go from `go.mod`, or when a file other than
`build.sh` writes out the build flags.

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
on ubuntu+macos (Node 24), runs `go-guards`
(the `plugins/gates/go/` unit tests, a rebuild-and-compare against the committed
binary, plus the differential test), and runs `version-bump-check` (see Releasing).

The rebuild calls `plugins/gates/go/build.sh`, which is the only place the build
flags are written down. The staleness test calls it too. Rebuild the binary with
that script rather than retyping the flags, or the comparison fails and reports a
stale binary when the real fault is a flag mismatch.
It also pins `GOTOOLCHAIN` to the exact `toolchain` line, because `setup-go` installs
the newest 1.27.x and a newer Go would otherwise build with itself. CI then checks
the fresh build's stamp, so a toolchain mismatch is reported as one.

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

