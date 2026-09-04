// @ts-check
// Landing loop: the outer loop that lands an approved plan unattended. Self-contained
// Workflow script (sealed sandbox: no imports, no fs, no Date.now/Math.random). One task
// at a time, in plan order: branch from fresh main → subagent-driven-development's
// workflow as a child for the inner loop → local check → push + PR → the repo's merge
// command as the CI gate, with one bounded fix on red → ledger. Pure helpers live between
// the PURE markers so land.test.mjs can extract them.
export const meta = {
  name: "landing-loop",
  description:
    "Lands each task of an approved plan as its own pull request: SDD inner loop per task, local check, push, PR, the repo's merge command as the CI gate with one bounded fix on red, ledger row. Halts on two consecutive blocked tasks or an infrastructure failure. Returns landed / blocked / skipped / halted.",
  phases: [
    { title: "Orient", detail: "fresh main, reconcile status from existing PRs, branch for the task" },
    { title: "Implement", detail: "subagent-driven-development workflow, one task, as a child run" },
    { title: "Verify", detail: "head is HEAD, tree clean, check command green; optional skeptic panel" },
    { title: "Ship", detail: "ledger row committed, branch pushed, pull request opened" },
    { title: "Gate", detail: "repo merge command waits for CI and merges; one bounded fix on a red check" },
  ],
};

// >>> PURE
const STATUSES = ["todo", "shipped", "landed", "blocked", "skipped"];
const MAX_TASK_ID_LEN = 64;

function taskId(n) {
  const s = typeof n === "number"
    ? (Number.isSafeInteger(n) && n > 0 ? String(n) : null)
    : (typeof n === "string" ? n : null);
  return s !== null && s.length <= MAX_TASK_ID_LEN && /^[A-Za-z0-9]+$/.test(s) ? s : null;
}

function isShaish(s) {
  return typeof s === "string" && /^[0-9a-f]{7,40}$/i.test(s);
}

function validateArgs(input) {
  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch { throw new Error("args string is not valid JSON"); }
  }
  if (!input || typeof input !== "object") throw new Error("args must be an object");
  for (const k of ["planPath", "workdir", "slug", "checkCmd", "mergeCmd", "sddPath", "sddPluginDir"]) {
    if (typeof input[k] !== "string" || !input[k]) throw new Error(`args.${k} is required`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(input.slug)) throw new Error("args.slug must be lowercase letters, digits and hyphens");
  if (!input.mergeCmd.includes("{pr}")) throw new Error("args.mergeCmd must contain {pr}, e.g. \"./merge-pr.sh {pr}\"");
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) throw new Error("args.tasks must be a non-empty array");
  const tasks = input.tasks.map((t, i) => {
    const n = taskId(t && t.n);
    if (!n) throw new Error(`tasks[${i}].n must be a positive integer or alphanumeric id`);
    if (typeof t.title !== "string" || !t.title) throw new Error(`tasks[${i}].title is required`);
    const deps = (t.deps || []).map((d) => {
      const id = taskId(d);
      if (!id) throw new Error(`tasks[${i}].deps contains an invalid id`);
      return id;
    });
    return {
      n, title: t.title,
      tier: t.tier || "opus",
      effort: ["low", "medium", "high"].includes(t.effort) ? t.effort : "medium",
      deps,
    };
  });
  const seen = new Set();
  for (const t of tasks) {
    if (seen.has(t.n)) throw new Error(`duplicate task id ${t.n}`);
    seen.add(t.n);
  }
  const li = input.limits || {};
  const limits = {
    fixRounds: Number.isInteger(li.fixRounds) && li.fixRounds >= 0 ? li.fixRounds : 1,
    skeptics: Number.isInteger(li.skeptics) && li.skeptics >= 0 ? li.skeptics : 0,
    maxTasks: Number.isInteger(li.maxTasks) && li.maxTasks > 0 ? li.maxTasks : 0,
    consecutiveBlocked: Number.isInteger(li.consecutiveBlocked) && li.consecutiveBlocked > 0 ? li.consecutiveBlocked : 2,
    sddFableEscalation: Boolean(li.sddFableEscalation),
  };
  return {
    planPath: input.planPath, workdir: input.workdir, slug: input.slug,
    checkCmd: input.checkCmd, mergeCmd: input.mergeCmd,
    sddPath: input.sddPath, sddPluginDir: input.sddPluginDir,
    globalConstraints: typeof input.globalConstraints === "string" ? input.globalConstraints : "",
    setupCmd: typeof input.setupCmd === "string" ? input.setupCmd : "",
    sessionLink: typeof input.sessionLink === "string" ? input.sessionLink : "",
    ledgerPath: typeof input.ledgerPath === "string" && input.ledgerPath
      ? input.ledgerPath
      : input.planPath.replace(/\.md$/, "") + ".ledger.md",
    tasks, limits,
  };
}

// Topological order, ties broken on list order. Throws on an unknown dep or a cycle.
function sequenceTasks(tasks) {
  const known = new Set(tasks.map((t) => t.n));
  for (const t of tasks) for (const d of t.deps) {
    if (!known.has(d)) throw new Error(`task ${t.n} depends on unknown task ${d}`);
  }
  const pending = [...tasks];
  const done = new Set();
  const out = [];
  while (pending.length) {
    const i = pending.findIndex((t) => t.deps.every((d) => done.has(d)));
    if (i < 0) throw new Error(`dependency cycle among tasks ${pending.map((t) => t.n).join(", ")}`);
    const [t] = pending.splice(i, 1);
    done.add(t.n);
    out.push(t);
  }
  return out;
}

function branchName(slug, n) {
  return `land/${slug}-t${n}`;
}

// Status from what GitHub says, never from memory. A merged PR is landed; an open draft
// is a task a previous run parked as blocked; an open non-draft is shipped and only needs
// the gate; a closed-unmerged PR is abandoned, so the task is todo again.
function reconcile(order, slug, prs) {
  const byBranch = new Map();
  for (const p of prs || []) if (p && typeof p.headRefName === "string") byBranch.set(p.headRefName, p);
  const state = new Map();
  for (const t of order) {
    const p = byBranch.get(branchName(slug, t.n));
    let status = "todo";
    let note = "";
    if (p) {
      if (p.state === "MERGED") status = "landed";
      else if (p.state === "OPEN" && p.isDraft) { status = "blocked"; note = "parked as draft by an earlier run"; }
      else if (p.state === "OPEN") status = "shipped";
    }
    state.set(t.n, { status, pr: p ? p.number : 0, url: p ? p.url || "" : "", note, branch: branchName(slug, t.n) });
  }
  return state;
}

// First task whose status is todo (or shipped — it resumes at the gate) and whose deps have
// all landed. Any todo task with a blocked or skipped dep becomes skipped on the way through.
function nextTask(order, state) {
  for (const t of order) {
    const s = state.get(t.n);
    if (s.status !== "todo" && s.status !== "shipped") continue;
    const deps = t.deps.map((d) => state.get(d).status);
    if (deps.every((d) => d === "landed")) return t;
    const bad = t.deps.find((d) => ["blocked", "skipped"].includes(state.get(d).status));
    if (bad && s.status === "todo") {
      state.set(t.n, { ...s, status: "skipped", note: `depends on task ${bad}, which is ${state.get(bad).status}` });
    }
  }
  return null;
}

function shouldHalt(history, limits) {
  const n = limits.consecutiveBlocked;
  if (history.length >= n && history.slice(-n).every((h) => h === "blocked")) {
    return `${n} consecutive tasks blocked — something upstream is wrong, not the next task`;
  }
  return "";
}

function renderLedger(cfg, order, state, approvedOn) {
  const rows = order.map((t) => {
    const s = state.get(t.n);
    const pr = s.pr ? `#${s.pr}` : "";
    const branch = s.status === "todo" || s.status === "skipped" ? "" : s.branch;
    const note = s.note || (t.deps.length && s.status === "todo" ? `deps: ${t.deps.join(", ")}` : "");
    return `| ${t.n} | ${branch} | ${pr} | ${s.status} | ${note} |`;
  });
  return [
    `# Ledger — ${cfg.planPath}`,
    "",
    `Approved by the human who invoked /landing-loop:land on ${approvedOn || "(date not supplied)"}.`,
    `Merge command: ${cfg.mergeCmd} · Check command: ${cfg.checkCmd}`,
    "",
    "Pull requests are the truth about status; this table is the map and the notes.",
    "",
    "| Task | Branch | PR | Status | Note |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

const UNATTENDED_CONSTRAINTS = `Authorized scope: only the files this task lists. Anything else you notice goes in the commit body under "Out of scope, noticed" and stays unchanged.
Tests are read-only. A test that seems wrong blocks the task: report BLOCKED with the test name and why; do not edit or delete it.
Docs in the same commit: update every doc that describes behaviour this task changes. If none does, the commit body carries "docs-sync:ack" and a one-line reason.
Never force-push, never merge, never use --admin. The loop merges through the repo's own gate.`;
// <<< PURE

const ORIENT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["ok", "mainSha", "prs", "reason"],
  properties: {
    ok: { type: "boolean" }, mainSha: { type: "string" }, reason: { type: "string" },
    prs: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["number", "headRefName", "state", "isDraft", "url"],
        properties: {
          number: { type: "integer" }, headRefName: { type: "string" },
          state: { type: "string" }, isDraft: { type: "boolean" }, url: { type: "string" },
        },
      },
    },
  },
};
const BRANCH_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["ok", "mainSha", "headSha", "reason"],
  properties: { ok: { type: "boolean" }, mainSha: { type: "string" }, headSha: { type: "string" }, reason: { type: "string" } },
};
const VERIFY_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["ok", "headSha", "lastLine", "reason"],
  properties: { ok: { type: "boolean" }, headSha: { type: "string" }, lastLine: { type: "string" }, reason: { type: "string" } },
};
const SKEPTIC_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["refuted", "reasons"],
  properties: { refuted: { type: "boolean" }, reasons: { type: "array", items: { type: "string" } } },
};
const SHIP_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["prNumber", "prUrl", "headSha", "reason"],
  properties: { prNumber: { type: "integer" }, prUrl: { type: "string" }, headSha: { type: "string" }, reason: { type: "string" } },
};
const GATE_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["merged", "redCheck", "infrastructure", "failedChecks", "logTail", "reason"],
  properties: {
    merged: { type: "boolean" }, redCheck: { type: "boolean" }, infrastructure: { type: "boolean" },
    failedChecks: { type: "array", items: { type: "string" } }, logTail: { type: "string" }, reason: { type: "string" },
  },
};
const FIX_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["pushed", "headSha", "summary", "reason"],
  properties: { pushed: { type: "boolean" }, headSha: { type: "string" }, summary: { type: "string" }, reason: { type: "string" } },
};

if (typeof phase === "function") {
  const cfg = validateArgs(args);
  const order = sequenceTasks(cfg.tasks);
  const wd = cfg.workdir;
  const gc = `${cfg.globalConstraints || "(none stated)"}\n\nUnattended constraints:\n${UNATTENDED_CONSTRAINTS}`;
  const approvedOn = args && typeof args.approvedOn === "string" ? args.approvedOn : "";
  const trailer = cfg.sessionLink ? `\n\n${cfg.sessionLink}` : "";

  const orientPrompt = () =>
    `You are orienting the landing loop for plan ${cfg.planPath} in ${wd}. Run exactly these, in ${wd}:
1. git switch main && git pull --ff-only
2. git rev-parse HEAD
3. gh pr list --search "head:land/${cfg.slug}-" --state all --limit 100 --json number,headRefName,state,isDraft,url
Return per schema: ok (both git commands succeeded and the tree is clean), mainSha, prs (the JSON array from step 3, verbatim), reason on failure. Change nothing else.`;

  const branchPrompt = (t) =>
    `In ${wd}: git switch main && git pull --ff-only && git switch -c ${branchName(cfg.slug, t.n)}
If that branch already exists locally: delete it first with \`git branch -D\` only when \`git log main..${branchName(cfg.slug, t.n)}\` is empty; otherwise return ok=false and say what is on it.
Return per schema: ok, mainSha and headSha (both \`git rev-parse HEAD\` on the new branch, identical), reason.`;

  const verifyPrompt = (t, head) =>
    `In ${wd}, branch ${branchName(cfg.slug, t.n)}. Verify three things and change nothing:
1. \`git rev-parse HEAD\` equals ${head}.
2. \`git status --porcelain\` is empty.
3. The check command exits 0, run exactly as written: ${cfg.checkCmd}
Return per schema: ok (all three hold), headSha, lastLine (the check command's final stdout line, verbatim), reason. Do not re-run the check with different flags and do not edit files.`;

  const skepticPrompt = (t, i) =>
    `Skeptic ${i + 1}. Task ${t.n} ("${t.title}") of plan ${cfg.planPath} claims to be complete on branch ${branchName(cfg.slug, t.n)} in ${wd}. Read that task's section of the plan, then \`git diff main...HEAD\`. Try to REFUTE completeness: a listed file untouched, a checkbox step with no evidence in the diff, a test weakened or deleted, a change outside the task's Files list. Default refuted=true if uncertain. Read-only. Return per schema: refuted, reasons[].`;

  const shipPrompt = (t, ledger, body) =>
    `In ${wd} on branch ${branchName(cfg.slug, t.n)}. Do these in order and stop at the first failure:
1. Write ${cfg.ledgerPath} with exactly this content (overwrite):
${ledger}
2. Stage only that file: git add ${cfg.ledgerPath}
3. Commit it. The commit must be the FIRST command of its Bash call, using a heredoc message:
git commit -F - <<'EOF'
ledger: task ${t.n} shipped

Ledger only, no behaviour change: docs-sync:ack${trailer}
EOF
4. git push -u origin ${branchName(cfg.slug, t.n)}
5. gh pr create --title ${JSON.stringify(`${t.title} (task ${t.n})`)} --body-file - with this body:
${body}
6. Read back: gh pr view --json number,url
Return per schema: prNumber (0 on failure), prUrl, headSha (\`git rev-parse HEAD\`), reason. Never force-push.`;

  const gatePrompt = (t, pr, finalRound) =>
    `Pull request #${pr}, branch ${branchName(cfg.slug, t.n)}, in ${wd}. Run the repo's merge command exactly as written:
${cfg.mergeCmd.replace("{pr}", String(pr))}
It waits for CI and merges only when every check is green. Then classify the outcome:
- merged: the command reported a merge AND \`gh pr view ${pr} --json state\` says MERGED. Then run git switch main && git pull --ff-only.
- redCheck: it refused because a check failed. Collect failedChecks from \`gh pr checks ${pr} --json name,bucket\` (bucket != pass, != skipping) and logTail from the failing job: \`gh run view <run-id> --log-failed | tail -60\`.
- infrastructure: checks never appeared, the command errored for a reason other than a failed check, or gh/network failed.
${finalRound ? `This was the last allowed round. If the outcome is redCheck: run \`gh pr ready --undo ${pr}\` and post \`gh pr comment ${pr}\` whose body starts "Blocked by the landing loop:" followed by the failed check names and the log tail.` : ""}
Return per schema: merged, redCheck, infrastructure, failedChecks, logTail, reason. Never use --admin. Never merge by any route other than the merge command.`;

  const ciFixPrompt = (t, pr, gate) =>
    `CI is red on pull request #${pr}, branch ${branchName(cfg.slug, t.n)}, task ${t.n} ("${t.title}") of ${cfg.planPath}, in ${wd}.
Failed checks: ${gate.failedChecks.join(", ") || "(none named)"}
Log tail:
${gate.logTail || "(none captured)"}
Fix ONLY what the log shows, inside this task's authorized scope (its Files list in the plan). Constraints:
${gc}
Run the check command until it exits 0: ${cfg.checkCmd}
Commit (heredoc message, git commit first in its call, ending with:${trailer || " nothing"}), then git push. Return per schema: pushed, headSha, summary, reason.`;

  const state = reconcile(order, cfg.slug, []);
  const history = [];
  let halted = null;
  let processed = 0;

  phase("Orient");
  const orient = await agent(orientPrompt(), {
    label: "orient", phase: "Orient", model: "sonnet", effort: "low", schema: ORIENT_SCHEMA,
  });
  if (!orient || !orient.ok || !isShaish(orient.mainSha)) {
    halted = { task: null, reason: `orientation failed: ${orient ? orient.reason : "no result"}` };
  } else {
    for (const [n, s] of reconcile(order, cfg.slug, orient.prs)) state.set(n, s);
    const known = [...state.values()].filter((s) => s.status !== "todo").length;
    if (known) log(`Reconciled ${known} task(s) from existing pull requests`);
  }

  const setStatus = (t, status, extra = {}) => state.set(t.n, { ...state.get(t.n), status, ...extra });

  const gate = async (t, pr) => {
    for (let round = 0; ; round++) {
      const finalRound = round >= cfg.limits.fixRounds;
      const g = await agent(gatePrompt(t, pr, finalRound), {
        label: `gate:t${t.n}${round ? `:r${round}` : ""}`, phase: "Gate", model: "sonnet", effort: "low", schema: GATE_SCHEMA,
      });
      if (!g) return { status: "blocked", note: "gate agent returned no result" };
      if (g.merged) return { status: "landed", note: "" };
      if (g.infrastructure || !g.redCheck) return { status: "halt", note: `gate: ${g.reason || "not merged, no red check reported"}` };
      if (finalRound) return { status: "blocked", note: `CI red after ${round + 1} round(s): ${g.failedChecks.join(", ")}; parked as draft PR #${pr}` };
      const fix = await agent(ciFixPrompt(t, pr, g), {
        label: `ci-fix:t${t.n}`, phase: "Gate", model: "opus", effort: "medium", schema: FIX_SCHEMA,
      });
      if (!fix || !fix.pushed) return { status: "blocked", note: `CI red and the fix did not push: ${fix ? fix.reason : "no result"}` };
      log(`Task ${t.n}: pushed a CI fix (${fix.summary})`);
    }
  };

  while (!halted) {
    const t = nextTask(order, state);
    if (!t) break;
    if (cfg.limits.maxTasks && processed >= cfg.limits.maxTasks) {
      halted = { task: t.n, reason: `maxTasks (${cfg.limits.maxTasks}) reached before task ${t.n}` };
      break;
    }
    processed++;
    const s0 = state.get(t.n);
    let outcome;

    if (s0.status === "shipped") {
      log(`Task ${t.n}: PR #${s0.pr} already open — resuming at the gate`);
      outcome = await gate(t, s0.pr);
    } else {
      phase("Orient");
      const br = await agent(branchPrompt(t), {
        label: `branch:t${t.n}`, phase: "Orient", model: "sonnet", effort: "low", schema: BRANCH_SCHEMA,
      });
      if (!br || !br.ok || !isShaish(br.headSha)) {
        outcome = { status: "blocked", note: `could not branch: ${br ? br.reason : "no result"}` };
      } else {
        phase("Implement");
        let sdd = null;
        let sddError = "";
        try {
          sdd = await workflow({ scriptPath: cfg.sddPath }, {
            planPath: cfg.planPath, workdir: wd, pluginDir: cfg.sddPluginDir,
            globalConstraints: gc, mergeBase: br.mainSha, branchTip: br.headSha,
            tasks: [{ n: t.n, title: t.title, tier: t.tier, effort: t.effort, deps: [] }],
            testCmd: cfg.checkCmd, setupCmd: cfg.setupCmd || undefined,
            limits: { fixRounds: 2, escalateAttempts: 1, maxParallel: 1, fableEscalation: cfg.limits.sddFableEscalation },
          });
        } catch (e) {
          sddError = String(e && e.message ? e.message : e);
        }
        if (!sdd || sdd.halted || !isShaish(sdd.head)) {
          const why = sddError || (sdd && sdd.halted ? sdd.halted.reason : "inner loop returned no head");
          outcome = { status: "blocked", note: `inner loop: ${why}` };
        } else if (sdd.meta && sdd.meta.finalChangesUnaddressed) {
          outcome = { status: "blocked", note: "final review said 'changes' and nothing addressed them" };
        } else {
          phase("Verify");
          const v = await agent(verifyPrompt(t, sdd.head), {
            label: `verify:t${t.n}`, phase: "Verify", model: "sonnet", effort: "low", schema: VERIFY_SCHEMA,
          });
          if (!v || !v.ok) {
            outcome = { status: "blocked", note: `local check: ${v ? v.reason : "no result"}` };
          } else {
            let refutedBy = [];
            if (cfg.limits.skeptics > 0) {
              const votes = (await parallel(Array.from({ length: cfg.limits.skeptics }, (_, i) => () =>
                agent(skepticPrompt(t, i), { label: `skeptic:t${t.n}:${i + 1}`, phase: "Verify", model: "opus", effort: "medium", schema: SKEPTIC_SCHEMA })))).filter(Boolean);
              refutedBy = votes.filter((x) => x.refuted);
              if (refutedBy.length * 2 >= Math.max(votes.length, 1)) {
                outcome = { status: "blocked", note: `refuted by ${refutedBy.length}/${votes.length} skeptics: ${refutedBy.flatMap((x) => x.reasons).slice(0, 3).join("; ")}` };
              }
            }
            if (!outcome) {
              phase("Ship");
              setStatus(t, "shipped");
              const ledger = renderLedger(cfg, order, state, approvedOn);
              const body = `Task ${t.n} of ${cfg.planPath}, landed unattended by the landing loop.\n\nLocal check: \`${cfg.checkCmd}\` → ${v.lastLine}\n\nOut of scope, noticed: see the commit bodies on this branch.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)${trailer}`;
              const ship = await agent(shipPrompt(t, ledger, body), {
                label: `ship:t${t.n}`, phase: "Ship", model: "sonnet", effort: "low", schema: SHIP_SCHEMA,
              });
              if (!ship || !ship.prNumber) {
                setStatus(t, "todo");
                outcome = { status: "blocked", note: `ship: ${ship ? ship.reason : "no result"}` };
              } else {
                setStatus(t, "shipped", { pr: ship.prNumber, url: ship.prUrl });
                phase("Gate");
                outcome = await gate(t, ship.prNumber);
              }
            }
          }
        }
      }
    }

    if (outcome.status === "halt") {
      halted = { task: t.n, reason: outcome.note };
      break;
    }
    setStatus(t, outcome.status, { note: outcome.note });
    history.push(outcome.status);
    log(`Task ${t.n}: ${outcome.status}${outcome.note ? ` — ${outcome.note}` : ""}`);
    const why = shouldHalt(history, cfg.limits);
    if (why) halted = { task: t.n, reason: why };
  }

  const pick = (status) => order.filter((t) => state.get(t.n).status === status)
    .map((t) => ({ n: t.n, title: t.title, pr: state.get(t.n).pr, url: state.get(t.n).url, note: state.get(t.n).note }));
  const landed = pick("landed");
  const blocked = pick("blocked");
  const skipped = pick("skipped");
  const todo = pick("todo").concat(pick("shipped"));
  log(halted
    ? `Halted at task ${halted.task}: ${halted.reason} (${landed.length} landed, ${blocked.length} blocked)`
    : `Done: ${landed.length} landed, ${blocked.length} blocked, ${skipped.length} skipped of ${order.length}`);
  return {
    landed, blocked, skipped, todo, halted,
    ledger: renderLedger(cfg, order, state, approvedOn),
    meta: { processed, total: order.length, checkCmd: cfg.checkCmd, mergeCmd: cfg.mergeCmd },
  };
}
