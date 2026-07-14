// @ts-check
// Deep-dive fan-out + tiered verification. Self-contained Workflow script
// (the runtime is a sealed sandbox: no imports, body wrapped in a function).
// Pure helpers live between the PURE markers so fanout.test.mjs can extract them.
export const meta = {
  name: "deep-dive-fanout",
  description:
    "Args-driven deep-dive fan-out: two-wave research with factored tier-1 verification and uncertainty-gated tier-2 escalation; returns schema-validated reports + verification + meta.",
  phases: [
    { title: "Research", detail: "wave-1 + conditional wave-2 gather, per-angle Sonnet workers" },
    { title: "Verify", detail: "factored verifier per angle, blind to draft" },
  ],
};

// >>> PURE
function partitionWaves(angles) {
  const wave1 = angles.filter((a) => !a.deps || a.deps.length === 0);
  const wave2 = angles.filter((a) => a.deps && a.deps.length > 0);
  return { wave1, wave2 };
}

function validateArgs(input) {
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      throw new Error("args string is not valid JSON");
    }
  }
  if (!input || typeof input !== "object") throw new Error("args must be an object");
  if (typeof input.topic !== "string" || input.topic.length === 0)
    throw new Error("args.topic is required");
  if (!Array.isArray(input.angles) || input.angles.length === 0)
    throw new Error("args.angles must be a non-empty array");
  const mode = input.mode === "scout" ? "scout" : "deep";
  const angles = input.angles.map((a, i) => {
    if (typeof a.question !== "string" || a.question.length === 0)
      throw new Error(`angle[${i}].question is required`);
    return {
      id: typeof a.id === "string" && a.id ? a.id : `angle-${i + 1}`,
      question: a.question,
      kind: ["core", "background", "follow-up"].includes(a.kind) ? a.kind : "core",
      model: a.model === "haiku" ? "haiku" : "sonnet",
      deps: Array.isArray(a.deps) ? a.deps : [],
    };
  });
  const allowed = ["low", "medium", "high"];
  const escalateOn =
    input.verify && allowed.includes(input.verify.escalateOn)
      ? input.verify.escalateOn
      : "low";
  return { topic: input.topic, mode, angles, verify: { escalateOn } };
}

function shouldEscalate(verification, escalateOn) {
  if (!verification) return false;
  const rank = { low: 0, medium: 1, high: 2 };
  const r = rank[verification.reliability];
  const threshold = escalateOn in rank ? rank[escalateOn] : rank.low;
  return typeof r === "number" && r <= threshold;
}

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

function researchPrompt(topic, angle, mode, waveCtx) {
  const depth =
    mode === "scout"
      ? "BREADTH MODE: skim 8-10 sources for coverage; one brief note per source."
      : "DEPTH MODE: read 2-4 sources DEEPLY; prefer primary/official docs.";
  const ctx = waveCtx
    ? `\n\nWAVE-1 FINDINGS to build directly on (use these, do not re-gather):\n${waveCtx}`
    : "";
  return `Research angle "${angle.question}". Part of: "${topic}".
${depth}
Use the Exa and Tavily MCP tools (any mcp__exa__* and mcp__tavily__* tool), plus WebSearch and WebFetch.
Cite EVERY claim with a real URL + title + date from a search result. Never invent URLs.
Return per schema: angleId="${angle.id}", kind="${angle.kind}", a <=120-word summary, and load-bearing findings.${ctx}`;
}

function verifyPrompt(angle, research) {
  const findings = (research.findings || [])
    .map((f, i) => `${i + 1}. ${f.claim} — ${f.sourceTitle} (${f.sourceUrl}, ${f.sourceDate})`)
    .join("\n");
  return `You are an INDEPENDENT tier-2 verifier. You did NOT do the original research. For the angle "${angle.question}", verify the 4-5 most load-bearing claims below by re-fetching each cited URL with WebFetch (and one corroborating search if a source is weak). Judge each: supported / partial / unsupported / unreachable. Flag single-source claims and any where the page does not actually support the claim. Be adversarial.

${findings}

Return per schema: angleId="${angle.id}", overallReliability (high/medium/low), and the per-claim flags.`;
}
// <<< PURE

const RESEARCH_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["angleId", "kind", "summary", "findings"],
  properties: {
    angleId: { type: "string" },
    kind: { type: "string", enum: ["core", "background", "follow-up"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["claim", "sourceUrl", "sourceTitle", "sourceDate"],
        properties: {
          claim: { type: "string" }, sourceUrl: { type: "string" },
          sourceTitle: { type: "string" }, sourceDate: { type: "string" },
        },
      },
    },
  },
};

const VERIFY_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["angleId", "overallReliability", "flags"],
  properties: {
    angleId: { type: "string" },
    overallReliability: { type: "string", enum: ["high", "medium", "low"] },
    flags: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["claim", "verdict", "note"],
        properties: {
          claim: { type: "string" },
          verdict: { type: "string", enum: ["supported", "partial", "unsupported", "unreachable"] },
          note: { type: "string" },
        },
      },
    },
  },
};

if (typeof phase === "function") {
  const cfg = validateArgs(args);
  const { wave1, wave2 } = partitionWaves(cfg.angles);
  const wavesRun = cfg.mode === "scout" || wave2.length === 0 ? 1 : 2;

  // Run one angle fully: research -> tier-1 verify -> conditional tier-2 escalation.
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
}
