// @ts-check
// Subagent-driven development loop. Self-contained Workflow script (sealed
// sandbox: no imports, no fs, no Date.now/Math.random; body wrapped in a fn).
// Pure helpers live between the PURE markers so sdd.test.mjs can extract them.
export const meta = {
  name: "subagent-driven-development",
  description:
    "Args-driven SDD loop: deps-driven waves — per-task implement -> review (spec + quality + ponytail) -> bounded fix loop run concurrently per wave in sibling worktrees (sequential = singleton waves), a per-wave merge gate with bounded repair, deterministic BLOCKED escalation and oscillation halt, then an Opus whole-branch final review. Returns task results + merges + plan-conflicts + final review.",
  phases: [
    { title: "Implement", detail: "per-task implementer (tiered), TDD + ponytail ladder" },
    { title: "Review", detail: "spec + quality + over-engineering lens, bounded fix loop" },
    { title: "Merge", detail: "per-wave integration: ordered merges, full suite, bounded repair" },
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
  // ADR adapter: adrPath is an alias for planPath — the file task-brief reads.
  // The `# Task N` planPath flow is unchanged; an ADR supplies its tasks via its
  // `### Task N` Decomposition section, read by the same task-brief script.
  const planPath = input.planPath || input.adrPath;
  if (typeof planPath !== "string" || !planPath) {
    throw new Error("args.planPath is required (or pass adrPath)");
  }
  for (const k of ["workdir", "pluginDir", "mergeBase"]) {
    if (typeof input[k] !== "string" || !input[k]) throw new Error(`args.${k} is required`);
  }
  if (!Array.isArray(input.tasks) || input.tasks.length === 0)
    throw new Error("args.tasks must be a non-empty array");
  const tasks = input.tasks.map((t, i) => {
    if (!Number.isInteger(t.n) || t.n <= 0) {
      throw new Error(`tasks[${i}].n must be a positive integer (got ${JSON.stringify(t.n)})`);
    }
    if (typeof t.title !== "string" || !t.title) throw new Error(`tasks[${i}].title is required`);
    return {
      n: t.n,
      title: t.title,
      tier: TIERS.includes(t.tier) ? t.tier : "sonnet",
      deps: Array.isArray(t.deps) ? t.deps : [],
    };
  });
  const seen = new Set();
  for (const t of tasks) {
    if (seen.has(t.n)) {
      // n names the branch (sdd/t{n}), the worktree (<workdir>-t{n}) and the report path —
      // two tasks sharing it would race on all three.
      throw new Error(`duplicate task number ${t.n}: task numbers must be unique`);
    }
    seen.add(t.n);
  }
  const li = input.limits || {};
  const limits = {
    fixRounds: Number.isInteger(li.fixRounds) ? li.fixRounds : 2,
    escalateAttempts: Number.isInteger(li.escalateAttempts) ? li.escalateAttempts : 2,
    maxParallel: Number.isInteger(li.maxParallel) && li.maxParallel >= 1 ? li.maxParallel : 4,
  };
  return {
    planPath, workdir: input.workdir, pluginDir: input.pluginDir,
    globalConstraints: typeof input.globalConstraints === "string" ? input.globalConstraints : "",
    successCriteria: typeof input.successCriteria === "string" ? input.successCriteria : "",
    mergeBase: input.mergeBase, tasks, limits,
    branchTip: typeof input.branchTip === "string" ? input.branchTip : "",
    setupCmd: typeof input.setupCmd === "string" ? input.setupCmd : "",
    testCmd: typeof input.testCmd === "string" ? input.testCmd : "",
  };
}

// Wave-0 dispatch base. mergeBase anchors the final-review diff range, not
// dispatch: the branch tip is usually ahead of it (spec/plan commits, earlier
// runs), and seeding worktrees from mergeBase checks out a stale tree.
function dispatchBase(cfg) {
  return cfg.branchTip || cfg.mergeBase;
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

// Topological levels from deps: wave 0 = no deps, else 1 + max(dep waves).
// sequenceTasks validates deps precede numerically, which guarantees a DAG.
function computeWaves(tasks) {
  const sorted = sequenceTasks(tasks);
  const waveOf = new Map();
  const waves = [];
  for (const t of sorted) {
    const w = t.deps.length ? 1 + Math.max(...t.deps.map((d) => waveOf.get(d))) : 0;
    waveOf.set(t.n, w);
    if (!waves[w]) waves[w] = [];
    waves[w].push(t);
  }
  return waves;
}

// Deterministic sibling-worktree path for task n (matches scripts/sdd-worktree).
function taskWorkdir(workdir, n) {
  return `${workdir.replace(/\/+$/, "")}-t${n}`;
}

// Run fn over items with at most `limit` in flight. Order-preserving; a
// thrown error becomes { poolError } in that slot so siblings always finish.
async function runPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        results[i] = { poolError: String((e && e.message) || e) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

// Split a wave's runTask results into merge candidates and failure entries.
function partitionWaveResults(wave, results) {
  const succeeded = [];
  const failures = [];
  wave.forEach((task, i) => {
    const r = results[i];
    if (r && r.task) succeeded.push(r.task);
    else if (r && r.halt) failures.push(r.halt);
    else failures.push({
      taskN: task.n,
      reason: (r && r.poolError) || "task agent returned no result",
      reportPath: "",
    });
  });
  return { succeeded, failures };
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

const MERGE_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["headSha", "merged", "conflictsResolved", "testSummary", "suite"],
  properties: {
    headSha: { type: "string" },
    merged: { type: "array", items: { type: "number" } },
    conflictsResolved: { type: "array", items: { type: "string" } },
    testSummary: { type: "string" },
    suite: { type: "string", enum: ["green", "red"] },
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
    criteria: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["criterion", "kind", "verdict"],
        properties: {
          criterion: { type: "string" },
          kind: { type: "string", enum: ["oracle", "checker"] },
          verdict: { type: "string", enum: ["met", "unmet", "cannot-verify"] },
          evidence: { type: "string" },
        },
      },
    },
    holistic: { type: "string" },
  },
};

if (typeof phase === "function") {
  const cfg = validateArgs(args);
  const order = sequenceTasks(cfg.tasks);
  const waves = computeWaves(order);
  const P = cfg.pluginDir;
  const gc = cfg.globalConstraints || "(none stated)";

  // Parallel-wave dispatches prepend worktree entry; sequential waves don't.
  const worktreePreamble = (task, base, wd) =>
    wd === cfg.workdir ? "" : `FIRST create/enter your task worktree: run ${P}/scripts/sdd-worktree ${cfg.workdir} ${base} ${task.n}
It prints your worktree path (${wd}); ALL work happens there, not in ${cfg.workdir}.${
      cfg.setupCmd ? `\nThen run the setup command (safe to re-run): ${cfg.setupCmd}` : ""
    }
`;

  const implPrompt = (task, tier, blocker, base, wd) =>
    `You are implementing Task ${task.n} ("${task.title}") of an approved plan. Work in ${wd}.
${worktreePreamble(task, base, wd)}Read your full operating instructions first: ${P}/prompts/implementer.md — follow them exactly.
Get your task brief by running: ${P}/scripts/task-brief -C ${wd} ${cfg.planPath} ${task.n}
Read the brief file it prints; implement THAT task only.
Global constraints that bind this task:\n${gc}
Write your full report to ${wd}/.sdd/task-${task.n}-report.md.${
      blocker ? `\nPRIOR ATTEMPT WAS BLOCKED: ${blocker}\nA ${tier} model is now assigned — resolve the blocker or report BLOCKED again with specifics.` : ""
    }
Return per schema: status, headSha (run \`git rev-parse HEAD\` after committing), testSummary, concerns, reportPath.`;

  const reviewPrompt = (task, base, head, wd) =>
    `You are reviewing Task ${task.n} ("${task.title}"). Work in ${wd}; READ-ONLY on the tree.
Read your full operating instructions first: ${P}/prompts/reviewer.md — follow them exactly.
Build the diff: ${P}/scripts/review-package -C ${wd} ${base} ${head}
Read the package file it prints. The implementer's report is at ${wd}/.sdd/task-${task.n}-report.md (treat as unverified claims).
Global constraints that bind this task:\n${gc}
Return per schema: spec ("pass"/"fail"), findings[{severity,class,file,line,what,planMandated}], cannotVerify[], quality, ponytail{net,items}.
Set planMandated=true for any finding the plan/brief explicitly mandates. "class" is a short stable label for the finding kind (used to detect oscillation).`;

  const fixPrompt = (task, findings, wd) =>
    `You are fixing review findings on Task ${task.n} ("${task.title}"). Work in ${wd}.
Read your full operating instructions first: ${P}/prompts/fixer.md — follow them exactly.
Fix ALL of these findings in one commit:\n${JSON.stringify(findings, null, 2)}
Re-run the tests covering each change; append the results to ${wd}/.sdd/task-${task.n}-report.md.
Return per schema: headSha (after committing), testSummary, fixed[].`;

  const mergePrompt = (w, waveBase, merged) =>
    `You are the wave-${w} MERGER. Work in ${cfg.workdir} (the integration worktree).
Read your full operating instructions first: ${P}/prompts/merger.md — follow them exactly.
Merge these task branches into the current branch in ascending task order:
${merged
      .map((t) => `- Task ${t.n}: branch sdd/t${t.n} at ${t.headSha}, worktree ${taskWorkdir(cfg.workdir, t.n)}, report ${taskWorkdir(cfg.workdir, t.n)}/.sdd/task-${t.n}-report.md`)
      .join("\n")}
Wave base was ${waveBase}.
${cfg.testCmd ? `Suite command: ${cfg.testCmd}` : "No suite command given — use the test commands named in the implementers' reports."}
Global constraints:\n${gc}
Return per schema: headSha, merged, conflictsResolved, testSummary, suite ("green"/"red").`;

  const finalPrompt = (mergeBase, head) =>
    `You are the whole-branch FINAL reviewer (most capable model). Work in ${cfg.workdir}; READ-ONLY.
Read your full operating instructions first: ${P}/prompts/final-reviewer.md — follow them exactly.
Build the branch diff: ${P}/scripts/review-package -C ${cfg.workdir} ${mergeBase} ${head}
Read the package. Also list any new \`ponytail:\` markers (grep the diff for 'ponytail:').
Global constraints:\n${gc}${
      cfg.successCriteria
        ? `\n\nADR SUCCESS CRITERIA — judge the branch against these (the done-oracle the human ratifies):\n${cfg.successCriteria}\nFor each: set kind ("oracle" if it names a test/CI/assertion, else "checker"); set verdict ("met"/"unmet"/"cannot-verify"). Judge "checker" criteria against the diff; for "oracle" criteria confirm the test/assertion is present and satisfied but do NOT re-run suites. Add any UNMET criterion to findings[] so it gets fixed. Then one holistic judgment in "holistic": do these changes add up to the stated intent? Return criteria[] and holistic.`
        : ""
    }
Return per schema: verdict ("approve"/"changes"), findings[{severity,file,line,what}], ponytailDebt[]${cfg.successCriteria ? ", criteria[], holistic" : ""}.`;

  const finalFixPrompt = (findings) =>
    `Fix ALL of these whole-branch review findings in one commit, in ${cfg.workdir}. Read ${P}/prompts/fixer.md and follow it.
Findings:\n${JSON.stringify(findings, null, 2)}
Re-run covering tests; return per schema: headSha, testSummary, fixed[].`;

  const results = [];
  const planConflicts = [];
  const merges = [];
  let halted = null;

  async function runTask(task, base, wd) {
    // Implement with the BLOCKED escalation ladder.
    let tier = task.tier, opusAttempts = 0, blocker = null, impl = null;
    while (true) {
      impl = await agent(implPrompt(task, tier, blocker, base, wd), {
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
      review = await agent(reviewPrompt(task, base, head, wd), {
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
      const fix = await agent(fixPrompt(task, actionable, wd), {
        label: `fix:t${task.n}.${rounds}`, phase: "Review", model: "sonnet", schema: FIX_SCHEMA,
      });
      if (!fix) return { halt: { taskN: task.n, reason: "fixer returned no result", reportPath: impl.reportPath } };
      head = fix.headSha || head;
    }
    return { task: { n: task.n, status: impl.status, headSha: head, reviewVerdict: review.spec, fixRounds: rounds } };
  }

  phase("Implement");
  let base = dispatchBase(cfg);

  for (let w = 0; w < waves.length && !halted; w++) {
    const wave = waves[w];

    if (wave.length === 1) {
      // Degenerate case: exactly the pre-wave behavior — shared workdir, no merge.
      const r = await runTask(wave[0], base, cfg.workdir);
      if (r.halt) { halted = { wave: w, reason: "task failure(s) in wave", failures: [r.halt] }; break; }
      results.push(r.task);
      base = r.task.headSha;
      continue;
    }

    const waveBase = base;
    const poolOut = await runPool(wave, cfg.limits.maxParallel, (task) =>
      runTask(task, waveBase, taskWorkdir(cfg.workdir, task.n)));
    const { succeeded, failures } = partitionWaveResults(wave, poolOut);

    if (succeeded.length) {
      const merge = await agent(mergePrompt(w, waveBase, succeeded), {
        label: `merge:w${w}`, phase: "Merge", model: "sonnet", schema: MERGE_SCHEMA,
      });
      if (!merge) {
        halted = { wave: w, reason: "merge agent returned no result", failures };
      } else {
        merges.push({ wave: w, merged: merge.merged, headSha: merge.headSha, testSummary: merge.testSummary });
        if (merge.suite === "red") {
          halted = { wave: w, reason: "merge gate red after repair", failures };
        } else {
          base = merge.headSha;
          succeeded.forEach((t) => results.push(t));
        }
      }
    }
    if (!halted && failures.length) {
      halted = { wave: w, reason: "task failure(s) in wave", failures };
    }
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

  log(halted
    ? `Halted in wave ${halted.wave}: ${halted.reason} (${halted.failures.length} failure(s))`
    : `Completed ${results.length}/${order.length} tasks across ${waves.length} wave(s)`);
  return {
    tasks: results, planConflicts, halted, finalReview,
    mergeBase: cfg.mergeBase, head: base, merges,
    ledgerPath: `${cfg.workdir}/.sdd/progress.md`,
    meta: { tasksCompleted: results.length, tasksTotal: order.length, waves: waves.length, planConflicts: planConflicts.length },
  };
}

