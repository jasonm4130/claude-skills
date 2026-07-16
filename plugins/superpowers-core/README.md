# superpowers-core

Owned fork of the [superpowers](https://github.com/obra/superpowers) process
skills (pinned to `6.1.1`), plus `using-skills` — a replacement dispatcher that
governs skill selection and currency verification for every turn.

## What it does

**Six skills:**

| Skill | Origin | What it's for |
|---|---|---|
| `brainstorming` | vendored | Design exploration before creative/build work — size-gated (trivial → skip, medium → lean plan, large/ambiguous → full spec) |
| `systematic-debugging` | vendored | Root-cause investigation before proposing a fix, for any bug/test-failure/unexpected behavior |
| `writing-plans` | vendored | Turns a spec/requirements into a sequenced implementation plan, with an open-questions list |
| `writing-skills` | vendored | Creating, editing, or verifying skills before deployment |
| `test-driven-development` | vendored | Failing-test-first discipline before implementation code |
| `using-skills` | owned, new | The dispatcher — match-and-proportion skill selection + currency/verification rules |

`using-skills` replaces upstream's `using-superpowers`. It isn't invoked like
the others — a `SessionStart` hook injects its behavioral kernel as
`additionalContext` at the start of every session, on `/clear`, on
`claude --resume`/`--continue`, and after auto-compact, so the rules that
govern skill selection are present *before* the model acts rather than
depended on being read from a skill list.

## Why a fork

Upstream superpowers ships a broader, more opinionated skill set and its own
dispatcher (`using-superpowers`) tuned for a generic setup. This fork keeps
only the five process skills that don't overlap with plugins already owned in
this repo (SDD, codex-review, visual-plan, adr, …), and replaces the
dispatcher with `using-skills`, whose specificity-wins rule defers to those
owned, narrower skills instead of colliding with them.

## Install

```
/plugin marketplace add jasonm4130/claude-skills
/plugin install superpowers-core@jasonm4130-claude-skills
/reload-plugins
```

On first load, Claude Code will prompt you to approve the `SessionStart` hook.
This is normal — plugins that execute code require explicit user trust.

## Requirements

- Claude Code ≥ 2.1.110 (for `additionalContext` support and the `resume`
  `SessionStart` matcher source)
- Node.js 18+ on `PATH` — used by `hooks/session-start` to JSON-encode the
  injected kernel; no other dependency

## Tests

```
node --test plugins/superpowers-core/tests/
```

Covers the `SessionStart` hook: valid JSON with a non-empty
`additionalContext` kernel, and the `startup|resume|clear|compact` matcher
covering all four session-start sources.

## License

MIT © 2025 Jesse Vincent — see `LICENSE`. The vendored skills originate from
[obra/superpowers](https://github.com/obra/superpowers); `using-skills` and
the packaging around them are new.
