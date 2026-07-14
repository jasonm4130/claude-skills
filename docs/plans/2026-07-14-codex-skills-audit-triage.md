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
**Fix (as built):** a lexical `path.relative` check is NOT enough — Codex review
found that a symlink inside `handoffs/` passes it and is then followed, and that a
resolve-then-read is a TOCTOU regardless. Restrict the marker to a **bare filename**
and open the file once with `O_NOFOLLOW | O_NONBLOCK` (the non-blocking flag is
load-bearing: a plain `open()` on a planted FIFO blocks *before* any `fstat` check can
reject it, hanging SessionStart). Plan:
`docs/superpowers/plans/2026-07-14-handoff-security-batch-b.md`.

### B2. TOCTOU race in statusline overlap guard — P2 — ✅ SHIPPED (PR #33, handoff 0.6.0)

**Resolved 2026-07-14.** Research: `docs/plans/2026-07-14-statusline-architecture-research.md`.
Plan: `docs/superpowers/plans/2026-07-14-statusline-architecture.md` (3 Codex rounds + audit,
11 unique findings). Outcome: the lock was the wrong primitive. Nudge firing is now idempotent
via an atomic exclusive-create band marker (`claimBand`), so **correctness no longer depends on
the guard at all**; the transcript parse is cached on path+mtime+size (removing the slow path
that created the overlap pressure); and the guard is demoted to an explicitly best-effort
performance guard. 342 tests pass. Residual races are documented, not papered over — see the
plan's "Accepted residual races".

The original analysis is kept below because B4 still references it.

---

**Original finding (2026-07-14):**
`plugins/handoff/scripts/status-and-flag.mjs:100–119`: check ("no fresh lock") and
`writeFileSync` are not atomic; two concurrent invocations both pass the check and
both write. **Impact:** double-fired flags, clobbered `last-context-pct` — the
0.5.1 guard's guarantee fails exactly under the contention it exists for.

**Pulled out of Batch B on 2026-07-14 after four Codex rounds each found a *new* race
in the lock design:** a partially-written lock parses as pid `NaN` → "dead" → broken
out from under its live creator; two stale-breakers cascade into deleting each other's
fresh lock; a losing breaker's rename-then-restore loses to a third acquirer; and the
pid-reuse hard cap displaces live holders by design. Every fix added a layer and
exposed the next race. That is a signal to change primitive, not to patch again.

**Design direction (grounded in `status-and-flag.mjs:180-206`, not speculative):** the
lock is the wrong tool. The invariant is *"fire each 10%-point band at most once per
session"* — an idempotency key, not a mutex. Replace the guard with an
exclusive-create marker per band:

```js
const band = currentPct >= threshold ? Math.floor((currentPct - threshold) / 10) : -1;
if (band >= 0) {
  const fired = path.join(dataDir, `handoff-fired-${sid}-b${band}`);
  try {
    writeFileSync(fired, "", { flag: "wx" });   // atomic; first invocation to reach the band wins
    writeFileSync(flagFile, msg);               // only the winner nudges
  } catch { /* EEXIST — band already fired; no-op */ }
}
```

Correct under any interleaving: no lock, no liveness check, no stale-breaking, no
pid-reuse hazard. The `fired` marker must NOT be consumed by `check-handoff-flag.mjs`
(only the nudge flag is) — otherwise the band re-fires every turn while context sits
in it; that is the role `last-context-pct` plays today and the marker replaces. The
render-cache write is then unprotected, which is harmless (concurrent invocations
write near-identical renders).

### B3. Handoff injection — a repo can plant its own handoff — P2 (NEW, from the Codex audit)
B1 closes *exfiltration* (a `.pending` marker reading files outside `.claude/handoffs/`).
It does **not** close *injection*: a hostile repo can commit an ordinary in-tree
`.claude/handoffs/evil.md` plus a `.pending` naming it, and the loader emits its
contents as `additionalContext` — attacker-authored text entering the next session as
trusted context.
**Why it is not a patch:** the loader cannot tell whether a handoff was written by
*this machine's* handoff skill or committed by the repo. Fixing it needs a provenance
boundary — e.g. handoffs (or an index of them) in the plugin's user-level data dir,
which a checked-out repo cannot write. That is a design decision about where handoffs
live, and it interacts with the SKILL's agent-authored write step (there is no trusted
writer today to stamp provenance). Needs its own spec.

### B4. Same double-breaker bug in `codex-review`'s `acquireLock` — P3 (NEW, found while fixing B2)
`plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs:127-152`: two
breakers observing the same stale lock can cascade — the first breaks it and
re-acquires, the second's unconditional `renameSync(lockPath, …)` then moves the
winner's *fresh* lock away and deletes it, leaving two holders.
**Blast radius is bounded** (this is why it is P3, not P2): the chain log's
post-append order verification is the real guard there, and the lock is documented as a
contention reducer only — a lost race self-aborts. Fix when convenient: adopt B2's
rename-verify-restore, or accept and document.

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
