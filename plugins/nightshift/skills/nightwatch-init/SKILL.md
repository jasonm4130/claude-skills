---
name: nightwatch-init
description: "Use when the user says \"initialize nightwatch\", \"init nightwatch\", \"set up nightwatch here\", \"set up nightwatch in this repo\", or \"/nightwatch-init\". Runs init.mjs's preflight and status table for the current repo, proposes check commands from the repo's CI when none exists, offers to set the kill switch, then runs init end to end and proves it with a dry run. Do NOT use to write a spec (nightwatch:spec), to run or watch a night (nightwatch:watch), or to scaffold the old task-per-PR loop (nightshift:init)."
---

# Set a repo up for Nightwatch

`init.mjs` does every step idempotently — preflight, the clone, the trust
entry, the check command, the state directory, the kill switch, a dry run —
and stops at the first thing it cannot do without you. This skill reads its
report, asks one question, then runs it. Announce: "Using nightwatch-init to
set this repo up for Nightwatch."

Resolve the plugin path as `${CLAUDE_PLUGIN_ROOT}` when set, else this file's
`../../nightwatch/` relative to its own location, and call the script with
`node`.

## 1. Report first

```
node <plugin>/nightwatch/init.mjs --report
```

`--report` changes nothing — no clone, no trust entry, no state dir, no
switch, no dry run — it only prints what each step would do. Show the status
table.

If the `check` step reports `needs you`, the repo has no `scripts/check` and
no `--check-cmd` was given. Read `.github/workflows/*.yml` yourself as well
as the candidates `--report` lists under "check-command candidates" (one
`run:` line per CI step that looks like a check — fmt, lint, test, etc.);
drop anything platform-only (a Windows- or container-only job) or that needs
a secret this session doesn't have, and say which you dropped and why. The
survivors become one `--check-cmd "<line>"` per flag, run in the order CI
runs them.

If the `switch` step reports `needs you`, the kill switch
(`LANDING_STATE`) is unset or not `run`. Say the exact command:

```
gh variable set LANDING_STATE --body run
```

## 2. Ask one question

AskUserQuestion, recommendation marked:

- **Proceed with these check commands and set the switch** (recommended when
  both were `needs you` and you have a check-command list) — runs init with
  `--check-cmd` for each line and `--set-switch`.
- **Proceed without setting the switch** — runs init with the check commands
  (if any were needed) but leaves the switch off; the dry run then reports
  `needs you: the switch is off, so the dry run did not start`, and nothing
  else runs.
- **Stop here** — report only, no run.
- **None of these; here is what I need first** — free text (a different
  check command list, a different `--name` or `--clone-root`, etc.).

## 3. Run it

```
node <plugin>/nightwatch/init.mjs --check-cmd "<line1>" --check-cmd "<line2>" --set-switch
```

Only pass `--check-cmd` when the repo has no `scripts/check`; only pass
`--set-switch` when the user chose to set it. Show the resulting status
table and the dry-run outcome (`dry run complete` in the journal, or the
`dry run FAILED` line).

## 4. Report and hand off

State plainly:

- Nothing was pushed and nothing was committed: init touches no branch, no
  GitHub, no CI.
- A generated check lives at the path in `config`'s `CHECK` line, inside the
  state directory — not in the repo. Commit a `scripts/check` yourself if
  you want the same commands checked in.
- Every acceptance and launcher check ends its output with `CHECK OK` as the
  last line; that's the contract every consumer (the linter, the engine, the
  launcher's own re-check) reads for.

End with: "Next: /nightwatch:spec to write the first spec, then
/nightwatch:watch to run the queue."
