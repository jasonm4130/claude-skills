# Deep-Research Hybrid Design — skill gate + args-driven Workflow

**Date:** 2026-05-30
**Status:** Approved design (pre-implementation)
**Plugin:** `deep-research` `0.1.0 → 0.2.0`

## Problem

The `deep-research` skill currently uses **model-driven dispatch**: SKILL.md instructs the
main model to spawn parallel `Agent` calls in one message and decide fan-out in prose.
Fan-out counts, wave conditionals, and synthesis passes are emergent from model reasoning,
so they are not reproducible, not testable, and not auditable.

The `Workflow` tool offers the other locus of control — **deterministic JavaScript**: fan-out
counts, wave conditionals, and verification tiers are code. The win is reproducibility +
schema-validated handoffs on the expensive steps. The constraint: a Workflow runs unattended
in the background, so anything needing a human gate or open-ended in-loop judgement must stay
in the main session.

This design splits the skill along that line: the **interactive gate stays inline**; the
**embarrassingly-parallel gather + mechanical verification move into a shipped, args-driven
workflow script**; **synthesis returns to the main Opus session**.

## Evidence base

Three workflow runs in the brainstorming session informed this (see
`RESEARCH_what_gives_best_deep_research.md` for the verified survey):

- **Experiment 1 (orchestration A/B):** two-wave (wave-2 built on wave-1 findings) was the
  single highest-leverage knob (B vs C, decisive). Haiku workers missed the load-bearing
  cross-source contradiction that Sonnet workers caught (C vs D) → **default workers to
  Sonnet, not Haiku.** Depth vs breadth was a wash → breadth is a cheap scout pass only.
- **State-of-the-art survey (tier-2 verified):** plan-first beats interleaved ReAct for
  research; **separate research from writing** (parallelize research, synthesize once);
  classify sub-questions **core/background/follow-up** and gate on *core* coverage (82%
  human-preference correlation); verification must **touch external evidence** and the
  verifier must be **blind to the draft** (factored, CoVe); **escalate cross-model only on
  uncertain findings** (keeps ~95% of gain at 13–28% less cost); a mandatory
  **retrieval-grounded citation gate** targets the correctness≠faithfulness failure.

## Locked decisions

| Decision | Choice | Basis |
|---|---|---|
| Packaging | Shipped `fanout.mjs`, fully args-driven, invoked via `scriptPath` | brainstorm Q1 |
| Change surface | Surgical splice of SKILL.md §2–4; triage/gate/prefs verbatim | brainstorm Q2 |
| Synthesis boundary | Split — workflow gathers+verifies, main Opus does critic + final | brainstorm Q3 |
| Wave structure | Two-wave (DAG `deps`) is the spine | experiment 1 + research |
| Worker model default | **Sonnet**; `haiku` opt-in for pure enumeration only | experiment 1 (C vs D) |
| Verification | Standard: factored tier-1 + uncertainty-gated tier-2 | survey (Verify-when-Uncertain, CiteCheck) |
| Decomposition | Flat angles + core/background/follow-up coverage gate | survey (Xie et al.) |

## Control flow

```
MAIN SESSION (Opus 4.8, interactive)
  1. Triage                    -- unchanged prose
  2. Plan angles + tag each core|background|follow-up; build DAG (deps -> waves)
  3. GATE: show core-coverage + DAG, wait for "go"      <- human-in-loop
  4. Build args; resolve fanout.mjs abs path via versioned glob (highest semver)
  5. Workflow({ scriptPath, args }) ----------------+
                                                     v
        WORKFLOW (background)
          wave 1: pipeline(rootAngles, research -> verify)   [Sonnet workers]
            verify = factored, blind to draft, re-fetch & flag
          -- barrier (wave-2 needs wave-1 findings) --
          wave 2: pipeline(depAngles, research+ctx -> verify)
          escalate: any angle reliability=low -> cross-model recheck of flagged claims
          return { reports[], verification[], meta }
                                                     |
  6. Receive reports + verification <----------------+
  7. Critic pass (<=2) -- Opus, downweights flagged/low-reliability claims
  8. Final synthesis   -- Opus -> user; flags surfaced, not buried
  9. Offer RESEARCH_<topic>.md
```

The gate (steps 1–3) and synthesis (7–8) stay with the human in the main thread. The workflow
owns only the parallel gather + mechanical verification.

## Interfaces

### args contract (skill → script)

```js
{
  topic: "string",
  mode: "deep" | "scout",          // deep = depth + 2-wave (default); scout = breadth + 1-wave first-pass
  angles: [
    { id: "string",
      question: "string",
      kind: "core" | "background" | "follow-up",
      model: "sonnet",             // default; "haiku" only for pure enumeration (correctness risk)
      deps: [] }                   // [] = wave 1; non-empty = wave 2 (built on those angles' findings)
  ],
  verify: { escalateOn: "low" }    // tier-1 always runs; tier-2 cross-model recheck only when reliability=low
}
```

The skill **never edits the script** — it only constructs this object from the confirmed DAG.
The same script can later back other research skills (e.g. code-review fan-out).

### return contract (script → main session), schema-validated

```js
{
  reports: [
    { angleId: "string",
      kind: "core" | "background" | "follow-up",
      summary: "string",
      findings: [{ claim, sourceUrl, sourceTitle, sourceDate }] }
  ],
  verification: [
    { angleId: "string",
      reliability: "high" | "medium" | "low",
      flags: [{ claim, verdict: "supported|partial|unsupported|unreachable", note }] }
  ],
  meta: { mode, wavesRun, anglesCompleted, anglesFailed, escalations }
}
```

Reports and verification are `schema`-forced so the main session consumes typed data, not
prose it must re-parse. The final synthesis is **not** schematized — it is Opus prose for the user.

## Runtime constraints (empirically probed 2026-05-30)

The Workflow runtime is a **sealed sandbox** — verified with a throwaway probe workflow:

- **No module imports.** Static and dynamic `import` both fail (`"A dynamic import
  callback was not specified"`). `fanout.mjs` must be **fully self-contained** — no shared
  `lib.mjs` at runtime.
- **Body is wrapped in a function.** Top-level `return` works; `export const meta` is
  statically extracted by the parser, but no *other* `export` is legal in the body. A
  consequence: `node:test` cannot `import` `fanout.mjs` (top-level `return` → SyntaxError).
- **Primitives are injected globals** (`typeof agent === "function"`), so a
  `typeof phase === "function"` guard can fence the orchestration off from any non-runtime
  evaluation.
- **`${CLAUDE_PLUGIN_ROOT}` is NOT set in the main session**, so the skill cannot rely on
  shell expansion. The script path is resolved by glob:
  `ls -d "$HOME"/.claude/plugins/cache/jasonm4130-claude-skills/deep-research/*/workflows/fanout.mjs | sort -V | tail -1`
  (highest installed semver; same resolution strategy `handoff`'s wrapper uses). In local
  dev, the repo path `plugins/deep-research/workflows/fanout.mjs` is used directly.

## fanout.mjs internal design

- **Self-contained:** all pure helpers inlined (the sandbox forbids imports). Helpers live
  between `// >>> PURE` / `// <<< PURE` markers so the test can extract them.
- **Wave partition:** split `args.angles` into wave 1 (`deps` empty) and wave 2 (`deps`
  non-empty) by code. `scout` mode collapses to a single breadth wave.
- **Per-wave pipeline:** `pipeline(waveAngles, researchStage, verifyStage)` — verification
  fires as soon as each angle's research returns; no within-wave barrier.
- **Between-wave barrier:** genuine cross-item dependency (wave-2 prompts embed wave-1
  findings), so an `await` barrier between waves is justified.
- **research stage:** Sonnet (or `angle.model`) worker; depth prompt in `deep`, breadth in
  `scout`; Exa+Tavily+WebSearch+WebFetch; returns `RESEARCH_SCHEMA`.
- **verify stage (tier-1):** factored verifier — receives the findings but is instructed it
  did NOT do the research and must re-fetch each cited source; returns `VERIFY_SCHEMA` with
  `reliability` + per-claim `flags`. Blind-to-draft = it judges claims against sources, not
  against the researcher's reasoning.
- **escalation (tier-2):** conditional stage — if `verify.reliability === "low"`, dispatch a
  cross-model recheck of only the flagged claims; otherwise pass through unchanged. Counted in
  `meta.escalations`.
- **Failure handling:** a failed angle → `null`, filtered, recorded in `meta.anglesFailed`
  and `log()`'d. No silent truncation.

## SKILL.md splice (surgical)

**Edit:**
- §1 (planning): add core/background/follow-up tagging; the "go" gate shows *core* coverage.
- §2 (dispatch): replace "spawn N Agent calls in one message" with "build the args object,
  resolve the `fanout.mjs` absolute path via the versioned glob above, call
  `Workflow({scriptPath, args})`".
- §4 (synthesis): citation verification now happens in the workflow's verify tier; the main
  session does critic (≤2) + final synthesis, **downweighting flagged/low-reliability claims**.
- Cost-defaults bullet: **Sonnet is the worker default**; `haiku` only for pure enumeration,
  with an explicit correctness-risk note (was: "haiku for recall angles").
- Add a short scout-mode note (breadth/1-wave cheap first pass for open-ended scoping).

**Keep verbatim:** triage table, source-diversity rule, tool-preference order, the debate
section, the common-mistakes table.

## Testing

`fanout.mjs` cannot be `import`ed (top-level `return`) and cannot spawn real agents in a unit
test. So `fanout.test.mjs` **reads `fanout.mjs` as text, extracts the `// >>> PURE` …
`// <<< PURE` block, and evaluates it with `new Function`** to obtain the real (not copied)
pure helpers, then tests:
- wave partitioning from `deps` (wave-1 vs wave-2 membership)
- `scout` vs `deep` branching (single breadth wave vs two depth waves)
- escalation trigger: `reliability=low` → tier-2 runs; otherwise it does not
- args validation (missing/invalid fields rejected)
- `meta` accounting (`anglesCompleted`/`anglesFailed`/`escalations`)

This tests the actually-shipped functions with zero duplication. Tests use `node:test` +
`node:assert/strict`, mirroring the `handoff` plugin. The orchestration glue (the
`typeof phase === "function"` block) is exercised by a **live smoke run**: invoke the real
workflow via `scriptPath` with a tiny 2-angle topic and confirm it returns the
`{reports, verification, meta}` shape.

## Non-goals (YAGNI)

- No nested sub-angles (flat angles + coverage gate captured the value at lower cost).
- No self-consistency tier (Nx the gather cost; token budget dominates variance anyway).
- No debate-in-workflow (the existing debate section stays main-session prose).
- No wave-3+ recursion (cap at 2, matching current skill).

## Resolved risks (were open at design time)

- `Workflow({scriptPath})` invocation: **verified** — the probe workflow ran via an absolute
  `scriptPath` successfully.
- Path resolution: **resolved** — `${CLAUDE_PLUGIN_ROOT}` is unavailable to skill prose, so the
  skill resolves via versioned glob (see Runtime constraints). The live smoke run in the impl
  plan re-confirms end-to-end from the skill.
- Sandbox semantics: **probed** — no imports, body wrapped in a function (see Runtime
  constraints); design adjusted to a self-contained script + extract-and-eval testing.
