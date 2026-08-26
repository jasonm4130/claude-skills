# handoff

A `/handoff` skill that writes a structured resume document for the current session,
plus a SessionStart hook that auto-loads it in the next one.

## What it does

1. **`/handoff` skill (manual, on demand)** — you run it. The agent writes
   `.claude/handoffs/<ISO-timestamp>-<slug>.md` covering current state, failed
   approaches, key decisions, modified files, blockers, and the next concrete
   runnable step, then writes a `.pending` marker naming that file.
2. **Auto-loads on next session** — the SessionStart hook reads `.pending` and injects
   the handoff as context, so a `/clear` or a fresh session resumes where you stopped.
   The marker expires after 24 hours.

   The marker may only name a **bare filename** inside `.claude/handoffs/`, and the
   file is opened with `O_NOFOLLOW | O_NONBLOCK` — so a marker naming `../../.env`, a
   symlink, or a FIFO is refused and the marker consumed. This stops a checked-out repo
   from making the loader read files *outside* the handoffs directory. It does not
   verify who *wrote* a handoff: a repo that commits its own handoff file can still get
   that text into your context, so treat handoffs in an untrusted checkout with the same
   suspicion as any other file in it.

There is **no automatic trigger**. Earlier versions shipped a statusLine script that
watched context fill and nudged the agent to hand off at a threshold. That path only
ever fired through a user-configured `statusLine`, it never ran end-to-end in practice,
and it was removed in 0.11.0 along with its setup helper. Run `/handoff` when you want
one — typically when you are deliberately stopping: ending for the day, switching
machines, or clearing before a new line of work. Compaction carries an ordinary session
forward on its own; what a handoff adds is the "what we tried" record no summary
reproduces.

## Upgrading from ≤ 0.10.x

If you ever ran the old `setup.mjs`, your `~/.claude/settings.json` `statusLine`
points at a generated wrapper (`~/.claude/handoff-statusline.mjs`) that resolves a
statusline script this plugin no longer ships. After upgrading, that wrapper finds
nothing and your status line degrades to a bare directory name and `?`. Fix it once:

1. Remove (or repoint) the `statusLine` block in `~/.claude/settings.json`.
2. Delete the wrapper: `rm ~/.claude/handoff-statusline.mjs`.
3. If you set them, remove the `HANDOFF_THRESHOLD_PCT` / `HANDOFF_EFFECTIVE_MAX_TOKENS`
   env entries — nothing reads them anymore.

The `/handoff` skill itself needs none of this and keeps working unchanged.

## Prerequisites

- **Node.js 18+** on `PATH`. The Claude Code installer does not bring Node — install
  it via your platform package manager (Homebrew, WinGet, your distro's apt/dnf/pacman,
  or [nodejs.org](https://nodejs.org)).
- Claude Code `>= 2.1.110`.

## Install

```
/plugin install handoff@jasonm4130-claude-skills
```

No setup step. The skill and the SessionStart hook are live as soon as the plugin is
installed and Claude Code has restarted.

## Example flow

1. You work through a session and decide to stop.
2. You run `/handoff auth-token-bug`.
3. The agent writes `.claude/handoffs/2026-05-25T14-32-00-auth-token-bug.md` and a
   `.pending` marker naming it.
4. You run `/clear`, or come back tomorrow.
5. The SessionStart hook auto-loads the handoff:
   > "[handoff] Loading pending handoff from previous session: ..."
6. The agent resumes in context.

### Why a handoff must never be committed (and what happens if one is)

**Keep `/.claude/handoffs/` gitignored.** The skill tells you to, and the loader depends
on it.

A handoff is injected into the next session announced as *"from your previous session"* — which is
exactly the framing that makes an agent treat text as its own notes rather than as untrusted input. So
a repository that **commits** its own `.claude/handoffs/evil.md` plus a `.pending` naming it could hand
attacker-authored instructions to your agent under your own byline, the moment you opened the repo.
Nobody reviews `.claude/handoffs/`, which is what made it worth closing.

The gitignore convention is what makes this cheap to close, with no allowlist and no friction: **a
handoff this machine wrote is untracked, always, and a fresh clone cannot produce an untracked-but-
present ignored file.** So anything git *tracks* was shipped by the repo, not written here.

The loader refuses to auto-load a handoff (or a `.pending`) that git tracks. It emits
neither the contents nor the filename — both are attacker-controlled — and instead tells you plainly
that a committed handoff was found and skipped. If you trust the repo, read the file yourself.

The consequence, stated plainly: **if you commit your own handoffs, they will stop auto-loading.**
That is the intended trade — the loader cannot distinguish your committed handoff from a hostile one,
and guessing wrong in that direction is the whole vulnerability.

## Troubleshooting

**Handoff not auto-loading in a new session:**
- Confirm `.claude/handoffs/.pending` was written (check after running `/handoff`).
- If more than 24 hours have passed since the handoff was written, `.pending` is
  deleted as stale. The handoff file itself still exists — `cat` it manually.
- If the handoff or the `.pending` marker is committed to git, the loader refuses it by
  design — see above.
- The new session's events log starts empty. `/retro` will quick-skip (correct behavior).

**Note:** After a resumed session, the `session-retro` plugin's `/retro` quick-skip
gate will fire (no edits in the new session yet). This is expected — the handoff
gives you context, but the retro waits until you've actually done work in the new session.

## State files

| File | Location | Description |
|---|---|---|
| `<ts>-<slug>.md` | `$PROJECT_ROOT/.claude/handoffs/` | The handoff document (agent-authored) |
| `.pending` | `$PROJECT_ROOT/.claude/handoffs/` | Auto-load marker for next session (24h TTL) |
