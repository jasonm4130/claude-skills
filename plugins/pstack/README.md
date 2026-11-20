# pstack

A vendored subset of [Lauren Tan's pstack](https://github.com/cursor/plugins/tree/main/pstack) (MIT). The main reason it is here is `/no-comments`: a Comment Sicko agent deletes every comment that isn't a licence header, a quirk of something outside your code, `prettier-ignore`, a public API doc or an issue link, and marks code that needed a comment to make sense as `MUST KILL`. The skill then checks its report and fixes what it flagged.

## Install

```
/plugin marketplace add jasonm4130/claude-skills
/plugin install pstack@jasonm4130-claude-skills
```

Every skill is typed, not auto-loaded: `/pstack:no-comments`, `/pstack:unslop` and so on.

## Skills

| Skill | Use |
| --- | --- |
| `no-comments` | Run Comment Sicko over a diff or a list of files, then fix what it flags. Defaults to the diff against `main`. |
| `unslop` | Cut AI tells from a piece of writing. |
| `correct` | Find mistakes agents keep repeating in a repo and make each one fail a check. |
| `how` | Explain how part of a codebase works. |
| `why` | Explain why code is the way it is, from commits and PRs. |
| `architect` | Sketch types and module shape before code. `no-comments` calls it when a fix needs a new shape. |
| `principle-fix-root-causes`, `principle-redesign-from-first-principles` | Guidance `no-comments` reads before fixing flagged code. |

The `comment-sicko` agent is in `agents/`. `docs/harness/claude-code.md` is upstream's map from Cursor names to Claude Code, which every skill reads first.

## Provenance

Copied on 2026-11-20 from pstack 0.15.46, upstream commit [`aaeb0ea`](https://github.com/cursor/plugins/tree/aaeb0ea/harness/pstack/claude-code), using upstream's generated Claude Code copy. `LICENSE` is upstream's, copyright 2026 Lauren Tan. The other 50 pstack skills were left out on purpose: `poteto-mode` and `setup-pstack` set their own persona and model routing, and most of the rest are reached only through `poteto-mode`.

Changes from upstream:

- `no-comments`: spawns Comment Sicko on `opus` instead of reading a model from `poteto-mode`, which isn't vendored.
- `agents/comment-sicko.md`: pins `model: opus`.
- `how`: spawns its explorer on `sonnet`.
- `architect`: drops the line pointing at `arena`, which isn't vendored.
- `docs/harness/claude-code.md`: one added paragraph saying this subset has no `poteto-mode` or `setup-pstack`.

Everything else matches upstream. To update, copy the same files from a newer `harness/pstack/claude-code` and reapply the changes above.
