// Stratified scoring: coverage gates, catch/over-rejection rates, and health
// floors against a recorded baseline. Pure — no I/O; run.mjs supplies records
// and writes scorecard.json/scorecard.md from what this module returns.
import { SEVERITY_WEIGHT } from "./model.mjs";
import { cacheKey } from "./cache.mjs";
import { locationMatch } from "./matcher.mjs";

export const COVERAGE_FLOOR = 0.95;
export const ERROR_CEILING = 0.20;
const CATCH_RATE_MARGIN = 0.10;
const OVER_REJECTION_MULTIPLIER = 1.5;

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function populationId({ manifestHash, config }) {
  return cacheKey({ manifestHash, config });
}

// Clean-arm over-rejection unit for one ok cell: severity-weighted sum of
// findings that don't location-match a known (already-adjudicated) issue,
// plus a flat 3 for a reject verdict carrying no findings to explain it.
function overRejectionScore(cell, truth, tolerance) {
  const knownIssues = truth?.knownIssues ?? [];
  const findings = cell.findings ?? [];
  let sum = 0;
  for (const f of findings) {
    const known = knownIssues.some((k) => locationMatch(f, k, tolerance));
    if (!known) sum += SEVERITY_WEIGHT[f.severity] ?? 0;
  }
  if (cell.verdict === "reject" && findings.length === 0) sum += 3;
  return sum;
}

function groupByAdapterArmItem(records) {
  const byAdapter = new Map();
  for (const r of records) {
    let byArm = byAdapter.get(r.adapter);
    if (!byArm) byAdapter.set(r.adapter, (byArm = new Map()));
    let byItem = byArm.get(r.arm);
    if (!byItem) byArm.set(r.arm, (byItem = new Map()));
    let cells = byItem.get(r.item);
    if (!cells) byItem.set(r.item, (cells = []));
    cells.push(r);
  }
  return byAdapter;
}

export function computeScorecard({
  records, truthsById, manifestHash, config, baseline = null, baselinesExist = false,
}) {
  const grouped = groupByAdapterArmItem(records);
  const adapterIds = Object.keys(config.adapters);
  const tolerance = config.matcher.tolerance;
  const pid = populationId({ manifestHash, config });

  const adapters = {};
  const strata = [];

  for (const adapterId of adapterIds) {
    const byArm = grouped.get(adapterId) ?? new Map();
    const trials = config.trialsPolicy[adapterId] ?? config.trialsPolicy.default;
    const scoreThreshold = Math.ceil(trials / 2);

    // Per-item scoring, per arm: an item is "scored" once at least
    // scoreThreshold of its cells came back ok.
    const scoring = new Map(); // arm -> item -> { okCells, scored }
    for (const arm of config.arms) {
      const byItem = byArm.get(arm) ?? new Map();
      const perItem = new Map();
      for (const [item, cells] of byItem) {
        const okCells = cells.filter((c) => c.status === "ok");
        perItem.set(item, { okCells, scored: okCells.length >= scoreThreshold });
      }
      scoring.set(arm, perItem);
    }

    // Seeded arm: catch rate (majority-catch scored items), flip rate
    // (scored items whose ok-cell catch verdicts disagree), and mechanism
    // accuracy (catches vs near-misses over every seeded ok cell).
    const seeded = scoring.get("seeded") ?? new Map();
    let majorityCatches = 0, scoredSeeded = 0, flips = 0;
    let mechCatches = 0, mechNearMisses = 0;
    for (const { okCells, scored } of seeded.values()) {
      for (const c of okCells) {
        if (!c.match) continue;
        if (c.match.catch) mechCatches += 1;
        mechNearMisses += c.match.nearMisses?.length ?? 0;
      }
      if (!scored) continue;
      scoredSeeded += 1;
      const flags = okCells.map((c) => c.match?.catch === true);
      if (flags.filter(Boolean).length > flags.length / 2) majorityCatches += 1;
      if (new Set(flags).size > 1) flips += 1;
    }
    const catchRate = scoredSeeded ? majorityCatches / scoredSeeded : null;
    const flipRate = scoredSeeded ? flips / scoredSeeded : null;
    const mechanismAccuracy = (mechCatches + mechNearMisses) > 0
      ? mechCatches / (mechCatches + mechNearMisses) : null;

    // Clean arm: over-rejection, mean-of-means over scored items.
    const clean = scoring.get("clean") ?? new Map();
    const cleanItemMeans = [];
    for (const [item, { okCells, scored }] of clean) {
      if (!scored) continue;
      const truth = truthsById[item];
      const cellScores = okCells.map((c) => overRejectionScore(c, truth, tolerance));
      cleanItemMeans.push(cellScores.length ? cellScores.reduce((a, b) => a + b, 0) / cellScores.length : 0);
    }
    const overRejection = cleanItemMeans.length
      ? cleanItemMeans.reduce((a, b) => a + b, 0) / cleanItemMeans.length : null;

    // Error rate + wall/token medians: every attempted cell, both arms.
    let attemptedCells = 0, errorCells = 0;
    const tokenTotals = [], wallMsList = [];
    for (const arm of config.arms) {
      for (const cells of (byArm.get(arm) ?? new Map()).values()) {
        attemptedCells += cells.length;
        for (const c of cells) {
          if (c.status !== "ok") { errorCells += 1; continue; }
          if (c.tokens) tokenTotals.push((c.tokens.input ?? 0) + (c.tokens.output ?? 0));
          if (typeof c.wallMs === "number") wallMsList.push(c.wallMs);
        }
      }
    }
    const errorRate = attemptedCells ? errorCells / attemptedCells : 0;

    // Strata: adapter x arm x bug class. Coverage below the floor withholds
    // that stratum's rate (surfaced in renderMarkdown as NOT-SCORED); the
    // adapter's own coverage is the roll-up across all of its strata.
    let coveredAttempted = 0, coveredScored = 0;
    for (const arm of config.arms) {
      const perItem = scoring.get(arm) ?? new Map();
      const byClass = new Map();
      for (const [item, { scored }] of perItem) {
        const cls = truthsById[item]?.class;
        if (!cls) continue;
        let bucket = byClass.get(cls);
        if (!bucket) byClass.set(cls, (bucket = { attempted: 0, scored: 0 }));
        bucket.attempted += 1;
        if (scored) bucket.scored += 1;
      }
      for (const [cls, bucket] of byClass) {
        const coverage = bucket.attempted ? bucket.scored / bucket.attempted : 1;
        coveredAttempted += bucket.attempted;
        coveredScored += bucket.scored;
        strata.push({
          key: `${adapterId}/${arm}/${cls}`, adapter: adapterId, arm, class: cls,
          attempted: bucket.attempted, scored: bucket.scored, coverage,
          notScored: coverage < COVERAGE_FLOOR,
        });
      }
    }
    const coverage = coveredAttempted ? coveredScored / coveredAttempted : 1;

    adapters[adapterId] = {
      catchRate, overRejection, mechanismAccuracy, flipRate, errorRate, coverage,
      medianTokens: median(tokenTotals), medianWallMs: median(wallMsList),
    };
  }

  const errorCeilingBreached = adapterIds.some((id) => adapters[id].errorRate > ERROR_CEILING);
  const matchingBaseline = baseline && baseline.populationId === pid ? baseline : null;
  // A baseline's populationId pins the corpus+config identity, so full stratum
  // coverage was implicit when it was recorded. If it covers an adapter (has a
  // recorded rate for it) and that adapter now has a notScored stratum, the
  // comparison the baseline anchors can no longer be trusted — surface that as
  // unreliable rather than silently comparing against thinner data.
  const baselineCoversNotScored = matchingBaseline
    ? strata.some((s) => s.notScored && matchingBaseline.adapters?.[s.adapter])
    : false;

  let status, exitCode;
  const floors = { evaluated: false, breaches: [] };

  if (errorCeilingBreached || baselineCoversNotScored) {
    status = "UNRELIABLE";
    exitCode = 2;
  } else if (baseline && !matchingBaseline) {
    // Either baseline.populationId differs from this run's population, or
    // baselinesExist is true and nothing matched — either way a recorded
    // baseline couldn't bind, and that must be visible, not silently ignored.
    status = "INFORMATIONAL";
    exitCode = 0;
  } else if (!matchingBaseline && baselinesExist) {
    status = "INFORMATIONAL";
    exitCode = 0;
  } else {
    status = "OK";
    if (matchingBaseline) {
      floors.evaluated = true;
      for (const adapterId of adapterIds) {
        const a = adapters[adapterId];
        const b = matchingBaseline.adapters?.[adapterId];
        if (!b) continue;
        if (a.catchRate != null && a.catchRate < b.catchRate - CATCH_RATE_MARGIN) {
          floors.breaches.push(
            `${adapterId}: catchRate ${a.catchRate} below floor ${(b.catchRate - CATCH_RATE_MARGIN).toFixed(2)}`,
          );
        }
        if (a.overRejection != null && a.overRejection > b.overRejection * OVER_REJECTION_MULTIPLIER) {
          floors.breaches.push(
            `${adapterId}: overRejection ${a.overRejection} above floor ${(b.overRejection * OVER_REJECTION_MULTIPLIER).toFixed(2)}`,
          );
        }
      }
    }
    exitCode = floors.breaches.length ? 1 : 0;
  }

  return {
    generatedFrom: manifestHash, populationId: pid, status, exitCode,
    adapters, strata, floors,
  };
}

function fmt(x, digits = 3) {
  return x === null || x === undefined ? "—" : Number(x.toFixed(digits)).toString();
}

export function renderMarkdown(scorecard) {
  const lines = [];
  lines.push(`# Benchmark Scorecard — ${scorecard.status} (exit ${scorecard.exitCode})`);
  lines.push("");
  lines.push(`Population: \`${scorecard.populationId}\` — generated from \`${scorecard.generatedFrom}\``);
  lines.push("");
  lines.push("## Adapters");
  lines.push("");
  lines.push("| adapter | catch rate | over-rejection | mech accuracy | flip rate | error rate | coverage | median tokens | median wall (ms) |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const [id, a] of Object.entries(scorecard.adapters)) {
    lines.push(
      `| ${id} | ${fmt(a.catchRate)} | ${fmt(a.overRejection)} | ${fmt(a.mechanismAccuracy)} | `
      + `${fmt(a.flipRate)} | ${fmt(a.errorRate)} | ${fmt(a.coverage)} | `
      + `${a.medianTokens ?? "—"} | ${a.medianWallMs ?? "—"} |`,
    );
  }
  lines.push("");
  lines.push("## Strata");
  lines.push("");
  lines.push("| adapter | arm | class | attempted | scored | coverage | status |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const s of scorecard.strata) {
    lines.push(
      `| ${s.adapter} | ${s.arm} | ${s.class} | ${s.attempted} | ${s.scored} | `
      + `${fmt(s.coverage)} | ${s.notScored ? "NOT-SCORED" : "ok"} |`,
    );
  }
  lines.push("");
  lines.push("## Floors");
  lines.push("");
  if (!scorecard.floors.evaluated) {
    lines.push("No matching baseline — floors not evaluated.");
  } else if (scorecard.floors.breaches.length === 0) {
    lines.push("All floors held.");
  } else {
    for (const b of scorecard.floors.breaches) lines.push(`- BREACH: ${b}`);
  }
  return `${lines.join("\n")}\n`;
}
