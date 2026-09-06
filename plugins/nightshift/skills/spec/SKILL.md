---
name: spec
description: "Use when the user has an outcome for Nightwatch to run unattended overnight and says \"write a nightwatch spec for X\", \"/nightwatch:spec\", or \"spec this out for the launcher\". Reads the code the outcome touches, settles Outcome / Acceptance / Non-goals / Context with the user one question at a time, declares Depends, Units and Writes headers when they apply, writes the spec file, and refuses to finish until lint-spec.mjs prints SPEC OK. Do NOT use to execute a spec (run.sh does that at night) or for a one-sitting edit that does not need an unattended run. Do NOT use for the old Task-N plan format — that is nightshift:plan."
---

# Write a spec the launcher can land unattended

A spec is read once, at 2 a.m., by a headless `claude -p` that cannot ask
anyone anything. The first night paid for four defects a linter now catches
before they cost a night: a `cargo run --` with no `--bin` running the wrong
binary, a `cargo test` filter with no pinned count standing in for a real
assertion, an artifact the acceptance mentions without a `Writes:` header, and
a code span that asserts failure informally instead of naming the exit
behaviour in prose. Announce: "Using nightwatch:spec to write a spec the
launcher can land unattended."

## 1. Read before asking

Read the code the outcome touches — the module boundaries, the existing
tests, the binaries and scripts already in the repo — before asking the user
anything. Then ask only what the code cannot answer, one question at a time.

## 2. Settle the four headings

```markdown
# <Outcome title>

Repo: <repo name>.
Depends: <slug>[, <slug>...]     # only if this spec needs another one landed first
Units: <n>                       # only if the default per-outcome cap is wrong for this one
Writes: <path>[, <path>...]      # every file an acceptance command creates

## Outcome

What exists when this is done, and what does not exist yet on main. Name the
exact files, modules and binaries by their real names — a wrong name resolves
the wrong target at night.

## Acceptance

Every item is a command with its expected output, checkable without a human.
One item is always the repo's `CHECK` command (from
`~/.local/state/nightwatch/<name>/config` — `scripts/check` when the repo
owns one, else the path `init.mjs` generated) → `CHECK OK`. A `cargo test <filter>` item
pins a count (`N passed`, `N tests`, or the word `exactly`) — a trivial test
must not stand in for the real assertion. A `cargo run --` or `cargo run
--release --` item names `--bin <name>` — an unnamed binary lets cargo guess.
A command that must fail says so in prose ("exits non-zero", "is refused",
"exits 1"), never as a code-span suffix like `` `cmd -- FAILS` ``. Any `.png`,
`.json`, `.md` or `.log` a command writes is also named in the header's
`Writes:` line.

## Non-goals

What this outcome explicitly does not do — the boundary a worker will
otherwise creep past at 2 a.m. with nobody to stop it.

## Context

Repo facts the worker needs in its first minute: module layout, the toolchain
version, where tests live, names already taken, line numbers that have moved
since any plan this spec is drawn from (locate by symbol, not by line).
```

`Depends:`, `Units:`, and `Writes:` are declared only when they apply — most
specs need none of them. A dependency names another spec's slug (its filename
without `.md`) in the same `--specs-dir`; the launcher will not start this
spec until that one has landed.

## 3. Write it, lint it, refuse to stop until it's clean

Write the file to the specs dir — the config's `SPECS` (default
`~/.local/state/nightwatch/<name>/specs`), `NN-<slug>.md` with `NN` the next
unused two-digit number in that directory — then run:

```
node <plugin>/nightwatch/lint-spec.mjs --specs-dir <specs-dir> --check <check> <file>
```

`<check>` is the config's `CHECK`, rendered the way `run.sh` and the engine
render it (double-quoted when the path isn't bare word characters).

A non-empty line means a problem, one per line, `<file>:<line>: <problem>`.
Fix the spec and re-run; do not consider the spec finished until the command
prints `SPEC OK (<n> specs)`. A `Depends:` on a slug not in the dir, on
itself, or forming a cycle across the dir's specs is a lint failure too — fix
the header, not the linter.

## 4. Hand off the launch line

```
caffeinate -i <plugin>/nightwatch/run.sh <name> --only <slug>
```

Print it and stop. This skill writes and lints the spec; running it,
watching it, and reading the morning are `nightwatch:watch` and
`nightshift:morning`'s jobs.
