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

### B4. Same double-breaker bug in `codex-review`'s `acquireLock` — P3 — ⚠️ MITIGATED, NOT ELIMINATED (PR pending, codex-review 0.2.1)

**Resolved-as-far-as-it-can-be 2026-07-14.** Plan:
`docs/superpowers/plans/2026-07-14-batch-c-integrity.md` (Task 3).

**What the fix buys:** a break now requires the lease **and** a provably-dead holder (the token already
carries the pid, so a merely-slow holder no longer gets its lock stolen on age alone), and the break is
**fenced on the lock's identity** — if the file we renamed away is not the one we judged, it is restored
and our own acquire aborts rather than proceeding on top of a fresh holder.

**What it does NOT buy — and must not be recorded as fixed.** A three-way interleaving on a genuinely
dead victim can still leave two believers: between the losing breaker's `renameSync` and its restore the
lock file *does not exist*, so a third process can create it, and the restore then overwrites that third
holder's lock while it still believes it owns it. **Node has no compare-and-unlink, so the check→break
window cannot be closed in userspace.** That is the same conclusion four Codex rounds forced on the
handoff statusline lock (B2), where the residual is likewise accepted and documented.

Blast radius stays bounded — the chain log's post-append order verification is the real guard, and a
lost race self-aborts. That is why this was P3, and why shrinking the window and *saying so* is the
right stopping point rather than a fifth layer of ceremony.

**Original finding (2026-07-14):**
`plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs:127-152`: two
breakers observing the same stale lock can cascade — the first breaks it and
re-acquires, the second's unconditional `renameSync(lockPath, …)` then moves the
winner's *fresh* lock away and deletes it, leaving two holders.

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

## Batch C — deep-dive result integrity — ✅ SHIPPED (deep-dive 0.4.0)

**Resolved 2026-07-14.** Plan: `docs/superpowers/plans/2026-07-14-batch-c-integrity.md`
(3 Codex rounds + audit, 16 unique findings). C1 and C2 shipped as **one commit** — they cannot be two:
C1 makes `runAngle` return truthy failure records, and the pre-C2 runner treats every truthy result as a
success and dereferences `r.research`. 394 tests pass.

### C1. Schema-valid junk accepted as research — P2 — ✅ SHIPPED
`plugins/deep-dive/workflows/fanout.mjs`: shape-only validation let placeholder claims / `example.com`
URLs / empty findings pass (the live 2026-07-14 incident). `researchProblems()` now rejects zero
findings, an unusable **summary**, placeholder URL hosts, non-http sources, and placeholder/stub claims;
an unusable angle is retried once with the rejection reason, then failed.

Two things the review surfaced that the original finding missed:
- **The summary had to be validated too, and it is load-bearing.** The wave-2 digest is built *entirely*
  from `research.summary`, and dep satisfaction keys off `!failed`. A root with three real findings and a
  blank summary was "successful", satisfied its dependents' deps, and dispatched them with a heading and
  nothing under it — a blank premise they answered anyway.
- **Every agent result is now bound to the angle it was dispatched for.** `reports[]` emits
  `research.angleId` while deps and meta key off the dispatched `angle.id`, so a foreign `angleId`
  misattributed coverage: one angle appeared answered twice while another was never answered.

**Scope, stated honestly:** this is a placeholder/junk filter, **not provenance verification**. It cannot
prove a URL was fetched — a live, non-placeholder URL with a long-enough invented claim still passes. The
workflow sandbox cannot see the worker's tool-call log. It ends the class of failure that happened; it
does not make results verified.

### C2. Failed angles dropped silently; wave-2 ignores deps — P2 — ✅ SHIPPED
`filter(Boolean)` erased crashed workers; wave-2 dispatched even when a declared dep never completed.
Failures now flow to a top-level **`failedAngles`** (`meta` carries counts only — never a second copy of
the list), core failures are called out, and SKILL.md requires the orchestrator to surface them in the
synthesis. `tallyMeta` counts on the explicit `failed` flag: a failure record is a *truthy object*, so
the old truthiness count reported `anglesFailed: 0` while `failedAngles` listed failures — a meta block
that contradicted itself.

### C3. Tier-2 escalation has NEVER fired — P1 — ✅ SHIPPED (NEW: found by Codex reviewing the C1/C2 plan, not in the audit)
`shouldEscalate` read `verification.reliability`; `VERIFY_SCHEMA` requires and returns
`overallReliability`. `rank[undefined]` is `undefined`, the `typeof r === "number"` guard fails, and the
function returned `false` for **every input** — including a verifier that explicitly reported `low`.
Proven at the console. **The entire low-reliability re-check was dead code**; `escalations: 0` in every
meta block was a dead branch, not a quiet one.

Also: `validateArgs` now rejects dependency graphs the two-wave runner cannot honour — duplicate ids,
self-deps, deps on angles that do not exist, and **deps on non-root angles**. That last one matters:
`partitionWaves` puts every angle with deps into wave 2 and `okIds` holds wave-1 successes only, so an
ordinary-looking `a → b → c` chain reported `c` as `dep-failed: b` **even when `b` succeeded perfectly**.
A confident lie is worse than a validation error.

## Batch A — doc-only fixes

- **A1 (P3):** ❌ **STALE — already fixed, nothing shipped.** `handoff/skills/handoff/SKILL.md:132`
  already names `load-pending-handoff.mjs`, matching `hooks.json`. The audit finding was wrong. No
  handoff bump.
- **A2 (P3):** ✅ **SHIPPED.** deep-dive README said recall angles default to Haiku; code + SKILL.md
  default to Sonnet. The README now says so *and states why* (an in-repo experiment found Haiku workers
  missed a load-bearing cross-source contradiction Sonnet caught), so nobody "optimizes" it back.
- **A3 (P3):** ✅ **SHIPPED.** adversarial-agents README merged prose and model-output into one table row
  reading "Hidden Assumptions + artefact-fit picks", implying built-in personas the skill does not have;
  SKILL.md is clear both panels require user-supplied `--personas`. Split the rows and showed the
  invocation that works. **The audit's stated *reason* was wrong** and was not carried over:
  `--personas a,b` entries *are* treated as inline prompt strings (SKILL.md:55), so the syntax **can**
  carry a custom persona. The defect was purely the over-promise.

---

## Dismissed findings

- **"`resumeFromRunId` not implemented in sdd.mjs"** — FALSE POSITIVE, verified
  by subagent 2026-07-14: `resumeFromRunId` is a top-level parameter of the
  harness's Workflow tool (sibling of `scriptPath`), not a script arg; both
  SKILL.md:145 and README.md:67 show it correctly at top level. The
  cached-replay promise holds: sdd.mjs derives all state through `agent()`
  calls (no `Date.now`/exec), so the replay prefix is deterministic.

## Status (2026-07-14)

| Batch | State |
|---|---|
| `codex-review` (the reviewer itself) | ✅ shipped, then escalated to **diff mode** (0.2.0) |
| **B1** path traversal | ✅ shipped |
| **B2** statusline race | ✅ shipped (handoff 0.6.0) |
| **B3** handoff injection | 🔴 **OPEN — needs its own spec, not a plan** |
| **B4** codex-review lock | ⚠️ mitigated, residual documented (0.2.1) |
| **C1 / C2 / C3** deep-dive integrity | ✅ shipped (deep-dive 0.4.0) |
| **D1 / D2 / D3** sdd.mjs correctness | 🔴 **OPEN** |
| **A1** | ❌ stale — was already fixed |
| **A2 / A3** | ✅ shipped |

**What is left: Batch D, and a spec for B3.** D1 is a live P1 (the final fixer's result is discarded;
observed on a real run) and is the highest-value remaining item.

### Notes for whoever picks up Batch D

Per the size-ceremony rule, D is "small plan + plain subagents with tests" scale — write a short
`# Task N` plan, Codex-review it, execute with tiered subagents. Two things this batch's experience
says to do differently:

- **Have Codex review the plan, not just the code.** Across B2, diff mode and C, the plan reviews caught
  more than the code reviews did — including designs that were fatally wrong before a line was written.
  The C plan alone took 16 unique findings across 3 rounds + audit, and the audit (a fresh reviewer
  reading the folded plan cold) found 3 P1s that three review rounds had missed.
- **Check whether your tasks can actually be separate commits.** C1 and C2 were planned as two tasks;
  the audit caught that committing C1 alone leaves the tree crashing on the exact input C1 was written
  to catch. Ask of every task boundary: *is the tree green between these two commits?*
- **The docs-sync guard counts only `plugins/<p>/README.md` and `CLAUDE.md`.** `SKILL.md` does not.
  Every one of this batch's deep-dive commits would have been denied; the audit caught that too.
