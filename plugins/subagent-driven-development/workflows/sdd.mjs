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

const IMPL_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["status", "headSha", "testSummary", "concerns", "reportPath"],
  properties: {
    status: { type: "string", enum: ["DONE", "DONE_WITH_CONCERNS", "BLOCKED", "NEEDS_CONTEXT"] },
    headSha: { type: "string" }, testSummary: { type: "string" },
    concerns: { type: "string" }, reportPath: { type: "string" },
  },
};

const REVIEW_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["spec", "findings", "cannotVerify", "quality", "ponytail"],
  properties: {
    spec: { type: "string", enum: ["pass", "fail"] },
    findings: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["severity", "class", "file", "line", "what", "planMandated"],
        properties: {
          severity: { type: "string", enum: ["Critical", "Important", "Minor"] },
          class: { type: "string" }, file: { type: "string" }, line: { type: "string" },
          what: { type: "string" }, planMandated: { type: "boolean" },
        },
      },
    },
    cannotVerify: { type: "array", items: { type: "string" } },
    quality: { type: "string" },
    ponytail: {
      type: "object", additionalProperties: false,
      required: ["net", "items"],
      properties: { net: { type: "number" }, items: { type: "array", items: { type: "string" } } },
    },
  },
};

const FIX_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["headSha", "testSummary", "fixed"],
  properties: {
    headSha: { type: "string" }, testSummary: { type: "string" },
    fixed: { type: "array", items: { type: "string" } },
  },
};

const FINAL_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["verdict", "findings", "ponytailDebt"],
  properties: {
    verdict: { type: "string", enum: ["approve", "changes"] },
    findings: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["severity", "file", "line", "what"],
        properties: {
          severity: { type: "string", enum: ["Critical", "Important", "Minor"] },
          file: { type: "string" }, line: { type: "string" }, what: { type: "string" },
        },
      },
    },
    ponytailDebt: { type: "array", items: { type: "string" } },
  },
};

if (typeof phase === "function") {
  const cfg = validateArgs(args);
  const order = sequenceTasks(cfg.tasks);
  const P = cfg.pluginDir;
  const gc = cfg.globalConstraints || "(none stated)";

  const implPrompt = (task, tier, blocker) =>
    `You are implementing Task ${task.n} ("${task.title}") of an approved plan. Work in ${cfg.workdir}.
Read your full operating instructions first: ${P}/prompts/implementer.md — follow them exactly.
Get your task brief by running: ${P}/scripts/task-brief ${cfg.planPath} ${task.n}
Read the brief file it prints; implement THAT task only.
Global constraints that bind this task:\n${gc}
Write your full report to ${cfg.workdir}/.sdd/task-${task.n}-report.md.${
      blocker ? `\nPRIOR ATTEMPT WAS BLOCKED: ${blocker}\nA ${tier} model is now assigned — resolve the blocker or report BLOCKED again with specifics.` : ""
    }
Return per schema: status, headSha (run \`git rev-parse HEAD\` after committing), testSummary, concerns, reportPath.`;

  const reviewPrompt = (task, base, head) =>
    `You are reviewing Task ${task.n} ("${task.title}"). Work in ${cfg.workdir}; READ-ONLY on the tree.
Read your full operating instructions first: ${P}/prompts/reviewer.md — follow them exactly.
Build the diff: ${P}/scripts/review-package ${base} ${head}
Read the package file it prints. The implementer's report is at ${cfg.workdir}/.sdd/task-${task.n}-report.md (treat as unverified claims).
Global constraints that bind this task:\n${gc}
Return per schema: spec ("pass"/"fail"), findings[{severity,class,file,line,what,planMandated}], cannotVerify[], quality, ponytail{net,items}.
Set planMandated=true for any finding the plan/brief explicitly mandates. "class" is a short stable label for the finding kind (used to detect oscillation).`;

  const fixPrompt = (task, findings) =>
    `You are fixing review findings on Task ${task.n} ("${task.title}"). Work in ${cfg.workdir}.
Read your full operating instructions first: ${P}/prompts/fixer.md — follow them exactly.
Fix ALL of these findings in one commit:\n${JSON.stringify(findings, null, 2)}
Re-run the tests covering each change; append the results to ${cfg.workdir}/.sdd/task-${task.n}-report.md.
Return per schema: headSha (after committing), testSummary, fixed[].`;

  const finalPrompt = (mergeBase, head) =>
    `You are the whole-branch FINAL reviewer (most capable model). Work in ${cfg.workdir}; READ-ONLY.
Read your full operating instructions first: ${P}/prompts/final-reviewer.md — follow them exactly.
Build the branch diff: ${P}/scripts/review-package ${mergeBase} ${head}
Read the package. Also list any new \`ponytail:\` markers (grep the diff for 'ponytail:').
Global constraints:\n${gc}
Return per schema: verdict ("approve"/"changes"), findings[{severity,file,line,what}], ponytailDebt[].`;

  const finalFixPrompt = (findings) =>
    `Fix ALL of these whole-branch review findings in one commit, in ${cfg.workdir}. Read ${P}/prompts/fixer.md and follow it.
Findings:\n${JSON.stringify(findings, null, 2)}
Re-run covering tests; return per schema: headSha, testSummary, fixed[].`;

  const results = [];
  const planConflicts = [];
  let halted = null;

  async function runTask(task, base) {
    // Implement with the BLOCKED escalation ladder.
    let tier = task.tier, opusAttempts = 0, blocker = null, impl = null;
    while (true) {
      impl = await agent(implPrompt(task, tier, blocker), {
        label: `impl:t${task.n}`, phase: "Implement", model: tier, schema: IMPL_SCHEMA,
      });
      if (!impl) return { halt: { taskN: task.n, reason: "implementer returned no result", reportPath: "" } };
      if (impl.status === "DONE" || impl.status === "DONE_WITH_CONCERNS") break;
      blocker = impl.concerns || impl.status;
      if (tier !== "opus") { tier = nextTier(tier); continue; }
      opusAttempts++;
      if (opusAttempts < maxAttemptsAtTier("opus", cfg.limits)) continue;
      return { halt: { taskN: task.n, reason: `blocked after escalation: ${blocker}`, reportPath: impl.reportPath } };
    }

    // Review + bounded fix loop.
    let head = impl.headSha, rounds = 0, review = null;
    const roundClasses = [];
    while (true) {
      review = await agent(reviewPrompt(task, base, head), {
        label: `review:t${task.n}`, phase: "Review", model: reviewerModel(task.tier), schema: REVIEW_SCHEMA,
      });
      if (!review) return { halt: { taskN: task.n, reason: "reviewer returned no result", reportPath: impl.reportPath } };
      (review.findings || []).filter((f) => f.planMandated).forEach((c) => planConflicts.push({ taskN: task.n, ...c }));
      const actionable = (review.findings || []).filter((f) => !f.planMandated && (f.severity === "Critical" || f.severity === "Important"));
      roundClasses.push(actionable.map((f) => f.class));
      if (review.spec === "pass" && actionable.length === 0) break;
      if (rounds >= cfg.limits.fixRounds || detectOscillation(roundClasses)) {
        return { halt: { taskN: task.n, reason: "review did not converge (cap or oscillation)", reportPath: impl.reportPath } };
      }
      rounds++;
      const fix = await agent(fixPrompt(task, actionable), {
        label: `fix:t${task.n}.${rounds}`, phase: "Review", model: "sonnet", schema: FIX_SCHEMA,
      });
      if (!fix) return { halt: { taskN: task.n, reason: "fixer returned no result", reportPath: impl.reportPath } };
      head = fix.headSha || head;
    }
    return { task: { n: task.n, status: impl.status, headSha: head, reviewVerdict: review.spec, fixRounds: rounds } };
  }

  phase("Implement");
  let base = cfg.mergeBase;
  for (const task of order) {
    const r = await runTask(task, base);
    if (r.halt) { halted = r.halt; break; }
    results.push(r.task);
    base = r.task.headSha;
  }

  let finalReview = null;
  if (!halted && results.length) {
    phase("Final");
    finalReview = await agent(finalPrompt(cfg.mergeBase, base), {
      label: "final-review", phase: "Final", model: "opus", schema: FINAL_SCHEMA,
    });
    if (finalReview && (finalReview.findings || []).length) {
      await agent(finalFixPrompt(finalReview.findings), {
        label: "final-fix", phase: "Final", model: "sonnet", schema: FIX_SCHEMA,
      });
    }
  }

  log(halted ? `Halted at task ${halted.taskN}: ${halted.reason}` : `Completed ${results.length}/${order.length} tasks`);
  return {
    tasks: results, planConflicts, halted, finalReview,
    mergeBase: cfg.mergeBase, head: base, ledgerPath: `${cfg.workdir}/.sdd/progress.md`,
    meta: { tasksCompleted: results.length, tasksTotal: order.length, planConflicts: planConflicts.length },
  };
}

