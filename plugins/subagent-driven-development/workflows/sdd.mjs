// @ts-check
// Subagent-driven development loop. Self-contained Workflow script (sealed
// sandbox: no imports, no fs, no Date.now/Math.random; body wrapped in a fn).
// Pure helpers live between the PURE markers so sdd.test.mjs can extract them.
export const meta = {
  name: "subagent-driven-development",
  description:
    "Args-driven SDD loop: deps-driven waves — per-task implement -> review (spec + quality + ponytail) -> bounded fix loop run concurrently per wave in sibling worktrees (sequential = singleton waves), a per-wave merge gate with bounded repair, deterministic BLOCKED escalation and oscillation halt, then an Opus whole-branch final review. Returns task results + merges + plan-conflicts + final review.",
  phases: [
    { title: "Implement", detail: "per-task implementer (tiered), TDD + ponytail ladder; claimed head verified" },
    { title: "Review", detail: "spec + quality + over-engineering lens" },
    { title: "Fix", detail: "bounded per-task repair — the round count is a plan-quality signal, so it gets its own box" },
    { title: "Merge", detail: "per-wave integration: ordered merges, full suite, bounded repair" },
    { title: "Final", detail: "whole-branch review on Opus, then one bounded fix + re-review", model: "opus" },
  ],
};

// >>> PURE
const TIERS = ["haiku", "sonnet", "opus"];
// Effort is the cost/latency lever on Opus 5; model downgrade was the lever before it
// existed. Anthropic names `low` as the fit for subagents specifically.
const EFFORTS = ["low", "medium", "high"];

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
      tier: TIERS.includes(t.tier) ? t.tier : "opus",
      effort: EFFORTS.includes(t.effort) ? t.effort : "medium",
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
    // Fable is an opt-in top escalation rung above Opus. Default on; flip to false to make the
    // ladder halt at Opus (e.g. if Fable is withdrawn, breaks, or its premium cost isn't wanted).
    fableEscalation: typeof li.fableEscalation === "boolean" ? li.fableEscalation : true,
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

function nextEffort(effort) {
  const i = EFFORTS.indexOf(effort);
  if (i < 0) return "medium";
  return i >= EFFORTS.length - 1 ? null : EFFORTS[i + 1];
}

function reviewerModel(taskTier) {
  return taskTier === "opus" ? "opus" : "sonnet";
}

// Reviewers sit a notch above the implementer they check: spotting a defect is judgment,
// and it is the stage where low effort costs the whole run.
function reviewerEffort(taskEffort) {
  return taskEffort === "high" ? "high" : "medium";
}

// Extra attempts are spent only at the top of the effort ladder, so total tries per task
// stay comparable to the old haiku->sonnet->opus->fable shape (5).
function maxAttemptsAtTier(tier, effort, limits) {
  return tier === "opus" && effort === "high" ? Math.max(1, limits.escalateAttempts) : 1;
}

// After the implementer reports BLOCKED at `tier` (having now blocked `attemptsAtTier` times at it),
// decide the ladder's next move: { action: "retry" } (same tier), { action: "escalate", tier }
// (step up), or { action: "halt" } (give up for a human). The base ladder is haiku→sonnet→opus, with
// Fable as an opt-in top rung reached ONLY from an exhausted Opus and tried ONCE. Fable is a paid
// premium tier that may be withdrawn or repriced, so it is gated on limits.fableEscalation: with that
// off, the ladder halts at Opus exactly as before. A Fable dispatch that fails outright still degrades
// safely — runTask's `if (!impl)` guard turns a null result into a clean halt, never a crash or a
// silent drop back to a lower tier.
function escalationStep(tier, effort, attemptsAtTier, limits) {
  if (attemptsAtTier < maxAttemptsAtTier(tier, effort, limits)) return { action: "retry" };
  if (tier === "fable") return { action: "halt" };
  if (tier === "opus") {
    const upEffort = nextEffort(effort);
    if (upEffort) return { action: "escalate", tier: "opus", effort: upEffort };
    if (limits.fableEscalation) return { action: "escalate", tier: "fable", effort: "high" };
    return { action: "halt" };
  }
  const up = nextTier(tier);
  return up === null ? { action: "halt" } : { action: "escalate", tier: up, effort };
}

// Dispatch the implementer, normalizing BOTH failure shapes to null so runTask's clean-halt guard
// fires either way: a resolved null (the runtime's terminal-error return) AND a thrown rejection. A
// tier that cannot be dispatched at all — e.g. a withdrawn or repriced Fable — can reject rather than
// resolve; without this catch that rejection escapes the `if (!impl)` guard and crashes the wave
// instead of returning the workflow's halted state. `agentFn` is injected so this is unit-testable.
async function dispatchImpl(agentFn, prompt, opts) {
  try {
    return await agentFn(prompt, opts);
  } catch {
    return null;
  }
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

function isSha(s) {
  return typeof s === "string" && /^[0-9a-f]{40}$/.test(s);
}

// Gate for interpolating an agent-supplied sha into a shell command the verifier will RUN.
// Hex-only, so it cannot carry a shell metacharacter; 7-40 chars, so an implementer reporting a
// short sha is not spuriously halted. Anything else fails closed without dispatching an agent.
function isShaish(s) {
  return typeof s === "string" && /^[0-9a-f]{7,40}$/.test(s);
}

/**
 * Decide whether a verifier's observation supports an agent's claim.
 *
 * An INDEPENDENT CHECK, not proof: sdd.mjs runs in a sandbox with no child_process, so the
 * verifier is another agent and its report is another claim. What it buys is a fresh, read-only
 * agent with no stake in the outcome, plus structural requirements a lazy report cannot satisfy by
 * accident. The controller's post-run re-run of git and the suite is the gate that actually holds.
 *
 * We compare the two SHAs the verifier says git printed — never a boolean it could simply set.
 */
function acceptVerification(v, testCmd) {
  const no = (reason) => ({ ok: false, reason, headSha: "" });
  if (!v) return no("verifier returned no result");
  if (!isSha(v.claimSha)) return no("the claimed head did not resolve to a commit");
  // Never fall back to the claimed sha: it is the value we do not trust.
  if (!isSha(v.headSha)) return no(`verifier reported no resolved branch head (got ${JSON.stringify(v.headSha)})`);
  if (v.claimSha !== v.headSha) return no(`claimed commit ${v.claimSha} is not the branch head ${v.headSha}`);
  // Continuity: a head that does not descend from the base we started at has discarded earlier work,
  // however green it is.
  if (v.baseContained !== true) return no(`head ${v.headSha} does not build on the base this run started from`);
  const missing = Array.isArray(v.missingCommits) ? v.missingCommits : [];
  if (missing.length) return no(`head ${v.headSha} does not contain task(s) ${missing.join(", ")}`);
  if (testCmd && v.suite !== "green") return no(`suite is ${v.suite} at ${v.headSha}`);
  return { ok: true, reason: "", headSha: v.headSha };
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

const VERIFY_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["claimSha", "headSha", "baseContained", "missingCommits", "suite", "evidence"],
  properties: {
    // The two SHAs git actually printed. The workflow compares them itself — a boolean like
    // `headMatchesClaim` would just be another string the agent could set (Codex review, round 2).
    claimSha: { type: "string" },  // what `rev-parse --verify <claim>^{commit}` printed; "" on failure
    headSha: { type: "string" },   // what `rev-parse HEAD` printed
    baseContained: { type: "boolean" }, // is the pre-transition base an ancestor of HEAD?
    missingCommits: { type: "array", items: { type: "number" } },
    suite: { type: "string", enum: ["green", "red", "unknown"] },
    evidence: { type: "string" },
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

  // Single entry point for every verification, so the injection guard cannot be forgotten at one
  // call site. Fails closed WITHOUT dispatching an agent when a sha is malformed — these strings
  // come from other agents and are interpolated into shell commands the verifier runs.
  // `phase` is passed IN, not inferred. It used to be derived as
  //   label === "verify:final-fix" ? "Final" : "Merge"
  // — a string match on the agent's own label standing in for a fact the caller already knows. It also
  // mis-grouped the singleton-wave verifier (`verify:t1`) under "Merge", where nothing was merged.
  const runVerify = async (claimedSha, claim, expectCommits, label, baseSha, phaseName) => {
    if (!isShaish(claimedSha)) {
      return { ok: false, reason: `claimed head is not a sha: ${JSON.stringify(claimedSha)}`, headSha: "" };
    }
    if (!isShaish(baseSha)) {
      return { ok: false, reason: `base is not a sha: ${JSON.stringify(baseSha)}`, headSha: "" };
    }
    const bad = expectCommits.find((c) => !isShaish(c.sha));
    if (bad) {
      return { ok: false, reason: `task ${bad.n} reported a head that is not a sha: ${JSON.stringify(bad.sha)}`, headSha: "" };
    }
    const v = await agent(verifyPrompt(claimedSha, claim, expectCommits, baseSha), {
      label, phase: phaseName, model: "sonnet", schema: VERIFY_SCHEMA,
    });
    return acceptVerification(v, cfg.testCmd);
  };

  const verifyPrompt = (claimedSha, claim, expectCommits = [], baseSha = "") => `You are a VERIFIER. Do not fix
anything, do not commit, do not write or edit any file. Observe, then report only what you saw.

Working directory: ${cfg.workdir}

Another agent claims: ${claim}
Claimed head SHA: ${claimedSha}

Run exactly these and report what they actually print:

1. \`git -C ${cfg.workdir} rev-parse --verify ${claimedSha}^{commit}\`
   Report the full 40-character SHA it prints as claimSha. If it fails, claimSha="", put the error
   text in evidence, and stop.
2. \`git -C ${cfg.workdir} rev-parse HEAD\`
   Report the full 40-character SHA it prints as headSha. Report what git printed — do not echo
   back the claimed SHA.
3. The branch must still BUILD ON where this run started — an agent that reset to some unrelated
   commit would otherwise pass every other check while discarding all earlier work:
   \`git -C ${cfg.workdir} merge-base --is-ancestor ${baseSha} HEAD\` (exit 0 = contained)
   Report baseContained=true only if that exits 0.
${expectCommits.length
  ? `4. Each of these task commits must be contained in HEAD. For each, run:
${expectCommits.map((c) => `   task ${c.n}: \`git -C ${cfg.workdir} merge-base --is-ancestor ${c.sha} HEAD\` (exit 0 = contained)`).join("\n")}
   Put the task number of every commit NOT contained in HEAD into missingCommits.
   (Check the commit SHAs, not sdd/t<N> branches — the merger deletes those branches.)`
  : `4. No task commits to check for this claim: missingCommits=[].`}
${cfg.testCmd
  ? `5. Run the suite VERBATIM from ${cfg.workdir}:
   \`${cfg.testCmd}\`
   Read its real output. suite="green" ONLY if it ran to completion with zero failures. Failures, a
   crash, or a command that would not run are all "red". Quote the real pass/fail summary line in
   evidence.`
  : `5. No test command was configured for this run: suite="unknown", and put the rev-parse output
   in evidence.`}

Never report a result you did not observe. A claim you could not confirm is not confirmed.`;

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
    let tier = task.tier, effort = task.effort, attemptsAtTier = 0, blocker = null, impl = null;
    while (true) {
      attemptsAtTier++;
      impl = await dispatchImpl(agent, implPrompt(task, tier, blocker, base, wd), {
        label: `impl:t${task.n}`, phase: "Implement", model: tier, effort, schema: IMPL_SCHEMA,
      });
      if (!impl) return { halt: { taskN: task.n, reason: "implementer returned no result", reportPath: "" } };
      if (impl.status === "DONE" || impl.status === "DONE_WITH_CONCERNS") break;
      blocker = impl.concerns || impl.status;
      const step = escalationStep(tier, effort, attemptsAtTier, cfg.limits);
      if (step.action === "halt") {
        return { halt: { taskN: task.n, reason: `blocked after escalation: ${blocker}`, reportPath: impl.reportPath } };
      }
      if (step.action === "escalate") { tier = step.tier; effort = step.effort; attemptsAtTier = 0; }
    }

    // Review + bounded fix loop.
    let head = impl.headSha, rounds = 0, review = null;
    const roundClasses = [];
    while (true) {
      review = await agent(reviewPrompt(task, base, head, wd), {
        label: `review:t${task.n}`, phase: "Review", model: reviewerModel(task.tier), effort: reviewerEffort(task.effort), schema: REVIEW_SCHEMA,
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
        label: `fix:t${task.n}.${rounds}`, phase: "Fix", model: "opus", effort: "medium", schema: FIX_SCHEMA,
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
      // Degenerate case: shared workdir, no merge — but the implementer's claimed head still has to
      // be checked, or a linear plan (all singleton waves) advances entirely on unverified claims.
      const r = await runTask(wave[0], base, cfg.workdir);
      if (r.halt) { halted = { wave: w, reason: "task failure(s) in wave", failures: [r.halt] }; break; }
      const acc = await runVerify(
        r.task.headSha,
        `task ${wave[0].n} is complete and its commit is the branch head`,
        [],
        `verify:t${wave[0].n}`,
        base, // continuity: the task's head must descend from where this wave started
        "Implement", // a singleton wave never merges; this checks the implementer's claim
      );
      if (!acc.ok) {
        halted = { wave: w, reason: `task ${wave[0].n} unverified: ${acc.reason}`, failures: [] };
        break;
      }
      results.push(r.task);
      base = acc.headSha;
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
        // The workflow's own record of what succeeded — a merger that omits a task from `merged`
        // must not shrink what gets checked. partitionWaveResults pushes `r.task`, so these ARE the
        // task objects ({ n, status, headSha, ... }) — not { task } wrappers (Codex review, round 3).
        const expect = succeeded.map((t) => ({ n: t.n, sha: t.headSha }));
        const acc = await runVerify(
          merge.headSha,
          `wave ${w} merged task(s) ${expect.map((e) => e.n).join(", ")} and left the suite ${merge.suite}`,
          expect,
          `verify:w${w}`,
          waveBase, // continuity: the merge must build on the base this wave was dispatched from
          "Merge",
        );
        merges.push({
          wave: w, merged: merge.merged,
          headSha: acc.ok ? acc.headSha : merge.headSha,
          testSummary: merge.testSummary,
          verified: acc.ok,
          reason: acc.reason,
        });
        if (merge.suite === "red") {
          halted = { wave: w, reason: "merge gate red after repair", failures };
        } else if (!acc.ok) {
          // The merger claimed green; an independent check could not confirm it. Do not let an
          // unverified base poison every wave after this one.
          halted = { wave: w, reason: `merge gate unverified: ${acc.reason}`, failures };
        } else {
          base = acc.headSha;
          succeeded.forEach((t) => results.push(t));
        }
      }
    }
    if (!halted && failures.length) {
      halted = { wave: w, reason: "task failure(s) in wave", failures };
    }
  }

  let finalReview = null;
  let finalFix = null;
  if (!halted && results.length) {
    phase("Final");
    finalReview = await agent(finalPrompt(cfg.mergeBase, base), {
      label: "final-review", phase: "Final", model: "opus", effort: "high", schema: FINAL_SCHEMA,
    });
    const findings = finalReview ? (finalReview.findings || []) : [];
    if (!finalReview) {
      // "The final review did not run" is not "the branch is fine".
      halted = { wave: "final", reason: "final review returned no result", failures: [] };
    } else if (finalReview.verdict === "changes" && !findings.length) {
      // The reviewer's contract (prompts/final-reviewer.md) is that "changes" means findings must be
      // addressed. "changes" with nothing to act on is a broken report, not an approval.
      halted = { wave: "final", reason: "final review returned verdict 'changes' with no findings to act on", failures: [] };
    } else if (findings.length) {
      const fix = await agent(finalFixPrompt(findings), {
        label: "final-fix", phase: "Final", model: "opus", effort: "medium", schema: FIX_SCHEMA,
      });
      if (!fix) {
        halted = { wave: "final", reason: "final fixer returned no result", failures: [] };
      } else {
        // Bounded on purpose: check once, do NOT re-run the whole-branch review — that turns a
        // one-shot fix into an unbounded review -> fix -> review loop.
        const acc = await runVerify(
          fix.headSha,
          `the final fixer addressed ${findings.length} finding(s) and left the suite: ${fix.testSummary}`,
          [],
          "verify:final-fix",
          base, // continuity: the fix must build on the reviewed head, not replace it
          "Final", // the final fix is one bounded step of the whole-branch gate, not the per-task loop
        );
        if (!acc.ok) {
          halted = { wave: "final", reason: `final fix unverified: ${acc.reason}`, failures: [] };
        } else {
          // head must point PAST the fix — the old code left it at the pre-fix commit.
          base = acc.headSha;
          // finalReview described the PRE-fix head. Review the post-fix head once, report-only: the
          // returned head must not be unreviewed. Report-only keeps it bounded — findings here go to
          // the controller to adjudicate, they do NOT trigger another fix (that is the unbounded loop).
          const postFix = await agent(finalPrompt(cfg.mergeBase, base), {
            label: "final-review-2", phase: "Final", model: "opus", effort: "high", schema: FINAL_SCHEMA,
          });
          finalFix = {
            headSha: acc.headSha, fixed: fix.fixed, testSummary: fix.testSummary, verified: true,
            postFixReview: postFix || null,
            postFixFindings: postFix ? (postFix.findings || []) : [],
          };
        }
      }
    }
  }

  log(halted
    ? `Halted in wave ${halted.wave}: ${halted.reason} (${halted.failures.length} failure(s))`
    : `Completed ${results.length}/${order.length} tasks across ${waves.length} wave(s)`);
  return {
    tasks: results, planConflicts, halted, finalReview, finalFix,
    mergeBase: cfg.mergeBase, head: base, merges,
    meta: {
      tasksCompleted: results.length, tasksTotal: order.length, waves: waves.length,
      planConflicts: planConflicts.length,
      finalFixApplied: Boolean(finalFix),
    },
  };
}

