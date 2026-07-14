# Codex Skills Audit — Findings & Triage Plan

**Source:** GPT-5.6 Terra (high effort, read-only sandbox) audit of `deep-dive`,
`subagent-driven-development`, `adversarial-agents`, and `handoff`, run 2026-07-14.
Cost ~132k tokens. Terra grounded itself by running the repo's non-mutating test
suites (`# pass 52` / `# fail 0`; handoff's stateful tests blocked by the read-only
sandbox — expected, not a finding).

**Scope decision (Jason, 2026-07-14):** ship `codex-review` first, then execute
these batches. Each batch's plan gets a Codex plan review via the new skill
(dogfoods it and feeds the decision gate: ≥1 confirmed unique finding per ~5
reviews by ~2026-07-28).

**Cross-cutting requirements for every batch:**
- Bump the touched plugin's patch version in `plugin.json` AND `marketplace.json`
  (repo-consistency test enforces the match).
- Update SKILL.md/README alongside behavior changes (docs-sync-guard will deny
  otherwise; that's working as intended).
- Tests via `node --test` (repo convention, no npm deps).

---

## Batch B — handoff security & race (do first)

### B1. Path traversal in pending-handoff loader — P1
`plugins/handoff/scripts/load-pending-handoff.mjs:57` uses the `.pending` marker's
contents as a path with no containment check; `../../.env` resolves outside
`handoffs/` and gets injected into the next session's context (line 91).
**Impact:** anything that can write one file in a checked-out repo can exfiltrate
local files into model context.
**Fix:** `path.resolve` the marker value against the handoffs dir and reject any
result whose `path.relative(handoffsDir, resolved)` starts with `..` (or is
absolute). Add a traversal test (`../../etc/hosts`-style marker → loader refuses,
logs, clears marker).

### B2. TOCTOU race in statusline overlap guard — P2
`plugins/handoff/scripts/status-and-flag.mjs:100–119`: check ("no fresh lock") and
`writeFileSync` are not atomic; two concurrent invocations both pass the check and
both write. **Impact:** double-fired flags, clobbered `last-context-pct` — the
0.5.1 guard's guarantee fails exactly under the contention it exists for.
**Fix:** atomic acquisition — `writeFileSync(lock, pid, { flag: "wx" })` with
EEXIST → treat as held; stale-break via rename (same pattern as
`codex-review`'s lock helper, reuse it). Test: two simulated acquirers, exactly
one wins.

## Batch D — sdd.mjs correctness (second)

### D1. Final fixer's result discarded — P1
`plugins/subagent-driven-development/workflows/sdd.mjs:425`: the final-fix agent
runs but nothing updates `head`, reruns the final review, or reruns the suite.
**Impact:** a final fix can break the branch while the returned `head` points at
the pre-fix commit; controller proceeds to finishing on a stale/red branch. This
is the likely root cause of the known "SDD findings stale vs HEAD" quirk
(memory: `retro_project_sdd_findings_stale_vs_head`).
**Confirmed live 2026-07-14:** the codex-review build run (wf_e69a9e74-22e)
returned `head: 6dfb959` while the final fixer had already committed `3949fdf`
on top of it; the suite was not rerun after that fix (it happened to be green —
verified manually, 288 pass).
**Fix:** capture fixer's reported new head, dispatch one cheap verify agent
(rev-parse + suite), update `head`/`finalReview` or surface a red result. Bounded:
one verify, no re-loop.

### D2. Merger claims trusted without proof — P2
`sdd.mjs:215`: wave merge agent returns `headSha` / `suite: "green"` as strings;
workflow advances `base` without resolving the SHA or executing `testCmd`.
**Impact:** one hallucinated "green" corrupts every subsequent wave.
**Fix:** post-merge verify step (haiku/sonnet agent: `git rev-parse <headSha>`,
run `testCmd`, return structured pass/fail) gating base advancement. Note:
sdd.mjs runs in the sealed Workflow sandbox — no exec; verification must itself
be an `agent()` call.

### D3. Duplicate/non-integer task numbers collide — P2
`sdd.mjs:37`: two tasks with `n: 1` race on the same `sdd/t1` branch,
`<workdir>-t1` worktree, and report path.
**Fix:** `validateArgs` rejects non-positive-integer or duplicate `n`. Trivial +
unit test.

## Batch C — deep-dive result integrity (third)

### C1. Schema-valid junk accepted as research — P2
`plugins/deep-dive/workflows/fanout.mjs:101`: shape-only validation lets
placeholder claims / `example.com` URLs / empty verifier flags pass (this is the
live incident from 2026-07-14's deep dive).
**Fix:** semantic guard: reject angle results with zero findings, placeholder
URL patterns (`example.com`, `example.org`, `localhost`, `test.`), or
placeholder-claim heuristics; failed guard → re-dispatch once, then mark angle
failed (feeds C2's reporting).

### C2. Failed angles dropped silently; wave-2 ignores deps — P2
`fanout.mjs:170`: `filter(Boolean)` erases crashed workers; wave-2 dispatches even
when a declared dep never completed. **Impact:** a deep dive looks finished while
missing a core angle.
**Fix:** carry failures into `meta.failedAngles`; skip wave-2 angles whose deps
failed and mark them `skipped: dep-failed`; orchestrator SKILL.md told to surface
both.

## Batch A — doc-only fixes (fold into any convenient branch)

- **A1 (P3):** handoff SKILL.md:132 names `load-pending-handoff.sh`; shipped hook
  runs the `.mjs` (`hooks/hooks.json:19`). Correct the filename.
- **A2 (P3):** deep-dive README:29 says recall angles default to Haiku; code +
  SKILL.md default to Sonnet (deliberate, post-experiment). Fix README.
- **A3 (P3):** adversarial-agents README:25 promises auto-fit prose/model-output
  panels; SKILL.md:50 says those need user personas, and `--personas a,b` syntax
  can't carry inline prompt bodies. Align README with SKILL.md and document how
  custom personas are actually supplied.

---

## Dismissed findings

- **"`resumeFromRunId` not implemented in sdd.mjs"** — FALSE POSITIVE, verified
  by subagent 2026-07-14: `resumeFromRunId` is a top-level parameter of the
  harness's Workflow tool (sibling of `scriptPath`), not a script arg; both
  SKILL.md:145 and README.md:67 show it correctly at top level. The
  cached-replay promise holds: sdd.mjs derives all state through `agent()`
  calls (no `Date.now`/exec), so the replay prefix is deterministic.

## Sequencing

1. Ship `codex-review` (in flight, SDD run on `feat/codex-review`).
2. **Batch B** (security P1 first) → **Batch D** (correctness P1) → **Batch C**.
3. **Batch A** rides along with whichever batch touches that plugin, else its own
   quick branch.
4. Per size-ceremony rule: B, C, D are each "small plan + plain subagents with
   tests" scale — full SDD ceremony not required; write a short `# Task N` plan
   per batch, Codex-review it, execute with tiered subagents.
