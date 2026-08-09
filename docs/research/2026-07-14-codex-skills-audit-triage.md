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

**Resolved 2026-07-14.** Research: `docs/research/2026-07-14-statusline-architecture-research.md`.
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

### B3. Handoff injection — a repo can plant its own handoff — P2 — ✅ SHIPPED (handoff 0.7.0)

**Resolved 2026-07-14 — and it did NOT need the spec this doc originally demanded.**

**The finding:** B1 closed *exfiltration* (a `.pending` marker reading outside `.claude/handoffs/`). It
did nothing about *injection*: a hostile repo can commit an ordinary in-tree `.claude/handoffs/evil.md`
plus a `.pending` naming it. The loader then emitted the contents announced as *"Loading pending handoff
from previous session"* — and **that framing is the exploit**. It invites the agent to treat
attacker-authored text as its own notes rather than as untrusted repo data, on a channel nobody reviews.

**Why the original scoping was wrong.** This doc (and I, at length) claimed the loader "cannot tell
whether a handoff was written by this machine or committed by the repo", and therefore needed a
provenance boundary — moving handoffs to a user-level data dir, plus a trusted writer to stamp them.
That was over-scoped. **The gitignore convention already supplies the invariant:**

- handoffs are gitignored **by design** (`SKILL.md` tells you to add `/.claude/handoffs/`), so a handoff
  this machine wrote is **untracked, always**; and
- a fresh clone **cannot** produce an untracked-but-present ignored file — git will not create one.

So for the realistic attack (clone a hostile repo), *"git tracks it"* is an **exact** test for
*"the repo shipped it"* — no allowlist, no hash index, no new state, no user friction.

**As built:** `gitTracksFile()` in `lib.mjs`; the loader refuses a tracked handoff **or** a tracked
`.pending`, emits **neither the contents nor the filename** (both attacker-controlled), and tells the
human what it skipped. It **fails open** — no git, or no repo, means no repo-supplied hazard — because
refusing a legitimate handoff is a worse failure than the bug. Both legitimate paths
(untracked-in-a-repo, no-repo-at-all) are pinned by their own tests.

**Severity, calibrated.** This is **not a novel capability**: a hostile repo can already put injection in
`CLAUDE.md`, which Claude Code loads **as instructions**, by design, gated only by the folder-trust
prompt — a strictly more powerful channel. B3 is a *credibility escalation* (self-authored framing) on an
*invisible* channel. Worth closing cheaply. Not worth an architecture.

**Known trade, documented in the README:** if you commit your own handoffs, they stop auto-loading. The
loader cannot distinguish your committed handoff from a hostile one, and guessing wrong in that
direction *is* the vulnerability.

> **Prior art, for the next time this shape comes up.** The field converged on one principle: *the trust
> record must live outside the artifact being trusted.* **direnv** is canonical — `.envrc` is
> repo-controlled, so it requires an explicit `direnv allow` that stores a **content hash** in a
> machine-local dir, and any edit re-locks it; **mise** copied it (`mise trust`). **git** learned it the
> hard way (`safe.directory`, post-CVE-2022-24765, plus a standing refusal to honor certain repo-local
> config keys at all). **VS Code Workspace Trust** and Claude Code's own folder-trust prompt are the
> coarse version. A direnv-style hash allowlist *would* have been best-in-class here — but it is the
> wrong trade for handoffs, because the agent writes them mid-session, so you would be approving a hash
> on every `/handoff`. The gitignore invariant buys the same guarantee for free.

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

## Batch D — sdd.mjs correctness — ✅ SHIPPED (2026-07-14, already on `main`)

**All three shipped before this doc was updated.** Verified against HEAD 2026-07-14, not taken on trust:

| | Commit | Where it lives now |
|---|---|---|
| **D1** | `69d3001` capture and check the final fixer's work | `sdd.mjs` — the fixer's commit goes through `runVerify`, `base = acc.headSha` ("head must point PAST the final fix"), and a bounded **report-only** `final-review-2` so the returned head is never unreviewed. A red fix halts instead of reporting an approved run. |
| **D2** | `97631c8` check every state advance against an independent verifier | `sdd.mjs` — every advance (singleton wave, merge gate, final fix) goes through one `runVerify` entry point: it fails closed on a malformed SHA *without dispatching*, checks `merge-base --is-ancestor` for continuity, checks each task commit is contained, and re-runs `testCmd`. `!acc.ok` **halts**; `base` never advances on a merger's word. |
| **D3** | `bfff821` reject duplicate and non-integer task numbers | `validateArgs` — `n` must be a positive integer and unique (`n` names the branch, the worktree and the report path; two tasks sharing it race on all three). |

Covered by `sdd.orchestration.test.mjs` — **11 tests, all passing**, including "a claimed-green merge the
verifier finds red halts the run", "the verifier is asked about EVERY succeeded task, not the merger's
list", and "head must point PAST the final fix".

**D1 also closes the known "SDD findings stale vs HEAD" quirk** (memory:
`retro_project_sdd_findings_stale_vs_head`) — that was this bug, confirmed live on the codex-review build
run (wf_e69a9e74-22e), which returned `head: 6dfb959` while the final fixer had already committed
`3949fdf` on top of it.

> **Lesson, and it has now bitten three times.** This doc listed D as open, and a later session's status
> table repeated that without checking. A1 was stale. D3 was stale. **An audit finding is a hypothesis
> about HEAD, and HEAD moves.** Verify every finding against the current code before planning work on it
> — the check costs one `grep`; the alternative is re-fixing something that is already fixed, or (worse)
> "fixing" code whose behavior you never actually read.

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
| **B3** handoff injection | ✅ shipped (handoff 0.7.0) — and it did **not** need the spec this doc demanded |
| **B4** codex-review lock | ⚠️ mitigated, residual documented (0.2.1) |
| **C1 / C2 / C3** deep-dive integrity | ✅ shipped (deep-dive 0.4.0) |
| **D1 / D2 / D3** sdd.mjs correctness | ✅ shipped — **and was already shipped when this table first claimed otherwise** |
| **A1** | ❌ stale — was already fixed |
| **A2 / A3** | ✅ shipped |

**Nothing is left. The audit is CLOSED**, with one accepted residual (B4's lock, documented above).

### What this audit taught, for the next one

- **An audit finding is a hypothesis about HEAD, and HEAD moves.** Three of the fourteen findings (A1,
  D3, and in fact all of Batch D) were already fixed by the time anyone planned work on them — and a
  status table in this very doc asserted D was open without checking. Re-verify every finding against
  the current code before planning against it. It costs one `grep`.
- **Scope the fix from the invariants you already have, not from the threat's worst framing.** B3 was
  scoped here as needing a provenance architecture and its own spec. It needed neither: handoffs are
  already gitignored, so `git ls-files` was an exact provenance test sitting in plain sight. Ask "what
  does the system already guarantee?" before designing new machinery to guarantee it.
- **Calibrate severity against the baseline, not against zero.** A hostile repo can already inject via
  `CLAUDE.md`, which is loaded *as instructions* by design. B3 was a credibility escalation on an
  invisible channel — real, cheap to close, and not the emergency the raw finding implied.
- **Have Codex review the *plan*, not just the code.** Across B2, diff mode and C, the plan reviews
  caught more than the code reviews did — including designs that were fatally wrong before a line was
  written. The C plan took 16 unique findings across 3 rounds + an audit, and the audit (a fresh reviewer
  reading the folded plan cold) found 3 P1s that three review rounds had missed.
- **Then review the code anyway.** `codex-review diff` on the finished C branch found 3 more real bugs in
  code the plan review had already blessed — including a host guard that would have let a fabricated
  finding point the verifier's `WebFetch` at `169.254.169.254`. Plan review and diff review catch
  different things.
- **Check whether your tasks can actually be separate commits.** C1 and C2 were planned as two; the audit
  caught that committing C1 alone leaves the tree crashing on the exact input C1 was written to catch.
  Ask of every task boundary: *is the tree green between these two commits?*
- **The docs-sync guard counts only `plugins/<p>/README.md` and `CLAUDE.md`.** `SKILL.md` does not — so
  every one of Batch C's deep-dive commits would have been denied. The audit caught that too.
