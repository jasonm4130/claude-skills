// Corpus metadata schemas + patch inspection. Pure — no I/O (validate.mjs owns I/O).
export const TAXONOMY = [
  "logic-inversion", "off-by-one", "wrong-constant", "swallowed-error",
  "null-path", "weakened-test", "missing-await", "resource-leak",
  "unsafe-input", "api-misuse",
];
export const SEVERITIES = ["Critical", "Important", "Minor"];
const SHA_RE = /^[0-9a-f]{40}$/;

export function validateItemMeta(meta) {
  if (!meta || typeof meta !== "object") return ["item.json: not an object"];
  const errors = [];
  if (typeof meta.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(meta.id)) errors.push("item.json: bad id");
  if (!["mined", "synthetic"].includes(meta.tranche)) errors.push("item.json: tranche must be mined|synthetic");
  if (meta.tranche === "synthetic") {
    if (meta.repo !== "self") errors.push('item.json: synthetic items must use repo "self"');
  } else if (meta.tranche === "mined") {
    if (typeof meta.repo !== "string" || !meta.repo || meta.repo === "self") errors.push("item.json: mined items need a repo path");
    if (!SHA_RE.test(meta.baseSha ?? "")) errors.push("item.json: mined items need a 40-hex baseSha");
    if (!meta.private && !/^https?:\/\//.test(meta.remote ?? "")) {
      errors.push('item.json: mined items need a public remote URL (or "private": true)');
    }
  }
  if (typeof meta.language !== "string" || !meta.language) errors.push("item.json: language required");
  return errors;
}

export function validateTruth(truth) {
  if (!truth || typeof truth !== "object") return ["truth.json: not an object"];
  const errors = [];
  if (!TAXONOMY.includes(truth.class)) errors.push(`truth.json: class must be one of ${TAXONOMY.join(", ")}`);
  if (typeof truth.file !== "string" || !truth.file) errors.push("truth.json: file required");
  if (!Array.isArray(truth.span) || truth.span.length !== 2
      || !truth.span.every((n) => Number.isInteger(n) && n > 0) || truth.span[0] > truth.span[1]) {
    errors.push("truth.json: span must be [start, end] positive ints, start <= end");
  }
  if (!SEVERITIES.includes(truth.severity)) errors.push(`truth.json: severity must be one of ${SEVERITIES.join(", ")}`);
  if (typeof truth.mechanism !== "string" || truth.mechanism.trim().length < 20) {
    errors.push("truth.json: mechanism must describe the defect (>=20 chars)");
  }
  if (!Array.isArray(truth.knownIssues ?? [])) errors.push("truth.json: knownIssues must be an array");
  else for (const [i, k] of (truth.knownIssues ?? []).entries()) {
    if (!k || typeof k.file !== "string" || !k.file || !Array.isArray(k.span) || k.span.length !== 2
        || !k.span.every((n) => Number.isInteger(n) && n > 0) || k.span[0] > k.span[1]) {
      errors.push(`truth.json: knownIssues[${i}] needs a file and a valid [start, end] span`);
    }
  }
  return errors;
}

// New-side hunk ranges of a unified diff, for one target file.
export function newSideRanges(patchText, file) {
  const ranges = [];
  let inFile = false;
  for (const line of patchText.split("\n")) {
    if (line.startsWith("+++ ")) inFile = line === `+++ b/${file}`;
    else if (line.startsWith("--- ")) continue;
    else if (inFile && line.startsWith("@@")) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(line);
      if (m) {
        const start = Number(m[1]);
        const len = m[2] === undefined ? 1 : Number(m[2]);
        ranges.push([start, start + Math.max(len, 1) - 1]);
      }
    }
  }
  return ranges;
}

export function spanCovered(patchText, file, span) {
  return newSideRanges(patchText, file).some(([a, b]) => span[0] <= b && span[1] >= a);
}
