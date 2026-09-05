---
name: morning
description: Use when the user says "/nightshift:morning", "what happened overnight", "how did the night go", "why did the loop stop", or opens a session in a repo with a `loop/` directory after a scheduled run. Reads the journal since the last start line and every open `land` / `land:blocked` pull request, says per stop what happened, what it costs to ignore, and the fix, then offers the fixes. Do NOT use to write plans (use plan), to scaffold the loop (use init), or to merge pull requests by hand — merges go through `./loop/merge-pr.sh` or the user.
---

# Triage the night

The loop leaves its evidence in three places and remembers nothing else.
Read all three before saying anything. Announce: "Using nightshift:morning to
read last night's run."

## 1. Gather

```
cfg=loop/config; . $cfg 2>/dev/null
journal=~/.local/state/nightshift/$(basename "$PWD")/journal.md
```

- **Journal:** everything after the last `start:` line. Each `STOP:` line
  names why the night ended; `task N:` lines carry cost and round outcomes.
- **Pull requests:** `gh pr list --label land --state open --json number,title,isDraft,labels,url`
  and the same for `--label land:blocked`. A draft with the blocked label is
  a task that failed its repair round; its body has the generator's report,
  the skeptic's verdict and the verifier's tail. Merged PRs since the start
  line: `gh pr list --label land --state merged --search "merged:>=<date>"`.
- **Run directory:** `~/.local/state/nightshift/<repo>/<date>-t<N>/` holds
  `brief.md`, `gen-<round>.md`, `skeptic-<round>.md`, `check-<round>.log`
  and the JSON envelopes. Read the log tail and the skeptic before judging.
- **The switch:** `gh variable get LANDING_STATE`. The loop flips nothing;
  if it is not `run`, a human froze it or never armed it.

## 2. Report, one block per stop

Headline first, then the consequence, then the fix. No raw log pastes; quote
the one line that matters.

- **Landed.** "Task 3 landed as #41, 2 rounds, $5.10." Nothing to do; say it.
- **Blocked** (`land:blocked` draft). Say which of the three refused it:
  verifier red (quote the `ERROR <step>` line), skeptic `REFUTED` (quote its
  reason), or the generator's `BLOCKED:` line. The consequence is that every
  later task waits, because the loop stops at the first blocked task.
- **Waiting** (open non-draft PR). CI is still running, or a check never
  registered (wait mode with a wrong `EXPECTED_CHECKS` name); the merge script's
  output is in the journal.
- **Closed without merging.** A human decided; the loop will not retry until
  the PR is reopened or the task is removed from the plan.
- **Produced nothing.** The generator made no commits; the brief was probably
  not self-contained. The fix is a plan edit, not a retry.
- **Frozen / deadline / MAX.** The night ended on purpose; say which.
- **No `start:` line today.** launchd did not fire: `launchctl list | grep nightshift`,
  and the `stdout`/`stderr` paths in `loop/launchd.plist`.

## 3. Offer the fixes, do not apply them

Each blocked task gets one of:

1. **Fix on the branch.** Check it out, make the change, run `scripts/check`,
   push, `gh pr ready <n>` and remove the label: `gh pr edit <n> --remove-label land:blocked`.
   The next run resumes it from "open PR".
2. **Close the PR.** The loop treats a closed unmerged PR as a human decision
   and stops on that task until the plan changes.
3. **Edit the plan.** Wrong or under-specified task: a plan change is a pull
   request (`nightshift:plan`'s landing step).
4. **Refreeze.** `gh variable set LANDING_STATE --body frozen` when the stops
   suggest the plan needs a human pass before another night.

Ask which, one question, then do that one. Never `gh pr merge` a task PR by
hand — that is what `./loop/merge-pr.sh <n>` is for, and the hook denies the
bare form for a reason: the same checks judge a PR whether a human or the
loop asks.
