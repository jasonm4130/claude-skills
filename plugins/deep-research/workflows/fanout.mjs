// @ts-check
// Deep-research fan-out + tiered verification. Self-contained Workflow script
// (the runtime is a sealed sandbox: no imports, body wrapped in a function).
// Pure helpers live between the PURE markers so fanout.test.mjs can extract them.
export const meta = {
  name: "deep-research-fanout",
  description:
    "Args-driven deep-research fan-out: two-wave research with factored tier-1 verification and uncertainty-gated tier-2 escalation; returns schema-validated reports + verification + meta.",
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
  return !!(verification && verification.reliability === (escalateOn || "low"));
}

function tallyMeta(mode, wavesRun, results) {
  const completed = results.filter(Boolean);
  return {
    mode,
    wavesRun,
    anglesCompleted: completed.length,
    anglesFailed: results.length - completed.length,
    escalations: completed.filter((r) => r && r.escalated).length,
  };
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
    const research = await agent(researchPrompt(cfg.topic, angle, cfg.mode, waveCtx), {
      label: `research:${angle.id}`, phase: "Research", model: angle.model, schema: RESEARCH_SCHEMA,
    });
    if (!research) return null;
    let verify = await agent(verifyPrompt(angle, research), {
      label: `verify:${angle.id}`, phase: "Verify", model: "sonnet", schema: VERIFY_SCHEMA,
    });
    let escalated = false;
    if (cfg.mode !== "scout" && verify && shouldEscalate(verify, cfg.verify.escalateOn)) {
      const recheck = await agent(
        `Independently re-verify ONLY these flagged claims for "${angle.question}" using a fresh search and WebFetch; correct the verdicts where warranted. Prior flags:\n${JSON.stringify(verify.flags)}`,
        { label: `escalate:${angle.id}`, phase: "Verify", model: "sonnet", schema: VERIFY_SCHEMA }
      );
      if (recheck) { verify = recheck; escalated = true; }
    }
    return { angle, research, verify, escalated };
  }

  phase("Research");
  const wave1Results = (await parallel(wave1.map((a) => () => runAngle(a, null)))).filter(Boolean);

  let wave2Results = [];
  if (wavesRun === 2) {
    const digest = wave1Results
      .map((r) => `### ${r.angle.question}\n${r.research.summary}`)
      .join("\n\n");
    wave2Results = (await parallel(wave2.map((a) => () => runAngle(a, digest)))).filter(Boolean);
  }

  const all = [...wave1Results, ...wave2Results];
  log(`Completed ${all.length}/${cfg.angles.length} angles (${wavesRun} wave(s))`);

  return {
    reports: all.map((r) => ({
      angleId: r.research.angleId, kind: r.research.kind,
      summary: r.research.summary, findings: r.research.findings,
    })),
    verification: all.map((r) => ({
      angleId: r.verify.angleId, reliability: r.verify.overallReliability, flags: r.verify.flags,
    })),
    meta: tallyMeta(cfg.mode, wavesRun, all),
  };
}
