# Statusline adaptive redesign — design spec

- **Date:** 2026-07-16
- **Status:** design approved (brainstorming); pending implementation plan
- **Plugin:** `handoff` — source at `plugins/handoff/scripts/status-and-flag.mjs` (render) and `plugins/handoff/scripts/lib.mjs` (pure helpers). The `~/.claude/plugins/cache/.../handoff/<ver>/` copy is regenerated on install — never edit it.
- **Prior art:** `docs/plans/2026-07-14-statusline-architecture-research.md` (statusline contract + pile-up/caching architecture, shipped in 0.7.0). This spec adds the **percentage-stability** and **adaptive-display** layers that doc never covered (it flagged its context-derivation section "medium confidence").

## Problem

The context bar "fills and empties wildly" during normal work **even though context is not compacting** (the user's words). That locates the fault precisely: it is not a compaction-detection problem, it is a volatile-source problem during ordinary turns.

**Root cause — volatile source, wrong precedence.** The bar reads the per-request stdin `context_window.current_usage` **first** (`status-and-flag.mjs` Step 1) and the stable transcript reading only as a fallback (Step 2). Claude Code emits transient incomplete / zero status frames (anthropics/claude-code#13783; ccstatusline#370), so a partial frame makes the bar flash empty, then refill on the next real frame.

**One knock-on, same cause.** The nudge-band reset keys off that same volatile reading: a transient zero-frame drives `currentPct` below threshold → `resetBands` fires → the next real frame reads high again → the band re-fires a nudge already delivered. This looks like a second bug ("compaction inferred from a %-drop") but it is the *same* volatile source feeding a downstream predicate. Fixing the source fixes both; the below-threshold reset predicate itself is sound (it is idempotent and self-healing — see `status-and-flag.mjs:224-229`) once it is fed a stable reading.

**Not the cause** (verified, do not "fix"):
- The **400k denominator** is correct and necessary. Claude Code's native `used_percentage` "always uses the model's full context window" (docs), so on a 1M model with `autoCompactWindow: 400000` it would read ~10% near the real ceiling. Issue #62210 asking Claude Code to expose the compaction budget was closed **NOT_PLANNED**; `HANDOFF_EFFECTIVE_MAX_TOKENS` is the only workaround.
- **Subagents.** Their tokens never fold into the main `context_window`; subagent usage is a separate `subagentStatusLine` payload. This session's heavy subagent use was not the cause.

## Goals

1. A **stable** context reading: monotonic-up within a compaction segment; no flicker from transient frames. The only downward step is one turn after a real compaction (see the accepted trade-off in Non-goals).
2. An **adaptive** display: quiet by default, surfacing detail only when it matters.
3. Four segments: **context bar, model, rate-limits, git**. No cost meter.
4. **Every new segment degrades to nothing.** Any segment whose source is absent, malformed, or times out is omitted — it never renders `NaN%`, `undefined`, or an error, and never takes the bar down (parity with the existing "a failed write must never take the bar down" constraint).

## Non-goals

- No session-cost (USD) segment (deliberately dropped by the user — rate-limit headroom is the real budget signal on a subscription).
- No attempt to compute "true % until auto-compact." The real trigger counts input+output against a smaller effective window — a gap up to ~48 points (anthropics/claude-code#17959), undocumented. The 400k-budget percentage is an honest proxy, not ground truth.
- No change to the denominator mechanism. `HANDOFF_EFFECTIVE_MAX_TOKENS` stays; when unset, existing raw-`used_percentage` behavior is preserved unchanged.
- **No exact-at-the-boundary bar reset, and no `compact_boundary` marker detection.** Immediately after `/compact`, `current_usage` is `null` (documented) and the most-recent transcript assistant turn is still the pre-compaction (high) one — so no trustworthy post-compaction value exists until the next assistant turn is written. Rather than invent one (render `?`, guess a floor) or add durable per-boundary acknowledgement state to make a marker-driven reset fire exactly once, the bar simply drops one turn later, when the first post-compaction turn lands. That one-turn lag is invisible next to the flicker being removed, and it keeps the engine to one mechanism (transcript-primary) instead of two.

## Design — stability engine

### 1. Context source: transcript-primary
Promote `lastAssistantUsageFromTranscript` (last main-chain assistant turn; already `isSidechain !== true`-filtered and mtime+size-cached via `cachedTranscriptUsage`) from fallback to **primary** source. stdin `current_usage` becomes a fallback used **only** when the transcript has no main-chain assistant turn yet (session start), and is null-guarded. The token sum stays `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` (output excluded — matches Claude Code's own `used_percentage` definition).

Rationale: the transcript reading changes only when a completed assistant turn is written (once per turn), so it is immune to the transient partial frames that drive the flicker. It is already cached, so promoting it adds no per-tick cost. Because the same reading feeds the nudge-band gate, this one change also removes the spurious reset-then-re-fire described in Problem — no separate fix needed.

### 2. Nudge-band reset (existing mechanism, unchanged — made robust by #1)
The band reset is **not** re-engineered. The current logic (`status-and-flag.mjs:221-247`) resets the ladder when `currentPct` falls below threshold and otherwise re-arms via `lastPct` tracking; that already re-fires a nudge correctly after a compaction, *including* a compaction that lands still-above threshold (`lastPct` tracks the drop down, so a later climb crosses a fresh band). Its only defect was the volatile source feeding it — fixed in #1.

Deliberately **not** added: `compact_boundary` marker detection. A marker-driven reset would need durable per-boundary acknowledgement (a byte offset or line hash persisted across renders) to fire exactly once — otherwise it either misses the reset (a post-boundary assistant turn precedes the first render, so a backward scan finds the turn before the boundary) or re-resets on every render (rediscovering the same historical boundary forever). That machinery buys nothing the below-threshold reset does not already deliver once its input is stable. Cut it (YAGNI).

### 3. Denominator (unchanged)
`pct = tokens / HANDOFF_EFFECTIVE_MAX_TOKENS * 100` (400000). Env var unset → preserve current behavior (raw `used_percentage`).

## Design — adaptive display

### Always-visible core (left → right)
`<identity> ⎇<branch> · <bar> <pct>% · <model>`
- **identity** — cwd basename (the worktree dir name in a worktree, e.g. `claude-skills-t2`, so parallel SDD sessions are distinguishable).
- **branch** — `⎇<name>`.
- **bar** — 10-block `█`/`░`, colored by `pct` (see table).
- **pct** — integer percent of the 400k budget.
- **model** — `model.display_name` from stdin; **Fable renders amber** as a standing "2×-tier" flag.

Calm example: `claude-skills ⎇main · ███░░░░░░░ 24% · Opus 4.8`

### Conditional segments (surface only past a threshold)
- **dirty count** `±N` — appended to the branch only when the worktree has N>0 changed files.
- **rate-limits** `5h NN% 7d NN%` — sourced from `rate_limits.{five_hour,seven_day}.used_percentage`. This field is **absent** for non-subscribers and before the first API response, and either window can be absent independently. Contract: read each window's `used_percentage` and use it only when it is a finite number; a window that is absent or non-numeric is silently dropped (never `NaN%`). Of the windows that remain, each surfaces only at `≥ RATE_LIMIT_SURFACE_PCT` (default 50); the whole segment is hidden when nothing qualifies. A `⚠` leads the segment when any surfaced window is red.
- **context tokens** `(NNNk)` — appended to `pct` only when the bar is red (≥70%), to make closeness to the 400k handoff concrete exactly when it matters (70% is already the handoff-nudge threshold).

Busy example: `claude-skills-t2 ⎇sdd/t2 ±5 · ███████░░░ 71% (287k) · Fable 5 · ⚠ 5h 84% 7d 21%`

### Git segment — source, working dir, failure modes
The current renderer reads the branch from stdin `worktree.branch`, which is populated **only** inside a git worktree (the SDD sibling worktrees). In an ordinary main-worktree session that field is absent, so an always-visible branch requires shelling out. Contract:

- **Working directory** — `wsDir` (the already-resolved `workspace.current_dir`, else `cwd`).
- **Fast path** — when stdin `worktree.branch` is present and non-empty, use it verbatim and skip the branch shell-out (zero cost; preserves current worktree-session behavior).
- **Branch (shell-out)** — `git -C <wsDir> symbolic-ref --quiet --short HEAD`. Exit 0 → the branch name. Non-zero → not on a branch; fall back to `git -C <wsDir> rev-parse --short HEAD`: success → **detached**, render `⎇@<sha7>`; failure → **not a git repo**, omit the whole git segment (no branch, no dirty).
- **Dirty count** — `git -C <wsDir> status --porcelain`; N = count of non-empty lines (tracked + untracked). Render `±N` only when N>0.
- **Guardrails** — both commands run via `spawnSync` with the same option shape the existing `gitTracksFile` helper uses (`{ encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }`, argv array — never a shell string), branching on `r.status === 0`, with `timeout` = `GIT_TIMEOUT_MS` (250 ms). A non-zero status (handled above), a timeout, a missing `git` binary, or any throw omits the affected piece and **never** takes the bar down. `node:child_process` is already imported in `lib.mjs`.
- **Performance** — git runs only on the primary render path; the overlap guard's replay path re-emits the cached line without shelling out, and the 250 ms timeout bounds the worst case on a large repo (degrading to "no git segment"), so this cannot reintroduce the ccusage#459 pile-up.

### Colors
| element | green | amber | red |
|---|---|---|---|
| context bar | <50% | 50–69% | ≥70% |
| rate-limit (5h / 7d) | *hidden* <50% | 50–79% | ≥80% |
| model | Opus / Sonnet / Haiku | **Fable** | — |
| dirty | — | `±N` present | — |

### Width behavior (best-effort — `COLUMNS` is not guaranteed)
`COLUMNS` is only populated by Claude Code from v2.1.153, but the plugin supports `>=2.1.110`; older supported versions (and any environment that does not export it) leave it unset. So width management is **best-effort**, not a guarantee: the design targets a clean line at typical widths, and accepts that on an older client in a very narrow terminal the line may soft-wrap. We do **not** raise the engine floor to 2.1.153 just for this — that would drop the plugin's whole 2.1.110–2.1.152 install base to fix a cosmetic wrap.

Algorithm: compute visible width (ANSI escapes excluded) against `COLUMNS` (else a default of 120). If over budget, drop segments right→left in this order:
1. rate-limits
2. dirty count
3. shorten model to its first word (`Opus 4.8` → `Opus`)
4. **final clamp** — if still over budget (a pathologically long branch or identity), hard-truncate branch to 24 chars and identity to 24 chars, each with a `…` ellipsis. This bounds the worst case even when `COLUMNS` is present and the first three drops are exhausted.

Never drop the context bar or `pct`; identity and branch may be *truncated* (step 4) but never removed entirely.

### Tunable defaults (call out in code as named constants)
- `RATE_LIMIT_SURFACE_PCT = 50`
- `SHOW_TOKENS_WHEN_RED = true`
- `GIT_TIMEOUT_MS = 250`
- `BRANCH_MAX_CHARS = 24`, `IDENTITY_MAX_CHARS = 24` (final-clamp budgets)
- truncation order = `["rate-limits", "dirty", "model-shorten", "final-clamp"]`

## Testing

Formatting/parsing/predicate logic goes in `lib.mjs` as plain **named exports** and is unit-tested in `tests/lib.test.mjs` by direct ESM `import` — the harness this plugin already uses (no PURE-block/`new Function` indirection; that is the SDD plugin's pattern, not handoff's). The git shell-out belongs in `lib.mjs` alongside the existing `gitTracksFile` helper, which already shells to git via `node:child_process`; keep the command-output *parsing* as its own pure export and exercise the shell-out via an integration test against a throwaway temp git repo (the `mkdtempSync` pattern `tests/lib.test.mjs` already uses). Cover:
- **context source selection** — transcript-primary; stdin fallback only when no main-chain turn; null-guard on a null/partial `current_usage`.
- **band reset unchanged, now stable** — a stable (non-zero) transcript reading never triggers a spurious below-threshold reset; a genuine drop below threshold still resets. (No `compact_boundary` path exists to test — its absence is the point.)
- **git parsing** — `symbolic-ref` output → branch; `symbolic-ref` fail + `rev-parse` success → `@<sha7>` detached; both fail → segment omitted; `status --porcelain` line-count → dirty N (0 → no `±`).
- **git failure modes** (integration) — timeout, missing `git` binary, non-git directory → segment omitted, bar still renders.
- **rate-limit absence** — absent `rate_limits`, absent single window, non-numeric `used_percentage` → dropped, never `NaN%`; present-and-≥-threshold → surfaced.
- **other surfacing predicates** — dirty (N>0), tokens (only when red).
- **color selection** — by threshold for bar and rate-limit; Fable → amber.
- **width truncation** — drops in the specified order including the final clamp; identity/branch truncated to their max-char budgets with `…`; bar and pct never dropped; with `COLUMNS` unset, falls back to the 120 default without throwing.

Render assembly in `status-and-flag.mjs` is exercised against representative stdin payloads (calm / busy / narrow-terminal / no-git / non-subscriber) — asserting on the plain-text (ANSI-stripped) line so tests are color-agnostic.

Red→green TDD per repo convention (`node --test <file>`).

## Files touched
- `plugins/handoff/scripts/lib.mjs` — new pure helpers (git-output parsing, rate-limit selection, width truncation, segment predicates).
- `plugins/handoff/scripts/status-and-flag.mjs` — precedence flip (transcript-primary), git segment (via a `lib.mjs` `spawnSync` helper matching `gitTracksFile`), adaptive render assembly. No `compact_boundary` logic.
- `plugins/handoff/tests/lib.test.mjs`, `plugins/handoff/tests/status-and-flag.test.mjs`, and an integration test for the git shell-out — tests.
- `plugins/handoff/.claude-plugin/plugin.json` + root `.claude-plugin/marketplace.json` — version bump 0.7.0 → 0.8.0 (kept in sync; `scripts/repo-consistency.test.mjs` enforces). Engine floor stays `>=2.1.110` (see Width behavior).

## Rollout / compatibility
Backward compatible. No settings migration. `HANDOFF_EFFECTIVE_MAX_TOKENS=400000` (already set) unchanged; unset → legacy behavior. The regenerated cache copy picks up the new source on next plugin update.
