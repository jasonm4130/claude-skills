---
name: init
description: Use when the user says "/nightshift:init", "set up nightshift here", "add the overnight landing loop to this repo", or asks how to run plans unattended in a repo that has no `loop/` directory. Scaffolds the loop, the two PreToolUse guards, a stack-specific verifier and the landing doc into the current repo, merges `.claude/settings.json`, proves it with a dry run, commits the scaffold on a branch, runs preflight and prints the first-night recipe. Do NOT use to run a night (the loop runs itself from launchd or the terminal), to triage one (use morning), or to write a plan (use plan). Do NOT re-run to update an existing scaffold; use `init.mjs --check` and `--update`. This is for the old landing loop; for Nightwatch use nightwatch-init.
---

# Scaffold Nightshift into this repo

The loop is committed in the target repo, not in this plugin: it runs
`claude -p --setting-sources project`, where installed plugins never load, so
the hooks only bite when they live under the repo's own `.claude/`. This skill
copies them in, proves the copy, and leaves the switch off. Announce: "Using
nightshift:init to scaffold the overnight landing loop."

Scripts live under this skill's plugin directory: resolve `${CLAUDE_PLUGIN_ROOT}`
(or this file's `../../scripts/`) and call them with `node`.

## 1. Look before writing

- `git remote get-url origin` is a GitHub remote, `gh auth status` succeeds.
- Detect the stack the way `init.mjs --stack auto` does (Cargo.toml, package.json,
  pyproject.toml, go.mod, else generic) and say which verifier skeleton it gets.
- An existing `loop/`, `scripts/check`, or `.claude/hooks/` means this is not a
  first init: run `node <plugin>/scripts/init.mjs --check` and stop with its
  report instead.
- Is there a plan to land? If the user names one, pass `--plan <path>`;
  otherwise init scaffolds `docs/plans/<today>-nightshift-smoke.md` with one
  harmless task so the first night has something to do.

## 2. Scaffold

```
node <plugin>/scripts/init.mjs --stack <stack> [--plan <path>] [--base <branch>]
```

Say what it wrote (it prints the list): `loop/*`, `.claude/hooks/*`,
`scripts/check` (never overwritten if present), `docs/developing/landing.md`
or `docs/nightshift.md`, the smoke plan, and the merged `.claude/settings.json`.
Then read `loop/config` back to the user: `MERGE_MODE` (`protected` when the base
branch has required checks, else `wait`) and `EXPECTED_CHECKS` (`gate` only when a
`gate` CI job exists; otherwise empty, and a human must fill it with the check
names GitHub reports, which `preflight` lists). `--deny-rules` also adds
`permissions.deny` entries; the hooks already deny in every permission mode.

## 3. Prove it, in this order

1. `scripts/check` from the repo root — last line must be `CHECK OK`. Edit the
   skeleton until it is (it is deliberately narrower than CI: fast, quiet).
2. `loop/land.sh --dry-run` — reads the plan from the checkout, so the
   uncommitted scaffold is enough. Expect `STOP: frozen` (the switch is unset)
   or, with `LANDING_STATE=run` already set, `STOP: would run task 1: …`.
3. `node --test .claude/hooks/*.test.mjs` — the copied guard tests pass in situ.
4. Commit the scaffold on a branch, one commit, and tell the user to open the
   PR: `loop/`, `.claude/hooks/`, `.claude/settings.json`, `scripts/check`, the
   docs page, the plan. Stage paths explicitly. The user opens the PR;
   this skill never pushes to the base branch.
5. `node <plugin>/scripts/preflight.mjs` — one line per check. Its plan check
   is expected to FAIL at this point (the plan is on the scaffold branch, not
   on `origin/<base>`) and says "merge the PR that carries it". Everything
   else should be `ok` or `warn`; a `FAIL` on `protection` or `checks` is a
   `loop/config` edit to make now.

## 4. Hand over

Print, verbatim from the landing doc, the first night by daylight:

```
gh variable set LANDING_STATE --body frozen     # the switch exists, and is off
for l in land land:blocked land:retry; do gh label create "$l"; done
# merge the scaffold PR, then:
node <plugin>/scripts/preflight.mjs             # all ok
gh variable set LANDING_STATE --body run
MAX=1 loop/land.sh                              # one task, watched
gh variable set LANDING_STATE --body frozen
```

and the launchd lines from `loop/launchd.plist`'s header. Never install
launchd yourself; never flip the switch to `run`. Both are the user's.

Later: `init.mjs --check` reports each scaffolded file as unchanged, modified
locally, or template newer; `--update` overwrites only files still at their
stamped hash. That is how a repo picks up a plugin fix without losing its edits.
