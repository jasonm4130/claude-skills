// Two-stage catch decision. Stage 1 is deterministic (file + line-in-span±5);
// stage 2 asks a sonnet judge whether the finding describes the planted
// MECHANISM (right line + wrong complaint is a near miss, not a catch).
// The judge prompt+schema are hashed into MATCHER_CONFIG — the oracle is part
// of baseline identity, and judge verdicts are cached by content.
import { createHash } from "node:crypto";
import { buildClaudeArgs, runClaude } from "./claude-cli.mjs";
import { cacheKey } from "./cache.mjs";

export const JUDGE_SCHEMA = {
  type: "object",
  properties: { match: { type: "boolean" }, reason: { type: "string" } },
  required: ["match", "reason"],
};

export function locationMatch(finding, truth, tolerance = 5) {
  const norm = (p) => String(p ?? "").replace(/^\.\//, "").replace(/^[ab]\//, "");
  if (norm(finding.file) !== norm(truth.file)) return false;
  return Number.isInteger(finding.line)
    && finding.line >= truth.span[0] - tolerance
    && finding.line <= truth.span[1] + tolerance;
}

export function buildJudgePrompt(finding, truth) {
  return [
    "A known code defect exists at a specific location. Its ground-truth description:",
    `MECHANISM: ${truth.mechanism}`,
    "",
    "A code reviewer reported this finding at the same location:",
    `SUMMARY: ${finding.summary}`,
    `MECHANISM: ${finding.mechanism}`,
    "",
    "Question: does the reviewer's finding describe the SAME defect — the same underlying",
    "mechanism of misbehavior — as the ground truth? The same location with a different",
    "complaint (style, a different bug, a vague \"this looks wrong\") is NOT a match.",
    "A paraphrase of the same runtime misbehavior IS a match. Answer via the schema.",
  ].join("\n");
}

export const MATCHER_CONFIG = {
  tolerance: 5,
  judgeModel: "sonnet",
  judgePromptVersion: createHash("sha256")
    .update(buildJudgePrompt({ summary: "V", mechanism: "V" }, { mechanism: "V", span: [1, 1], file: "V" }))
    .update(JSON.stringify(JUDGE_SCHEMA))
    .digest("hex").slice(0, 12),
};

export async function judgeMechanism(finding, truth, deps = { runClaude }) {
  const args = buildClaudeArgs({
    prompt: buildJudgePrompt(finding, truth),
    model: MATCHER_CONFIG.judgeModel,
    schema: JUDGE_SCHEMA,
    allowedTools: [],
  });
  const res = await deps.runClaude(args, { timeoutMs: 120_000 });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, match: res.structured.match === true, reason: res.structured.reason };
}

// First judge-confirmed hit wins (later location hits are left unjudged — they
// cannot change the catch verdict, and judging them would only spend tokens).
export async function matchCell(record, truth, { cache = null, deps = { runClaude } } = {}) {
  const out = { catch: false, matchedFinding: null, nearMisses: [], errors: [] };
  for (let i = 0; i < record.findings.length; i++) {
    const f = record.findings[i];
    if (!locationMatch(f, truth, MATCHER_CONFIG.tolerance)) continue;
    const key = cacheKey({
      kind: "judge",
      finding: { summary: f.summary, mechanism: f.mechanism },
      truthMechanism: truth.mechanism,
      cfg: MATCHER_CONFIG,
    });
    let verdict = cache?.get(key) ?? null;
    if (!verdict) {
      const j = await judgeMechanism(f, truth, deps);
      if (!j.ok) { out.errors.push(j.error); continue; }
      verdict = j;
      cache?.put(key, j);
    }
    if (verdict.match) { out.catch = true; out.matchedFinding = i; return out; }
    out.nearMisses.push(i);
  }
  return out;
}

// Manual judge calibration: node benchmarks/harness/matcher.mjs --self-eval
// (real API calls — never run in CI).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
    && process.argv.includes("--self-eval")) {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join } = await import("node:path");
  const here = fileURLToPath(new URL(".", import.meta.url));
  const cases = JSON.parse(readFileSync(join(here, "fixtures", "judge-cases.json"), "utf8"));
  let wrong = 0;
  for (const c of cases) {
    const j = await judgeMechanism(c.finding, c.truth);
    const got = j.ok ? j.match : "ERROR";
    const okMark = got === c.expected ? "ok " : (wrong++, "BAD");
    console.log(`${okMark} expected=${c.expected} got=${got} — ${c.name}`);
  }
  console.log(`${cases.length - wrong}/${cases.length} correct`);
  process.exit(wrong ? 1 : 0);
}
