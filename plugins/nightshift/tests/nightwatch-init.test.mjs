// init.mjs sets a repo up for Nightwatch end to end: preflight, clone, trust,
// the check command, the state dir, the kill switch, and a dry run that proves
// the lot. Every case runs the real script against a throwaway working repo
// with fake `gh`/`claude` on PATH; nothing here reaches GitHub, the real HOME
// or the real ~/.local/state.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { workingRepo, writeResult } from "./nightwatch-fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "..");
const INIT = join(PLUGIN, "nightwatch", "init.mjs");
const LINT = join(PLUGIN, "nightwatch", "lint-spec.mjs");

/** A DRYRUN unit result the launcher accepts as a complete dry run. */
const DRY_OK = writeResult({
  state: "DRYRUN",
  unit: 1,
  unitTitle: "plumbing",
  summary: "reconciled and ran the acceptance commands",
  blockedReason: "",
  commits: [],
  verify: { results: [], allPass: true, checkOk: true, clean: true },
});

/** The curated environment: no ANTHROPIC_API_KEY, no real HOME, a fast poll. */
function initEnv(r, extra = {}) {
  return {
    PATH: `${r.bin}:${process.env.PATH}`,
    HOME: r.home,
    POLL_S: "1",
    DEADLINE: "1h",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    FAKE_GH_LOG: r.ghLog,
    FAKE_GH_STATE_FILE: r.switchFile,
    FAKE_GH_STATE: "run",
    FAKE_NW_SCRIPT: "",
    ...extra,
  };
}

function runInit(r, args = [], { env = {}, path } = {}) {
  const e = initEnv(r, env);
  if (path) e.PATH = path;
  const res = spawnSync(process.execPath, [INIT, ...args], { encoding: "utf8", timeout: 240000, env: e });
  return { code: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
}

/** Run with --json and parse the report. */
function initJson(r, args = [], opts = {}) {
  const out = runInit(r, ["--json", ...args], opts);
  let report;
  try {
    report = JSON.parse(out.stdout);
  } catch {
    assert.fail(`not JSON: ${out.stdout}\n${out.stderr}`);
  }
  const by = (name) => report.steps.find((s) => s.step === name) || assert.fail(`no step ${name}: ${out.stdout}`);
  return { ...out, ...report, by };
}

const stateDir = (r, name = "r") => join(r.home, ".local", "state", "nightwatch", name);

function readConfig(r, name = "r") {
  const kv = {};
  for (const line of readFileSync(join(stateDir(r, name), "config"), "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
  }
  return kv;
}

const journal = (r, name = "r") => {
  const p = join(stateDir(r, name), "journal.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
};

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

/**
 * A PATH holding nothing but stubs for the seven binaries preflight wants, so
 * "timeout is missing" is testable on a host whose /usr/bin has one.
 */
function stubPath(r, omit = "") {
  const dir = join(r.root, `stubs-${omit || "all"}`);
  mkdirSync(dir, { recursive: true });
  for (const b of ["claude", "gh", "jq", "caffeinate", "node", "shasum", "timeout"]) {
    if (b === omit) continue;
    writeFileSync(join(dir, b), "#!/bin/bash\nexit 0\n");
    chmodSync(join(dir, b), 0o755);
  }
  return dir;
}

// ---- the happy path -------------------------------------------------------

test("a fresh init walks every step and proves the setup with a dry run", () => {
  const r = workingRepo();
  writeFileSync(join(r.home, ".claude.json"), JSON.stringify({ numStartups: 3, projects: { "/somewhere/else": { x: 1 } } }));

  const out = initJson(r, ["--repo", r.repo, "--clone-root", r.cloneRoot], { env: { FAKE_NW_SCRIPT: DRY_OK } });

  assert.equal(out.code, 0, out.stdout + out.stderr);
  for (const s of out.steps) assert.ok(["done", "skipped"].includes(s.status), `${s.step}: ${s.status} ${s.detail}`);

  const clone = join(r.cloneRoot, "r");
  assert.equal(existsSync(join(clone, ".git")), true);
  assert.equal(git(clone, "remote", "get-url", "origin"), r.origin);

  const cj = JSON.parse(readFileSync(join(r.home, ".claude.json"), "utf8"));
  assert.equal(cj.projects[clone].hasTrustDialogAccepted, true);
  assert.equal(cj.numStartups, 3, "every other key survives");
  assert.deepEqual(cj.projects["/somewhere/else"], { x: 1 }, "every other project survives");
  assert.equal(existsSync(join(r.home, ".claude.json.nightwatch-bak")), true);

  const cfg = readConfig(r);
  assert.equal(cfg.NAME, "r");
  assert.equal(cfg.REPO, r.repo);
  assert.equal(cfg.ORIGIN, r.origin);
  assert.equal(cfg.CLONE, clone);
  assert.equal(cfg.SPECS, join(stateDir(r), "specs"));
  assert.equal(cfg.BASE, "main");
  assert.equal(cfg.STATE_VAR, "LANDING_STATE");
  assert.equal(cfg.CHECK, "scripts/check");
  assert.equal(cfg.CHECK_SHA, undefined, "a repo-owned check is not hashed");

  assert.match(journal(r), /dry run complete/);
});

test("a second init clones nothing, trusts nothing again, and keeps the first backup", () => {
  const r = workingRepo();
  writeFileSync(join(r.home, ".claude.json"), JSON.stringify({ projects: {} }));
  assert.equal(runInit(r, ["--repo", r.repo, "--clone-root", r.cloneRoot, "--no-dry-run"]).code, 0);
  const bak = join(r.home, ".claude.json.nightwatch-bak");
  const first = readFileSync(bak, "utf8");
  const mtime = statSync(bak).mtimeMs;

  const out = initJson(r, ["--repo", r.repo, "--clone-root", r.cloneRoot, "--no-dry-run"]);

  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.equal(out.by("clone").status, "skipped");
  assert.equal(out.by("trust").status, "skipped");
  assert.equal(readFileSync(bak, "utf8"), first, "the backup still holds the original file");
  assert.equal(statSync(bak).mtimeMs, mtime, "no second backup was written");
});

test("the base branch comes from origin/HEAD, and the landing branch is cut from it", () => {
  const r = workingRepo(undefined, { base: "develop" });

  const out = initJson(r, ["--repo", r.repo, "--clone-root", r.cloneRoot], { env: { FAKE_NW_SCRIPT: DRY_OK } });

  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.equal(readConfig(r).BASE, "develop");
  assert.match(journal(r), /cut from origin\/develop/);
  assert.match(journal(r), /dry run complete/);
});

// ---- the check command ----------------------------------------------------

test("a repo with no scripts/check and no --check-cmd stops before the dry run", () => {
  const r = workingRepo(undefined, { check: false });

  const out = initJson(r, ["--repo", r.repo, "--clone-root", r.cloneRoot]);

  assert.equal(out.code, 1);
  assert.equal(out.by("check").status, "needs you");
  assert.match(out.by("check").detail, /--check-cmd/);
  assert.equal(out.steps.some((s) => s.step === "dry-run"), false, "no dry run without a check");
  assert.equal(existsSync(join(stateDir(r), "config")), false, "no config is written");
});

test("--report lists the CI run: lines that look like checks", () => {
  const r = workingRepo(undefined, { check: false });

  const out = runInit(r, ["--repo", r.repo, "--clone-root", r.cloneRoot, "--report"]);

  assert.match(out.stdout, /cargo fmt --all -- --check/);
  assert.match(out.stdout, /cargo clippy --all-targets -- -D warnings/);
  assert.match(out.stdout, /cargo nextest run/);
  assert.equal(/echo hello world/.test(out.stdout), false, "a step that is not a check is not suggested");
});

test("--check-cmd lines become a generated check, proved in the clone, and the repo is untouched", () => {
  const r = workingRepo(undefined, { check: false });
  const statusBefore = git(r.repo, "status", "--porcelain");
  const branchesBefore = git(r.repo, "branch", "--format=%(refname:short)");
  const headBefore = git(r.repo, "rev-parse", "HEAD");

  const out = initJson(r, [
    "--repo", r.repo, "--clone-root", r.cloneRoot, "--no-dry-run",
    "--check-cmd", "echo one", "--check-cmd", "echo two",
  ]);

  assert.equal(out.code, 0, out.stdout + out.stderr);
  const script = join(stateDir(r), "check");
  assert.equal(existsSync(script), true);
  const log = readFileSync(join(stateDir(r), "check-first-run.log"), "utf8").trimEnd();
  assert.match(log, /✓ echo one/);
  assert.match(log, /✓ echo two/);
  assert.equal(log.split("\n").pop(), "CHECK OK");

  const cfg = readConfig(r);
  assert.equal(cfg.CHECK, script);
  assert.equal(cfg.CHECK_SHA, createHash("sha256").update(readFileSync(script)).digest("hex"));

  assert.equal(git(r.repo, "status", "--porcelain"), statusBefore, "the working repo gained no files");
  assert.equal(git(r.repo, "branch", "--format=%(refname:short)"), branchesBefore, "and no branches");
  assert.equal(git(r.repo, "rev-parse", "HEAD"), headBefore, "and no commits");
  assert.equal(/(^| )pr( |$)/m.test(readFileSync(r.ghLog, "utf8")), false, "init never calls gh pr");
});

test("a re-run keeps the generated check, so --report and a second init do not dead-end", () => {
  const r = workingRepo(undefined, { check: false });
  const first = initJson(r, ["--repo", r.repo, "--clone-root", r.cloneRoot, "--no-dry-run", "--check-cmd", "echo one"]);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  const script = join(stateDir(r), "check");
  const shaBefore = readConfig(r).CHECK_SHA;

  const again = initJson(r, ["--repo", r.repo, "--clone-root", r.cloneRoot, "--no-dry-run"]);
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.equal(again.by("check").status, "skipped");
  assert.match(again.by("check").detail, /generated check at .* kept/);
  assert.equal(readConfig(r).CHECK, script);
  assert.equal(readConfig(r).CHECK_SHA, shaBefore);

  const report = initJson(r, ["--repo", r.repo, "--clone-root", r.cloneRoot, "--report"]);
  assert.equal(report.by("check").status, "skipped");
  assert.equal(report.steps.some((s) => s.status === "needs you" && s.step === "check"), false);
});

test("a --check-cmd that fails in the clone is a failed step, and writes no config", () => {
  const r = workingRepo(undefined, { check: false });

  const out = initJson(r, ["--repo", r.repo, "--clone-root", r.cloneRoot, "--no-dry-run", "--check-cmd", "false"]);

  assert.equal(out.code, 1);
  assert.equal(out.by("check").status, "failed");
  assert.match(out.by("check").detail, /does not pass in/);
  assert.equal(existsSync(join(stateDir(r), "config")), false);
});

// ---- --report changes nothing --------------------------------------------

test("--report writes nothing at all", () => {
  const r = workingRepo();

  const out = runInit(r, ["--repo", r.repo, "--clone-root", r.cloneRoot, "--report"]);

  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.equal(existsSync(join(r.cloneRoot, "r")), false, "no clone");
  assert.equal(existsSync(join(r.home, ".claude.json")), false, "no ~/.claude.json");
  assert.equal(existsSync(stateDir(r)), false, "no state dir");
});

// ---- the kill switch ------------------------------------------------------

test("an unset switch is a needs-you with the exact command, and the dry run says so", () => {
  const r = workingRepo();

  const out = initJson(r, ["--repo", r.repo, "--clone-root", r.cloneRoot], { env: { FAKE_GH_STATE: "unset" } });

  assert.equal(out.code, 1);
  assert.equal(out.by("switch").status, "needs you");
  assert.match(out.by("switch").detail, /gh variable set LANDING_STATE --body run/);
  assert.match(out.by("switch").detail, new RegExp(r.repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(out.by("dry-run").status, "needs you");
  assert.match(out.by("dry-run").detail, /switch is off/);
});

test("--set-switch flips it and the dry run then runs", () => {
  const r = workingRepo();

  const out = initJson(r, ["--repo", r.repo, "--clone-root", r.cloneRoot, "--set-switch"], {
    env: { FAKE_GH_STATE: "unset", FAKE_NW_SCRIPT: DRY_OK },
  });

  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.match(readFileSync(r.ghLog, "utf8"), /variable set LANDING_STATE --body run/);
  assert.equal(out.by("switch").status, "done");
  assert.equal(out.by("dry-run").status, "done");
  assert.match(journal(r), /dry run complete/);
});

// ---- the things init refuses ---------------------------------------------

test("a ~/.claude.json that is not JSON is never overwritten", () => {
  const r = workingRepo();
  const file = join(r.home, ".claude.json");
  writeFileSync(file, "{ this is not json");

  const out = initJson(r, ["--repo", r.repo, "--clone-root", r.cloneRoot, "--no-dry-run"]);

  assert.equal(out.code, 1);
  assert.equal(out.by("trust").status, "failed");
  assert.equal(readFileSync(file, "utf8"), "{ this is not json");
  assert.equal(existsSync(`${file}.nightwatch-bak`), false);
});

test("a name already taken by another origin is refused until --name says otherwise", () => {
  const r = workingRepo();
  assert.equal(runInit(r, ["--repo", r.repo, "--clone-root", r.cloneRoot, "--no-dry-run"]).code, 0);
  // A second checkout with the same basename and a different origin.
  const other = workingRepo(undefined, { check: true });
  const args = ["--repo", other.repo, "--clone-root", r.cloneRoot, "--no-dry-run"];

  const clash = initJson(r, args);
  assert.equal(clash.code, 1);
  assert.equal(clash.by("repo").status, "failed");
  assert.match(clash.by("repo").detail, /name r is taken by/);

  const ok = initJson(r, [...args, "--name", "other"]);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.equal(readConfig(r, "other").ORIGIN, other.origin);
});

for (const [label, opts] of [
  ["claude missing", { omit: "claude" }],
  ["timeout missing", { omit: "timeout" }],
  ["ANTHROPIC_API_KEY set", { key: "sk-test" }],
]) {
  test(`preflight stops on ${label} and nothing is created`, () => {
    const r = workingRepo();
    const env = opts.key ? { ANTHROPIC_API_KEY: opts.key } : {};

    const out = initJson(r, ["--repo", r.repo, "--clone-root", r.cloneRoot], {
      env,
      path: stubPath(r, opts.omit || ""),
    });

    assert.equal(out.code, 1);
    assert.equal(out.steps.length, 1);
    assert.equal(out.by("preflight").status, "failed");
    assert.match(out.by("preflight").detail, opts.key ? /ANTHROPIC_API_KEY/ : new RegExp(opts.omit));
    assert.equal(existsSync(r.cloneRoot), false);
    assert.equal(existsSync(stateDir(r)), false);
  });
}

// ---- a check path with a space --------------------------------------------

test("a generated check behind a space is quoted once, and the launcher runs that exact script", () => {
  const r = workingRepo(undefined, { check: false, homeName: "ho me" });

  const out = initJson(r, [
    "--repo", r.repo, "--clone-root", r.cloneRoot, "--check-cmd", "echo one",
  ], { env: { FAKE_NW_SCRIPT: DRY_OK } });

  assert.equal(out.code, 0, out.stdout + out.stderr);
  const script = join(stateDir(r), "check");
  const cfg = readConfig(r);
  assert.equal(cfg.CHECK, script, "the config carries the raw path, unquoted");
  assert.ok(script.includes(" "));
  assert.equal(cfg.CHECK_SHA, createHash("sha256").update(readFileSync(script)).digest("hex"));

  // The one rendering every consumer sees: the spec, the linter and run.sh.
  const rendered = `"${script}"`;
  const specPath = join(stateDir(r), "dry-specs", "00-plumbing.md");
  assert.ok(readFileSync(specPath, "utf8").includes(rendered), "the Acceptance line carries the quoted form");
  const lint = spawnSync(process.execPath, [LINT, "--specs-dir", join(stateDir(r), "dry-specs"), "--check", rendered], { encoding: "utf8" });
  assert.equal(lint.status, 0, lint.stdout + lint.stderr);

  assert.match(journal(r), /dry run complete/);
  const lc = readFileSync(join(stateDir(r), "outcomes", "00-plumbing", "u1-logs", "launcher-check.log"), "utf8").trimEnd().split("\n");
  assert.equal(lc.pop(), "exit=0");
  assert.equal(lc.pop(), "CHECK OK");
});
