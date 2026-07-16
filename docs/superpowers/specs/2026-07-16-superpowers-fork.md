# Spec: Finish the Superpowers Fork — an Owned Process-Skill Surface

- **Date:** 2026-07-16
- **Status:** Draft (awaiting user review)
- **Author:** Jason Matthew (with Claude)
- **Backlogged dependency:** deep-dive `fanout.mjs` verifier false-negative — [issue #41](https://github.com/jasonm4130/claude-skills/issues/41) (out of scope here)

## Problem

Today's setup is a **deny-list fork** held together by a manual blocklist:

- `superpowers@claude-plugins-official` is enabled whole-plugin, but **9 of its 14 skills are denied** in `~/.claude/settings.json` `permissions.deny` (subagent-driven-development, executing-plans, dispatching-parallel-agents, test-driven-development, using-git-worktrees, finishing-a-development-branch, requesting-code-review, receiving-code-review, verification-before-completion).
- Owned replacements already exist for most of them (`subagent-driven-development`, `deep-dive`, `adr`, `visual-plan`, `adversarial-agents`, `codex-review`, `handoff`, `session-retro`, `ship-gate`).
- Only 5 superpowers skills are *currently* kept (allowed through the deny-list): `brainstorming`, `systematic-debugging`, `writing-plans`, `writing-skills`, `using-superpowers`. The fork's **final** surface differs (see Design → Final skill surface).

This arrangement has three structural leaks:

1. **Blocklist against a moving target.** superpowers ships upstream (6.0.3 → 6.1.0 → 6.1.1); any new/renamed skill is *allowed by default* until manually denied.
2. **Name collision.** `superpowers:subagent-driven-development` collides with the owned `subagent-driven-development`; it must be explicitly denied so the owned one wins — a fragile exact-string fix.
3. **Behavioral mandate fights house style.** The `using-superpowers` SessionStart injection ("even a 1% chance a skill applies → you ABSOLUTELY MUST invoke it") is the opposite of the global CLAUDE.md *simplicity-first / surgical / no unrequested ceremony* philosophy, and can't be tuned without owning it.

## Decision

**Finish the fork.** Vendor the skills still used into an owned marketplace plugin, replace the dispatcher with an owned *match-and-proportion* kernel, reshape frontend-design, disable the upstream plugins, and **delete the deny list**.

## Scope

**In scope:** two new plugins (`superpowers-core`, `frontend-design`), the dispatcher, the tiered artifact model, first-class Codex gate, and the settings cutover.

**Out of scope:** the `fanout.mjs` verifier bug (issue #41); rebuilding any of the 9 already-replaced skills; changes to other owned plugins. **Historical plan files** under `docs/superpowers/plans/` that reference `superpowers:*` (7 files, all completed/shipped work — e.g. the statusline plan = merged PR #40) are **archival records, not re-executable**; leave them as-is rather than rewriting history. (If any is ever re-run through SDD, migrate its refs then.)

## Design

### Plugin 1 — `superpowers-core` (MIT, attributed to Jesse Vincent)

**Vendoring source (pinned): superpowers `6.1.1`.** Every file/reference count below was verified against that exact revision (`~/.claude/plugins/cache/claude-plugins-official/superpowers/6.1.1`; `6.0.3` and `6.1.0` are also cached — do **not** copy from them). Re-run the inventory greps if the pin is ever bumped.

**Final skill surface — exactly 6 skills** (this supersedes any earlier "5 kept" count, which described the *current* deny-list state): 4 vendored as-is (`brainstorming`, `systematic-debugging`, `writing-plans`, `writing-skills`), 1 vendored newly-restored (`test-driven-development`), and 1 owned replacement (`using-skills`). **`using-superpowers` is dropped**, not vendored — `using-skills` replaces it. A vendored `LICENSE` (MIT © 2025 Jesse Vincent) and attribution in `plugin.json` are retained.

**Vendor each skill's *entire directory***, not just `SKILL.md` — every skill drags support files that break if left behind: brainstorming (7: `visual-companion.md`, `scripts/server.cjs`+`helper.js`+start/stop scripts, `frame-template.html`, `spec-document-reviewer-prompt.md`), systematic-debugging (10), writing-skills (6), writing-plans (1), test-driven-development (1). A copy of `SKILL.md` alone leaves e.g. brainstorming's visual-companion offer pointing at missing paths.

| Skill | Origin | Change on vendoring |
|---|---|---|
| `brainstorming` | vendored | Re-tiered (remove always-design HARD-GATE) + planning enhancements (below) |
| `systematic-debugging` | vendored | Rewrite `superpowers:` refs → `superpowers-core:`; redirect the dropped `verification-before-completion` ref |
| `writing-plans` | vendored | Handoff rewired → owned SDD; plan = disposable derivative; emits open-questions list |
| `writing-skills` | vendored | Rewrite `superpowers:test-driven-development`/`:systematic-debugging` refs → `superpowers-core:` |
| `test-driven-development` | vendored | New 5th skill — closes the dangling refs from systematic-debugging & writing-skills; matches global "failing test first, quote red→green" rule |
| `using-skills` | **owned, new** | Replaces `using-superpowers`; delivered by a SessionStart hook |

**Cross-reference rewrites (the vendoring landmine).** The governing rule: **at cutover the entire `superpowers:` namespace disappears, so *every* `superpowers:<skill>` reference in *every* vendored file must be rewritten** — including references to skills that ARE vendored (they move to `superpowers-core:`). Vendoring a skill keeps its *target* alive but does **not** fix a reference that still carries the old `superpowers:` prefix. Complete inventory (verified across all files, not just `SKILL.md`; `brainstorming` and `test-driven-development` carry none):

| File | Old reference (count) | Rewrite to | Why |
|---|---|---|---|
| `systematic-debugging` | `superpowers:test-driven-development` (2) | `superpowers-core:test-driven-development` | vendored (kept) |
| `systematic-debugging` | `superpowers:verification-before-completion` (1) | redirect → global CLAUDE.md verification discipline (its `## Verification before claiming complete` section) — no skill reference (there is no `verify` *plugin*; it is a built-in) | dropped |
| `writing-plans` | `superpowers:subagent-driven-development` (2) | `subagent-driven-development` (owned plugin) | replaced |
| `writing-plans` | `superpowers:executing-plans` (2) | owned `subagent-driven-development` | dropped/replaced |
| `writing-plans` | `superpowers:using-git-worktrees` (1) | owned SDD (handles worktree isolation) | dropped |
| `writing-skills` | `superpowers:test-driven-development` (4) | `superpowers-core:test-driven-development` | vendored (kept) |
| `writing-skills` | `superpowers:systematic-debugging` (1) | `superpowers-core:systematic-debugging` | vendored (kept) |
| any | `elements-of-style:writing-clearly-and-concisely` | leave as-is (optional "if available") | no-op, not owned |

Implementation must grep every vendored file for `superpowers:` and confirm zero remain before cutover.

### The dispatcher — `using-skills` (behavioral kernel)

Delivered by a SessionStart hook (mirrors the proven superpowers mechanism; self-contained in the plugin; does **not** touch the cross-tool chezmoi CLAUDE.md). **The hook MUST match `startup|resume|clear|compact`** — upstream superpowers matches only `startup|clear|compact`; we add `resume` to close the gap where `claude --resume`/`--continue` would otherwise start without the kernel — and emit the kernel via `hookSpecificOutput.additionalContext`. Otherwise a resumed or compacted session continues *without* the match-and-proportion rules, the very behavioral leak the dispatcher exists to close. All four entry points (fresh start, resume, `/clear`, auto-compact) must be tested. Two tight parts.

**Part A — Skill selection (match-and-proportion):**
1. Invoke a skill only when its description is a *closer, more specific match* to the task than acting directly — **and** the work is non-trivial (multi-step, irreversible, or touches product source). Trivial/one-shot → just do it, no ceremony.
2. **Specificity wins:** when two skills match, prefer the narrower one. Owned workflow skills are more specific to this work than any generic one → they win. (Structurally dissolves collisions — no future deny-line needed.)
3. **User instructions suppress skills:** a concrete instruction in the current turn overrides any skill firing for the same concern. User > skills > defaults.
4. When invoking, announce "Using [skill] to [purpose]" and follow it.
5. **Authoring rule:** every skill description carries a negative scope ("do NOT use for…") to keep selection unambiguous.

**Part B — Currency & verification:**
1. If an answer turns on something that changes over time (versions, prices, releases, "current/latest/now", anything plausibly past the training cutoff) → **don't answer from memory; verify first.**
2. **Match the tool to the need:** one load-bearing fact → a single web search; a multi-angle/comparative/"state of X" question → `deep-dive`. Never fan out a deep-dive on what one search settles.
3. **Stale-fact ≠ unclear-intent:** a factual gap you can close → verify it; an intent you'd only guess at → ask *one* question. State verified-vs-remembered when load-bearing.

**Injection guardrail (keeps the kernel from re-becoming the superpowers wall).** A behaviour earns a line in the SessionStart injection **only if both**: (a) it must be present *before* the model acts, and (b) it isn't already reliably governed elsewhere (global CLAUDE.md, or self-evident). Skill-selection and currency-verification pass; the Karpathy-4 / simplicity / verification-before-complete rules **fail (b)** — they live in global CLAUDE.md and must not be duplicated here.

### Artifact model — tiered-by-size (durable spec / disposable plan)

Resolves the "is a separate spec *and* plan really needed?" question. Evidence: Google design-docs (the decision to write a design doc is gated on *ambiguity/complexity*, not size); Kiro ("Quick Plan"/"vibe" tiers); spec-kit (lean path skips clarify/checklist/analyze). All best-in-class workflows keep the *jobs* distinct but tier the *ceremony* by size. (The Boehm "100× to fix later" cost multiplier is empirically contested — Bossavit — so it is not relied on; the audience/durability argument stands on its own.)

**The jobs are distinct and audience-based:** a **spec** answers *why/what* (goals, non-goals, trade-offs, alternatives) — durable, broad-audience, survives implementation. A **plan** answers *how* (sequenced tasks) — executor-facing, **disposable**.

**Tiering rules:**

- **Trivial** → neither artifact. Just do it (Part A already says this).
- **Medium** → *one* artifact: a plan with a 2–3 line "why" header. No separate spec.
- **Large / ambiguous / load-bearing** → both: spec (durable why) → plan (disposable how).

**Reframe that removes the redundancy objection:** the plan is a **disposable derivative** of the spec — regenerated from it, thrown away after SDD runs, never maintained. This kills *both* failure modes of separation: no double-writing (the plan doesn't restate the why) and no divergence (the plan is never updated, only regenerated).

**Consequences for the vendored skills:**

- `brainstorming` — **remove the always-design HARD-GATE** ("Every project goes through this process… a config change — all of them") and replace with a **size gate at the top**: trivial → skip; medium → straight to a lean plan (no spec); large/ambiguous → full spec. This is the single most important edit.
- `writing-plans` — the plan is a derivative of the spec (when one exists) and emits an explicit **"Open questions / unresolved assumptions"** list attached to the plan.

### Planning enhancements (`brainstorming`)

Fold in best-in-class elicitation (grill-me / grill-with-docs), reconciled to the *one-question-at-a-time* rule — the trick is making each question load-bearing, not asking fewer:

1. **Tree, not list** — one branch → one question → the answer picks the next question.
2. **Always offer a recommended default** with each question (the biggest fatigue reducer).
3. **Auto-resolve first** — before asking, check what's discoverable in the codebase/docs; only ask what genuinely needs the human's judgment.
4. **Doc-grounded assumption check (the owned flavour, labeled original — not a proven named pattern):** before locking the design, check every load-bearing library/API assumption against fetched docs (context7 / WebFetch) and surface any contradiction as *one* question.
5. **Log evidence inline** as decisions resolve (into the spec draft), not reconstructed at the end. Stop condition = no unresolved items (not a question count).

**`writing-plans` stays deliberately lean.** Explicitly **skip** spec-kit constitutional gates, EARS templates, PR-FAQ, and pre-mortem/red-team role-play — each duplicates what the cross-provider Codex gate already does adversarially. The only add is the open-questions list (above), which gives the Codex reviewer concrete targets.

### Codex review — first-class

Vendoring moves the gate from a *cross-file CLAUDE.md convention* into `writing-plans`' own terminal flow, where it fires at the moment the plan is finalized: **finalize plan → emit open-questions list → hand to `codex-plan-review` → loop on verdict.** The review checks *two* things: internal soundness **and** fidelity to the spec's intent (did the *how* drift from the *why*? — spec-kit's `/analyze`).

**Honest limit (not "structural"):** `codex-plan-review` is a model-invoked skill, not a hook. Putting the call in `writing-plans`' flow makes it *more reliable* (it's right there when the model finishes the plan) but does **not** guarantee it — a session that finalizes a plan without going through the skill still reaches SDD un-reviewed. True enforcement would need an SDD-side hook, which was previously declined and stays out of scope. The success criterion is therefore *"the vendored `writing-plans` flow invokes the gate,"* not *"the gate is structurally unbypassable."*

- Guards: *never re-run on the same artifact without an explicit ask*; *whole-branch, not per-task*. On an unavailable/unauthenticated Codex, **disclose that the gate was skipped and continue without blocking** — the skip must be visible and the review status travels with the plan into SDD. (Settled: the project CLAUDE.md rule at `~/Work/Git/CLAUDE.md:37` is updated from "skip silently" to "disclose, don't block" so the two authorities agree — a silently-skipped gate would hand SDD an unreviewed plan with no signal, exactly the "implying success" failure the global rules warn against.)
- One gate for medium (one-artifact) work; optionally add a spec-level Codex pass for very large / novel work, where cross-family review earns the most on intent errors.

### Plugin 2 — `frontend-design` (owned, written fresh; replaces the official plugin)

Written in-voice (not vendored — sidesteps the official plugin's `LICENSE.txt`). A **gate**:

- **Light / surgical design** → keep the inline guidance structure that worked: *ground-it-in-the-subject → design principles → explore → self-critique*.
- **Wide-sweeping or very detailed design** → detect it, recommend **Claude Design in the browser** (iterating visually in the claude.ai web app), and **emit a ready-to-paste design brief** (goals / users / constraints / screens / existing patterns / references) so the handoff keeps momentum.

### Cutover (settings)

1. Register `superpowers-core` and `frontend-design` in `.claude-plugin/marketplace.json` (pluginRoot `./plugins`).
2. In `~/.claude/settings.json`: enable `superpowers-core@jasonm4130-claude-skills` and `frontend-design@jasonm4130-claude-skills`; **disable** `superpowers@claude-plugins-official` and `frontend-design@claude-plugins-official`.
3. **Delete all 9 `Skill(superpowers:*)` entries** from `permissions.deny` (list becomes empty of superpowers entries).

## Success criteria

- `permissions.deny` contains **zero** `Skill(superpowers:*)` entries.
- The `using-skills` kernel (Parts A + B) is injected at **all three** SessionStart entry points — fresh start, `/clear`, and auto-compact (hook matcher `startup|clear|compact`); no `superpowers:*` skills are offered; the owned `subagent-driven-development` resolves without a deny-line.
- A `grep -r 'superpowers:'` across all vendored files returns **zero** matches (all rewritten to `superpowers-core:` or redirected); each vendored skill's **full directory** (support files/scripts/assets, not just `SKILL.md`) is present; `writing-plans` hands off to the owned SDD.
- `brainstorming` **skips** spec ceremony on a trivial/medium task and produces a spec only for large/ambiguous work.
- `writing-plans` output includes an "Open questions / unresolved assumptions" list, and its flow **invokes** `codex-plan-review` (disclosing, not silently skipping, when Codex is unavailable). Note: reliable invocation, not hook-enforced unbypassability.
- `frontend-design` routes a wide/detailed design request to a paste-ready browser brief and keeps inline guidance for a small tweak.
- `superpowers-core` ships the MIT `LICENSE` + attribution.

## Risks & mitigations

- **Recall drop** from match-and-proportion (a skill occasionally skipped) — accepted trade-off for less ceremony; specificity-wins + good descriptions mitigate.
- **Vendored skills drift from upstream** — accepted; the surface is owned now, and the fork already diverged.
- **Kernel bloat** re-creating the superpowers wall — prevented by the injection guardrail test.

## Attribution

`superpowers-core` vendors MIT-licensed skills © 2025 Jesse Vincent; the MIT `LICENSE` is retained and `plugin.json` credits the original author. `frontend-design` is written fresh.
