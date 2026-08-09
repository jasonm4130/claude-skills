# Statusline Architecture — Research Findings (2026-07-14)

Deep dive (4 angles, run `wf_b3a2be87-a26`). Two core angles verified **high** reliability;
the concurrency-primitives and context-derivation angles came back **medium** (noted inline).

## 1. Claude Code's statusLine contract (high confidence)

| Property | Finding | Source |
|---|---|---|
| Trigger | After each assistant message, after `/compact`, on permission-mode change, on vim-mode toggle. **Debounced 300ms.** | [statusline docs](https://code.claude.com/docs/en/statusline) |
| Timer | Optional `refreshInterval` (min 1s) re-runs it on a timer — added in v2.1.97. We do not set it. | statusline docs |
| Overlap | Docs state twice: *"If a new update triggers while your script is still running, the in-flight execution is cancelled."* Serialization is **cancel-and-replace**, not queuing. | statusline docs |
| Timeout | **None documented.** The word "timeout" does not appear on the statusline page. statusLine is **not a hook** — the hooks reference doesn't mention it, so hook timeouts (60s → 600s in v2.1.3) **do not apply**. | statusline docs, hooks reference, [#19175](https://github.com/anthropics/claude-code/issues/19175) |
| Failure | Non-zero exit or empty output → the bar goes **blank** (no fallback to the last good render). A slow-but-successful script leaves the previous frame in place (passive staleness, not a cache). | statusline docs |
| Caching | None provided. The docs explicitly tell authors to build their own, keyed on `session_id`, with a staleness threshold. | statusline docs |

**The load-bearing correction to our 0.5.1 assumptions:** we assumed a hook-like timeout would
kill a slow statusline. There is no such documented timeout, and statusLine is not a hook. Any
design that relied on "Claude Code will kill it before N seconds" was resting on nothing. (This
is exactly the assertion Codex refused to let the Batch B plan make.)

## 2. Does concurrency actually happen? Yes — the docs are not the whole story (high confidence)

Despite documented cancel-and-replace, **ccusage issue #459** (2025-08-09) is a production
report of unbounded statusline process pile-up: **34 simultaneous node instances, 300%+ CPU,
3+ GB memory, load average 21.73**. Root cause: Bun/npx cold-start latency outrunning Claude
Code's refresh cadence. Fixed in ccusage v15.9.8 by adding a per-session semaphore file.

**Conclusion: the overlap guard is not defending a phantom.** Cancellation evidently does not
reliably reap the spawned process (or does not apply before the process has started), so
multiple invocations do coexist. Claude Code core has its own zombie-process/CPU-meltdown issue
from naive per-invocation full-transcript reads ([#34092](https://github.com/anthropics/claude-code/issues/34092)).

## 3. What the production tools actually do (high confidence)

Surveyed: **ccusage**, **ccstatusline**, **claude-powerline**. All three converge on the same
shape, and it is *not* what we built:

- **No OS-level file locking.** None of them use `flock` or `proper-lockfile`.
- **Best-effort JSON marker/cache files**, gated by **TTL + mtime + PID-liveness** (`kill(pid, 0)`).
- **Serve stale output during overlap** rather than blocking or recomputing.
- ccusage's semaphore: `env::temp_dir()/ccusage-semaphore/{session_id}.lock`, plain JSON;
  validity = time-based expiry **plus transcript-mtime change**; stale-while-revalidate.
- ccstatusline caches git subprocess output (issue #384 — ~95% fewer git spawns).
- A persistent-daemon statusline was proposed ([#10162](https://github.com/anthropics/claude-code/issues/10162)) and **never shipped by anyone**.

**Independent convergence worth noting:** pid-liveness is exactly where our own lock design
landed after four Codex rounds. The production tools got there too — and then stopped, treating
the marker as a *performance* guard rather than a correctness mutex. That is the insight we were
missing: they don't need the lock to be correct, because nothing correctness-critical depends on it.

## 4. Context derivation is the real cost (medium confidence)

- `used_percentage` = `(input_tokens + cache_creation + cache_read) / context_window_size` —
  the **raw model window**, not the effective auto-compact threshold (~180k of 200k). It also
  **excludes output tokens**.
- `context_window.current_usage` is **null before the first API call and again right after
  `/compact`** until the next call repopulates it.
- **Issue #62210** — asking CC to expose an auto-compact-relative percentage — **was filed by
  Jason, and was auto-closed as stale, unfixed** as of 2026-07. `HANDOFF_EFFECTIVE_MAX_TOKENS`
  remains the correct workaround.
- **Every surveyed tool does a full synchronous `readFile` of the transcript**, then splits and
  reverses in memory. Nobody does a true tail-only backward read (the pattern exists; no
  statusline tool uses it). ccusage makes it affordable by **caching the parse, keyed on elapsed
  time + transcript mtime**, so the expensive path runs rarely rather than on every ~300ms tick.

## 5. What this means for our architecture (the B2 redesign)

The 0.5.1 guard has the right instinct and the wrong shape. Three changes, in priority order:

1. **Make flag-firing idempotent, so correctness does not depend on the guard at all.** The
   invariant is "fire each 10%-point band at most once per session" — an idempotency key, not a
   mutex. An exclusive-create marker per band (`writeFileSync(fired, "", { flag: "wx" })`) is
   correct under *any* interleaving, with no lock, no liveness check, no pid-reuse hazard. This
   is strictly stronger than what ccusage/ccstatusline do.
2. **Cache the expensive derivation, keyed on transcript `mtime` + `size`.** This is the actual
   root cause of slow invocations — and of the lease problem that defeated four lock designs. If
   the JSONL parse only runs when the transcript changed, the slow path essentially disappears,
   and the pile-up pressure with it. This is ccusage's proven fix.
3. **Demote the overlap marker to what it really is: a performance guard** (avoid pile-up,
   serve the cached render), keeping pid-liveness — matching the three-tool consensus. It no
   longer has to be a correct mutex, because (1) means nothing correctness-critical rides on it.

**Do not** claim any timeout-based guarantee: there is no documented statusLine timeout.

## Sources

- Claude Code statusline docs — https://code.claude.com/docs/en/statusline
- Claude Code hooks reference — https://code.claude.com/docs/en/hooks
- anthropics/claude-code#19175 (hook timeout docs; confirms statusLine ≠ hook)
- anthropics/claude-code#34092 (zombie processes from per-invocation transcript reads)
- anthropics/claude-code#10162 (daemon statusline proposal; never shipped)
- anthropics/claude-code#62210 (auto-compact-relative percentage; filed by Jason, closed stale)
- ryoppippi/ccusage#459 (statusline process pile-up), #755, #384
- ccstatusline, claude-powerline (git-output caching, marker-file patterns)
