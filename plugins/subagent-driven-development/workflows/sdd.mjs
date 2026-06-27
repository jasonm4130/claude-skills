// @ts-check
// Subagent-driven development loop. Self-contained Workflow script (sealed
// sandbox: no imports, no fs, no Date.now/Math.random; body wrapped in a fn).
// Pure helpers live between the PURE markers so sdd.test.mjs can extract them.
export const meta = {
  name: "subagent-driven-development",
  description:
    "Args-driven SDD loop: sequential per-task implement -> review (spec + quality + ponytail) -> bounded fix loop, with deterministic BLOCKED escalation and oscillation halt, then an Opus whole-branch final review. Returns task results + plan-conflicts + final review.",
  phases: [
    { title: "Implement", detail: "per-task implementer (tiered), TDD + ponytail ladder" },
    { title: "Review", detail: "spec + quality + over-engineering lens, bounded fix loop" },
    { title: "Final", detail: "whole-branch review on Opus", model: "opus" },
  ],
};

// >>> PURE
const TIERS = ["haiku", "sonnet", "opus"];

function validateArgs(input) {
  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch { throw new Error("args string is not valid JSON"); }
  }
  if (!input || typeof input !== "object") throw new Error("args must be an object");
  for (const k of ["planPath", "workdir", "pluginDir", "mergeBase"]) {
    if (typeof input[k] !== "string" || !input[k]) throw new Error(`args.${k} is required`);
  }
  if (!Array.isArray(input.tasks) || input.tasks.length === 0)
    throw new Error("args.tasks must be a non-empty array");
  const tasks = input.tasks.map((t, i) => {
    if (typeof t.n !== "number") throw new Error(`tasks[${i}].n must be a number`);
    if (typeof t.title !== "string" || !t.title) throw new Error(`tasks[${i}].title is required`);
    return {
      n: t.n,
      title: t.title,
      tier: TIERS.includes(t.tier) ? t.tier : "sonnet",
      deps: Array.isArray(t.deps) ? t.deps : [],
    };
  });
  const li = input.limits || {};
  const limits = {
    fixRounds: Number.isInteger(li.fixRounds) ? li.fixRounds : 2,
    escalateAttempts: Number.isInteger(li.escalateAttempts) ? li.escalateAttempts : 2,
  };
  return {
    planPath: input.planPath, workdir: input.workdir, pluginDir: input.pluginDir,
    globalConstraints: typeof input.globalConstraints === "string" ? input.globalConstraints : "",
    mergeBase: input.mergeBase, tasks, limits,
  };
}

function sequenceTasks(tasks) {
  const sorted = [...tasks].sort((a, b) => a.n - b.n);
  const seen = new Set();
  for (const t of sorted) {
    for (const d of t.deps) {
      if (!seen.has(d)) throw new Error(`task ${t.n} depends on ${d} which does not precede it`);
    }
    seen.add(t.n);
  }
  return sorted;
}

function nextTier(tier) {
  const i = TIERS.indexOf(tier);
  if (i < 0) return "sonnet";
  return i >= TIERS.length - 1 ? null : TIERS[i + 1];
}

function reviewerModel(taskTier) {
  return taskTier === "opus" ? "opus" : "sonnet";
}

function maxAttemptsAtTier(tier, limits) {
  return tier === "opus" ? Math.max(1, limits.escalateAttempts) : 1;
}

// roundClasses: array (one per review round) of arrays of finding-class strings.
// True if any class recurs across the most recent `cap` consecutive rounds.
function detectOscillation(roundClasses, cap = 2) {
  if (roundClasses.length < cap) return false;
  const recent = roundClasses.slice(-cap);
  const counts = new Map();
  for (const round of recent) for (const c of new Set(round)) counts.set(c, (counts.get(c) || 0) + 1);
  for (const v of counts.values()) if (v >= cap) return true;
  return false;
}

function ledgerLine(n, base7, head7, verdict) {
  return `Task ${n}: ${verdict} (commits ${base7}..${head7})`;
}
// <<< PURE
