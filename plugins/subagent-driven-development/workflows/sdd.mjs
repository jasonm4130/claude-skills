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

// A closed vocabulary for finding classes. The oscillation breaker compares these labels across
// review rounds run by SEPARATE agents with no shared history — free text made that comparison
// unreliable in both directions: "missing-validation" vs "input-validation" hid a real loop, and two
// unrelated defects both called "test-quality" halted sound work.
const FINDING_CLASSES = [
  "correctness", "spec-gap", "test-gap", "error-handling",
  "security", "over-engineering", "duplication", "naming",
];

// Normalize a task id to its canonical string form, or null if it is not a
// usable id. Numbers must still be positive integers (so NaN, 0, -1 and 1.5 stay
// rejected) and SAFE ones: JSON.parse silently rounds 9007199254740993 to
// ...992, so an unsafe integer id would validate and then point task-brief at a
// heading the plan does not contain. Strings may be any alphanumeric run, which
// is exactly the character set that is safe in a git ref, a directory name and a
// file name, and short enough that "<workdir>-t<n>" stays under NAME_MAX (255 on
// this filesystem); ids beyond 2^53 can be passed as strings.
const MAX_TASK_ID_LEN = 64;
function taskId(n) {
  const s = typeof n === "number"
    ? (Number.isSafeInteger(n) && n > 0 ? String(n) : null)
    : (typeof n === "string" ? n : null);
  // The alphanumeric gate applies to numbers too: 1e21 is a positive integer that
  // stringifies to "1e+21", which is neither alphanumeric nor a heading any plan writes.
  return s !== null && s.length <= MAX_TASK_ID_LEN && /^[A-Za-z0-9]+$/.test(s) ? s : null;
}

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
    // n is an identity, not a position. A plan's ids are stable cross-document
    // references (an ADR cites "Task N3"), so renumbering them to satisfy this
    // loop throws away the thing the plan and its ADR use to refer to each
    // other. Accept any alphanumeric id; that keeps every downstream use safe —
    // it names the branch (sdd/t{n}), the worktree (<workdir>-t{n}), the report
    // path, and the task-brief argument, none of which need a number.
    const id = taskId(t.n);
    if (id === null) {
      throw new Error(
        `tasks[${i}].n must be a positive integer or an alphanumeric id of at most ` +
          `${MAX_TASK_ID_LEN} characters, such as "N2" (got ${JSON.stringify(t.n)})`,
      );
    }
    if (typeof t.title !== "string" || !t.title) throw new Error(`tasks[${i}].title is required`);
    return {
      n: id,
      title: t.title,
      tier: TIERS.includes(t.tier) ? t.tier : "opus",
      effort: EFFORTS.includes(t.effort) ? t.effort : "medium",
      deps: (Array.isArray(t.deps) ? t.deps : []).map((d) => String(d)),
    };
  });
  const seen = new Set();
  for (const t of tasks) {
    // Compared case-insensitively: n names the branch (sdd/t{n}), the worktree
    // (<workdir>-t{n}) and the report path, and on a case-insensitive filesystem —
    // the macOS default — "N2" and "n2" are the same directory and the same ref.
    // Two tasks sharing any of those would race on all three.
    const key = t.n.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`duplicate task id ${t.n}: task ids must be unique, ignoring case`);
    }
    seen.add(key);
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

// Topological sort over deps. Ordering used to be the numeric sort, with a check
// that deps preceded numerically — which conflated a task's identity with its
// position and rejected perfectly good DAGs whose execution order isn't
// monotonic in the ids (N3 -> 2 -> 3 -> 9A -> N2 is a real plan's order).
// Ties break on input order, so a plan already listed in execution order comes
// back in exactly that order. Errors only on an unknown dep or a real cycle.
function sequenceTasks(tasks) {
  const known = new Set(tasks.map((t) => String(t.n)));
  for (const t of tasks) {
    for (const d of t.deps || []) {
      if (!known.has(String(d))) {
        throw new Error(`task ${t.n} depends on ${d}, which is not a task in this plan`);
      }
    }
  }
  const pending = [...tasks];
  const done = new Set();
  /** @type {any[]} */
  const out = [];
  while (pending.length) {
    const i = pending.findIndex((t) => (t.deps || []).every((d) => done.has(String(d))));
    if (i === -1) {
      // Every remaining task is waiting on another remaining task.
      throw new Error(`dependency cycle among tasks: ${pending.map((t) => t.n).join(", ")}`);
    }
    const [t] = pending.splice(i, 1);
    done.add(String(t.n));
    out.push(t);
  }
  return out;
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

// The reviewer is never weaker than the implementer it checks. `taskTier` is the tier the
// implementer FINISHED at, so it can be "fable" — the escalation ladder's top rung, which is not in
// TIERS. Falling through to "sonnet" there would hand the run's hardest task to its weakest
// reviewer, so opus and fable each review at their own tier.
function reviewerModel(taskTier) {
  if (taskTier === "fable") return "fable";
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

// Dispatch an agent, normalizing BOTH failure shapes to null so every caller's clean-halt guard
// fires either way: a resolved null (the runtime's terminal-error return) AND a thrown rejection.
// A tier that cannot be dispatched at all — a withdrawn or repriced model, a transient API failure
// — can reject rather than resolve; an uncaught rejection escapes the `if (!x)` guard and takes the
// whole run with it, returning no halted state, no results and no merges for a run that cannot be
// resumed. `agentFn` is injected so this is unit-testable.
async function dispatchAgent(agentFn, prompt, opts) {
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
// sequenceTasks has already rejected unknown deps and cycles, so every dep's
// wave is known by the time it is read here.
function computeWaves(tasks) {
  const sorted = sequenceTasks(tasks);
  const waveOf = new Map();
  const waves = [];
  for (const t of sorted) {
    const w = t.deps.length ? 1 + Math.max(...t.deps.map((d) => waveOf.get(String(d)))) : 0;
    waveOf.set(String(t.n), w);
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
function partitionWaveResults(wave, results, waveBase = "") {
  const succeeded = [];
  const failures = [];
  wave.forEach((task, i) => {
    const r = results[i];
    if (r && r.task && waveBase && r.task.headSha === waveBase) {
      // A parallel task is only ever verified via the merge gate, where its sha being an
      // ancestor of the merge head is trivially true when it IS the base. This is the one
      // place the no-op is visible without another dispatch.
      failures.push({
        taskN: task.n,
        reason: "task head is still the wave base — the claimed work was never committed",
        reportPath: r.task.reportPath || "",
      });
    } else if (r && r.task) succeeded.push(r.task);
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

// Why a dirty tree blocks each caller. The halt reason is the only diagnostic a human gets, so it
// has to name the actual problem: the wave-0 seeding explanation is simply wrong for a singleton
// task (no worktrees exist), a merge gate (merging into a dirty tree) or the final gate.
const DIRTY_CONTEXT = {
  preflight: "wave worktrees are seeded from the committed tip and cannot see them",
  Implement: "the next wave is seeded from this commit and would not see them",
  Merge: "the next wave's merger merges into this tree and would sweep them in",
  Final: "the head this run returns must be exactly the code that was reviewed and verified",
};

// Decide from a reported `git status --porcelain` whether dispatch may proceed. Empty output
// (modulo whitespace) is the only clean state; a missing/unreported field is NOT clean, because
// "I could not tell" must never read as "fine". `context` explains why to whoever reads the halt.
function acceptPreflight(p, context = "uncommitted work must be committed or stashed first") {
  if (!p || typeof p.porcelain !== "string") {
    return { ok: false, reason: "preflight did not report git status output" };
  }
  const dirty = p.porcelain.split("\n").map((l) => l.trim()).filter(Boolean);
  if (dirty.length) {
    return { ok: false, reason: `workdir has ${dirty.length} uncommitted change(s) — ${context}: ${dirty.slice(0, 5).join("; ")}` };
  }
  return { ok: true, reason: "" };
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
function acceptVerification(v, testCmd, dirtyContext) {
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
  if (!Number.isInteger(v.commitCount) || v.commitCount < 0) {
    return no(`verifier reported no usable commit count (got ${JSON.stringify(v.commitCount)})`);
  }
  if (v.commitCount === 0) {
    return no(`head ${v.headSha} contains no commits from this step — the claimed work was never committed`);
  }
  // The tree the merge landed in must be clean: it can go dirty at any point after the wave-0
  // preflight, and the next wave's merger merges into whatever it finds. Same helper, same rule —
  // but the caller names why, since this runs for singleton tasks and the final gate too.
  const pre = acceptPreflight(v, dirtyContext);
  if (!pre.ok) return no(pre.reason);
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
          class: { type: "string", enum: FINDING_CLASSES }, file: { type: "string" }, line: { type: "string" },
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
    // Task ids, not positions — a plan may use "N3"/"9A" (see validateArgs).
    merged: { type: "array", items: { type: "string" } },
    conflictsResolved: { type: "array", items: { type: "string" } },
    testSummary: { type: "string" },
    suite: { type: "string", enum: ["green", "red"] },
  },
};

const PREFLIGHT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["porcelain", "clean"],
  properties: {
    // The raw output of `git status --porcelain`. The workflow decides from THIS, not from
    // `clean` — same reasoning as VERIFY_SCHEMA's two SHAs: a boolean is a value the agent
    // can simply set, and the whole point of the gate is not to take its word for it.
    porcelain: { type: "string" },
    clean: { type: "boolean" },
  },
};

const VERIFY_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["claimSha", "headSha", "baseContained", "missingCommits", "commitCount", "porcelain", "suite", "evidence"],
  properties: {
    // The two SHAs git actually printed. The workflow compares them itself — a boolean like
    // `headMatchesClaim` would just be another string the agent could set (Codex review, round 2).
    claimSha: { type: "string" },  // what `rev-parse --verify <claim>^{commit}` printed; "" on failure
    headSha: { type: "string" },   // what `rev-parse HEAD` printed
    baseContained: { type: "boolean" }, // is the pre-transition base an ancestor of HEAD?
    missingCommits: { type: "array", items: { type: "string" } }, // task ids, not positions
    // How many commits the claimed range actually contains. A task that reported HEAD
    // without committing produces 0 here and passes every other check in this schema:
    // its sha resolves, it is its own ancestor, and the suite is green because nothing
    // changed. This is the only field that can tell that apart from real work.
    commitCount: { type: "number" },
    // `git status --porcelain` in the integration tree. A merge into a dirty tree either
    // aborts or silently integrates uncommitted edits nobody reviewed, and the tree can
    // become dirty at any point after the wave-0 preflight.
    porcelain: { type: "string" },
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
        required: ["severity", "file", "line", "what", "planMandated"],
        properties: {
          severity: { type: "string", enum: ["Critical", "Important", "Minor"] },
          file: { type: "string" }, line: { type: "string" }, what: { type: "string" },
          planMandated: { type: "boolean" },
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
Read the package file it prints. You are NOT given the implementer's report: the diff and the brief
are the evidence, and a stated rationale is not one. Judge what the code does.
Global constraints that bind this task:\n${gc}
Return per schema: spec ("pass"/"fail"), findings[{severity,class,file,line,what,planMandated}], cannotVerify[], quality, ponytail{net,items}.
Set planMandated=true for any finding the plan/brief explicitly mandates.
"class" must be exactly one of: ${FINDING_CLASSES.join(", ")}. Pick the closest; it is compared across review rounds to detect a defect the fixer cannot land.`;

  const fixPrompt = (task, findings, wd) =>
    `You are fixing review findings on Task ${task.n} ("${task.title}"). Work in ${wd}.
Read your full operating instructions first: ${P}/prompts/fixer.md — follow them exactly.
Fix ALL of these findings in one commit:\n${JSON.stringify(findings, null, 2)}
Re-run the tests covering each change; append the results to ${wd}/.sdd/task-${task.n}-report.md.
Return per schema: headSha (after committing), testSummary, fixed[].`;

  const mergePrompt = (w, waveBase, merged) =>
    `You are the wave-${w} MERGER. Work in ${cfg.workdir} (the integration worktree).
Read your full operating instructions first: ${P}/prompts/merger.md — follow them exactly.
Merge these task branches into the current branch in the order listed:
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
    const v = await dispatchAgent(agent, verifyPrompt(claimedSha, claim, expectCommits, baseSha), {
      label, phase: phaseName, model: "sonnet", schema: VERIFY_SCHEMA,
    });
    return acceptVerification(v, cfg.testCmd, DIRTY_CONTEXT[phaseName]);
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
2. \`git -C ${cfg.workdir} status --porcelain\`
   Report its output verbatim as porcelain — "" if it printed nothing.
3. \`git -C ${cfg.workdir} rev-parse HEAD\`
   Report the full 40-character SHA it prints as headSha. Report what git printed — do not echo
   back the claimed SHA.
4. The branch must still BUILD ON where this run started — an agent that reset to some unrelated
   commit would otherwise pass every other check while discarding all earlier work:
   \`git -C ${cfg.workdir} merge-base --is-ancestor ${baseSha} HEAD\` (exit 0 = contained)
   Report baseContained=true only if that exits 0.
5. \`git -C ${cfg.workdir} rev-list --count ${baseSha}..${claimedSha}\`
   Report the integer it prints as commitCount. Report the number you saw — if the command
   fails or prints nothing, say so in evidence and report commitCount=0.
${expectCommits.length
  ? `6. Each of these task commits must be contained in HEAD. For each, run:
${expectCommits.map((c) => `   task ${c.n}: \`git -C ${cfg.workdir} merge-base --is-ancestor ${c.sha} HEAD\` (exit 0 = contained)`).join("\n")}
   Put the task id of every commit NOT contained in HEAD into missingCommits (as strings).
   (Check the commit SHAs, not sdd/t<N> branches — the merger deletes those branches.)`
  : `6. No task commits to check for this claim: missingCommits=[].`}
${cfg.testCmd
  ? `7. Run the suite VERBATIM from ${cfg.workdir}:
   \`${cfg.testCmd}\`
   Read its real output. suite="green" ONLY if it ran to completion with zero failures. Failures, a
   crash, or a command that would not run are all "red". Quote the real pass/fail summary line in
   evidence.`
  : `7. No test command was configured for this run: suite="unknown", and put the rev-parse output
   in evidence.`}

Never report a result you did not observe. A claim you could not confirm is not confirmed.`;

  const finalPrompt = (mergeBase, head, deferred) =>
    `You are the whole-branch FINAL reviewer (most capable model). Work in ${cfg.workdir}; READ-ONLY.
Read your full operating instructions first: ${P}/prompts/final-reviewer.md — follow them exactly.
Build the branch diff: ${P}/scripts/review-package -C ${cfg.workdir} ${mergeBase} ${head}
Read the package. Also list any new \`ponytail:\` markers (grep the diff for 'ponytail:').
Global constraints:\n${gc}${
      cfg.successCriteria
        ? `\n\nADR SUCCESS CRITERIA — judge the branch against these (the done-oracle the human ratifies):\n${cfg.successCriteria}\nFor each: set kind ("oracle" if it names a test/CI/assertion, else "checker"); set verdict ("met"/"unmet"/"cannot-verify"). Judge "checker" criteria against the diff; for "oracle" criteria confirm the test/assertion is present and satisfied but do NOT re-run suites. Add any UNMET criterion to findings[] so it gets fixed. Then one holistic judgment in "holistic": do these changes add up to the stated intent? Return criteria[] and holistic.`
        : ""
    }
Set planMandated=true for any finding the plan or an ADR explicitly mandates — those go to a human to
adjudicate and are NEVER auto-fixed.${deferred.minors.length || deferred.cannotVerify.length
  ? `\nDEFERRED FROM PER-TASK REVIEW — triage these against the whole branch. A Minor that recurs across tasks is not minor; a "could not verify" that is still unverified at branch level is a finding.\nMinors:\n${JSON.stringify(deferred.minors, null, 2)}\nCould not verify:\n${JSON.stringify(deferred.cannotVerify, null, 2)}`
  : "\nNo per-task reviews deferred anything: there are no rolled-up Minors and nothing was reported unverifiable."}
Return per schema: verdict ("approve"/"changes"), findings[{severity,file,line,what,planMandated}], ponytailDebt[]${cfg.successCriteria ? ", criteria[], holistic" : ""}.`;

  const finalFixPrompt = (findings) =>
    `Fix ALL of these whole-branch review findings in one commit, in ${cfg.workdir}. Read ${P}/prompts/fixer.md and follow it.
Findings:\n${JSON.stringify(findings, null, 2)}
Re-run covering tests; return per schema: headSha, testSummary, fixed[].`;

  const results = [];
  const planConflicts = [];
  /** @type {any[]} */
  const deferredMinors = [];
  /** @type {any[]} */
  const deferredCannotVerify = [];
  // One object over the two arrays: it holds references, so it reflects every push. Both
  // finalPrompt call sites and the return value hand out the same thing.
  const deferred = { minors: deferredMinors, cannotVerify: deferredCannotVerify };
  const merges = [];
  let halted = null;

  async function runTask(task, base, wd) {
    // Implement with the BLOCKED escalation ladder.
    let tier = task.tier, effort = task.effort, attemptsAtTier = 0, blocker = null, impl = null;
    while (true) {
      attemptsAtTier++;
      impl = await dispatchAgent(agent, implPrompt(task, tier, blocker, base, wd), {
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
    /** @type {string[][]} */
    const postFixClasses = [];
    while (true) {
      review = await dispatchAgent(agent, reviewPrompt(task, base, head, wd), {
        label: `review:t${task.n}`, phase: "Review",
        // The tier the implementer FINISHED at, not the one the controller guessed: a task that
        // escalated to opus/high must not be checked by a reviewer picked for its original sonnet.
        model: reviewerModel(tier), effort: reviewerEffort(effort), schema: REVIEW_SCHEMA,
      });
      if (!review) return { halt: { taskN: task.n, reason: "reviewer returned no result", reportPath: impl.reportPath } };
      (review.findings || []).filter((f) => f.planMandated).forEach((c) => planConflicts.push({ taskN: task.n, ...c }));
      const actionable = (review.findings || []).filter((f) => !f.planMandated && (f.severity === "Critical" || f.severity === "Important"));
      // Only rounds that follow a fix attempt count: the first review is the baseline, and a class
      // present in it has not yet survived anything.
      if (rounds > 0) postFixClasses.push(actionable.map((f) => f.class));
      if (review.spec === "pass" && actionable.length === 0) break;
      if (rounds >= cfg.limits.fixRounds || detectOscillation(postFixClasses)) {
        return { halt: { taskN: task.n, reason: "review did not converge (cap or oscillation)", reportPath: impl.reportPath } };
      }
      rounds++;
      const fix = await dispatchAgent(agent, fixPrompt(task, actionable, wd), {
        label: `fix:t${task.n}.${rounds}`, phase: "Fix", model: "opus", effort: "medium", schema: FIX_SCHEMA,
      });
      if (!fix) return { halt: { taskN: task.n, reason: "fixer returned no result", reportPath: impl.reportPath } };
      head = fix.headSha || head;
    }
    // The loop's LAST review is the one that describes the code being returned; earlier rounds
    // describe code that has since been fixed. Recording every round would double-count a Minor
    // that survived a fix and make one task look like a cross-task pattern.
    (review.findings || []).filter((f) => !f.planMandated && f.severity === "Minor")
      .forEach((f) => deferredMinors.push({ taskN: task.n, ...f }));
    (review.cannotVerify || []).forEach((w) => deferredCannotVerify.push({ taskN: task.n, what: w }));
    return { task: {
      n: task.n, status: impl.status, headSha: head,
      reviewVerdict: review.spec, fixRounds: rounds,
      concerns: impl.concerns || "", reportPath: impl.reportPath || "",
    } };
  }

  phase("Implement");
  let base = dispatchBase(cfg);

  // Wave worktrees are seeded from the committed tip, so uncommitted changes in the integration
  // workdir are invisible to every implementer — and then the wave merger merges into that dirty
  // tree. sdd.mjs has no child_process, so this is a dispatched observation the workflow gates on,
  // exactly as runVerify does for SHAs. A prose precondition in SKILL.md does not bind a direct
  // Workflow(...) invocation, which bypasses the controller entirely.
  const pre = await dispatchAgent(agent, `You are a PREFLIGHT checker. Do not fix anything, do not commit, do not write or edit any file.
Run exactly this and report what it actually prints:
  \`git -C ${cfg.workdir} status --porcelain\`
Report the output verbatim as porcelain ("" if it printed nothing), and set clean accordingly.
Never report a result you did not observe.`, {
    label: "preflight:workdir", phase: "Implement", model: "sonnet", effort: "low", schema: PREFLIGHT_SCHEMA,
  });
  const preOk = acceptPreflight(pre, DIRTY_CONTEXT.preflight);
  if (!preOk.ok) {
    halted = { wave: "preflight", reason: preOk.reason, failures: [] };
  }

  for (let w = 0; w < waves.length && !halted; w++) {
    const wave = waves[w];

    if (wave.length === 1) {
      // Degenerate case: shared workdir, no merge — but the implementer's claimed head still has to
      // be checked, or a linear plan (all singleton waves) advances entirely on unverified claims.
      // runTask returns { task } or { halt } and can still reject from code outside a dispatch; a
      // singleton wave has no runPool to catch that, and an escaped rejection returns nothing at all.
      const r = await runTask(wave[0], base, cfg.workdir).catch((e) => ({
        halt: { taskN: wave[0].n, reason: `task dispatch failed: ${e && e.message ? e.message : e}`, reportPath: "" },
      }));
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
    const { succeeded, failures } = partitionWaveResults(wave, poolOut, waveBase);

    if (succeeded.length) {
      const merge = await dispatchAgent(agent, mergePrompt(w, waveBase, succeeded), {
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
    finalReview = await dispatchAgent(agent, finalPrompt(cfg.mergeBase, base, deferred), {
      label: "final-review", phase: "Final", model: "opus", effort: "high", schema: FINAL_SCHEMA,
    });
    const allFindings = finalReview ? (finalReview.findings || []) : [];
    allFindings.filter((f) => f.planMandated).forEach((c) => planConflicts.push({ taskN: "final", ...c }));
    // Severity, not count: an "approve" carrying one Minor nit used to fire an Opus fixer plus an
    // Opus re-review — the most expensive tail in the run, spent on a nit.
    const findings = allFindings.filter((f) => !f.planMandated && (f.severity === "Critical" || f.severity === "Important"));
    if (!finalReview) {
      // "The final review did not run" is not "the branch is fine".
      halted = { wave: "final", reason: "final review returned no result", failures: [] };
    } else if (finalReview.verdict === "changes" && !allFindings.length) {
      // The reviewer's contract (prompts/final-reviewer.md) is that "changes" means findings must be
      // addressed. "changes" with nothing to act on is a broken report, not an approval.
      halted = { wave: "final", reason: "final review returned verdict 'changes' with no findings to act on", failures: [] };
    } else if (findings.length) {
      const fix = await dispatchAgent(agent, finalFixPrompt(findings), {
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
          const postFix = await dispatchAgent(agent, finalPrompt(cfg.mergeBase, base, deferred), {
            label: "final-review-2", phase: "Final", model: "opus", effort: "high", schema: FINAL_SCHEMA,
          });
          if (!postFix) {
            // The fix is committed and verified green, but nothing has reviewed the head we are
            // about to return. "The re-review did not run" is not "the branch is fine".
            halted = { wave: "final", reason: "post-fix review returned no result — the returned head is unreviewed", failures: [] };
          }
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
    deferred,
    mergeBase: cfg.mergeBase, head: base, merges,
    meta: {
      tasksCompleted: results.length, tasksTotal: order.length, waves: waves.length,
      planConflicts: planConflicts.length,
      finalFixApplied: Boolean(finalFix),
      finalVerdict: finalReview ? finalReview.verdict : null,
      // A "changes" verdict carrying only Minor findings runs no fixer (severity gating, on purpose)
      // and no halt — without this flag the run would report as complete while the reviewer's
      // explicit "do not merge yet" survived only inside finalReview.verdict, which nothing reads.
      finalChangesUnaddressed: Boolean(finalReview && finalReview.verdict === "changes" && !finalFix),
    },
  };
}

