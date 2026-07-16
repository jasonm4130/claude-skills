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

  return { topic: input.topic, mode, angles, verify: { escalateOn } };
}

function shouldEscalate(verification, escalateOn) {
  if (!verification) return false;
  const rank = { low: 0, medium: 1, high: 2 };
  // The verifier returns `overallReliability` (VERIFY_SCHEMA requires it). Reading `reliability` made
  // this return false for EVERY input, so tier-2 escalation never ran once.
  const r = rank[verification.overallReliability];
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
                           "localhost", "test.com", "foo.com", "yoursite.com"];
/** RFC 2606 / 6761 reserve these: they can NEVER resolve to a real site, so a citation using one is fabricated by construction. */
const RESERVED_TLDS = ["invalid", "test", "example", "local", "localhost"];
/** Unambiguous — safe to match ANYWHERE in a claim. "This is a placeholder claim" is one. */
const PLACEHOLDER_MARKERS = ["lorem ipsum", "placeholder", "example claim"];
/** Ambiguous as substrings (a real claim may discuss TODOs), so these only count as a PREFIX. */
const PLACEHOLDER_PREFIXES = ["todo", "tbd", "n/a"];

/**
 * Is this host unusable as a research citation?
 *
 * Three ways to be unusable, and the first two were both walked straight past by the original
 * equality-check-against-a-blocklist:
 *
 * 1. A bare IP literal. A real source is a NAMED website; a finding citing an IP is fabricated, or is
 *    aiming somewhere it has no business going — and the tier-1 verifier is INSTRUCTED to fetch these
 *    URLs. `169.254.169.254` is the cloud instance-metadata endpoint. Rejecting every IP literal is
 *    both simpler and stricter than CIDR arithmetic, and costs nothing real: research does not cite IPs.
 * 2. A reserved TLD (RFC 2606/6761). `example.invalid` cannot resolve, ever.
 * 3. A placeholder domain — exact match OR any subdomain. `sub.example.com` is the same fabricated
 *    citation with a label bolted on. (The caller strips the FQDN trailing dot, so `example.com.` is
 *    canonicalized before it gets here.)
 *
 * @param {string} host  lowercase, trailing dot stripped
 * @returns {boolean}
 */
function isPlaceholderHost(host) {
  // IPv6 arrives bracketed from hostFromUrl ("[::1]"); IPv4 is all-digits-and-dots.
  if (host.startsWith("[") || /^[\d.]+$/.test(host)) return true;
  // Alternate host encodings that a real fetcher WOULD normalize to a blocked target, but the regex
  // parser does not (new URL() did — issue #41). A legitimate research citation is plain ASCII DNS.
  //   - any char outside [a-z0-9.-]: percent-encoding (`%31%36%39.254.169.254`) or a non-ASCII
  //     homograph (`example%E3%80%82com` = ideographic full stop -> "example.com");
  //   - a dotless host: a hex/octal/decimal IP literal (`0xA9FEA9FE` -> 169.254.169.254) or a bare
  //     intranet name — never a real public citation. (Bracketed IPv6 already returned above.)
  if (/[^a-z0-9.-]/.test(host) || !host.includes(".")) return true;
  const tld = host.split(".").pop();
  if (RESERVED_TLDS.includes(tld)) return true;
  // A real TLD is alphabetic (or punycode `xn--…`, which starts with a letter). EVERY alternate IPv4
  // notation — dotted hex (`0xA9.0xFE.0xA9.0xFE`), dotted octal (`0250.0376.…`), mixed (`0x7f.0.0.1`),
  // short-form (`127.1`) — ends in a numeric/hex label, so a non-letter TLD is an IP in disguise.
  // This is what makes the guard robust without re-implementing new URL()'s inet_aton canonicalization.
  if (!tld || !/^[a-z]/.test(tld)) return true;
  return PLACEHOLDER_HOSTS.some((p) => host === p || host.endsWith(`.${p}`));
}

/**
 * Canonical host of an http(s) URL, or null if the URL is not http(s) or has no host.
 *
 * Why not `new URL()`: the sealed Workflow runtime has NO global URL constructor — `new URL()`
 * throws ReferenceError there, which false-rejected every finding as "not a fetched http(s) URL"
 * (issue #41). The node test harness DOES have URL, so the break was invisible to the suite. This
 * parses with RegExp only (which the sandbox does have) and reproduces the exact canonicalization
 * the old code relied on, so the security checks below are unchanged:
 *   - scheme must be http/https (case-insensitive) — anything else was never fetched;
 *   - userinfo is stripped at the LAST "@" so `https://evil@example.com/x` reads as host example.com;
 *   - a bracketed IPv6 literal keeps its brackets (isPlaceholderHost keys off the leading "[");
 *   - an :port suffix is dropped; the host is lowercased and its trailing FQDN dot removed, so
 *     `EXAMPLE.COM` and `example.com.` both canonicalize to `example.com`.
 *
 * @param {string} url
 * @returns {string|null}
 */
function hostFromUrl(url) {
  const m = /^(https?):\/\/([^/?#]*)/i.exec(url);
  if (!m) return null; // no http(s) scheme → never fetched
  let authority = m[2];
  const at = authority.lastIndexOf("@");
  if (at !== -1) authority = authority.slice(at + 1); // drop userinfo
  let host;
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    host = end === -1 ? authority : authority.slice(0, end + 1); // keep the [..] IPv6 literal
  } else {
    const port = /:(\d+)$/.exec(authority);
    // A real URL parser rejects a port outside 1..65535; the old new URL() path did too. Without this
    // an unfetchable citation (`…:99999`) would reach the verifier. (`:abc` is caught by the charset
    // rule in isPlaceholderHost; this handles the numeric-but-out-of-range case.)
    if (port) {
      const n = Number(port[1]);
      if (n < 1 || n > 65535) return null;
    }
    host = authority.replace(/:\d*$/, ""); // drop :port
  }
  host = host.toLowerCase().replace(/\.$/, "");
  return host === "" ? null : host;
}

/**
 * Is this claim placeholder text? Unambiguous markers match anywhere; ambiguous ones only as a prefix.
 *
 * `startsWith()` alone only catches a marker at position 0, so "This is a placeholder claim which must
 * not be synthesized." was accepted as usable research. But a blanket `includes()` would reject the
 * legitimate claim "the codebase carries 42 TODO comments" — so the short, ambiguous tokens stay
 * prefix-only.
 *
 * @param {string} lower  the claim, lowercased and trimmed
 * @returns {boolean}
 */
function isPlaceholderClaim(lower) {
  if (PLACEHOLDER_MARKERS.some((p) => lower.includes(p))) return true;
  return PLACEHOLDER_PREFIXES.some((p) => lower === p || lower.startsWith(`${p} `) || lower.startsWith(`${p}:`));
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
  } else if (isPlaceholderClaim(summaryLower)) {
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
    // URL straight through. hostFromUrl handles userinfo, ports, IPv6 and case — without `new URL()`,
    // which the sandbox lacks (issue #41).
    const host = hostFromUrl(url);

    if (host === null) {
      problems.push(`finding ${n}: sourceUrl is not a fetched http(s) URL (${JSON.stringify(url)})`);
    } else if (isPlaceholderHost(host)) {
      problems.push(`finding ${n}: placeholder URL host "${host}" — a fabricated citation`);
    }

    const lower = claim.toLowerCase();
    if (claim.length < 20) {
      problems.push(`finding ${n}: claim is too short to be load-bearing (${JSON.stringify(claim)})`);
    } else if (isPlaceholderClaim(lower)) {
      problems.push(`finding ${n}: placeholder claim (${JSON.stringify(claim.slice(0, 40))})`);
    }

    // The schema types these as strings, and "" is a string. But the workflow's contract is that every
    // claim carries a URL *and* a title *and* a date — the synthesis renders all three — so an empty one
    // is a broken citation, not a complete one.
    const title = typeof f?.sourceTitle === "string" ? f.sourceTitle.trim() : "";
    const date = typeof f?.sourceDate === "string" ? f.sourceDate.trim() : "";
    if (title === "") problems.push(`finding ${n}: sourceTitle is empty — an incomplete citation`);
    if (date === "") problems.push(`finding ${n}: sourceDate is empty — an incomplete citation`);
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
