#!/usr/bin/env node
// Preflight for a Nightshift repo: one line per check, exit 1 on a hard
// failure. Run before the first daylight `MAX=1 loop/land.sh`, and again after
// touching loop/config or CI.
//
//   node preflight.mjs [--repo <dir>] [--skip-check]
//
// Checks, in order:
//   gh         `gh auth status` succeeds (the loop opens PRs and reads variables as you)
//   claude     `claude --version` prints something
//   timeout    coreutils `timeout` on PATH; without it land.sh runs every step unbounded
//   config     loop/config sources; PLAN has `# Task N` headings and is on origin/BASE (a real run reads it there)
//   hooks      .claude/settings.json parses and registers both guards; the guard files exist
//   protection branch protection on BASE → MERGE_MODE must be `protected`; none → `wait`
//   checks     wait mode: EXPECTED_CHECKS is set and each name is a check GitHub has
//              reported on the base branch's latest commit (matrix names included)
//   switch     repo variable LANDING_STATE exists (frozen or run)
//   verifier   CHECK_CMD runs and its last line is CHECK OK (skip with --skip-check)
//
// Fails open on nothing: a red line here is cheaper than a red night.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { ciJobNames } from "./init.mjs";

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim(), status: r.status };
}

/** Read `: "${KEY:=value}"` defaults out of loop/config, with the environment winning. */
export function readConfig(dir, env = process.env) {
  const p = join(dir, "loop", "config");
  const cfg = { PLAN: "", BASE: "main", CHECK_CMD: "scripts/check", MERGE_CMD: "./loop/merge-pr.sh --stay", MERGE_MODE: "wait", EXPECTED_CHECKS: "", STATE_VAR: "LANDING_STATE" };
  if (existsSync(p)) {
    for (const m of readFileSync(p, "utf8").matchAll(/^:\s*"\$\{([A-Z_]+):=(.*)\}"\s*$/gm)) cfg[m[1]] = m[2];
  }
  for (const k of Object.keys(cfg)) if (env[k]) cfg[k] = env[k];
  return cfg;
}

/** owner/repo from the origin URL, or null. */
export function originSlug(dir) {
  const r = sh("git", ["-C", dir, "remote", "get-url", "origin"]);
  if (!r.ok) return null;
  const m = r.out.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function run(argv = process.argv.slice(2), log = console.log) {
  let repo = process.cwd(), skipCheck = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo") repo = argv[++i];
    else if (argv[i] === "--skip-check") skipCheck = true;
  }
  const top = sh("git", ["-C", repo, "rev-parse", "--show-toplevel"]);
  if (!top.ok) { log(`FAIL repo       ${repo} is not a git repository`); return 1; }
  const dir = top.out;
  let failures = 0;
  const ok = (k, m) => log(`ok   ${k.padEnd(10)} ${m}`);
  const warn = (k, m) => log(`warn ${k.padEnd(10)} ${m}`);
  const fail = (k, m) => { failures++; log(`FAIL ${k.padEnd(10)} ${m}`); };

  const gh = sh("gh", ["auth", "status"]);
  gh.ok ? ok("gh", "authenticated") : fail("gh", `gh auth status failed: ${(gh.err || gh.out).split("\n")[0]}`);

  const cl = sh("claude", ["--version"]);
  cl.ok ? ok("claude", cl.out.split("\n")[0]) : fail("claude", "claude is not on PATH");

  const to = sh("sh", ["-c", "command -v timeout"]);
  to.ok ? ok("timeout", to.out) : warn("timeout", "no timeout(1) on PATH — land.sh runs steps unbounded (macOS: brew install coreutils)");

  const cfg = readConfig(dir);
  if (!existsSync(join(dir, "loop", "config"))) fail("config", "loop/config is missing — run init first");
  else if (!cfg.PLAN || /YYYY-MM-DD|your-plan/.test(cfg.PLAN)) fail("config", `PLAN in loop/config is still the placeholder (${cfg.PLAN || "empty"})`);
  else if (!existsSync(join(dir, cfg.PLAN))) fail("config", `PLAN ${cfg.PLAN} does not exist`);
  else {
    const tasks = (readFileSync(join(dir, cfg.PLAN), "utf8").match(/^#+\s+Task\s+[0-9]+/gm) || []).length;
    const tracked = sh("git", ["-C", dir, "ls-files", "--error-unmatch", cfg.PLAN]).ok;
    const dirty = sh("git", ["-C", dir, "status", "--porcelain", "--", cfg.PLAN]).out !== "";
    if (!tasks) fail("config", `${cfg.PLAN} has no '# Task N' headings`);
    else if (!tracked || dirty) fail("config", `${cfg.PLAN}: ${tasks} task(s), NOT committed — a dry run reads it here, a real run reads origin/${cfg.BASE}; commit it, merge it, then re-run preflight`);
    else {
      sh("git", ["-C", dir, "fetch", "-q", "origin", cfg.BASE]);
      const onBase = sh("git", ["-C", dir, "cat-file", "-e", `origin/${cfg.BASE}:${cfg.PLAN}`]).ok;
      if (!onBase) fail("config", `${cfg.PLAN}: ${tasks} task(s), committed here but NOT on origin/${cfg.BASE} — a real run reads the plan from there; merge the PR that carries it, then re-run preflight`);
      else ok("config", `${cfg.PLAN}: ${tasks} task(s), on origin/${cfg.BASE}`);
    }
  }

  const sp = join(dir, ".claude", "settings.json");
  try {
    const s = JSON.parse(readFileSync(sp, "utf8"));
    const cmds = ((s.hooks && s.hooks.PreToolUse) || []).flatMap((e) => (e.hooks || []).map((h) => h.command || ""));
    const want = ["no-route-around-ci.mjs", "tests-are-readonly.mjs"];
    const missing = want.filter((f) => !cmds.some((c) => c.includes(f)) || !existsSync(join(dir, ".claude", "hooks", f)));
    missing.length ? fail("hooks", `not registered or missing on disk: ${missing.join(", ")}`) : ok("hooks", "both guards registered and present");
  } catch (e) { fail("hooks", `${sp}: ${e.message}`); }

  const slug = originSlug(dir);
  let protectedBase = null;
  if (!slug) warn("protection", "origin is not a github.com remote; cannot probe branch protection");
  else {
    const pr = sh("gh", ["api", `repos/${slug}/branches/${cfg.BASE}/protection`, "--jq", ".required_status_checks.contexts | length"]);
    if (pr.ok) { protectedBase = Number(pr.out) || 0; }
    else if (/404|Branch not protected/i.test(pr.err)) protectedBase = 0;
    else if (/403|Upgrade to GitHub Pro/i.test(pr.err)) protectedBase = 0;
    else warn("protection", `could not probe: ${pr.err.split("\n")[0]}`);
    if (protectedBase !== null) {
      const should = protectedBase > 0 ? "protected" : "wait";
      const msg = protectedBase > 0 ? `${cfg.BASE} has ${protectedBase} required check(s)` : `${cfg.BASE} has no branch protection`;
      cfg.MERGE_MODE === should ? ok("protection", `${msg}; MERGE_MODE=${cfg.MERGE_MODE}`) : fail("protection", `${msg} but MERGE_MODE=${cfg.MERGE_MODE}; set MERGE_MODE=${should} in loop/config`);
      if (protectedBase === 0) warn("protection", `${cfg.BASE} accepts direct pushes; the no-route-around-ci hook is a textual match and a generator can spell \`git push\` around it — protect ${cfg.BASE} (require the CI checks) so GitHub, not the hook, is the gate`);
    }
  }

  if (cfg.MERGE_MODE === "wait") {
    const expected = cfg.EXPECTED_CHECKS.split(/\s+/).filter(Boolean);
    // Names as GitHub reports them, from the latest commit on the base branch.
    let seen = [];
    if (slug) {
      const shaR = sh("git", ["-C", dir, "rev-parse", `origin/${cfg.BASE}`]);
      const cr = shaR.ok ? sh("gh", ["api", `repos/${slug}/commits/${shaR.out}/check-runs`, "--jq", ".check_runs[].name"]) : { ok: false, out: "" };
      seen = [...new Set(cr.out.split("\n").filter(Boolean))];
    }
    if (!expected.length) fail("checks", `MERGE_MODE=wait but EXPECTED_CHECKS is empty${seen.length ? ` — names seen on origin/${cfg.BASE}: ${seen.join(", ")}` : ""}`);
    else {
      const jobs = ciJobNames(dir);
      const unknown = expected.filter((e) => !seen.includes(e) && !jobs.includes(e));
      unknown.length ? fail("checks", `never reported on origin/${cfg.BASE} and not a job id: ${unknown.join(", ")}${seen.length ? ` (seen: ${seen.join(", ")})` : ""}`) : ok("checks", `waiting on: ${expected.join(", ")}`);
      if (!expected.includes("gate")) warn("checks", "no `gate` job: a paths-filtered job that never registers would stall the merge and refuse it");
    }
  }

  const sw = sh("gh", ["variable", "get", cfg.STATE_VAR], { cwd: dir });
  if (sw.ok) ok("switch", `${cfg.STATE_VAR}=${sw.out}`);
  else fail("switch", `repo variable ${cfg.STATE_VAR} is unset — gh variable set ${cfg.STATE_VAR} --body frozen`);

  if (skipCheck) warn("verifier", "skipped (--skip-check)");
  else {
    const t0 = Date.now();
    const v = sh("bash", ["-c", cfg.CHECK_CMD], { cwd: dir, timeout: 30 * 60 * 1000 });
    const last = v.out.split("\n").filter(Boolean).pop() || "";
    const secs = Math.round((Date.now() - t0) / 1000);
    v.ok && last === "CHECK OK" ? ok("verifier", `${cfg.CHECK_CMD} → CHECK OK in ${secs}s`) : fail("verifier", `${cfg.CHECK_CMD} exit ${v.status}, last line: ${last || v.err.split("\n").pop() || "(nothing)"}`);
  }

  log(failures ? `${failures} failure(s)` : "preflight clean");
  return failures ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(run());
