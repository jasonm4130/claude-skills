#!/usr/bin/env node
// Scaffold Nightshift into a repository: the loop, its two guards, a quiet
// verifier skeleton, the docs page, and the settings the loop's `claude -p`
// sessions read. Everything lands *in the repo*, committed, because the loop
// runs `claude -p --setting-sources project` (user settings and installed
// plugins never load inside it) and launchd needs a path that does not move
// when this plugin is updated.
//
//   node init.mjs [--repo <dir>] [--stack auto|node|cargo|python|go|generic]
//                 [--plan <path>] [--check] [--update] [--deny-rules] [--base <branch>]
//
// Default: copy every template that is missing, fill placeholders, merge
// .claude/settings.json, write loop/.nightshift (a stamp of what was rendered).
// --plan    the plan loop/config points at. Without it, init scaffolds
//           docs/plans/<today>-nightshift-smoke.md with one small real task, so
//           `loop/land.sh --dry-run` has something to read on the first run.
// --check   report each managed file as unchanged / modified locally / template
//           newer, change nothing, exit 1 if anything is not unchanged.
// --update  overwrite files that are still at their stamped content with the
//           newer template. Locally modified files are left alone and named.
// --deny-rules  also add permissions.deny for `gh pr merge` and force pushes.
//           Off by default: the hooks deny both in every permission mode, and a
//           deny rule would also refuse the same commands in daytime sessions.
//
// Stdlib only. No network. Never deletes anything.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, "..");
const templates = join(pluginRoot, "templates");
const VERSION = JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")).version;

export const HOOK_FILES = ["no-route-around-ci.mjs", "tests-are-readonly.mjs", "hooks.test.mjs"];
export const LOOP_FILES = ["land.sh", "config", "PROMPT.md", "SKEPTIC.md", "task-brief", "merge-pr.sh", "launchd.plist"];
const EXECUTABLE = new Set(["loop/land.sh", "loop/task-brief", "loop/merge-pr.sh", "scripts/check"]);

/** @param {string[]} argv */
export function parseArgs(argv) {
  const o = { repo: process.cwd(), stack: "auto", check: false, update: false, denyRules: false, base: "main", plan: "", help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") o.repo = argv[++i];
    else if (a === "--stack") o.stack = argv[++i];
    else if (a === "--base") o.base = argv[++i];
    else if (a === "--plan") o.plan = argv[++i];
    else if (a === "--check") o.check = true;
    else if (a === "--update") o.update = true;
    else if (a === "--deny-rules") o.denyRules = true;
    else if (a === "-h" || a === "--help") { o.help = true; }
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

/** @param {string} dir */
export function detectStack(dir) {
  if (existsSync(join(dir, "Cargo.toml"))) return "cargo";
  if (existsSync(join(dir, "pyproject.toml"))) return "python";
  if (existsSync(join(dir, "go.mod"))) return "go";
  if (existsSync(join(dir, "package.json"))) return "node";
  return "generic";
}

/** The build tool an allow rule should name for a stack, or null. */
const STACK_TOOL = { cargo: "cargo", python: "uv", go: "go", node: "npm", generic: null };

/** protected when BASE has required status checks and gh can say so; wait otherwise. */
export function probeMergeMode(dir, base) {
  try {
    const url = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (!m) return "wait";
    const n = execFileSync("gh", ["api", `repos/${m[1]}/${m[2]}/branches/${base}/protection`, "--jq", ".required_status_checks.contexts | length"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return Number(n) > 0 ? "protected" : "wait";
  } catch { return "wait"; }
}

/** Job names declared in .github/workflows/*.yml — a `gate` job wins if present. */
export function ciJobNames(dir) {
  const wf = join(dir, ".github", "workflows");
  if (!existsSync(wf)) return [];
  const names = new Set();
  for (const f of readdirSync(wf)) {
    if (!/\.ya?ml$/.test(f)) continue;
    const lines = readFileSync(join(wf, f), "utf8").split("\n");
    let inJobs = false;
    for (const line of lines) {
      if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
      if (inJobs && /^\S/.test(line)) inJobs = false;
      const m = inJobs && line.match(/^  ([A-Za-z_][\w-]*):\s*$/);
      if (m) names.add(m[1]);
    }
  }
  const all = [...names];
  return all.includes("gate") ? ["gate"] : all;
}

/** @param {string} text @param {Record<string,string>} vars */
export function fill(text, vars) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

const sha = (s) => createHash("sha256").update(s).digest("hex");

/** Every file init manages: repo-relative path → rendered content. */
export function render(dir, opts) {
  const name = basename(resolve(dir));
  const stack = opts.stack === "auto" ? detectStack(dir) : opts.stack;
  // Job ids are not check names (a matrix job reports as `name (os)`), so only a
  // single `gate` job is safe to pre-fill; anything else a human names.
  const jobs = ciJobNames(dir);
  const vars = {
    NAME: name,
    BASE: opts.base,
    PLAN: opts.plan || `docs/plans/${opts.today || "YYYY-MM-DD"}-nightshift-smoke.md`,
    MERGE_MODE: opts.mergeMode || probeMergeMode(dir, opts.base),
    EXPECTED_CHECKS: jobs.length === 1 && jobs[0] === "gate" ? "gate" : "",
    REPO: resolve(dir),
    HOME: process.env.HOME || "",
    PATH: process.env.PATH || "",
  };
  /** @type {Record<string,string>} */
  const out = {};
  for (const f of LOOP_FILES) {
    let t = readFileSync(join(templates, "loop", f), "utf8");
    if (f === "launchd.plist") t = t.replace(/__REPO__/g, vars.REPO).replace(/__HOME__/g, vars.HOME).replace(/__NAME__/g, vars.NAME).replace(/__PATH__/g, vars.PATH);
    out[`loop/${f}`] = fill(t, vars);
  }
  for (const f of HOOK_FILES) out[`.claude/hooks/${f}`] = readFileSync(join(templates, "hooks", f), "utf8");
  out["scripts/check"] = readFileSync(join(templates, "check", `${stack}.sh`), "utf8");
  const docsDir = existsSync(join(dir, "docs", "developing")) ? "docs/developing/landing.md" : "docs/nightshift.md";
  out[docsDir] = fill(readFileSync(join(templates, "docs", "landing.md"), "utf8"), vars);
  if (!opts.plan) out[vars.PLAN] = smokePlan(docsDir);
  return { files: out, vars, stack };
}

/** The first plan: one task small enough that what is being tested is the loop. */
export function smokePlan(docsPath) {
  return `# Plan: Nightshift smoke

The first plan the overnight loop lands. One task, small and real, checkable by
reading the diff, so what is being tested is the loop, not the task. Replace
this file with a real plan once a task has landed.

# Task 1: Record the first night

Append a section \`## First night\` to the end of \`${docsPath}\` containing one
sentence: the date (from \`date +%F\`) and that this task was landed by the loop
unattended. Do not change anything else in the file. If the section already
exists, add one dated line under it instead of a second heading.
`;
}

const HOOK_CMD = (f) => `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${f}"`;

/** Merge the loop's hooks and allow rules into an existing settings object. Never removes. */
export function mergeSettings(settings, { stack, denyRules }) {
  const s = settings && typeof settings === "object" ? settings : {};
  s.permissions = s.permissions && typeof s.permissions === "object" ? s.permissions : {};
  const allow = new Set(Array.isArray(s.permissions.allow) ? s.permissions.allow : []);
  for (const r of ["Bash(scripts/check:*)", "Bash(./scripts/check:*)", "Bash(loop/task-brief:*)", "Bash(./loop/task-brief:*)", "Bash(./loop/merge-pr.sh:*)", "Bash(git:*)", "Bash(gh:*)"]) allow.add(r);
  const tool = STACK_TOOL[stack];
  if (tool) allow.add(`Bash(${tool}:*)`);
  s.permissions.allow = [...allow];
  if (denyRules) {
    const deny = new Set(Array.isArray(s.permissions.deny) ? s.permissions.deny : []);
    for (const r of ["Bash(gh pr merge:*)", "Bash(git push --force:*)", "Bash(git push -f:*)"]) deny.add(r);
    s.permissions.deny = [...deny];
  }
  s.hooks = s.hooks && typeof s.hooks === "object" ? s.hooks : {};
  const pre = Array.isArray(s.hooks.PreToolUse) ? s.hooks.PreToolUse : [];
  const present = new Set();
  for (const entry of pre) for (const h of entry.hooks || []) {
    for (const f of HOOK_FILES) if (typeof h.command === "string" && h.command.includes(f)) present.add(f);
  }
  const missing = ["no-route-around-ci.mjs", "tests-are-readonly.mjs"].filter((f) => !present.has(f));
  if (missing.length) pre.push({ matcher: "Bash", hooks: missing.map((f) => ({ type: "command", command: HOOK_CMD(f) })) });
  s.hooks.PreToolUse = pre;
  return s;
}

function readStamp(dir) {
  const p = join(dir, "loop", ".nightshift");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

/** Classify each managed file against the stamp and the freshly rendered template. */
export function classify(dir, rendered, stamp) {
  /** @type {Array<{path:string, state:string}>} */
  const rows = [];
  for (const [rel, content] of Object.entries(rendered)) {
    const abs = join(dir, rel);
    if (!existsSync(abs)) { rows.push({ path: rel, state: "missing" }); continue; }
    const current = sha(readFileSync(abs, "utf8"));
    const stamped = stamp && stamp.files && stamp.files[rel];
    const fresh = sha(content);
    if (!stamped) rows.push({ path: rel, state: current === fresh ? "unchanged" : "unmanaged" });
    else if (current !== stamped) rows.push({ path: rel, state: "modified locally" });
    else if (fresh !== stamped) rows.push({ path: rel, state: "template newer" });
    else rows.push({ path: rel, state: "unchanged" });
  }
  return rows;
}

function writeFile(dir, rel, content) {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  if (EXECUTABLE.has(rel)) chmodSync(abs, 0o755);
}

export function main(argv = process.argv.slice(2), log = console.log) {
  const opts = parseArgs(argv);
  if (opts.help) { log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 22).map((l) => l.replace(/^\/\/ ?/, "")).join("\n")); return 0; }
  let dir;
  try { dir = execFileSync("git", ["-C", opts.repo, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { throw new Error(`${opts.repo} is not inside a git repository`); }
  const stamp = readStamp(dir);
  // Carry the values a previous init rendered with, so --check compares like with like.
  const carried = stamp && stamp.vars ? { plan: stamp.vars.PLAN, mergeMode: stamp.vars.MERGE_MODE, base: stamp.vars.BASE || opts.base } : {};
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; // local date, not UTC
  const { files, vars, stack } = render(dir, { ...opts, today, ...carried });
  const rows = classify(dir, files, stamp);

  if (opts.check) {
    for (const r of rows) log(`${r.state.padEnd(17)} ${r.path}`);
    const bad = rows.filter((r) => r.state !== "unchanged");
    log(bad.length ? `${bad.length} file(s) differ from the ${stamp ? `stamped ${stamp.version}` : "template"} (plugin ${VERSION})` : `all ${rows.length} managed files unchanged (plugin ${VERSION})`);
    return bad.length ? 1 : 0;
  }

  const written = [], skipped = [];
  const newStamp = { version: VERSION, vars: { PLAN: vars.PLAN, MERGE_MODE: vars.MERGE_MODE, BASE: vars.BASE, NAME: vars.NAME }, files: {} };
  for (const r of rows) {
    const content = files[r.path];
    const take = r.state === "missing" || (opts.update && r.state === "template newer");
    if (take) { writeFile(dir, r.path, content); written.push(r.path); }
    else skipped.push(`${r.path} (${r.state})`);
    // Stamp what is on disk now: a locally modified file keeps its local hash so --check keeps saying so.
    newStamp.files[r.path] = take || r.state === "unchanged" || r.state === "template newer" ? sha(existsSync(join(dir, r.path)) ? readFileSync(join(dir, r.path), "utf8") : content) : (stamp && stamp.files && stamp.files[r.path]) || sha(content);
  }

  // settings.json: merge, write, re-parse. Claude Code silently drops a settings
  // file it cannot parse, and every hook in it with it.
  const sp = join(dir, ".claude", "settings.json");
  let settings = {};
  if (existsSync(sp)) {
    try { settings = JSON.parse(readFileSync(sp, "utf8")); }
    catch (e) { throw new Error(`${sp} does not parse (${e.message}); fix it before init merges into it`); }
  }
  const merged = mergeSettings(settings, { stack, denyRules: opts.denyRules });
  const text = JSON.stringify(merged, null, 2) + "\n";
  mkdirSync(dirname(sp), { recursive: true });
  writeFileSync(sp, text);
  JSON.parse(readFileSync(sp, "utf8"));

  mkdirSync(join(dir, "loop"), { recursive: true });
  writeFileSync(join(dir, "loop", ".nightshift"), JSON.stringify(newStamp, null, 2) + "\n");

  log(`nightshift ${VERSION} → ${dir} (stack: ${stack}, merge mode: ${vars.MERGE_MODE}${vars.EXPECTED_CHECKS ? `, expected checks: ${vars.EXPECTED_CHECKS}` : ""})`);
  for (const w of written) log(`  wrote    ${w}`);
  for (const s of skipped) log(`  kept     ${s}`);
  log(`  merged   ${relative(dir, sp)}`);
  log(`  stamped  loop/.nightshift`);
  log("");
  log("Next:");
  log(`  1. loop/config points at ${vars.PLAN}${opts.plan ? "" : " (a one-task smoke plan init wrote; replace it once a task has landed)"}${vars.MERGE_MODE === "wait" ? `; EXPECTED_CHECKS is ${vars.EXPECTED_CHECKS ? `"${vars.EXPECTED_CHECKS}"` : "EMPTY — name your CI checks as GitHub names them, or add a final gate job"}` : "; MERGE_MODE=protected reads the required checks from GitHub"}.`);
  log("  2. scripts/check must end with CHECK OK — edit the steps to match your CI.");
  log("  3. node <plugin>/scripts/preflight.mjs   # gh auth, timeout(1), branch protection, kill switch, the verifier");
  log("  4. loop/land.sh --dry-run               # says which task it would pick, touches nothing");
  log("  5. Commit loop/, .claude/, scripts/check and the docs page. The plan lands from what is committed.");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exit(main()); }
  catch (e) { console.error(`init: ${e.message}`); process.exit(2); }
}
