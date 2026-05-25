---
description: >
  Write a structured handoff / resume document for this session so the next
  session can pick up exactly where this one left off. Use when the user asks
  to write a handoff, "prep for resume", "session handoff", or when context
  is high and you want to preserve state before /compact or /clear.
  Triggers: "/handoff", "handoff", "write a handoff", "prep for resume",
  "session handoff", "write a resume doc", "handoff before clear".
---

# Handoff

Write a structured resume document that lets the next Claude session
understand exactly where this session left off — without needing any of this
conversation's context.

Accept an optional free-form `<focus>` argument. If provided, use it as the
slug (lowercased, spaces replaced with hyphens). If omitted, slug = `auto`.

## Output location

```
$PROJECT_ROOT/.claude/handoffs/<ISO-timestamp>-<slug>.md
```

For example:
- `/handoff auth-token-bug` → `.claude/handoffs/2026-05-25T14-32-00-auth-token-bug.md`
- `/handoff` → `.claude/handoffs/2026-05-25T14-32-00-auto.md`

Create the `.claude/handoffs/` directory if it doesn't exist. It should be
gitignored — add `/.claude/handoffs/` to `.gitignore` if not already present.

## Required sections

Write these sections in order. Keep each section tight.

### Current state
1-2 sentences. Where are we right now? What's working, what's half-done?

### What we tried (MOST IMPORTANT)
Bullet list of failed/abandoned approaches and why each failed. This is the
highest-value section — the next session must not re-attempt the same dead
ends. If nothing failed, write "Nothing failed — clean path to current state."

### Key decisions
Each decision on its own line: **Decision** — *why*. No orphan decisions
without a reason.

### Modified files
Table or list: file path + one-line note on what changed and why. Be concrete
(`src/auth/token.ts` — added 24h expiry check, not "changed auth file").

### Blockers
Anything that is genuinely blocked and why. If none, write "None."

### Next concrete step
A single runnable instruction. Must be one of:
- A bash command: `npm test -- auth.test.ts`
- A file+line: `src/auth/token.ts:142 — implement the refresh logic`
- A numbered list if the next step has 2-3 substeps

NOT acceptable: "continue the refactor", "pick up where we left off",
"keep going with the auth work".

## Worked example

```markdown
## Current state
Token refresh is half-implemented. The request path works but the 401-retry
loop in `fetchWithAuth` is not wired up yet.

## What we tried
- Tried intercepting at the axios level (src/api/client.ts) — abandoned
  because interceptors run before the token check, causing double-refresh.
- Tried a global event bus approach — too complex, reverted in commit a3f9d2.

## Key decisions
- **Store refresh token in httpOnly cookie** — avoids XSS exposure via
  localStorage (OWASP TOP-10 A02).
- **Retry once on 401, then force logout** — prevents infinite loops on
  revoked tokens.

## Modified files
- `src/auth/token.ts` — added `refreshAccessToken()`, wires to cookie store
- `src/api/fetchWithAuth.ts` — placeholder for retry logic (TODO at line 58)
- `tests/auth.test.ts` — added 3 token-refresh scenarios, all currently skipped

## Blockers
- `refreshAccessToken()` needs the backend `/auth/refresh` endpoint, which
  isn't deployed yet. Ticket: JIRA-4821.

## Next concrete step
Open `src/api/fetchWithAuth.ts:58`, implement the retry wrapper:
`if (res.status === 401) { await refreshAccessToken(); return fetch(req); }`
Then run: `npm test -- --testPathPattern auth`
```

## Rules

1. **Don't duplicate content already in commits/PRDs/diffs.** Reference them
   instead: "See commit a3f9d2 for the axios interceptor attempt" or
   "See docs/auth-design.md for the token storage rationale."
2. **Redact secrets.** Never write API keys, tokens, or credentials into the
   handoff doc. Instead write: `API_KEY=[retrieve from 1Password vault
   "project-name dev"]` or `TOKEN=[set via: aws sso login --profile dev]`.

## Pre-write checklist

Before writing the file, verify internally:
- [ ] No secrets, tokens, or credentials in any section
- [ ] Every modified file is listed with a concrete description
- [ ] Every decision has a stated reason
- [ ] "Next concrete step" is runnable without asking questions

## After writing

Run this to register the handoff for auto-load on next session:

```bash
HANDOFF_FILENAME=$(basename "$HANDOFF_PATH")
mkdir -p "$(dirname "$HANDOFF_PATH")"
printf "%s" "$HANDOFF_FILENAME" > "$PROJECT_ROOT/.claude/handoffs/.pending"
```

Tell the user:
> "Handoff written to `.claude/handoffs/<filename>`. If you run `/clear` or
> start a fresh session within 24 hours, the next session will auto-load it
> via the SessionStart hook."

Note: if the user has the `handoff` plugin installed and its `load-pending-handoff.sh`
SessionStart hook is active, the handoff will inject automatically. If not,
the user can manually `cat .claude/handoffs/<filename>` to prime the next session.
