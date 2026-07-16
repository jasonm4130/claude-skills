# Statusline adaptive redesign — design spec

- **Date:** 2026-07-16
- **Status:** design approved (brainstorming); pending implementation plan
- **Plugin:** `handoff` — source at `plugins/handoff/scripts/status-and-flag.mjs` (render) and `plugins/handoff/scripts/lib.mjs` (pure helpers). The `~/.claude/plugins/cache/.../handoff/<ver>/` copy is regenerated on install — never edit it.
- **Prior art:** `docs/plans/2026-07-14-statusline-architecture-research.md` (statusline contract + pile-up/caching architecture, shipped in 0.7.0). This spec adds the **percentage-stability** and **adaptive-display** layers that doc never covered (it flagged its context-derivation section "medium confidence").

## Problem

The context bar "fills and empties wildly" during normal work even though context is not compacting. Two root causes, both grounded:

1. **Volatile source, wrong precedence.** The bar reads the per-request stdin `context_window.current_usage` **first** (`status-and-flag.mjs` Step 1) and the stable transcript reading only as a fallback (Step 2). Claude Code emits transient incomplete / zero status frames (anthropics/claude-code#13783; ccstatusline#370), so a partial frame makes the bar flash empty, then refill on the next real frame.
2. **Compaction inferred from a %-drop.** The nudge band logic resets when the percentage falls below threshold — the same fragile heuristic ccstatusline#370 abandoned in favour of a discrete marker.

**Not the cause** (verified, do not "fix"):
- The **400k denominator** is correct and necessary. Claude Code's native `used_percentage` "always uses the model's full context window" (docs), so on a 1M model with `autoCompactWindow: 400000` it would read ~10% near the real ceiling. Issue #62210 asking Claude Code to expose the compaction budget was closed **NOT_PLANNED**; `HANDOFF_EFFECTIVE_MAX_TOKENS` is the only workaround.
- **Subagents.** Their tokens never fold into the main `context_window`; subagent usage is a separate `subagentStatusLine` payload. This session's heavy subagent use was not the cause.

## Goals

1. A **stable** context reading: monotonic-up between compactions; drops only on a *real* compaction.
2. An **adaptive** display: quiet by default, surfacing detail only when it matters.
3. Four segments: **context bar, model, rate-limits, git**. No cost meter.

## Non-goals

- No session-cost (USD) segment (deliberately dropped by the user — rate-limit headroom is the real budget signal on a subscription).
- No attempt to compute "true % until auto-compact." The real trigger counts input+output against a smaller effective window — a gap up to ~48 points (anthropics/claude-code#17959), undocumented. The 400k-budget percentage is an honest proxy, not ground truth.
- No change to the denominator mechanism. `HANDOFF_EFFECTIVE_MAX_TOKENS` stays; when unset, existing raw-`used_percentage` behavior is preserved unchanged.

## Design — stability engine

### 1. Context source: transcript-primary
Promote `lastAssistantUsageFromTranscript` (last main-chain assistant turn; already `isSidechain !== true`-filtered and mtime+size-cached via `cachedTranscriptUsage`) from fallback to **primary** source. stdin `current_usage` becomes a fallback used **only** when the transcript has no main-chain assistant turn yet (session start), and is null-guarded. The token sum stays `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` (output excluded — matches Claude Code's own `used_percentage` definition).

Rationale: the transcript reading changes only when a completed assistant turn is written (once per turn), so it is immune to the transient partial frames that drive the flicker. It is already cached, so promoting it adds no per-tick cost.

### 2. Compaction-aware reset
Detect a real compaction from the discrete `{ "type": "system", "subtype": "compact_boundary" }` JSONL marker — never from a percentage drop (the #370 anti-pattern currently in the nudge band logic).

Mechanism: scan the transcript backward. If a `compact_boundary` is encountered **before** any main-chain assistant turn, the current post-compaction segment has no turn yet → the reading resets (fall back to the null-guarded stdin value — a freshly-compacted low reading). Otherwise use that most-recent main-chain turn. Scoping the reading to the current post-compaction segment gives two properties for free:
- the bar **drops at the boundary, not a turn late** (a pre-boundary turn is never used once a boundary is more recent than it);
- within a segment the reading is **monotonic-up** (successive turns grow) — no %-delta heuristic, no separate clamp.

The nudge bands reset on the same `compact_boundary` signal.

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
- **rate-limits** `5h NN% 7d NN%` — each half surfaces only at `≥ RATE_LIMIT_SURFACE_PCT` (default 50); the whole segment is hidden when both are below. A `⚠` leads the segment when any part is red.
- **context tokens** `(NNNk)` — appended to `pct` only when the bar is red (≥70%), to make closeness to the 400k handoff concrete exactly when it matters (70% is already the handoff-nudge threshold).

Busy example: `claude-skills-t2 ⎇sdd/t2 ±5 · ███████░░░ 71% (287k) · Fable 5 · ⚠ 5h 84% 7d 21%`

### Colors
| element | green | amber | red |
|---|---|---|---|
| context bar | <50% | 50–69% | ≥70% |
| rate-limit (5h / 7d) | *hidden* <50% | 50–79% | ≥80% |
| model | Opus / Sonnet / Haiku | **Fable** | — |
| dirty | — | `±N` present | — |

### Width behavior
Compute visible width (ANSI escapes excluded). If it exceeds the terminal columns (`COLUMNS` env, else a safe default of 120), drop segments right→left in this order: **rate-limits → dirty count → shorten model to its first word** (`Opus 4.8` → `Opus`). Never drop identity or the context bar.

### Tunable defaults (call out in code as named constants)
- `RATE_LIMIT_SURFACE_PCT = 50`
- `SHOW_TOKENS_WHEN_RED = true`
- truncation order = `["rate-limits", "dirty", "model-shorten"]`

## Testing

New logic goes in `lib.mjs` as **pure, extractable helpers** (between the `// >>> PURE` / `// <<< PURE` markers) and is unit-tested in `lib.test.mjs` (mirrors the existing harness that evals the PURE block via `new Function`). Cover:
- **context source selection** — transcript-primary; stdin fallback only when no main-chain turn; null-guard on a null/partial `current_usage`.
- **compaction detection** — a `compact_boundary` line is recognized; a plain %-drop is not treated as compaction.
- **monotonic-between-boundaries** invariant — reading never decreases without a `compact_boundary`.
- **segment surfacing predicates** — dirty (N>0), rate-limit (≥ threshold, hidden below), tokens (only when red).
- **color selection** — by threshold for bar and rate-limit; Fable → amber.
- **width truncation** — drops in the specified order; never touches identity/bar.

Render assembly in `status-and-flag.mjs` is exercised against representative stdin payloads (calm / busy / narrow-terminal) — asserting on the plain-text (ANSI-stripped) line so tests are color-agnostic.

Red→green TDD per repo convention (`node --test <file>`).

## Files touched
- `plugins/handoff/scripts/lib.mjs` — new pure helpers.
- `plugins/handoff/scripts/status-and-flag.mjs` — precedence flip, compaction reset, render assembly.
- `plugins/handoff/scripts/lib.test.mjs`, `status-and-flag.test.mjs` — tests.
- `plugins/handoff/.claude-plugin/plugin.json` + root `.claude-plugin/marketplace.json` — version bump 0.7.0 → 0.8.0 (kept in sync; `scripts/repo-consistency.test.mjs` enforces).

## Rollout / compatibility
Backward compatible. No settings migration. `HANDOFF_EFFECTIVE_MAX_TOKENS=400000` (already set) unchanged; unset → legacy behavior. The regenerated cache copy picks up the new source on next plugin update.
