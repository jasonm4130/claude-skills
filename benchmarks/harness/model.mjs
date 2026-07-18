// Canonical normalized result model shared by all adapters, plus the one
// gate-outcome policy (spec: reviewers can reject without an actionable
// finding, so verdict is first-class, not derived only from findings).
export const SEVERITY_WEIGHT = { Critical: 3, Important: 2, Minor: 1 };

export const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string", description: "repo-relative path" },
          line: { type: "integer", description: "new-side line number" },
          severity: { enum: ["Critical", "Important", "Minor"] },
          summary: { type: "string", description: "one-sentence defect statement" },
          mechanism: { type: "string", description: "what concretely goes wrong at runtime, and why" },
        },
        required: ["file", "line", "severity", "summary", "mechanism"],
      },
    },
  },
  required: ["findings"],
};

export function normalizeSeverity(raw) {
  const s = String(raw ?? "").toLowerCase();
  if (s.startsWith("crit") || s === "p1" || s === "high" || s === "blocker") return "Critical";
  if (s.startsWith("import") || s === "p2" || s === "medium" || s === "major") return "Important";
  return "Minor";
}

export function applyVerdictPolicy({ explicitReject = false, findings, threshold = "Critical" }) {
  const t = SEVERITY_WEIGHT[threshold];
  return explicitReject || findings.some((f) => (SEVERITY_WEIGHT[f.severity] ?? 0) >= t)
    ? "reject" : "pass";
}

export function makeCellRecord({
  item, arm, adapter, adapterVersion, trial, status,
  verdict = null, findings = [], tokens = null, wallMs = null, cacheHit = false, error = null,
}) {
  return { item, arm, adapter, adapterVersion, trial, status, verdict, findings, tokens, wallMs, cacheHit, error };
}
