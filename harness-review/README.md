# harness-review

Measurement scripts for the weekly Claude Code failure review. Not a plugin: nothing
here runs in a session. The weekly job (not yet built) and humans run them by hand.

`matchers/` is **matcher set v1 (2026-09-29)**. The weekly review compares failure
rates before and after a harness change, so a matcher must not change underneath a
running comparison. To change a category's regex, bump the version here, note what
changed, and re-baseline any open experiment on that category.

| Script | Reads | Emits |
|---|---|---|
| `matchers/extract.py [--since YYYY-MM-DD] [--out f]` | `~/.claude/projects/**/*.jsonl` transcripts, subagents included | input-free rows: tool calls (input hashed), errors with a category, human-message correction flags (no text), interrupts, compactions |
| `matchers/analyze.py [events.jsonl]` | extract.py output | per-category counts, sessions, main vs subagent, rate per 1,000 calls, daily trend, identical-retry streaks |
| `matchers/bash_exit_clusters.py` | transcripts | `Exit code N` failures grouped by output signature, excluding zsh and 1Password, which extract.py counts separately |

Run with `uv run --no-project python matchers/extract.py`. Output defaults to
`$TMPDIR/harness-corpus/`. No raw command, output or message text is written.

Session ids starting `canary-` come from `claude-canary` (chezmoi) and must be
excluded from any rate.
