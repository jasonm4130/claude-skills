# Developing

Working on the plugins in this repo: layout, tests, local install, and releasing.

## Repo layout

```
.claude-plugin/marketplace.json   # marketplace manifest (all plugins registered here)
plugins/<name>/
  .claude-plugin/plugin.json      # per-plugin manifest
  skills/<skill>/SKILL.md         # skill definition + frontmatter
  hooks/hooks.json                # hook registrations (where applicable)
  scripts/ tests/                 # stdlib-only .mjs + node:test suites
  bin/ccguard                     # committed Go guard binary, macOS universal
                                  #   (plugins/gates only; the .mjs stays as
                                  #   fallback AND reference impl)
  go/                             # source for bin/ccguard (plugins/gates only)
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

Go is pinned to 1.27.1 in both `mise.toml` and `plugins/gates/go/go.mod`'s `toolchain` line. The
two must match: CI rebuilds `plugins/gates/bin/ccguard` from source and compares
bytes against the committed binary, so a patch mismatch fails the `go-guards` job.

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

## Nightshift

`plugins/nightshift` ships the overnight landing loop as templates plus a scaffolder.
Its `tests/` answer "does the code work" (init, preflight, the hooks, `task-brief`,
`land.sh --dry-run`, all against throwaway repos with a fake `gh`); a repo's own
`loop/` answers "does the night work". Templates are the source of truth: a repo
that ran `init` picks up a template fix with `init.mjs --check` then `--update`,
which touches only files still at their stamped hash. Plans the loop lands live in
`docs/plans/`.

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

