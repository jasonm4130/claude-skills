---
name: repo-state
description: >
  Generate or refresh a repo's docs/CURRENT_STATE.md — the prose orientation doc
  that answers "what is this, where do I start, what is in flight". Use when the
  user asks to create, update, or refresh the current-state doc, when a repo-state
  staleness warning fires at session start, or when a drift nudge asks for a
  refresh. Triggers: "/repo-state", "repo-state init", "repo-state refresh",
  "refresh the current state doc", "the state doc is stale".
  Do NOT use for architecture decision records (use adr), implementation plans
  (use writing-plans), or hand-written CLAUDE.md rules — this skill owns one
  generated file and nothing else.
---

# repo-state

One artifact: `docs/CURRENT_STATE.md`, committed, carrying a stamp that says which
commit it describes.

## The stamp

Line 1 of the doc, always:

```
<!-- repo-state: commit=<full-40-char-sha> generated=<iso8601> -->
```

The stamp records **the commit the doc describes**, not the commit that contains
the doc. A committed file cannot carry the SHA of its own commit — its bytes are an
input to that hash. So at generation time the stamp is `git rev-parse HEAD`; after
the doc-only commit lands, the same value is `HEAD~1`. The hooks exclude the doc's
own commits from drift for exactly this reason.

## `/repo-state init`

For a repo with no doc yet.

1. Read enough of the repo to answer, concretely: what this is and who it serves;
   how to run it and how to test it; the entry points; the module map at one level
   of depth; anything in flight (open branches, TODOs that matter, known-broken
   things).
2. Write `docs/CURRENT_STATE.md` with the stamp set to `git rev-parse HEAD`.
3. Commit it on its own. Verify afterwards that the stamp equals `git rev-parse HEAD~1`.
4. Add a `## Current state` block to the repo's `CLAUDE.md` pointing at the doc —
   without it the doc has no discovery path, because the SessionStart hook is silent
   when the doc is fresh.

Keep it prose. This artifact exists because prose reports get read and query
interfaces do not.

## `/repo-state refresh`

For a repo whose doc has drifted. **The stamp is a claim that the doc is true as of
that commit — so never advance it past a diff you have not read.**

1. `git rev-list --count <stamp>..HEAD -- ':(exclude)docs/CURRENT_STATE.md'` to size
   the job.
2. `git diff <stamp>..HEAD` — the actual hunks, not `--stat`. A commit that inverts
   an authorization check inside an existing file shows up in `--stat` as a pathname
   and two line counts; re-stamping on that evidence re-blesses a now-false claim as
   current and buys another threshold's worth of silence. That is the failure this
   plugin exists to prevent.
3. Map changed paths to the doc sections that describe them. For each affected
   section, re-verify the claim against current source, then rewrite it.
4. Carry unaffected sections forward untouched.
5. Re-stamp to the new HEAD and commit.

If the diff is too large to read in full, say so and regenerate from scratch instead.
Do not re-stamp on partial evidence.

## Delegation

For a large refresh, hand the diff-reading to a subagent with an explicit
`model: 'sonnet'` — reconciling hunks against doc sections is mechanical work from a
clear spec. Keep the judgment call about what belongs in the doc in the main session.
