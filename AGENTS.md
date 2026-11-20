# claude-skills

A Claude Code plugin marketplace: independent plugins under `plugins/<name>/`, registered in `.claude-plugin/marketplace.json`. [docs/developing.md](docs/developing.md) covers layout, tests, local install and releasing; this file adds what an agent needs on top.

- Work in a git worktree under `.claude/worktrees/`; Jason commits in the main checkout at the same time.
- Scope test: could a stranger install this and have it work? Machine-level config (`settings.json`, enabled plugins, MCP, `CLAUDE.md`, lifecycle hooks) belongs in the dotfiles repo (chezmoi), not here.
- Each plugin is self-contained: the whole `plugins/<name>/` tree ships to the install cache. A shipped file cites anything outside its own payload by github.com URL, never by path; `scripts/repo-consistency.test.mjs` fails the build otherwise.
- Any change to a plugin's shipped content needs a version bump: `node scripts/bump-plugin.mjs <name> <patch|minor|major>` updates `plugin.json` and the marketplace entry together. CI's `version-bump-check` enforces it.
- `plugins/gates/bin/ccguard` is a committed Go binary. Rebuild it only with `plugins/gates/go/build.sh`; CI rebuilds and compares bytes. Go is pinned in both `mise.toml` and `go.mod`'s `toolchain` line, and the two must match.
- `plugins/pstack` is vendored from Lauren Tan's pstack (MIT). Keep it close to upstream and record any local change in its README.
- Before a PR: `scripts/check` (prints `CHECK OK`) and `node scripts/check-version-bumps.mjs main` (no violations). `claude plugin validate plugins/<name>` for any manifest or skill frontmatter change.
- Merge with `gh pr merge --merge`. Installed users pick up a release per the "Updating an installed plugin" section of docs/developing.md.
- Comments: keep only what the code can't say. Code that needs a paragraph to explain should be restructured instead.
