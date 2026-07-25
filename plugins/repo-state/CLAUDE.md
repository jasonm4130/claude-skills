# repo-state — working notes

## The invariant that matters

**Never advance the stamp past a diff nobody read.** Everything else here is
convenience; this is the one rule whose violation recreates the problem the plugin was
built to solve. `git log --stat` is not evidence — it reports that a file changed by
some number of lines, not what the change means. A refresh that re-stamps on `--stat`
re-blesses a stale claim as current and then buys another 25 commits of silence.

## Why the stamp is the parent commit

A committed file cannot carry the SHA of the commit that contains it — the file's bytes
are an input to that hash. The stamp therefore records the commit the doc *describes*.
Consequences that have already bitten once in review:

- drift must exclude the doc's own commits (`:(exclude)docs/CURRENT_STATE.md`), or every
  refresh re-arms the nudge at drift 1
- the post-commit invariant is `stamp == HEAD~1`, not `stamp == HEAD`

## The drift count is post-simplification, and that is fine

Adding any pathspec to `rev-list` turns on history simplification, so the excluded count
is not `total − doc-only commits`. Measured on brok-stacks over a 232-commit range: 39
merges, 193 non-merges, and an excluded count of **206** — 193 non-merges plus the 13
merges whose tree actually differs for the filtered paths. The other 26 merges are
simplified away.

That is acceptable for a threshold: doc-only commits never count, content commits always
do, and the number never over-counts. Do not "fix" it into matching the plain count — a
future reader comparing the two numbers and assuming a bug is the reason this note exists.

## Why two hooks and not one

`SessionStart` is the guard: it fires before the doc is read, which is the only moment
the warning is useful. `Stop` + `UserPromptSubmit` is the maintenance trigger, and it
can only fire after work has happened. A session opening a three-weeks-stale repo needs
the first; it would never reach the second in time.

Deleting the `SessionStart` hook would leave a plugin that nudges you to refresh a doc
it also lets you trust blindly. Don't.

## Fail open, and mean it

Every ambiguous case returns null from `computeDrift` and exits 0. "Cannot tell" is
never "warn" — a guard that cries wolf on shallow clones gets uninstalled, and then the
real staleness goes unnoticed too.

## Hook form

Shell form (`command: "node \"${CLAUDE_PLUGIN_ROOT}/...\""`), never exec form (`args`).
See `scripts/hook-runtime-guard.test.mjs` in the repo root for why — exec form silently
disables hooks on hosts older than Claude Code 2.1.139 and `engines` cannot prevent the
install.

## Tests are slow on purpose

The threshold tests build 24–25 real commits each, so the suite takes ~45s. Real repos
catch pathspec and ancestry bugs that mocked git would not — the `:(exclude)` behaviour
was verified empirically before it was written into the lib.
