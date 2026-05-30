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
