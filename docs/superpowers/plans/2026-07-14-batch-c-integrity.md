# Batch C + B4 + A — Deep-dive Integrity, Lock Fix, Doc Fixes

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last of the Codex skills-audit triage
(`docs/plans/2026-07-14-codex-skills-audit-triage.md`): deep-dive result integrity (C1, C2, and the
newly-found C3), the double-breaker bug in `codex-review`'s own lock (B4), and two P3 doc fixes.

**Architecture.** Three plugins, one branch.

- **C1 + C2 — one task, not two.** `fanout.mjs` validates research by *shape* only, so placeholder junk
  (`example.com` URLs, empty findings) is accepted as research — the live 2026-07-14 incident. And
  `.filter(Boolean)` on the wave results **erases crashed workers silently**, while wave-2 angles
  dispatch even when a declared dep never completed. These are **inseparable**: C1 makes `runAngle`
  return failure records, and any commit that does that *before* C2 rewrites the settlement leaves a
  runner that treats a truthy failure record as a success and dereferences `r.research` — a crash. They
  ship together, in one commit, or the tree is broken in between.
- **C3 (NEW, P1 — found by Codex reviewing this plan, not in the original audit)** — **tier-2
  escalation has never fired, once.** `shouldEscalate` reads `verification.reliability`, but
  `VERIFY_SCHEMA` requires and returns `overallReliability`. `rank[undefined]` is `undefined`, the
  `typeof r === "number"` guard fails, and the function returns `false` for *every* input — including a
  verifier that explicitly reported `low`. Proven at the console:
  `shouldEscalate({overallReliability: "low"}, "low") === false`. The whole low-reliability re-check is
  dead code; `escalations: 0` in every meta block was a dead branch, not a quiet one.
- **B4** — `codex-review`'s `acquireLock` breaks a stale lock on **age alone**, so two breakers cascade
  into two holders. **Mitigated, not fixed** (Task 3): break only a provably-dead holder, and fence the
  break on the lock's identity. Node has no compare-and-unlink, so a three-way interleaving on a dead
  victim survives — the same residual handoff 0.6.0 accepted and documented after four Codex rounds.
  The task's job is to shrink the window and *say so*, not to claim a mutex.
- **A2–A3** — two P3 doc fixes where docs contradict shipped code. **A1 is dropped: it is already
  fixed** — `handoff/skills/handoff/SKILL.md:132` already names `load-pending-handoff.mjs`, matching
  `hooks.json`. The audit finding was stale. **No handoff version bump.**

**What this batch does NOT claim.** The C1 guard is a **placeholder/junk filter, not provenance
verification**. It cannot establish that a URL was actually fetched: any live, non-placeholder http(s)
URL paired with a long-enough invented claim passes it. The workflow sandbox has no access to the
worker's tool-call log, so real provenance is not available to us here. The guard raises the floor —
it ends the class of failure that actually happened — and the plan says so plainly rather than
implying the results are now verified.

**Tech Stack:** Node 18+ ESM, stdlib only, `// @ts-check`. Tests: `node --test`.

## Global Constraints

- Version bumps, each in BOTH `plugins/<p>/.claude-plugin/plugin.json` AND the plugin's entry in
  `.claude-plugin/marketplace.json` (the repo-consistency test enforces the match):
  - `deep-dive` → **0.4.0** (behavior change: angles can now fail and be reported; escalation now works)
  - `codex-review` → **0.2.1** (bugfix)
  - `adversarial-agents` → **0.1.1** (doc fix)
  - **NOT handoff** — A1 is already fixed; there is nothing to ship.
- **ESM only, stdlib only**, `// @ts-check`. No new dependencies.
- **`fanout.mjs` runs in the sealed Workflow sandbox**: no `import`, no `fs`, no `child_process`, no
  `Date.now()`, no `Math.random()`.
- **The docs-sync gate will DENY a behavior-change commit that stages no plugin-root doc.**
  `plugins/docs-sync-guard/scripts/pretooluse-guard-docs-sync.mjs:123` counts **only**
  `plugins/<name>/README.md` and `plugins/<name>/CLAUDE.md`. **`SKILL.md` does not count** — staging it
  is not enough and the commit will be blocked. So: every commit touching `plugins/deep-dive/**` code
  **must also stage `plugins/deep-dive/README.md`** (there is a real doc change to make in each of them,
  so this is not a formality). A commit with genuinely no doc impact uses `docs-sync:ack` in the message
  instead — that is what Task 3 does for `codex-review`'s internal, undocumented lock.
- **How the PURE block is actually tested — read this before writing a test.** New pure helpers go
  between the `// >>> PURE` and `// <<< PURE` markers in `fanout.mjs`. The **`return {…}` list lives in
  `fanout.test.mjs`**, not in `fanout.mjs`:
  ```js
  const block = src.split("// >>> PURE")[1]?.split("// <<< PURE")[0];
  const PURE = new Function(block + "\nreturn { partitionWaves, validateArgs, shouldEscalate, tallyMeta, researchPrompt, verifyPrompt };")();
  ```
  So: add each new helper's name to **that list in the test file**, and call it as `PURE.researchProblems(…)`
  (or destructure once: `const { researchProblems, depsSatisfied } = PURE;`).
  **Never put a `return` inside `fanout.mjs`'s PURE block** — it is real workflow code, and a `return`
  there would exit the workflow before it runs.
- Run the full suite with `bash scripts/run-node-tests.sh`, never `node --test <dir>`.
- Branch `fix/batch-c-integrity`. Every commit message ends with:
  `Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw`

---

## Task 1: C1 + C2 — reject schema-valid junk, and stop dropping failed angles

**Files:**
- Modify: `plugins/deep-dive/workflows/fanout.mjs` (PURE block, `runAngle`, wave dispatch, return)
- Modify: `plugins/deep-dive/skills/deep-dive/SKILL.md` (surface failures at synthesis)
- Modify: `plugins/deep-dive/README.md` (document the new return shape — **and the docs-sync gate
  requires a plugin-root doc in this commit**)
- Test: `plugins/deep-dive/workflows/fanout.test.mjs`
- Create: `plugins/deep-dive/workflows/fanout.orchestration.test.mjs`

**These are one task because they cannot be two commits.** C1 changes `runAngle` to return
`{ angle, failed: true, reason }` instead of `null`. The current runner does
`(await parallel(...)).filter(Boolean)` and then reads `r.research.angleId` — a failure record is a
**truthy object**, so it survives the filter and the very next line throws `TypeError: Cannot read
properties of undefined`. Committing C1 alone ships a workflow that crashes on the exact input C1 was
written to catch.

**Interfaces produced:**
- `researchProblems(research, angle)` → `string[]` — empty means usable. `angle` is `{ id, kind }`, the
  angle the result was *dispatched for*.
- `isPlaceholderHost(host)` → `boolean`
- `depsSatisfied(angle, okIds)` → `boolean`
- Workflow return gains a top-level `failedAngles: [{ angleId, kind, question, reason }]`.

**Background — C1: shape is not evidence.**

`RESEARCH_SCHEMA` validates *shape*: a `findings` array of objects each with a `claim`, `sourceUrl`,
`sourceTitle`, `sourceDate`. Every one of those can be a plausible-looking lie. An empty `findings: []`
is schema-valid. So is `sourceUrl: "https://example.com"`. The workflow then reports the angle as
completed research and the synthesis treats it as evidence.

The guard is **semantic**, and it **fails the angle** rather than passing it through:

1. **Zero findings** — an angle that found nothing did not succeed.
2. **An unusable summary** — see below; this one is load-bearing for wave 2.
3. **Placeholder URLs** — `example.com` and friends, *including* FQDN (`example.com.`) and subdomain
   (`sub.example.com`) variants.
4. **Non-http URLs** — anything that is not `http://` or `https://` was never fetched.
5. **Placeholder claims** — `TODO`, `TBD`, `lorem ipsum`, `placeholder`, or a claim under ~20 chars.

**Why the summary must be validated too, and not as an afterthought.** Wave-2 context is built
*entirely* from `research.summary`:

```js
const digest = wave1Settled.filter(...).map((r) => `### ${r.angle.question}\n${r.research.summary}`).join("\n\n");
```

and dep satisfaction keys off `!failed`. So a root angle with three real findings and an **empty
summary** is "successful", satisfies its dependents' deps, and dispatches them with a digest containing
a heading and nothing under it. The dependent angle then researches a question whose entire premise is
blank — and reports back a perfectly well-formed result. Validate the summary in `researchProblems`.

**Background — C2: two silent failures that make a broken run look finished.**

1. `wave1Results = (await parallel(...)).filter(Boolean)` — **`filter(Boolean)` erases every crashed
   worker.** `log("Completed N/M angles")` is the only trace. If the missing angle was `kind: "core"`,
   the synthesis answers a different question than the user asked, with no indication.
2. Wave-2 angles dispatch **even when the dep they declared never completed** — the dep exists precisely
   because the angle is not well-posed without it.

- [ ] **Step 1: Write the failing pure-helper tests**

Append to `plugins/deep-dive/workflows/fanout.test.mjs` (it already extracts the PURE block — follow its
existing extraction pattern, do not build a second one).

```js
const good = {
  angleId: "a1", kind: "core",
  summary: "Cloudflare's workerd runs untrusted code in V8 isolates rather than containers.",
  findings: [{ claim: "Rust adoption in Cloudflare Workers grew via workerd's V8 isolates.",
               sourceUrl: "https://blog.cloudflare.com/workerd", sourceTitle: "workerd", sourceDate: "2024-01-01" }],
};

test("researchProblems: a real result has no problems", () => {
  assert.deepEqual(researchProblems(good), []);
});

test("researchProblems: zero findings is a FAILED angle, not an empty success", () => {
  // Schema-valid. Reported as completed research today. The synthesis then treats "nothing" as
  // evidence of nothing, rather than as a worker that failed.
  assert.ok(researchProblems({ ...good, findings: [] }).some((p) => /no findings/i.test(p)));
});

test("researchProblems: an unusable SUMMARY fails the angle — wave 2 is built from it", () => {
  // Dep satisfaction keys off !failed, and the wave-2 digest is built ENTIRELY from research.summary.
  // A root with real findings and an empty summary is "successful", satisfies its dependents, and
  // dispatches them with a heading and nothing under it — so they research a question with a blank
  // premise and return a well-formed answer to it.
  for (const summary of ["", "   ", undefined, "TODO", "n/a", "short"]) {
    assert.ok(researchProblems({ ...good, summary }).some((p) => /summary/i.test(p)),
      `summary ${JSON.stringify(summary)} must fail the angle`);
  }
});

test("researchProblems: placeholder URLs are the fingerprint of a fabricated citation", () => {
  for (const url of ["https://example.com", "http://example.org/x", "https://localhost:3000/a",
                     "https://127.0.0.1/a", "http://test.com/a", "https://"]) {
    const r = { ...good, findings: [{ ...good.findings[0], sourceUrl: url }] };
    assert.ok(researchProblems(r).length > 0, `${url} must be rejected`);
  }
});

test("researchProblems: a non-http source was never fetched", () => {
  for (const url of ["internal-knowledge", "ftp://x/y", "file:///etc/passwd", "not a url"]) {
    const r = { ...good, findings: [{ ...good.findings[0], sourceUrl: url }] };
    assert.ok(researchProblems(r).some((p) => /url/i.test(p)), `${url} must be rejected`);
  }
});

test("researchProblems: userinfo cannot smuggle a placeholder host past the check", () => {
  // A hand-rolled split on "/" reads the host of `https://evil@example.com/x` as "evil@example.com",
  // which is not in the blocklist — so the placeholder walks straight through. URL.hostname does not.
  for (const url of ["https://evil@example.com/x", "https://a:b@localhost/y", "https://x@127.0.0.1/z"]) {
    const r = { ...good, findings: [{ ...good.findings[0], sourceUrl: url }] };
    assert.ok(researchProblems(r).some((p) => /placeholder/i.test(p)), `${url} must be rejected`);
  }
});

test("researchProblems: DNS variants of a placeholder host are the same fabricated citation", () => {
  // Two equality-check bypasses, both trivial:
  //   - `example.com.` is a fully-qualified name. It resolves identically and is NOT === "example.com".
  //   - `sub.example.com` is a placeholder with a label bolted on.
  for (const url of ["https://example.com./x", "https://sub.example.com/x", "https://docs.example.org/y",
                     "https://a.b.test.com/z", "https://EXAMPLE.COM/x"]) {
    const r = { ...good, findings: [{ ...good.findings[0], sourceUrl: url }] };
    assert.ok(researchProblems(r).some((p) => /placeholder/i.test(p)), `${url} must be rejected`);
  }
  // …but a real host that merely CONTAINS a placeholder name is not one. Do not over-reject.
  for (const url of ["https://example.community/x", "https://notexample.com/x", "https://myexample.com/x"]) {
    const r = { ...good, findings: [{ ...good.findings[0], sourceUrl: url }] };
    assert.deepEqual(researchProblems(r), [], `${url} is a legitimate host`);
  }
});

test("researchProblems: placeholder and stub claims are rejected", () => {
  for (const claim of ["TODO", "TBD", "placeholder", "Lorem ipsum dolor sit", "Example claim here", "short"]) {
    const r = { ...good, findings: [{ ...good.findings[0], claim }] };
    assert.ok(researchProblems(r).length > 0, `claim ${JSON.stringify(claim)} must be rejected`);
  }
});

test("researchProblems: a null/garbage result is rejected, not thrown on", () => {
  assert.ok(researchProblems(null).length > 0);
  assert.ok(researchProblems({}).length > 0);
  assert.ok(researchProblems({ findings: "not an array" }).length > 0);
});

test("researchProblems: a result must be BOUND to the angle it was dispatched for", () => {
  // `reports` emits research.angleId, while deps, failedAngles and meta all key off the DISPATCHED
  // angle.id. A worker that returns someone else's angleId therefore misattributes coverage: angle a2
  // appears answered twice, a1 is never answered, and nothing anywhere says so.
  const a1 = { id: "a1", kind: "core" };
  assert.deepEqual(researchProblems(good, a1), [], "the matching case still passes");
  const mismatch = researchProblems({ ...good, angleId: "a2" }, a1);
  assert.ok(mismatch.some((p) => /dispatched for/i.test(p)), "a foreign angleId must fail the angle");
  const wrongKind = researchProblems(good, { id: "a1", kind: "follow-up" });
  assert.ok(wrongKind.some((p) => /kind/i.test(p)));
});

test("depsSatisfied: an angle with no deps is always runnable", () => {
  assert.equal(depsSatisfied({ id: "b", deps: [] }, new Set()), true);
  assert.equal(depsSatisfied({ id: "b" }, new Set()), true);
});

test("depsSatisfied: an angle runs only when EVERY dep succeeded", () => {
  assert.equal(depsSatisfied({ id: "c", deps: ["a"] }, new Set(["a"])), true);
  assert.equal(depsSatisfied({ id: "c", deps: ["a", "b"] }, new Set(["a", "b"])), true);
  // The dep exists precisely because the angle is not well-posed without it. Running anyway means
  // researching a question built on a digest that is missing the thing it depended on.
  assert.equal(depsSatisfied({ id: "c", deps: ["a"] }, new Set()), false);
  assert.equal(depsSatisfied({ id: "c", deps: ["a", "b"] }, new Set(["a"])), false);
});

test("tallyMeta counts failures from the flag, not from truthiness", () => {
  const settled = [
    { angle: { id: "a" }, escalated: true },
    { angle: { id: "b" }, failed: true, reason: "unusable research" },
    { angle: { id: "c" }, failed: true, reason: "dep-failed: b" },
  ];
  const m = tallyMeta("deep", 2, settled);
  // A failure record is a TRUTHY OBJECT. Counting completions with filter(Boolean) reports
  // anglesFailed: 0 while failedAngles lists two — a meta block that contradicts itself.
  assert.equal(m.anglesCompleted, 1);
  assert.equal(m.anglesFailed, 2);
  assert.equal(m.escalations, 1);
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `node --test plugins/deep-dive/workflows/fanout.test.mjs`
Expected: FAIL — `researchProblems` and `depsSatisfied` are not defined.

- [ ] **Step 3: Add the guards to the PURE block**

Add **between the `// >>> PURE` and `// <<< PURE` markers in `fanout.mjs`**, then add
`researchProblems`, `isPlaceholderHost` and `depsSatisfied` to the **`return {…}` list in
`fanout.test.mjs`** (see Global Constraints — that list lives in the test, not the workflow).

```js
const PLACEHOLDER_HOSTS = ["example.com", "example.org", "example.net", "example.edu",
                           "localhost", "127.0.0.1", "test.com", "foo.com", "yoursite.com"];
const PLACEHOLDER_CLAIMS = ["todo", "tbd", "lorem ipsum", "placeholder", "example claim", "n/a"];

/**
 * Is this a placeholder host? Exact match OR any subdomain of one.
 *
 * `PLACEHOLDER_HOSTS.includes(host)` is not enough. `https://sub.example.com/x` and
 * `https://docs.example.org/y` are the same fabricated citation with a label bolted on, and both slip
 * through an equality check. (The caller strips the FQDN trailing dot, so `example.com.` is
 * canonicalized before it gets here.)
 *
 * @param {string} host  lowercase, trailing dot stripped
 * @returns {boolean}
 */
function isPlaceholderHost(host) {
  return PLACEHOLDER_HOSTS.some((p) => host === p || host.endsWith(`.${p}`));
}

/**
 * Semantic validation of an angle's research. The JSON schema checks SHAPE only — `findings: []` is
 * schema-valid, and so is `sourceUrl: "https://example.com"`. Both have been accepted as real research
 * (the 2026-07-14 incident). Shape is not evidence.
 *
 * SCOPE — read this before extending it. This is a PLACEHOLDER/JUNK FILTER, not provenance
 * verification. It cannot establish that a URL was ever fetched: a live, non-placeholder http(s) URL
 * paired with a long-enough invented claim passes. The workflow sandbox has no access to the worker's
 * tool-call log, so real provenance is not available here. This raises the floor and ends the class of
 * failure that actually happened; it does not make the results verified.
 *
 * `angle` binds the result to the angle it was DISPATCHED for. `reports` emits `research.angleId` while
 * deps and meta use the dispatched `angle.id`, so a worker that returns someone else's angleId silently
 * misattributes coverage — an angle can appear answered twice while another is never answered at all.
 *
 * Returns a list of human-readable problems; empty means usable.
 *
 * @param {any} research
 * @param {{id: string, kind: string}} [angle]
 * @returns {string[]}
 */
function researchProblems(research, angle) {
  const problems = [];
  if (!research || typeof research !== "object") return ["no research result returned"];

  if (angle) {
    if (research.angleId !== angle.id) {
      return [`result is for angle ${JSON.stringify(research.angleId)}, but was dispatched for ${JSON.stringify(angle.id)}`];
    }
    if (research.kind !== angle.kind) {
      problems.push(`result kind ${JSON.stringify(research.kind)} does not match the angle's ${JSON.stringify(angle.kind)}`);
    }
  }

  // The summary is not decoration: the wave-2 digest is built ENTIRELY from it, and dep satisfaction
  // keys off !failed. An empty summary on a "successful" root dispatches its dependents with a blank
  // premise — and they answer it.
  const summary = typeof research.summary === "string" ? research.summary.trim() : "";
  const summaryLower = summary.toLowerCase();
  if (summary.length < 40) {
    problems.push(`summary is too short to brief a dependent angle (${JSON.stringify(summary.slice(0, 40))})`);
  } else if (PLACEHOLDER_CLAIMS.some((p) => summaryLower.startsWith(p) || summaryLower === p)) {
    problems.push(`summary is a placeholder (${JSON.stringify(summary.slice(0, 40))})`);
  }

  const findings = Array.isArray(research.findings) ? research.findings : null;
  if (findings === null) return [...problems, "findings is not an array"];
  if (findings.length === 0) return [...problems, "no findings — the angle produced nothing"];

  findings.forEach((f, i) => {
    const n = i + 1;
    const url = typeof f?.sourceUrl === "string" ? f.sourceUrl.trim() : "";
    const claim = typeof f?.claim === "string" ? f.claim.trim() : "";

    // Parse the host properly. A hand-rolled split on "/" treats `https://evil@example.com/x` as host
    // "evil@example.com", which is not in the blocklist — so the userinfo trick smuggles a placeholder
    // URL straight through. URL.hostname handles userinfo, ports, IPv6 and case.
    let host = null;
    try {
      const u = new URL(url);
      if (u.protocol === "http:" || u.protocol === "https:") {
        // Canonicalize. `https://example.com./x` parses to hostname "example.com." — a fully-qualified
        // DNS name that resolves identically and is NOT equal to "example.com", so a bare equality
        // check waves it straight through.
        host = u.hostname.toLowerCase().replace(/\.$/, "");
      }
    } catch {
      host = null; // not a parseable URL at all
    }

    if (host === null) {
      problems.push(`finding ${n}: sourceUrl is not a fetched http(s) URL (${JSON.stringify(url)})`);
    } else if (isPlaceholderHost(host)) {
      problems.push(`finding ${n}: placeholder URL host "${host}" — a fabricated citation`);
    }

    const lower = claim.toLowerCase();
    if (claim.length < 20) {
      problems.push(`finding ${n}: claim is too short to be load-bearing (${JSON.stringify(claim)})`);
    } else if (PLACEHOLDER_CLAIMS.some((p) => lower.startsWith(p) || lower === p)) {
      problems.push(`finding ${n}: placeholder claim (${JSON.stringify(claim.slice(0, 40))})`);
    }
  });

  return problems;
}

/**
 * May this angle run? Only if every angle it declared a dep on actually SUCCEEDED.
 *
 * A dep is declared precisely because the angle is not well-posed without it. Dispatching anyway
 * researches a question built on a digest that is missing the thing it depended on — and the result
 * looks like a normal completed angle.
 *
 * @param {{deps?: string[]}} angle
 * @param {Set<string>} okIds  ids of angles that produced usable research
 * @returns {boolean}
 */
function depsSatisfied(angle, okIds) {
  const deps = Array.isArray(angle.deps) ? angle.deps : [];
  return deps.every((d) => okIds.has(d));
}
```

- [ ] **Step 4: Fix `tallyMeta`, which cannot count failures at all**

`tallyMeta` currently derives failures from truthiness:

```js
const completed = results.filter(Boolean);
anglesFailed: results.length - completed.length,
```

Both ways of calling it are now wrong, and the result is a meta block that **contradicts
`failedAngles`** — worse than not reporting at all:
- pass the successes only → every element is truthy → `anglesFailed: 0`, always.
- pass everything → a failure record is a truthy object → also counted as *completed*.

Count on the explicit `failed` flag instead:

```js
function tallyMeta(mode, wavesRun, settled) {
  const completed = settled.filter((r) => r && !r.failed);
  const failed = settled.filter((r) => !r || r.failed);
  return {
    mode,
    wavesRun,
    anglesCompleted: completed.length,
    anglesFailed: failed.length,
    escalations: completed.filter((r) => r.escalated).length,
  };
}
```

- [ ] **Step 5: Rewrite `runAngle` — validate, retry once, bind every result**

```js
  async function runAngle(angle, waveCtx) {
    let research = await agent(researchPrompt(cfg.topic, angle, cfg.mode, waveCtx), {
      label: `research:${angle.id}`, phase: "Research", model: angle.model, schema: RESEARCH_SCHEMA,
    });

    // Shape is not evidence. A schema-valid result can still be placeholder junk — the whole reason
    // this guard exists (the 2026-07-14 incident). Passing `angle` also binds the result to the angle
    // it was dispatched for. Retry once; models do recover.
    let problems = researchProblems(research, angle);
    if (problems.length > 0) {
      log(`angle ${angle.id}: unusable research (${problems[0]}) — retrying once`);
      research = await agent(
        `${researchPrompt(cfg.topic, angle, cfg.mode, waveCtx)}

YOUR PREVIOUS ATTEMPT WAS REJECTED: ${problems.join("; ")}. Cite only URLs you actually fetched from a search result — never example.com, never a placeholder, never an invented URL. Write a summary that could brief someone who has not read your findings. If you genuinely cannot find sources, say so in the summary and return only the findings you can actually support.`,
        { label: `research:${angle.id}:retry`, phase: "Research", model: angle.model, schema: RESEARCH_SCHEMA },
      );
      problems = researchProblems(research, angle);
    }
    if (problems.length > 0) {
      return { angle, failed: true, reason: `unusable research: ${problems.join("; ")}` };
    }

    let verify = await agent(verifyPrompt(angle, research), {
      label: `verify:${angle.id}`, phase: "Verify", model: "sonnet", schema: VERIFY_SCHEMA,
    });
    if (!verify) return { angle, failed: true, reason: "verifier returned no result" };
    // Bind the verifier's result to this angle too — same misattribution hazard as the research.
    if (verify.angleId !== angle.id) {
      return { angle, failed: true,
               reason: `verifier returned angleId ${JSON.stringify(verify.angleId)} for angle ${angle.id}` };
    }

    // THE TIER-2 RECHECK MUST BE BOUND TOO — and note WHY that is newly load-bearing. Today
    // `fanout.mjs` does `if (recheck) { verify = recheck; }` with no angleId check, so a recheck for
    // another angle silently REPLACES this angle's verification and is emitted in verification[]. That
    // has never bitten anyone only because shouldEscalate has never returned true (C3, Task 2). Task 2
    // makes this path execute for the FIRST TIME, so it must be bound in the same batch — otherwise
    // fixing C3 introduces the very misattribution C1 exists to prevent.
    let escalated = false;
    if (cfg.mode !== "scout" && shouldEscalate(verify, cfg.verify.escalateOn)) {
      // The escalation prompt is an INLINE template literal in fanout.mjs — there is no escalatePrompt()
      // helper, and a call to one would throw ReferenceError. Keep the prompt verbatim; the only change
      // in this block is the binding check.
      const recheck = await agent(
        `Independently re-verify ONLY these flagged claims for "${angle.question}" using a fresh search and WebFetch; correct the verdicts where warranted. Prior flags:\n${JSON.stringify(verify.flags)}`,
        { label: `escalate:${angle.id}`, phase: "Verify", model: "sonnet", schema: VERIFY_SCHEMA },
      );
      if (recheck) {
        if (recheck.angleId !== angle.id) {
          return { angle, failed: true,
                   reason: `tier-2 recheck returned angleId ${JSON.stringify(recheck.angleId)} for angle ${angle.id}` };
        }
        verify = recheck;
        escalated = true;
      }
      // A null recheck keeps the tier-1 verification; escalation is a re-check, not a gate.
    }

    return { angle, research, verify, escalated, failed: false };
  }
```

**Do not introduce an `escalatePrompt()` helper.** It does not exist. Extracting one is not what this
task is for.

- [ ] **Step 6: Rewire the wave dispatch and the return value**

**Do not `.filter(Boolean)` anything** — that is the bug.

```js
  phase("Research");
  const wave1Results = await parallel(wave1.map((a) => () => runAngle(a, null)));
  // A thunk that throws resolves to null (documented parallel() behavior), so a null here is a
  // CRASHED worker, not an absent one. filter(Boolean) would erase it — which is exactly how a deep
  // dive came to look finished while missing a core angle.
  const wave1Settled = wave1Results.map((r, i) =>
    r ?? { angle: wave1[i], failed: true, reason: "worker crashed or was skipped" });

  const okIds = new Set(wave1Settled.filter((r) => !r.failed).map((r) => r.angle.id));

  let wave2Settled = [];
  if (wavesRun === 1) {
    // SCOUT MODE (or no wave-2 angles). wavesRun is 1, so wave2 never dispatches — but validateArgs
    // still ACCEPTS deps, so a scout run with dependent angles would drop them from both `reports` and
    // `failedAngles` entirely: invisible, which is exactly the failure C2 exists to end. Report them.
    wave2Settled = wave2.map((a) => ({
      angle: a, failed: true,
      reason: `skipped: ${cfg.mode} mode runs one wave, and this angle declares dep(s) ${(a.deps || []).join(", ")}`,
    }));
    for (const r of wave2Settled) log(`angle ${r.angle.id}: SKIPPED — ${r.reason}`);
  } else {
    const runnable = wave2.filter((a) => depsSatisfied(a, okIds));
    const blocked = wave2.filter((a) => !depsSatisfied(a, okIds));
    for (const a of blocked) {
      log(`angle ${a.id}: SKIPPED — dep(s) ${(a.deps || []).filter((d) => !okIds.has(d)).join(", ")} failed`);
    }

    // NOTE: every wave-2 angle gets the full wave-1 digest (deps scope runnability, not context).
    // researchProblems now guarantees every summary in here is usable — that is why it validates the
    // summary, not just the findings.
    const digest = wave1Settled
      .filter((r) => !r.failed)
      .map((r) => `### ${r.angle.question}\n${r.research.summary}`)
      .join("\n\n");

    const raw = await parallel(runnable.map((a) => () => runAngle(a, digest)));
    wave2Settled = raw.map((r, i) =>
      r ?? { angle: runnable[i], failed: true, reason: "worker crashed or was skipped" });
    wave2Settled.push(...blocked.map((a) => ({
      angle: a, failed: true,
      reason: `dep-failed: ${(a.deps || []).filter((d) => !okIds.has(d)).join(", ")}`,
    })));
  }

  const settled = [...wave1Settled, ...wave2Settled];
  const all = settled.filter((r) => !r.failed);
  // NOTE: `settled` has one entry per declared angle, always — succeeded, crashed, unusable, or
  // skipped. Nothing is dropped. That invariant is what makes the meta block trustworthy.
  const failedAngles = settled.filter((r) => r.failed).map((r) => ({
    angleId: r.angle.id, kind: r.angle.kind, question: r.angle.question, reason: r.reason,
  }));

  const failedCore = failedAngles.filter((f) => f.kind === "core");
  if (failedAngles.length > 0) {
    log(`⚠ ${failedAngles.length} angle(s) FAILED: ${failedAngles.map((f) => `${f.angleId} (${f.reason})`).join("; ")}`);
  }
  if (failedCore.length > 0) {
    log(`⚠ ${failedCore.length} of them are CORE — the synthesis will not answer the question as asked.`);
  }
  log(`Completed ${all.length}/${cfg.angles.length} angles (${wavesRun} wave(s))`);

  return {
    reports: all.map((r) => ({
      angleId: r.research.angleId, kind: r.research.kind,
      summary: r.research.summary, findings: r.research.findings,
    })),
    verification: all.map((r) => ({
      angleId: r.verify.angleId, reliability: r.verify.overallReliability, flags: r.verify.flags,
    })),
    // ONE authoritative location. `failedAngles` is a first-class RESULT — a peer of `reports` and
    // `verification` — not a statistic. `meta` carries COUNTS ONLY (anglesFailed, failedCore), never a
    // second copy of the list: two copies of the same list is how a consumer ends up reading the wrong
    // one, and the SKILL/README contract points at exactly one.
    failedAngles,
    // tallyMeta takes `settled` (every angle), NOT `all` — see Step 4. Passing `all` makes anglesFailed
    // permanently 0 while failedAngles lists failures: a meta block that contradicts itself is worse
    // than no meta block.
    meta: { ...tallyMeta(cfg.mode, wavesRun, settled), failedCore: failedCore.length },
  };
```

- [ ] **Step 7: Prove the RUNTIME behavior, not just the helpers**

The pure-helper tests cannot show that a crashed worker becomes a failure record, that a blocked angle
is skipped, or that `meta` agrees with `failedAngles` — and those are the actual bugs. Drive the real
workflow body with a scripted `agent()` mock, exactly as
`plugins/subagent-driven-development/workflows/sdd.orchestration.test.mjs` already does (**copy that
file's harness; do not invent a second one**). A Workflow script has a top-level `return`, so it
**cannot be `import()`ed** — the harness rebuilds the runtime's function wrapper:

```js
// new file: plugins/deep-dive/workflows/fanout.orchestration.test.mjs
const src = readFileSync(new URL("./fanout.mjs", import.meta.url), "utf8");
const body = src.replace(/export const meta\s*=\s*\{[\s\S]*?\n\};/, "");
const runWorkflow = (agent, args) =>
  new Function("agent", "phase", "log", "parallel", "pipeline", "args",
    `return (async () => { ${body} })();`,
  )(agent, () => {}, () => {}, (thunks) => Promise.all(thunks.map((t) => t().catch(() => null))), null, args);

const okResearch = (id) => ({
  angleId: id, kind: "core",
  summary: "A summary long enough to actually brief a dependent angle on what this one found.",
  findings: [{ claim: "A real, load-bearing claim about the topic under study.",
               sourceUrl: "https://example-real.dev/post", sourceTitle: "t", sourceDate: "2025-01-01" }],
});
const okVerify = (id) => ({ angleId: id, overallReliability: "high", flags: [] });

test("runtime: a crashed root angle becomes a FAILURE, and its dependent is SKIPPED — neither vanishes", async () => {
  const args = {
    topic: "t", mode: "deep",
    angles: [
      { id: "a", question: "qa", kind: "core", model: "sonnet", deps: [] },
      { id: "b", question: "qb", kind: "core", model: "sonnet", deps: ["a"] },
    ],
    verify: { escalateOn: "low" },
  };
  // Angle "a" crashes. Today filter(Boolean) erases it, and "b" runs anyway on a digest missing the
  // very thing it depended on — and the run reports as complete.
  const agent = async (_p, o) => {
    if (o.label.startsWith("research:a")) throw new Error("worker crashed");
    if (o.label.startsWith("research:")) return okResearch("b");
    return okVerify("b");
  };

  const r = await runWorkflow(agent, args);

  assert.equal(r.reports.length, 0, "b must NOT be reported: its dep failed");
  assert.equal(r.failedAngles.length, 2);
  assert.deepEqual(r.failedAngles.map((f) => f.angleId).sort(), ["a", "b"]);
  assert.match(r.failedAngles.find((f) => f.angleId === "b").reason, /dep-failed/);
  assert.equal(r.meta.anglesFailed, 2, "meta must AGREE with failedAngles");
  assert.equal(r.meta.anglesCompleted, 0);
  assert.equal(r.meta.failedCore, 2);
});

test("runtime: schema-valid JUNK is retried once, then failed — not reported as research", async () => {
  const args = {
    topic: "t", mode: "deep",
    angles: [{ id: "a", question: "qa", kind: "core", model: "sonnet", deps: [] }],
    verify: { escalateOn: "low" },
  };
  let researchCalls = 0;
  const agent = async (_p, o) => {
    if (o.label.startsWith("research:")) {
      researchCalls++;
      // Schema-valid, and entirely fabricated. Accepted as research today.
      return { angleId: "a", kind: "core", summary: "s",
               findings: [{ claim: "TODO", sourceUrl: "https://example.com", sourceTitle: "t", sourceDate: "d" }] };
    }
    return okVerify("a");
  };

  const r = await runWorkflow(agent, args);

  assert.equal(researchCalls, 2, "an unusable angle is retried exactly once");
  assert.equal(r.reports.length, 0, "placeholder junk must never reach the synthesis as research");
  assert.equal(r.failedAngles.length, 1);
  assert.match(r.failedAngles[0].reason, /unusable research/);
});

test("runtime: a root with an EMPTY SUMMARY cannot satisfy a dependent's dep", async () => {
  const args = {
    topic: "t", mode: "deep",
    angles: [
      { id: "a", question: "qa", kind: "core", model: "sonnet", deps: [] },
      { id: "b", question: "qb", kind: "core", model: "sonnet", deps: ["a"] },
    ],
    verify: { escalateOn: "low" },
  };
  // Real findings, blank summary. Without summary validation this angle is "successful", satisfies b's
  // dep, and b is dispatched with a digest that is a heading and nothing else — a blank premise it will
  // nonetheless answer.
  const agent = async (_p, o) => {
    if (o.label.startsWith("research:a")) return { ...okResearch("a"), summary: "" };
    if (o.label.startsWith("research:")) return okResearch("b");
    return okVerify("b");
  };

  const r = await runWorkflow(agent, args);

  assert.equal(r.reports.length, 0);
  assert.match(r.failedAngles.find((f) => f.angleId === "a").reason, /summary/i);
  assert.match(r.failedAngles.find((f) => f.angleId === "b").reason, /dep-failed/);
});

test("runtime: a healthy run still reports normally", async () => {
  const args = {
    topic: "t", mode: "deep",
    angles: [{ id: "a", question: "qa", kind: "core", model: "sonnet", deps: [] }],
    verify: { escalateOn: "low" },
  };
  const agent = async (_p, o) => (o.label.startsWith("research:") ? okResearch("a") : okVerify("a"));

  const r = await runWorkflow(agent, args);
  assert.equal(r.reports.length, 1);
  assert.equal(r.failedAngles.length, 0);
  assert.equal(r.meta.anglesCompleted, 1);
  assert.equal(r.meta.anglesFailed, 0);
});
```

Note the `parallel` shim catches a thrown thunk to `null` — that is the documented `parallel()`
contract, and the whole reason a crashed worker arrives as `null` rather than an exception. If the real
runtime's contract differs, match it.

- [ ] **Step 8: Tell the orchestrator it must surface failures**

In `plugins/deep-dive/skills/deep-dive/SKILL.md`, in the synthesis section (step 4), add:

> **Before synthesizing, read `failedAngles`.** The workflow no longer silently drops angles that
> crashed, returned unusable research, or were skipped because a dep failed. If `failedAngles` is
> non-empty you MUST tell the user which angles are missing and why, in the synthesis itself — not
> just in passing. **If any failed angle is `kind: "core"`, say so first and state plainly that the
> research does not answer the question as asked**; offer to re-run those angles. A synthesis that
> reads as complete while a core angle is missing is the failure this reporting exists to prevent.

- [ ] **Step 9: Update the README's documented return shape**

`plugins/deep-dive/README.md` documents the workflow as returning `{ reports, verification, meta }`.
It now returns **`{ reports, verification, failedAngles, meta }`**. Update it, and state the contract
explicitly: `failedAngles` is the authoritative list (`[{ angleId, kind, question, reason }]`); `meta`
carries **counts only** (`anglesCompleted`, `anglesFailed`, `failedCore`, `escalations`) and never a
second copy of the list.

(This is also what satisfies the docs-sync gate for this commit — see Global Constraints. `SKILL.md`
alone does **not** satisfy it.)

- [ ] **Step 10: Run the tests**

Run: `node --test plugins/deep-dive/workflows/fanout.test.mjs plugins/deep-dive/workflows/fanout.orchestration.test.mjs`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add plugins/deep-dive/workflows/fanout.mjs plugins/deep-dive/workflows/fanout.test.mjs \
        plugins/deep-dive/workflows/fanout.orchestration.test.mjs \
        plugins/deep-dive/skills/deep-dive/SKILL.md plugins/deep-dive/README.md
git commit -m "fix(deep-dive): reject schema-valid junk; stop dropping failed angles (C1, C2)

RESEARCH_SCHEMA validates SHAPE only. 'findings: []' is schema-valid; so is
'sourceUrl: \"https://example.com\"'. Both were accepted as completed research and fed to synthesis as
evidence — the live 2026-07-14 incident. Shape is not evidence.

researchProblems() rejects zero findings, an unusable summary, placeholder URL hosts (including FQDN and
subdomain variants — 'example.com.' and 'sub.example.com' both walked past an equality check), non-http
sources, and placeholder or stub claims. An unusable angle is retried once with the rejection reason,
then FAILED rather than silently passed through. The summary check is load-bearing, not cosmetic: the
wave-2 digest is built entirely from research.summary, so a root with real findings and a blank summary
used to satisfy its dependents' deps and dispatch them with a blank premise.

filter(Boolean) on the wave results ERASED every crashed worker — a deep dive looked finished while
missing an angle, and if that angle was 'core', the synthesis answered a different question than the
user asked with no indication. Wave-2 angles also dispatched even when a declared dep never completed.
Failures now flow to a top-level failedAngles (meta carries counts only, never a second copy), and
SKILL.md requires the orchestrator to surface them in the synthesis.

Every agent result is BOUND to the angle it was dispatched for — research, tier-1 verify, and the tier-2
recheck. reports[] emits research.angleId while deps and meta key off the dispatched angle.id, so a
result carrying a foreign angleId misattributes coverage: one angle appears answered twice while another
is never answered, and nothing says so. The recheck binding is dead until the next commit fixes C3 —
that path has never once executed.

C1 and C2 are one commit because they cannot be two: C1 makes runAngle return truthy failure records,
and the pre-C2 runner treats every truthy result as a success and dereferences r.research.

SCOPE: this is a placeholder/junk filter, NOT provenance verification. It cannot prove a URL was
fetched. It ends the class of failure that actually happened; it does not make results verified.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Task 2: C3 — tier-2 escalation has never fired, and validateArgs accepts a broken DAG

**Files:**
- Modify: `plugins/deep-dive/workflows/fanout.mjs` (`shouldEscalate`, `validateArgs` — both PURE)
- Modify: `plugins/deep-dive/README.md` (document the DAG rules — **and the docs-sync gate requires a
  plugin-root doc in this commit**)
- Test: `plugins/deep-dive/workflows/fanout.test.mjs`, `plugins/deep-dive/workflows/fanout.orchestration.test.mjs`

**Background — a one-word bug that disabled a whole feature.**

```js
function shouldEscalate(verification, escalateOn) {
  const r = rank[verification.reliability];        // ← the schema calls it overallReliability
  return typeof r === "number" && r <= threshold;  // ← rank[undefined] is undefined → always false
}
```

`VERIFY_SCHEMA` **requires** `overallReliability`, and `verifyPrompt` asks the agent for
`overallReliability`. Nothing ever produces `reliability`. So `rank[undefined]` is `undefined`, the
`typeof` guard fails, and `shouldEscalate` returns `false` for **every input** — including a verifier
that explicitly reported `low`. Confirmed at the console:

```
shouldEscalate({ angleId: "a", overallReliability: "low", flags: [] }, "low")  →  false
```

**Tier-2 escalation — the entire low-reliability re-check — has never run in any deep dive.** The
`escalations: 0` in every meta block was not "nothing needed escalating"; it was a dead branch. This
was not in the original audit; Codex found it while reviewing this plan.

**This task must land AFTER Task 1**, which binds the recheck's `angleId`. Fixing `shouldEscalate` first
would make an unbound recheck path live for the first time.

**And `validateArgs` accepts a dependency graph the two-wave implementation cannot honour** — after Task
1, the runner will confidently report those angles as `dep-failed`, which is a *lie*. `partitionWaves`
is the whole scheduler:

```js
const wave1 = angles.filter((a) => !a.deps || a.deps.length === 0);   // roots
const wave2 = angles.filter((a) => a.deps && a.deps.length > 0);      // EVERYTHING else
```

There are exactly two waves, and `okIds` holds **wave-1 successes only**. So:

- **A dep on a non-root angle is unsatisfiable.** Given `a: []`, `b: ["a"]`, `c: ["b"]` — `b` *and* `c`
  are both in wave 2. `c` is checked against `okIds`, which never contains `b` no matter how well `b`
  did. `c` is marked `dep-failed: b` **even when `b` succeeded**. The chain `a → b → c` looks like a
  perfectly ordinary DAG and the workflow silently cannot run it.
- **Duplicate ids** make `okIds` ambiguous.
- **A dep on an id that does not exist** is unsatisfiable, and the angle is skipped forever for a reason
  the user never stated.
- **A self-dep** is unsatisfiable by construction.

Reject all four **before** spending money on wave 1. The alternative — implementing N waves — is a real
feature, not a bugfix, and nothing has asked for it; a clear error at validation beats a
plausible-looking lie at synthesis.

- [ ] **Step 1: Write the failing tests**

In `fanout.test.mjs`:

```js
test("shouldEscalate reads the field the verifier ACTUALLY returns", () => {
  // VERIFY_SCHEMA requires `overallReliability`. Reading `reliability` makes rank[undefined] undefined,
  // so the typeof guard fails and this returned false for EVERY input — tier-2 escalation has never
  // fired once, in any deep dive.
  const v = (overallReliability) => ({ angleId: "a", overallReliability, flags: [] });
  assert.equal(shouldEscalate(v("low"), "low"), true, "a LOW verifier at threshold low MUST escalate");
  assert.equal(shouldEscalate(v("medium"), "low"), false);
  assert.equal(shouldEscalate(v("medium"), "medium"), true);
  assert.equal(shouldEscalate(v("high"), "medium"), false);
  assert.equal(shouldEscalate(v("high"), "high"), true);
  assert.equal(shouldEscalate(null, "low"), false);
  assert.equal(shouldEscalate(v("garbage"), "low"), false, "an unknown reliability must not escalate");
});

test("validateArgs rejects a dependency graph the two-wave runner cannot honour", () => {
  const base = { topic: "t", mode: "deep", verify: { escalateOn: "low" } };
  const angle = (id, deps) => ({ id, question: "q", kind: "core", model: "sonnet", deps });

  assert.throws(() => validateArgs({ ...base, angles: [angle("a", []), angle("a", [])] }), /duplicate/i,
    "duplicate ids make okIds ambiguous");
  assert.throws(() => validateArgs({ ...base, angles: [angle("a", ["nope"])] }), /unknown dep|does not exist/i,
    "a dep on a nonexistent angle is unsatisfiable — it would be skipped forever, silently");
  assert.throws(() => validateArgs({ ...base, angles: [angle("a", ["a"])] }), /itself|self/i);

  // a -> b -> c is an ordinary-looking DAG that this scheduler CANNOT run. partitionWaves puts every
  // angle with deps into wave 2, and okIds only ever holds wave-1 successes — so c is reported
  // "dep-failed: b" even when b succeeded perfectly. A confident lie. Reject it at validation instead.
  assert.throws(
    () => validateArgs({ ...base, angles: [angle("a", []), angle("b", ["a"]), angle("c", ["b"])] }),
    /root|two waves|non-root/i,
    "a dep on a non-root angle needs a third wave, which does not exist",
  );

  // The valid shape — roots plus one dependent wave — still passes.
  assert.ok(validateArgs({ ...base, angles: [angle("a", []), angle("b", ["a"])] }));
  assert.ok(validateArgs({ ...base, angles: [angle("a", []), angle("b", []), angle("c", ["a", "b"])] }));
});
```

In `fanout.orchestration.test.mjs` — the runtime proof that the feature exists at all:

```js
test("runtime: a LOW verifier actually escalates now — this path has never once executed", async () => {
  const args = {
    topic: "t", mode: "deep",
    angles: [{ id: "a", question: "qa", kind: "core", model: "sonnet", deps: [] }],
    verify: { escalateOn: "low" },
  };
  const labels = [];
  const agent = async (_p, o) => {
    labels.push(o.label);
    if (o.label.startsWith("research:")) return okResearch("a");
    if (o.label.startsWith("escalate:")) return { angleId: "a", overallReliability: "high", flags: [] };
    return { angleId: "a", overallReliability: "low", flags: [] }; // tier-1 says LOW
  };

  const r = await runWorkflow(agent, args);

  // Before C3, shouldEscalate returned false for EVERY input, so escalate: was never dispatched and
  // meta.escalations was permanently 0. This assertion is the proof the feature exists at all.
  assert.ok(labels.some((l) => l.startsWith("escalate:a")), "a LOW tier-1 verifier MUST trigger tier-2");
  assert.equal(r.meta.escalations, 1);
  assert.equal(r.verification[0].reliability, "high", "the tier-2 recheck replaces the tier-1 verdict");
});

test("runtime: a tier-2 recheck for the WRONG angle fails the angle instead of replacing its verdict", async () => {
  const args = {
    topic: "t", mode: "deep",
    angles: [{ id: "a", question: "qa", kind: "core", model: "sonnet", deps: [] }],
    verify: { escalateOn: "low" },
  };
  const agent = async (_p, o) => {
    if (o.label.startsWith("research:")) return okResearch("a");
    // Schema-valid, and about a DIFFERENT angle. Before Task 1, `verify = recheck` swallowed it whole
    // and emitted it in verification[] as angle a's reliability.
    if (o.label.startsWith("escalate:")) return { angleId: "zzz", overallReliability: "high", flags: [] };
    return { angleId: "a", overallReliability: "low", flags: [] };
  };

  const r = await runWorkflow(agent, args);

  assert.equal(r.reports.length, 0);
  assert.equal(r.failedAngles.length, 1);
  assert.match(r.failedAngles[0].reason, /recheck returned angleId/i);
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `node --test plugins/deep-dive/workflows/fanout.test.mjs plugins/deep-dive/workflows/fanout.orchestration.test.mjs`
Expected: FAIL — the `low`→escalate assertions return `false` / never dispatch `escalate:`, and
`validateArgs` accepts all four bad graphs.

- [ ] **Step 3: Fix `shouldEscalate`**

```js
function shouldEscalate(verification, escalateOn) {
  if (!verification) return false;
  const rank = { low: 0, medium: 1, high: 2 };
  // The verifier returns `overallReliability` (VERIFY_SCHEMA requires it). Reading `reliability` made
  // this return false for EVERY input, so tier-2 escalation never ran once.
  const r = rank[verification.overallReliability];
  const threshold = escalateOn in rank ? rank[escalateOn] : rank.low;
  return typeof r === "number" && r <= threshold;
}
```

- [ ] **Step 4: Validate the DAG in `validateArgs`**

After the existing per-angle validation, add:

```js
  const ids = angles.map((a) => a.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) throw new Error(`duplicate angle id(s): ${[...new Set(dupes)].join(", ")}`);

  const byId = new Map(angles.map((a) => [a.id, a]));
  // Roots are exactly what partitionWaves puts in wave 1. There is no wave 3.
  const isRoot = (a) => !a.deps || a.deps.length === 0;

  for (const a of angles) {
    for (const d of a.deps || []) {
      if (d === a.id) throw new Error(`angle ${a.id} depends on itself`);
      // Unsatisfiable: the angle would be skipped forever, and (before C2) skipped INVISIBLY.
      const dep = byId.get(d);
      if (!dep) throw new Error(`angle ${a.id} has an unknown dep "${d}" (no such angle)`);
      // The runner has exactly TWO waves, and okIds holds wave-1 successes only. A dep on an angle that
      // itself has deps can never be satisfied — the runner would report `${a.id}` as "dep-failed: ${d}"
      // even when ${d} succeeded. Reject it here rather than lie at synthesis.
      if (!isRoot(dep)) {
        throw new Error(
          `angle ${a.id} depends on "${d}", which is not a root angle — this runner has two waves, ` +
          `so a dep chain (${d} -> ${a.id}) would need a third and can never be satisfied`,
        );
      }
    }
  }
```

- [ ] **Step 5: Document the DAG rules in the README**

In `plugins/deep-dive/README.md`, state that the runner has exactly two waves: **root angles (no deps)
run in wave 1; angles with deps run in wave 2 and may only depend on roots.** A dep chain
(`a → b → c`) is rejected at validation, as are duplicate ids, self-deps, and deps on angles that do not
exist. Note that `escalateOn` now actually works.

(This also satisfies the docs-sync gate for this commit — see Global Constraints.)

- [ ] **Step 6: Run the tests**

Run: `node --test plugins/deep-dive/workflows/fanout.test.mjs plugins/deep-dive/workflows/fanout.orchestration.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/deep-dive/workflows/fanout.mjs plugins/deep-dive/workflows/fanout.test.mjs \
        plugins/deep-dive/workflows/fanout.orchestration.test.mjs plugins/deep-dive/README.md
git commit -m "fix(deep-dive): tier-2 escalation never fired — a one-word field-name bug (C3)

shouldEscalate read verification.reliability; VERIFY_SCHEMA requires and returns overallReliability.
rank[undefined] is undefined, the typeof guard fails, and the function returned false for EVERY input —
including a verifier that explicitly reported 'low'. The entire low-reliability re-check has never run
in any deep dive; 'escalations: 0' in every meta block was a dead branch, not a quiet one.

Also reject dependency graphs the two-wave runner cannot honour, BEFORE spending on wave 1: duplicate
ids, self-deps, deps on angles that do not exist, and deps on NON-ROOT angles. That last one matters:
partitionWaves puts every angle with deps into wave 2 and okIds holds wave-1 successes only, so an
ordinary-looking a -> b -> c chain reports c as 'dep-failed: b' even when b succeeded perfectly. A
confident lie is worse than a validation error.

Lands after C1/C2 deliberately: that commit binds the tier-2 recheck's angleId, and this one is what
makes the recheck path execute for the first time.

Found by Codex while reviewing the batch plan — not in the original audit.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Task 3: B4 — the double-breaker bug in `codex-review`'s lock

**Files:**
- Modify: `plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs` (`acquireLock`)
- Test: `plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs`

**Background — a real reduction in blast radius, NOT a correct mutex.**

`acquireLock` breaks a stale lock on **age alone**:

```js
if (age > staleMs) {
  renameSync(lockPath, `${lockPath}.stale-${token}`);
  unlinkSync(`${lockPath}.stale-${token}`);
  continue;   // retry the acquire
}
```

The comment claims the rename makes this safe ("exactly one breaker wins the rename"). It does not.
Two breakers, A and B, both see the same stale lock:

1. A renames it away, unlinks it, retries, and **acquires a fresh lock**.
2. B — which already judged the lock stale — now renames **A's fresh lock** away and unlinks it.
3. B retries and acquires. **A and B both believe they hold the lock.**

The rename is atomic; the *decision* to break is not, and it was made against a lock that no longer
exists.

What this task actually does — two real reductions, then an honest stop:

1. **Never break a holder we can see is alive.** Break only when the lock is past its lease **and** the
   pid in its token is provably gone. The token is already `${pid}-${ts}-${rand}`, so the pid is right
   there. This closes the *common* case outright: today a merely-slow holder gets its lock stolen on age
   alone.
2. **Fence the break on the lock's identity.** Capture the token before judging, and after the rename
   verify the file we grabbed is the one we judged. If it is not, we just grabbed a *replacement's*
   fresh lock — restore it and abort our own acquire rather than proceeding.
3. **Stop there, and write the residual down.**

**The residual, stated precisely — do not let the commit message or the docs upgrade it into a
guarantee.** "A live holder is never broken" is *false* as an absolute, and this plan must not assert
it. In the three-acquirer interleaving:

- A and B both judge the same genuinely-dead lock breakable.
- A renames it away, unlinks it, retries, and acquires a fresh lock.
- B's `renameSync(lockPath, tmp)` now moves **A's fresh lock** away. B reads it, sees a token that is
  not its captured `victim`, and restores it with `renameSync(tmp, lockPath)` — but between B's rename
  and B's restore, the lock file **does not exist**, so a third process can `openSync("wx")` it and
  believe it holds the lock. B's restore then **overwrites that third holder's lock**, and the third
  holder still believes it owns it.

So the honest claim is: *the break is fenced on identity and on holder liveness, which removes the
common single-race failure; a three-way interleaving on a dead victim can still produce two believers.*
Node has no compare-and-unlink, so that window cannot be closed in userspace — that is precisely the
conclusion four Codex rounds forced on the handoff statusline lock, where the residual is **documented
as accepted**, not fixed. The blast radius stays bounded (the chain log's post-append order
verification is the real guard, and a lost race self-aborts) — which is why this was triaged P3, and
why the right move is to shrink the window and say so, not to add a fifth layer of ceremony.

An unparseable/empty lock (a holder mid-write, between `openSync` and `writeSync`) must **not** read as
dead — but it must not be immortal either, or a crash there wedges the log forever.

- [ ] **Step 1: Write the failing tests**

```js
test("acquireLock: does NOT break a stale-looking lock whose holder is ALIVE", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "l.lock");
  // A lock held by THIS (alive) process, aged past the lease. Age alone must never justify a break:
  // two breakers who both judge it stale will cascade — the second renames away the FIRST's fresh
  // lock, and both end up holding it.
  writeFileSync(lock, `${process.pid}-1-abc`);
  const old = new Date(Date.now() - 120_000);
  utimesSync(lock, old, old);

  assert.throws(() => acquireLock(lock, 30_000), /held/i, "a live holder's lock must not be broken");
  assert.equal(readFileSync(lock, "utf8"), `${process.pid}-1-abc`, "and must be left intact");
});

test("acquireLock: DOES break a stale lock whose holder is dead", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-lock2-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "l.lock");
  writeFileSync(lock, "2147483646-1-abc"); // a pid that cannot exist
  const old = new Date(Date.now() - 120_000);
  utimesSync(lock, old, old);

  const token = acquireLock(lock, 30_000);
  assert.ok(token, "a dead holder's stale lock must not wedge the log forever");
  assert.equal(readFileSync(lock, "utf8"), token);
});

test("acquireLock: a FRESH empty lock is a holder mid-write, not a corpse", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-lock3-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "l.lock");
  writeFileSync(lock, ""); // openSync("wx") returned; writeSync has not landed yet
  assert.throws(() => acquireLock(lock, 30_000), /held/i, "an unparseable pid is not proof of death");
});

test("acquireLock: an ANCIENT empty lock IS broken — a crash mid-write must not wedge the log", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-lock4-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "l.lock");
  writeFileSync(lock, ""); // a process died between openSync and writeSync
  const ancient = new Date(Date.now() - 600_000);
  utimesSync(lock, ancient, ancient);

  assert.ok(acquireLock(lock, 30_000), "if 'unparseable' meant 'alive' forever, this lock would be immortal");
});

test("acquireLock: the empty-lock grace is ADDED to the lease, not raced against it", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-lock4b-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "l.lock");
  writeFileSync(lock, "");
  const old = new Date(Date.now() - 130_000);
  utimesSync(lock, old, old);

  // Lease 120s, grace 60s, age 130s. `age > EMPTY_LOCK_GRACE_MS` alone would say "breakable" — the
  // 60s grace evaporates entirely whenever the lease exceeds it, which is exactly when a mid-write
  // window is most likely. It must take staleMs + grace = 180s.
  assert.throws(() => acquireLock(lock, 120_000), /held/i);
});

test("acquireLock: a free lock is acquired", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-lock5-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "l.lock");
  const token = acquireLock(lock, 30_000);
  assert.equal(readFileSync(lock, "utf8"), token);
});
```

- [ ] **Step 2: Run and verify the live-holder tests fail**

Run: `node --test plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs`
Expected: FAIL on the live-holder and fresh-empty tests — today's code breaks both on age alone.

- [ ] **Step 3: Implement**

```js
/**
 * EXTRA grace for an unparseable lock, ON TOP of the lease — not a competing absolute.
 *
 * A bare `age > EMPTY_LOCK_GRACE_MS` reads as "a far longer grace" but is not one: with a 120s lease
 * and a 60s constant, an empty lock becomes breakable at 120s — the same instant a pid-bearing one
 * does. The grace has silently evaporated at exactly the lease lengths where a mid-write window is
 * most likely. Adding it to staleMs makes it strictly longer for every lease.
 */
const EMPTY_LOCK_GRACE_MS = 60_000;

/** @param {number} pid */
function holderAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return Boolean(e) && /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
  }
}

/**
 * Is this lock breakable? Past its lease AND its holder provably gone.
 *
 * Age alone is NOT enough. Two breakers who both judge the same lock stale on age will cascade: the
 * first breaks it and re-acquires; the second then renames away the FIRST's fresh lock and acquires
 * too, leaving two holders. The rename is atomic; the DECISION to break was made against a lock that
 * no longer exists.
 *
 * An unparseable pid is not proof of death either — an empty file is exactly what a lock looks like
 * between openSync("wx") and writeSync(). But it cannot be immortal, or a crash in that window wedges
 * the log forever; so give it the lease PLUS an extra grace (see EMPTY_LOCK_GRACE_MS: a bare
 * `age > EMPTY_LOCK_GRACE_MS` is not a longer grace at all once staleMs exceeds the constant).
 *
 * @param {string} lockPath
 * @param {number} staleMs
 * @returns {boolean}
 */
function lockIsBreakable(lockPath, staleMs) {
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age <= staleMs) return false;
    const pid = Number.parseInt(String(readFileSync(lockPath, "utf8")).trim().split("-")[0], 10);
    // Mid-write, or a corpse. Strictly more grace than a pid-bearing lock gets, at ANY lease length.
    if (!Number.isInteger(pid) || pid <= 0) return age > staleMs + EMPTY_LOCK_GRACE_MS;
    return !holderAlive(pid);
  } catch {
    return false; // vanished or unreadable — nothing to break
  }
}
```

and in `acquireLock`, replace the `if (age > staleMs) { … }` block with an identity-fenced break:

```js
      // Capture WHICH lock we are judging. Without this, a break decided against the old lock can be
      // executed against a replacement's fresh one — the double-breaker bug.
      let victim = "";
      try { victim = String(readFileSync(lockPath, "utf8")); } catch { continue; } // vanished — retry

      if (lockIsBreakable(lockPath, staleMs)) {
        const tmp = `${lockPath}.stale-${token}`;
        try {
          renameSync(lockPath, tmp);
          if (String(readFileSync(tmp, "utf8")) === victim) {
            unlinkSync(tmp);          // it really was the lock we judged — break it
          } else {
            renameSync(tmp, lockPath); // NOT ours to break: a fresh holder replaced it. Put it back…
            throw err("LOCK_HELD", `lock held: ${lockPath}`); // …and abort, rather than acquire on top.
          }
        } catch (e) {
          if (e && e.code === "LOCK_HELD") throw e;
          // another breaker won the rename — fall through and retry the acquire
        }
        continue;
      }
      throw err("LOCK_HELD", `lock held: ${lockPath}`);
```

Delete the now-unused `age` variable. Ensure `readFileSync` and `statSync` are imported.

**Do not add further ceremony to close the remaining window.** The restore in the `else` branch can
itself lose to a third acquirer. That is the accepted residual (see Background); every previous attempt
to close a window like it opened a new one.

- [ ] **Step 3b: Amend the existing lock test — this change makes it impossible to pass**

`codex-review.test.mjs` (the ownership-safe-release test) does:

```js
const t2 = acquireLock(lockPath);
const old = (Date.now() - 60_000) / 1000;
utimesSync(lockPath, old, old);            // "simulate a crashed/paused holder"
const t3 = acquireLock(lockPath, 30_000);  // expects the stale lock to be BROKEN
```

But `t2`'s token carries **this test process's pid**, and this process is very much alive — so
`holderAlive()` correctly refuses to break it and `acquireLock` now throws. The test's *simulation* was
only ever valid because the old code broke locks on age alone.

Rewrite that setup to simulate a genuinely crashed holder — a dead pid in the token — so the test keeps
asserting what it was written to assert (ownership-safe release), on a premise that is now true:

```js
  // A crashed holder: a pid that cannot exist. Ageing a lock held by THIS (live) process no longer
  // makes it breakable — that is the point of the fix.
  const t2 = `2147483646-1-crashed`;
  writeFileSync(lockPath, t2);
  const old = (Date.now() - 60_000) / 1000;
  utimesSync(lockPath, old, old);
  const t3 = acquireLock(lockPath, 30_000); // breaks the DEAD holder's stale lock
  releaseLock(lockPath, t2);                // the ex-holder returns: must NOT delete t3's lock
  assert.ok(existsSync(lockPath), "ownership-safe release must not remove another holder's lock");
  releaseLock(lockPath, t3);
  assert.ok(!existsSync(lockPath));
```

- [ ] **Step 4: Run the tests**

Run: `node --test plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

The lock is internal and undocumented, so this commit legitimately has no doc impact — that is what
`docs-sync:ack` is for, and the ack lands in the message where it stays auditable.

```bash
git add plugins/codex-review/skills/codex-plan-review/scripts/codex-review.mjs \
        plugins/codex-review/skills/codex-plan-review/scripts/codex-review.test.mjs
git commit -m "fix(codex-review): shrink the lock's stale-break race; document the residual (B4)

acquireLock broke a lock on AGE ALONE, and its comment claimed the rename made that safe. It does not.
Two breakers both judge the same lock stale: A renames it away and re-acquires; B then renames away
A's FRESH lock and acquires too. Both hold it. The rename is atomic; the DECISION to break was made
against a lock that no longer exists.

Break now requires the lease AND a provably-dead holder (the token already carries the pid), and the
break is fenced on the lock's identity: if the file we renamed away is not the one we judged, restore it
and abort rather than acquiring on top. An unparseable pid is not proof of death — an empty file is what
a lock looks like between openSync('wx') and writeSync — but it is not immortal either, so it gets the
lease PLUS an extra grace.

MITIGATION, NOT A FIX — and the code says so. A three-way interleaving on a genuinely dead victim can
still produce two believers: between the losing breaker's rename and its restore the lock does not
exist, so a third process can create it, and the restore then overwrites that third holder's lock. Node
has no compare-and-unlink; that window cannot be closed in userspace. Four Codex rounds forced the same
conclusion on the handoff statusline lock, where the residual is likewise accepted and documented. Blast
radius stays bounded — the chain log's post-append order verification is the real guard, and a lost race
self-aborts (why this is P3).

docs-sync:ack — bugfix only; the lock is internal and undocumented.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Task 4: A2–A3 — doc fixes, and the three version bumps

**Files:**
- `plugins/deep-dive/README.md` (A2)
- `plugins/adversarial-agents/README.md` (A3)
- Three `plugin.json` files + `.claude-plugin/marketplace.json`

**A1 is NOT in this task — it is already fixed.** `plugins/handoff/skills/handoff/SKILL.md:132` already
names `load-pending-handoff.mjs`, matching `hooks.json`. The audit finding was stale. Do not "fix" it,
and do **not** bump handoff.

- [ ] **Step 1: A2** — `plugins/deep-dive/README.md` says recall angles default to Haiku. The code and
  SKILL.md default workers to **Sonnet**, deliberately: an in-repo orchestration experiment found Haiku
  workers missed a load-bearing cross-source contradiction that Sonnet caught. Fix the README and state
  that reason, so nobody "optimizes" it back.

- [ ] **Step 2: A3** — the README over-promises what the model-output panel does on its own.

  `plugins/adversarial-agents/README.md:26` lists, in its artefact→personas table:
  `Prose / model output | Hidden Assumptions + artefact-fit picks` — which reads as *built-in* personas
  the skill selects for you. But `plugins/adversarial-agents/skills/adversarial-agents/SKILL.md:50`
  says the model-output panel needs **user-supplied** personas, passed via `--personas`.

  **Verify both lines before editing; do not trust this plan's line numbers.**

  Note what is *not* wrong, so the fix does not overshoot: SKILL.md:55 documents that
  `--personas custom_a,custom_b` entries **are** treated as inline prompt strings, so the syntax
  *can* carry a custom persona. The defect is purely that the README promises auto-fit picks the
  skill does not make. Fix the README to say the model-output row requires `--personas`, and show
  the one-line invocation that supplies them. Do not add a claim that the syntax is limited — it is not.

- [ ] **Step 3: Bump the three touched plugins** in `plugin.json` AND `marketplace.json`:
  `deep-dive` → `0.4.0`, `codex-review` → `0.2.1`, `adversarial-agents` → `0.1.1`. **Not handoff.**

- [ ] **Step 4: Run the full suite**

Run: `bash scripts/run-node-tests.sh`
Expected: PASS, 0 fail — including `scripts/repo-consistency.test.mjs`'s version match for all three.

- [ ] **Step 5: Commit**

```bash
git add plugins/deep-dive/README.md plugins/adversarial-agents/README.md \
        plugins/deep-dive/.claude-plugin/plugin.json \
        plugins/codex-review/.claude-plugin/plugin.json \
        plugins/adversarial-agents/.claude-plugin/plugin.json \
        .claude-plugin/marketplace.json
git commit -m "docs: fix two docs-contradict-code bugs (A2, A3); bump three plugins

A2: deep-dive README said recall angles default to Haiku; code and SKILL.md default to Sonnet,
    deliberately — Haiku workers missed a load-bearing cross-source contradiction Sonnet caught.
A3: adversarial-agents README's artefact table implied built-in personas for the model-output panel;
    SKILL.md is clear that panel needs user-supplied --personas.

A1 was already fixed (SKILL.md already names the .mjs hook) — the audit finding was stale. No handoff
bump.

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

- [ ] **Step 6: Mark the triage closed — and commit it**

In `docs/plans/2026-07-14-codex-skills-audit-triage.md`:

- Mark **C1, C2, A2, A3 shipped** (in the style B2 already uses).
- Mark **A1 stale — already fixed, nothing shipped.**
- Add **C3** (dead tier-2 escalation) as a finding *found while reviewing this batch's plan*, marked
  shipped. It was never in the audit; recording it only in a commit message loses it.
- Mark **B4 mitigated, not eliminated.** Say what the mitigation buys (no break of a holder we can see
  is alive; the break is fenced on the lock's identity) **and** name the residual (a three-way
  interleaving on a dead victim can still leave two believers; the chain log's append-order
  verification remains the real guard). **Do not record B4 as "fixed."**
- **B3 (handoff provenance) remains open** — it needs its own spec, not a plan.

This edit needs its own commit; the previous step's commit does not stage it:

```bash
git add docs/plans/2026-07-14-codex-skills-audit-triage.md
git commit -m "docs(triage): close C1, C2, C3, A2, A3; B4 mitigated; A1 stale; B3 still open

Claude-Session: https://claude.ai/code/session_014M3mNy7fL8MH3BtwZAZigw"
```

---

## Out of scope

- **B3** — a hostile repo can still commit its own `.claude/handoffs/evil.md` + `.pending`, and the
  loader cannot tell it from one this machine wrote. Needs a provenance boundary (a design question
  about where handoffs live), not a patch.
- **Real provenance for research results.** The C1 guard is a junk filter; proving a URL was fetched
  needs the worker's tool-call log, which the workflow sandbox cannot see. If that ever matters enough,
  it is a workflow-runtime feature request, not a patch to `fanout.mjs`.
- **N-wave dependency graphs.** Task 2 *rejects* dep chains rather than implementing a third wave.
  Nothing has asked for one.
- Escalating `codex-review` further (SDD hook, adversarial persona) — diff mode has one data point.
