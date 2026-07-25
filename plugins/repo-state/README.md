# repo-state

Keeps one generated orientation doc per repo — `docs/CURRENT_STATE.md` — honest about
its own age, and refreshes it when the repo has actually changed rather than when a
calendar says so.

## Why

This plugin replaces a weekly cron that rebuilt knowledge graphs across 14 repos. Over
45 days and ~3,800 sessions that setup was measured at **30 reads of the generated
markdown report, 15 update runs, and zero graph queries** — the prose report was the
only part anyone consumed, and it was the part left to rot. Five repos sat frozen for
a week while their `CLAUDE.md` still instructed every session to trust them.

Two failures made that possible, and this plugin targets both:

**Silent staleness.** A generated doc that goes stale doesn't fail visibly — the agent
reads it, believes it, and answers confidently about code that no longer exists. In one
published head-to-head, a five-day-old knowledge graph scored 0/3 on a two-week-old
feature with *zero nodes for it*, while plain grep found it. A doc that announces its
own age turns that silent wrong answer into a visible caveat.

**Calendar cadence.** A weekly job over-serves dormant repos and under-serves hot ones.
In the repos this replaced, three had zero commits in 45 days and were rebuilt every
Sunday regardless, while the busiest took 78 commits in a week and drifted the whole
week between runs.

## How it works

| Hook | Script | What it does |
|---|---|---|
| `SessionStart` | `sessionstart-check-staleness.mjs` | If the doc is stale, injects a warning that its claims are unverified — **before** the agent reads it |
| `Stop` | `stop-check-state-drift.mjs` | Measures drift at turn end; arms `repostate-nudge-{sid}.flag` when past threshold |
| `UserPromptSubmit` | `check-state-flag.mjs` | Consumes the flag fire-once and injects the refresh nudge |

The `SessionStart` guard is the load-bearing half. The nudge is maintenance; without the
guard, a stale doc is still trusted.

## Adoption is the doc's presence

No config file, no repo list. A repo participates when `docs/CURRENT_STATE.md` exists;
every other repo never hears from this plugin. Run `/repo-state init` to opt a repo in.

## Drift

A repo is stale when any of these hold:

- the stamped commit is not an ancestor of `HEAD` (rebase, squash, force-push)
- the stamped commit doesn't exist in the repo at all
- `git rev-list --count <stamp>..HEAD -- ':(exclude)docs/CURRENT_STATE.md'` ≥ threshold

That pathspec exclusion is not cosmetic: without it a freshly-refreshed doc reports
drift 1 against its own commit and re-arms the nudge immediately.

Threshold defaults to **25 commits**, overridable with `REPO_STATE_DRIFT_THRESHOLD`.
The override is parsed strictly — a plain positive integer is honoured, and `0`,
negatives, decimals and junk all fall back to 25. An unvalidated parse is the
difference between warning on every turn and never warning at all.

## Fail open, always

Not a git repo, doc absent, stamp unparseable, shallow clone, git broken, malformed
payload — every one of these exits 0 silently. This hook must never be the reason a
session breaks.

## The stamp

```
<!-- repo-state: commit=<full-40-char-sha> generated=<iso8601> -->
```

It records the commit the doc *describes* — the parent of the doc's own commit. A
committed file cannot carry the SHA of the commit containing it; its bytes are an input
to that hash. So `stamp == HEAD` holds only between generating and committing, and
`stamp == HEAD~1` after.

## Install

```
/plugin marketplace add jasonm4130/claude-skills
/plugin install repo-state@jasonm4130-claude-skills
```

## Tests

```
node --test plugins/repo-state/tests/repo-state-hooks.test.mjs
```

Each test builds a real throwaway git repo and runs the hook as a child process with a
synthetic payload — the same contract Claude Code uses at runtime. The threshold
boundary is covered in both directions (24 silent / 25 stale), as is every fail-open
path.
