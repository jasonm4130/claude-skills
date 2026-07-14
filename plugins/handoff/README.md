# handoff

Context-fill-triggered handoff skill — writes a structured resume document
when your context window fills up, and auto-loads it in the next session.

## What it does

1. **Monitors context fill** via a statusLine command that renders a color-coded
   progress bar and detects when context crosses a configurable threshold (default 70%).
   Since 0.5.0 the bar is prefixed with the working-dir basename (and `⎇branch` when in
   a git worktree) so parallel sessions in different tabs are tellable apart at a glance.
   Since 0.6.0, each nudge is **idempotent per band**: an atomic exclusive-create marker
   (not a lock) guarantees a band fires at most once no matter how many invocations race,
   and the transcript-derivation fallback is cached on the transcript's path + mtime + size
   so the expensive read only runs when the transcript actually changed. Overlapping
   invocations (Claude Code can fire the next one before a slow render finishes) are still
   guarded — a concurrent run replays the previous render — but that guard is a
   **performance guard**, not a mutex: it never breaks a lock on age alone or one whose
   holder is alive, and correctness does not depend on it (statusLine has no documented
   timeout).
2. **Nudges escalate with context** — a nudge fires on every 10%-point band
   entered at or above the threshold (e.g. 70%, then again at 80%, then again
   at 90%), not just once. Marathon sessions that sail past the first nudge
   still get re-nudged as they climb. Each nudge is delivered as an
   agent-directed `additionalContext` injection on the next user prompt, with
   wording that gets more urgent near the top of the window (see below).
3. **`/handoff` skill** — the agent writes a structured `.claude/handoffs/<ts>-<slug>.md`
   document covering current state, failed approaches, key decisions, modified files,
   blockers, and the next concrete runnable step.
4. **Auto-loads on next session** — after `/handoff`, a `.pending` marker is written.
   The SessionStart hook reads it and injects the handoff as context so the next
   session resumes seamlessly. The marker expires after 24 hours.

   The marker may only name a **bare filename** inside `.claude/handoffs/`, and the
   file is opened with `O_NOFOLLOW | O_NONBLOCK` — so a marker naming `../../.env`, a
   symlink, or a FIFO is refused and the marker consumed. This stops a checked-out repo
   from making the loader read files *outside* the handoffs directory. It does not
   verify who *wrote* a handoff: a repo that commits its own handoff file can still get
   that text into your context, so treat handoffs in an untrusted checkout with the same
   suspicion as any other file in it.

## Prerequisites

- **Node.js 18+** on `PATH`. The Claude Code installer does not bring Node — install
  it via your platform package manager (Homebrew, WinGet, your distro's apt/dnf/pacman,
  or [nodejs.org](https://nodejs.org)).
- Claude Code `>= 2.1.110`.

## Install

```
/plugin install handoff@jasonm4130-claude-skills
```

After install, run the one-time `setup.mjs` helper to wire the context-fill bar into
your user-level `statusLine`:

```bash
node "$(echo ~/.claude/plugins/cache/jasonm4130-claude-skills/handoff/*/scripts/setup.mjs | tr ' ' '\n' | sort -V | tail -n1)"
```

The setup script:

1. Reads (or creates) `~/.claude/settings.json`.
2. Backs the current file up to `~/.claude/settings.json.pre-handoff.bak`.
3. Writes a stable wrapper at `~/.claude/handoff-statusline.mjs` that
   auto-resolves the highest installed plugin version at run time.
4. Writes a `statusLine` entry pointing at that stable wrapper.
5. Tells you to restart Claude Code.

Because the statusLine now points at the stable wrapper rather than a
version-specific path, **plugin upgrades no longer require re-running setup**.
The wrapper picks up the new version automatically on the next Claude Code restart.

If you already have a custom `statusLine` configured, setup will refuse to overwrite
it. Re-run with `--force` if you want to replace it, or merge manually — see "Existing
statusLine" below.

### Existing statusLine

If you already have a `statusLine` configured (e.g., a custom HUD), you will need
to merge the outputs. Composable statusLine (running multiple commands and combining
output) is not yet supported by Claude Code. For now, the options are:

- Replace your existing statusLine with this plugin's script, or
- Run your existing script from inside `status-and-flag.mjs` and append its output.

Composable statusLine support is tracked as a follow-up.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `HANDOFF_THRESHOLD_PCT` | `70` | Context % at which to fire the nudge |
| `HANDOFF_EFFECTIVE_MAX_TOKENS` | _(unset)_ | Token ceiling to compute pct against — mirror your `autoCompactWindow` setting. When set, a JSONL transcript fallback (added in 0.3.0) is used if `current_usage` is absent or all-zero in stdin. |
| `CLAUDE_PLUGIN_DATA` | `<os.tmpdir>/handoff-data` | Where flag and last-pct state files are stored |

Set env vars in `~/.claude/settings.json` under `"env"`:

```json
{
  "env": {
    "HANDOFF_THRESHOLD_PCT": "65",
    "HANDOFF_EFFECTIVE_MAX_TOKENS": "400000"
  }
}
```

### Why `HANDOFF_EFFECTIVE_MAX_TOKENS`?

Claude Code's statusLine stdin reports `used_percentage` against the model's
**full context window** (e.g. 1M tokens for extended-context Sonnet), not
against your `autoCompactWindow` setting. If you have
`"autoCompactWindow": 400000` and you're 96% through your effective window,
the bar would otherwise show ~35% and the nudge would fire far too late
(or never).

Setting `HANDOFF_EFFECTIVE_MAX_TOKENS` to match your `autoCompactWindow`
makes the plugin compute pct from the input-only token fields in stdin's
`context_window.current_usage` against your effective ceiling. The bar and
nudge then track CC's native "% until auto-compact" indicator.

When unset (or 0 / non-numeric / negative), the plugin falls back to the raw
`used_percentage` field — same behavior as v0.2.0.

This is a workaround for upstream
[anthropics/claude-code#62210](https://github.com/anthropics/claude-code/issues/62210)
(stdin doesn't expose `autoCompactWindow` or a pre-computed
"% until auto-compact"). Tracked locally as
[issue #4](https://github.com/jasonm4130/claude-skills/issues/4).

## Example flow

1. You work through a session. Context climbs.
2. At 70%, the status bar turns red: `[███████░░░] 71%`. On your next prompt,
   the agent gets an instruction to wrap the current step and run `/handoff`,
   and suggest `/clear` to you.
3. You keep going — a long session sails past 70%. At 80% and again at 90%
   the nudge re-fires (once per 10%-point band), so it isn't a one-shot that
   gets missed in a marathon session. Past 85%, the wording escalates: the
   agent is told to run the handoff skill **now**, stop starting new work, and
   tell you to `/clear`.
4. You run `/handoff auth-token-bug`.
5. The agent writes `.claude/handoffs/2026-05-25T14-32-00-auth-token-bug.md`.
6. You run `/clear`.
7. Next session starts — the SessionStart hook auto-loads the handoff:
   > "[handoff] Loading pending handoff from previous session: ..."
8. The agent resumes in context.

### Why a handoff must never be committed (and what happens if one is)

**Keep `/.claude/handoffs/` gitignored.** The skill tells you to, and since 0.7.0 the loader depends
on it.

A handoff is injected into the next session announced as *"from your previous session"* — which is
exactly the framing that makes an agent treat text as its own notes rather than as untrusted input. So
a repository that **commits** its own `.claude/handoffs/evil.md` plus a `.pending` naming it could hand
attacker-authored instructions to your agent under your own byline, the moment you opened the repo.
Nobody reviews `.claude/handoffs/`, which is what made it worth closing.

The gitignore convention is what makes this cheap to close, with no allowlist and no friction: **a
handoff this machine wrote is untracked, always, and a fresh clone cannot produce an untracked-but-
present ignored file.** So anything git *tracks* was shipped by the repo, not written here.

Since 0.7.0 the loader refuses to auto-load a handoff (or a `.pending`) that git tracks. It emits
neither the contents nor the filename — both are attacker-controlled — and instead tells you plainly
that a committed handoff was found and skipped. If you trust the repo, read the file yourself.

The consequence, stated plainly: **if you commit your own handoffs, they will stop auto-loading.**
That is the intended trade — the loader cannot distinguish your committed handoff from a hostile one,
and guessing wrong in that direction is the whole vulnerability.

### Nudge wording tiers

| Context % | Wording |
|---|---|
| threshold – 84% | `[handoff] Context at <pct>% (past threshold). Wrap the current step, then run the handoff skill before starting anything new; suggest /clear to the user.` |
| ≥ 85% | `[handoff] Context at <pct>% — run the handoff skill NOW, then tell the user to /clear and resume from the handoff. Do not start new work.` |

### Band-crossing semantics

The flag fires on every 10%-point band entered at or above the threshold —
e.g. with the default 70% threshold: 70, 80, 90. Moving within a band (72% →
75%) does not re-fire; entering a new band (75% → 81%) does, even if a
previous band's nudge was already consumed. Below the threshold, no nudge
fires regardless of band movement.

Bands are computed relative to the configured threshold, not absolute
deciles — so a non-decile `HANDOFF_THRESHOLD_PCT` (e.g. 75) still fires its
first nudge as soon as context crosses 75%, then again at 85%, 95%, etc.,
rather than waiting for the next absolute 10%-boundary.

### Concurrency and caching (0.6.0)

- **Nudges are idempotent per band.** An atomic exclusive-create marker
  (`handoff-fired-<sid>-t<thr>-b<N>`) — not a lock — is what guarantees a band fires at
  most once, no matter how many statusline invocations race to claim it. Dropping below
  the threshold (a fresh session, or a `/compact`) clears the marker ladder, so a
  compact-then-refill still escalates again.
- **The transcript JSONL fallback is cached** on the transcript's path + mtime + size, so
  the expensive full-file parse only runs when the transcript has actually changed since
  the last invocation.
- **The overlap guard is a performance guard** (don't pile up; replay the cached render
  instead of recomputing), not a mutex. It never breaks a lock on age alone and never
  breaks one whose holder is alive — but it is explicitly not race-free, and nudge
  correctness does not depend on it.
- **No timeout claim.** statusLine is not a hook and has no documented invocation timeout;
  nothing here rests on Claude Code killing a slow run.

## Troubleshooting

**No nudge firing even though context is high:**
- Check that `status-and-flag.mjs` is being called (verify statusLine wiring;
  re-run `setup.mjs` if unsure).
- Check the last-pct file is updating: `cat $TMPDIR/handoff-data/last-context-pct-<session-id>.txt`
  (or wherever `CLAUDE_PLUGIN_DATA` points).
- Make sure the threshold env var is not set higher than the current context %.
- If the bar shows a much lower % than CC's native "% until auto-compact",
  set `HANDOFF_EFFECTIVE_MAX_TOKENS` to match your `autoCompactWindow` — see
  Configuration above.
- If `current_usage` is missing from stdin (can happen early in a session),
  the bar will fall back to reading the transcript JSONL for the last assistant
  turn's token count. If both are unavailable (no assistant turns yet), the bar
  renders `?`.

**Nudge fires repeatedly on every prompt:**
- The `UserPromptSubmit` hook (`check-handoff-flag.mjs`) should delete the flag after consuming it.
- Check for errors in the hook: run `check-handoff-flag.mjs` manually with test input.
- If `CLAUDE_PLUGIN_DATA` is unset and the tmpdir fallback is not writable, the flag may
  not be created or deleted correctly.
- Note: since 0.4.0, re-firing at each new 10%-point band (70/80/90) is
  expected behavior, not a bug — see "Band-crossing semantics" above.

**Handoff not auto-loading in new session:**
- Confirm `.claude/handoffs/.pending` was written (check after running `/handoff`).
- If more than 24 hours have passed since the handoff was written, `.pending` is
  deleted as stale. The handoff file itself still exists — `cat` it manually.
- The new session's events log starts empty. `/retro` will quick-skip (correct behavior).

**Note:** After a resumed session, the `session-retro` plugin's `/retro` quick-skip
gate will fire (no edits in the new session yet). This is expected — the handoff
gives you context, but the retro waits until you've actually done work in the new session.

## State files

| File | Location | Description |
|---|---|---|
| `handoff-statusline.mjs` | `~/.claude/` | Stable wrapper script that auto-resolves the latest installed plugin version (written by setup.mjs) |
| `last-context-pct-<sid>.txt` | `$CLAUDE_PLUGIN_DATA` | Tracks last seen context % for band-crossing detection |
| `handoff-nudge-<sid>.flag` | `$CLAUDE_PLUGIN_DATA` | Nudge flag, consumed by UserPromptSubmit; re-written on each new 10%-point band |
| `handoff-fired-<sid>-t<thr>-b<N>` | `$CLAUDE_PLUGIN_DATA` | Per-band claim marker — the atomic arbiter that makes a nudge fire at most once per band, however many invocations race. Cleared when context drops below the threshold. |
| `transcript-usage-<sid>.json` | `$CLAUDE_PLUGIN_DATA` | Cached transcript parse, keyed on the transcript's path + mtime + size |
| `statusline-inflight-<sid>.lock` | `$CLAUDE_PLUGIN_DATA` | In-flight marker for the (best-effort) overlap guard; breakable once past its lease AND its holder is provably gone — age alone never breaks it |
| `last-render-<sid>.txt` | `$CLAUDE_PLUGIN_DATA` | Last rendered statusline output, replayed verbatim by overlapping invocations |
| `<ts>-<slug>.md` | `$PROJECT_ROOT/.claude/handoffs/` | The handoff document (agent-authored) |
| `.pending` | `$PROJECT_ROOT/.claude/handoffs/` | Auto-load marker for next session (24h TTL) |
