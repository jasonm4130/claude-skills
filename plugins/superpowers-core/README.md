# superpowers-core

Owned fork of the [superpowers](https://github.com/obra/superpowers) process
skills, pinned to `6.1.1`.

## What it does

**Five skills:**

| Skill | Origin | What it's for |
|---|---|---|
| `brainstorming` | vendored | Design exploration before creative/build work — size-gated (trivial → skip, medium → lean plan, large/ambiguous → full spec) |
| `systematic-debugging` | vendored | Root-cause investigation before proposing a fix, for any bug/test-failure/unexpected behavior |
| `writing-plans` | vendored | Turns a spec/requirements into a sequenced implementation plan, with an open-questions list |
| `writing-skills` | rewritten | This repo's skill conventions + the wording findings from its own tests; defers to Anthropic's live spec for the format |
| `test-driven-development` | vendored | Failing-test-first discipline before implementation code |

## Where the dispatcher went

Earlier versions shipped a `using-skills` skill whose behavioral kernel — the
skill-selection and currency-verification rules — a `SessionStart` hook injected
as `additionalContext` at the start of every session. Those rules now live in the
owner's global `CLAUDE.md`, which Claude Code already loads at every session
start. Two copies of one rule drift, and when they disagree the model picks one
arbitrarily; the plugin keeps the skills and lets the global file keep the rules.

The plugin therefore ships no hook, and installing it no longer raises a
hook-approval prompt.

## Why a fork

Upstream superpowers ships a broader, more opinionated skill set tuned for a
generic setup. This fork keeps only the five process skills that don't overlap
with plugins already owned in this repo (SDD, codex-review, adr, …).

## Install

```
/plugin marketplace add jasonm4130/claude-skills
/plugin install superpowers-core@jasonm4130-claude-skills
/reload-plugins
```

## Requirements

- For the `writing-plans` handoff: the `codex-review` and
  `subagent-driven-development` plugins from the same marketplace — the finished
  plan is gated by `codex-plan-review`, then executed by
  `subagent-driven-development`. Without them installed, that handoff dangles.

## Tests

```
node --test plugins/superpowers-core/tests/*.test.mjs
```

Covers the shipped skill set (five method skills, no dispatcher, no hook) and
that no vendored skill still carries an upstream `superpowers:` cross-reference.

## License

MIT © 2025 Jesse Vincent — see `LICENSE`. The vendored skills originate from
[obra/superpowers](https://github.com/obra/superpowers); the packaging around
them is new.
