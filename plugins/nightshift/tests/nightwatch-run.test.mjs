// The launcher takes orders: Depends, Units, the control file, and the states
// it is honest about. Every case runs run.sh end to end against a throwaway
// clone with a fake `claude` that writes the unit result the test wants.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  CONTINUE_UNIT,
  DIED_UNIT,
  FAILED_UNIT,
  PASS_NO_LOG,
  PASS_NO_RESULTS,
  PASS_UNIT,
  RUN_SH,
  branches,
  nightwatchRepo,
  runNightwatch,
  spec,
  unreachableCommit,
  writeConfig,
  writeResult,
} from "./nightwatch-fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "..");
const MORNING = join(PLUGIN, "nightwatch", "morning.mjs");

/** A check script on disk, plus the CHECK_SHA the config would carry for it. */
function genCheck(dir, name, body) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const text = `#!/usr/bin/env bash\n${body}\n`;
  writeFileSync(path, text);
  chmodSync(path, 0o755);
  return { path, sha: createHash("sha256").update(text).digest("hex") };
}

/** The two JSON documents `--print-settings` prints, parsed. */
function printSettings(r, name, { runSh = RUN_SH } = {}) {
  const out = runNightwatch(r, { positional: [name], args: ["--print-settings"], runSh, stateName: name });
  assert.equal(out.code, 0, out.stderr);
  const [settingsLine, argsLine, agentsLine] = out.stdout.trim().split("\n");
  return { settings: JSON.parse(settingsLine), args: JSON.parse(argsLine), agents: JSON.parse(agentsLine), out };
}

test("an unmet Depends waits: no branch, no unit, the queue moves on", () => {
  const r = nightwatchRepo({
    specs: { "01-a.md": spec("A"), "02-b.md": spec("B", "Depends: 03-c") },
  });
  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: PASS_UNIT } });

  assert.match(out.journal, /02-b: waiting on 03-c/);
  assert.equal(branches(r).some((b) => b.endsWith("/02-b")), false);
  assert.match(out.landed, /^01-a\t/m);
  assert.equal(/02-b u1:/.test(out.journal), false);
});

test("a landed row the landing branch cannot reach does not satisfy Depends", () => {
  const r = nightwatchRepo({ specs: { "02-b.md": spec("B", "Depends: 03-c") } });
  const stale = unreachableCommit(r); // a real commit object, reachable from no ref
  mkdirSync(r.state, { recursive: true });
  writeFileSync(join(r.state, "landed"), `03-c\t20260101-000000\t${stale}\t${stale}\t/x/03-c.md\n`);

  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: PASS_UNIT } });

  assert.match(out.journal, /02-b: waiting on 03-c/);
  assert.equal(branches(r).some((b) => b.endsWith("/02-b")), false);
});

test("a Depends met earlier in the same run lets the spec proceed", () => {
  const r = nightwatchRepo({
    specs: { "01-a.md": spec("A"), "02-b.md": spec("B", "Depends: 01-a") },
  });
  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: PASS_UNIT } });

  assert.equal(/waiting on/.test(out.journal), false);
  assert.match(out.journal, /02-b u1: PASS/);
  assert.match(out.landed, /^01-a\t/m);
  assert.match(out.landed, /^02-b\t/m);
});

test("Units: 1 caps the spec at one unit", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A", "Units: 1") } });
  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: CONTINUE_UNIT } });

  assert.match(out.journal, /01-a u1: CONTINUE/);
  assert.equal(/01-a u2:/.test(out.journal), false);
  assert.match(out.journal, /01-a: PARTIAL; branch/);
});

test("requeue appends the spec to the queue and the second pass resumes its branch", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A", "Units: 1") } });
  const script = [
    `grep -q requeue "$STATEDIR/control" 2>/dev/null || echo "requeue 01-a" >> "$STATEDIR/control"`,
    FAILED_UNIT,
  ].join("\n");
  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: script } });

  assert.equal((out.journal.match(/01-a u1: FAILED/g) || []).length, 2);
  assert.match(out.journal, /01-a: resuming branch/);
});

test("no result file but a commit on the branch is PARTIAL, not FAILED", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A", "Units: 1") } });
  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: DIED_UNIT } });

  assert.match(out.journal, /01-a u1: PARTIAL/);
  assert.match(out.journal, /workflow died after 1 commit\(s\)/);
  assert.match(out.journal, /boom: the workflow threw/);
});

test("stop in the control file ends the night after the current unit", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A"), "02-b.md": spec("B") } });
  const script = [`echo stop >> "$STATEDIR/control"`, PASS_UNIT].join("\n");
  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: script } });

  assert.match(out.journal, /control: stop/);
  assert.match(out.journal, /end: 1 outcome\(s\) landed/);
  assert.equal(/02-b u1:/.test(out.journal), false);
});

test("a PASS whose verify log is missing is downgraded and nothing lands", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A", "Units: 1") } });
  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: PASS_NO_LOG } });

  assert.match(out.journal, /01-a u1: PARTIAL/);
  assert.match(out.journal, /verify evidence missing for bash scripts\/check/);
  assert.equal(out.landed, "");
  assert.match(out.journal, /end: 0 outcome\(s\) landed/);
  assert.equal(branches(r).some((b) => b.endsWith("/01-a")), true);
});

test("a PASS with no verify results at all is downgraded, not landed", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A", "Units: 1") } });
  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: PASS_NO_RESULTS } });

  assert.match(out.journal, /01-a u1: PARTIAL/);
  assert.match(out.journal, /verify evidence missing for \(no verify results in the result file\)/);
  assert.equal(out.landed, "");
  assert.match(out.journal, /end: 0 outcome\(s\) landed/);
});

test("a landed row carries five fields and this run's stamp", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A") } });
  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: PASS_UNIT } });

  const stamp = out.journal.match(/start: .*run (\d{8}-\d{6})/)[1];
  const row = out.landed.trim().split("\n")[0].split("\t");
  assert.equal(row.length, 5);
  assert.equal(row[0], "01-a");
  assert.equal(row[1], stamp);
  assert.match(row[2], /^[0-9a-f]{40}$/);
  assert.match(row[3], /^[0-9a-f]{40}$/);
  assert.match(row[4], /01-a\.md$/);
});

test("the control file is consumed by complete lines only, and the offset advances", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A", "Units: 3") } });
  // Unit 1 appends a partial line ("sto"); unit 2 completes it ("p\n"). The
  // launcher must ignore the partial and honour "stop" at the next boundary.
  const script = [
    `case "$UNIT" in 1) printf 'sto' >> "$STATEDIR/control" ;; 2) printf 'p\\n' >> "$STATEDIR/control" ;; esac`,
    CONTINUE_UNIT,
  ].join("\n");
  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: script } });

  assert.match(out.journal, /01-a u1: CONTINUE/);
  assert.match(out.journal, /01-a u2: CONTINUE/);
  assert.equal(/01-a u3:/.test(out.journal), false, "stop must land before unit 3");
  assert.match(out.journal, /control: stop/);
  assert.equal(/unknown/.test(out.journal), false, "a partial line must not be read as a command");
  const size = statSync(join(r.state, "control")).size;
  assert.equal(Number(out.controlOffset), size);
  assert.equal(readFileSync(join(r.state, "control"), "utf8"), "stop\n");
});

test("the spec is snapshotted per unit and the record line carries wall clock", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A", "Units: 1") } });
  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: PASS_UNIT } });

  const snap = readFileSync(join(r.state, "outcomes", "01-a", "u1.spec.md"), "utf8");
  assert.match(snap, /^# A$/m);
  const rec = JSON.parse(out.decisions.trim().split("\n")[0]);
  assert.match(rec.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(rec.endedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof rec.durationS, "number");
});

test("--only takes a comma-separated list", () => {
  const r = nightwatchRepo({
    specs: { "01-a.md": spec("A"), "02-b.md": spec("B"), "03-c.md": spec("C") },
  });
  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: PASS_UNIT }, args: ["--only", "01-a,03-c"] });

  assert.match(out.journal, /01-a u1: PASS/);
  assert.match(out.journal, /03-c u1: PASS/);
  assert.equal(/02-b u1:/.test(out.journal), false);
});

// ---- a repo name is enough ------------------------------------------------

test("--print-settings ships the two guards, the scrub opt-out and BASE", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A") } });
  writeConfig(r.home, "r", { REPO: r.clone, ORIGIN: r.origin, CLONE: r.clone, SPECS: r.specsDir, BASE: "main", CHECK: "/x/check" });

  const { settings } = printSettings(r, "r");

  assert.equal(settings.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "0");
  assert.equal(settings.env.BASE, "main");
  const entry = settings.hooks.PreToolUse[0];
  assert.equal(entry.matcher, "Bash");
  assert.equal(entry.hooks.length, 2);
  assert.match(entry.hooks[0].command, /^node '.*\/no-route-around-ci\.mjs'$/);
  assert.match(entry.hooks[1].command, /^node '.*\/tests-are-readonly\.mjs'$/);
});

test("the guard paths resolve from a plugin directory whose name has a space", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A") } });
  writeConfig(r.home, "r", { CLONE: r.clone, SPECS: r.specsDir, BASE: "main", CHECK: "/x/check" });
  const copy = join(r.root, "nw plugin", "nightshift");
  cpSync(PLUGIN, copy, { recursive: true });

  const { settings } = printSettings(r, "r", { runSh: join(copy, "nightwatch", "run.sh") });

  for (const h of settings.hooks.PreToolUse[0].hooks) {
    const path = h.command.match(/^node '(.*)'$/)[1];
    assert.match(path, /nw plugin\//);
    assert.equal(existsSync(path), true, `${path} must exist on disk`);
  }
});

test("a bare name lands exactly as the two-positional form does, with the config's check in args", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A") } });
  const check = genCheck(join(r.root, "gen"), "check", "echo CHECK OK");
  writeConfig(r.home, "r", { CLONE: r.clone, SPECS: r.specsDir, BASE: "main", CHECK: check.path, CHECK_SHA: check.sha });

  const out = runNightwatch(r, { positional: ["r"], stateName: "r", env: { FAKE_NW_SCRIPT: PASS_UNIT } });

  assert.equal(out.code, 0, out.stderr);
  assert.match(out.journal, /01-a: PASS, landed on nightwatch\//);
  assert.match(out.landed, /^01-a\t/m);
  assert.ok(out.prompts.includes(`"check":"${check.path}"`), out.prompts.slice(0, 400));
});

test("a bare name with no config exits 64 and says to run init", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A") } });
  const out = runNightwatch(r, { positional: ["r"], stateName: "r" });

  assert.equal(out.code, 64);
  assert.match(out.stderr, /no config for r; run init\.mjs/);
});

// ---- the dry run has to prove itself --------------------------------------

const DRY_UNIT = (allPass, clean) =>
  writeResult({
    state: "DRYRUN", unit: 1, unitTitle: "dry", summary: "acceptance did not run", blockedReason: "", commits: [],
    verify: { results: [], allPass, checkOk: allPass, clean },
  });

test("a dry run whose acceptance did not pass is a failed launch", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A") } });
  const out = runNightwatch(r, { args: ["--dry-run"], env: { FAKE_NW_SCRIPT: DRY_UNIT(false, true) } });

  assert.match(out.journal, /01-a: dry run FAILED: acceptance did not run/);
  assert.equal(out.code, 1);
});

test("a dry run that passed and left the tree clean is a complete one", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A") } });
  const out = runNightwatch(r, { args: ["--dry-run"], env: { FAKE_NW_SCRIPT: DRY_UNIT(true, true) } });

  assert.match(out.journal, /01-a: dry run complete/);
  assert.equal(/dry run FAILED/.test(out.journal), false);
  assert.equal(out.code, 0, out.stderr);
});

// ---- the landing branch --------------------------------------------------

test("a landing branch with nothing on it moves forward to origin/BASE", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A") } });
  r.git("branch", "nightwatch/2026-01-01");
  writeFileSync(join(r.clone, "more.txt"), "more\n");
  r.git("add", "-A");
  r.git("commit", "-q", "-m", "base moved");
  r.git("push", "-q", "origin", "main");

  const out = runNightwatch(r, { env: { DATE: "2026-01-01", FAKE_NW_SCRIPT: PASS_UNIT } });

  assert.match(out.journal, /landing branch nightwatch\/2026-01-01 moved to origin\/main/);
  const landing = execFileSync("git", ["rev-parse", "nightwatch/2026-01-01~1"], { cwd: r.clone, encoding: "utf8" }).trim();
  const base = execFileSync("git", ["rev-parse", "origin/main"], { cwd: r.clone, encoding: "utf8" }).trim();
  assert.equal(landing, base, "the outcome landed on top of the moved base");
});

test("a landing branch carrying its own commit is left where it is", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A") } });
  r.git("switch", "-q", "-c", "nightwatch/2026-01-01");
  writeFileSync(join(r.clone, "own.txt"), "own\n");
  r.git("add", "-A");
  r.git("commit", "-q", "-m", "already landed something");
  const kept = r.git("rev-parse", "HEAD");
  r.git("switch", "-q", "main");
  writeFileSync(join(r.clone, "more.txt"), "more\n");
  r.git("add", "-A");
  r.git("commit", "-q", "-m", "base moved");
  r.git("push", "-q", "origin", "main");

  const out = runNightwatch(r, { env: { DATE: "2026-01-01", FAKE_NW_SCRIPT: PASS_UNIT } });

  assert.equal(/moved to origin\/main/.test(out.journal), false);
  assert.match(out.journal, /landing branch nightwatch\/2026-01-01 exists at .*; continuing on it/);
  const landing = execFileSync("git", ["rev-parse", "nightwatch/2026-01-01~1"], { cwd: r.clone, encoding: "utf8" }).trim();
  assert.equal(landing, kept);
});

// ---- the launcher's own check --------------------------------------------

test("a generated check the unit rewrote is a changed script, and nothing lands", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A") } });
  const check = genCheck(join(r.root, "gen"), "check", "echo CHECK OK");
  writeConfig(r.home, "r", { CLONE: r.clone, SPECS: r.specsDir, BASE: "main", CHECK: check.path, CHECK_SHA: check.sha });
  const script = [`printf '#!/usr/bin/env bash\\necho pwned\\necho CHECK OK\\n' > "${check.path}"`, PASS_UNIT].join("\n");

  const out = runNightwatch(r, { positional: ["r"], stateName: "r", env: { FAKE_NW_SCRIPT: script } });

  assert.match(out.journal, /01-a: launcher check: script changed/);
  assert.match(out.journal, /01-a: FAILED; branch/);
  assert.equal(out.landed, "");
  assert.match(out.journal, /end: 0 outcome\(s\) landed/);
});

test("a generated check that exits non-zero fails the outcome the unit called PASS", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A") } });
  const check = genCheck(join(r.root, "gen"), "check", "exit 1");
  writeConfig(r.home, "r", { CLONE: r.clone, SPECS: r.specsDir, BASE: "main", CHECK: check.path, CHECK_SHA: check.sha });

  const out = runNightwatch(r, { positional: ["r"], stateName: "r", env: { FAKE_NW_SCRIPT: PASS_UNIT } });

  assert.match(out.journal, /01-a: launcher check: exit=1/);
  assert.equal(out.landed, "");
});

test("a passing generated check writes its own log and the outcome lands", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A") } });
  const check = genCheck(join(r.root, "gen"), "check", "echo CHECK OK");
  writeConfig(r.home, "r", { CLONE: r.clone, SPECS: r.specsDir, BASE: "main", CHECK: check.path, CHECK_SHA: check.sha });

  const out = runNightwatch(r, { positional: ["r"], stateName: "r", env: { FAKE_NW_SCRIPT: PASS_UNIT } });

  const log = readFileSync(join(out.state, "outcomes", "01-a", "u1-logs", "launcher-check.log"), "utf8");
  assert.equal(log, "CHECK OK\nexit=0\n");
  assert.match(out.landed, /^01-a\t/m);
});

test("a repo-owned check rewritten on the branch is judged by the base branch's copy", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A") } });
  // The base's own check fails, so a rewrite on the outcome branch cannot save it.
  writeFileSync(join(r.clone, "scripts", "check"), "#!/usr/bin/env bash\nexit 1\n");
  r.git("add", "-A");
  r.git("commit", "-q", "-m", "base check fails");
  r.git("push", "-q", "origin", "main");
  const script = [`printf '#!/usr/bin/env bash\\necho CHECK OK\\n' > scripts/check`, PASS_UNIT].join("\n");

  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: script } });

  assert.match(out.journal, /01-a: check script changed on this branch; review it in the PR/);
  assert.match(out.journal, /01-a: launcher check: exit=1/);
  assert.equal(out.landed, "");
});

test("a rewritten repo-owned check still lands when the base's copy passes, and the morning says so", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A") } });
  const script = [`printf '#!/usr/bin/env bash\\necho CHECK OK\\n' > scripts/check`, PASS_UNIT].join("\n");

  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: script } });

  assert.match(out.landed, /^01-a\t/m);
  assert.match(out.journal, /01-a: check script changed on this branch; review it in the PR/);
  // The base copy is discriminating: it prints CHECK OK only from the clone root.
  const log = readFileSync(join(out.state, "outcomes", "01-a", "u1-logs", "launcher-check.log"), "utf8");
  assert.equal(log, "CHECK OK\nexit=0\n");
  assert.equal(existsSync(join(r.clone, "scripts", ".nw-base-check")), false, "the base copy is removed after the run");

  const report = execFileSync(process.execPath, [MORNING, out.state], { encoding: "utf8" });
  assert.match(report, /check script changed on this branch; review it in the PR/);
});

test("a check path with a space survives the config, the args JSON and the engine's wrapper", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A") } });
  const check = genCheck(join(r.root, "a b"), "check", "echo CHECK OK");
  writeConfig(r.home, "r", { CLONE: r.clone, SPECS: r.specsDir, BASE: "main", CHECK: check.path });

  const { args } = printSettings(r, "r");
  assert.equal(args.check, `"${check.path}"`);

  // The engine runs every command as `bash -c '<command>'`; double quotes are
  // the only wrapping that survives that, which is why check_cmd uses them.
  const res = spawnSync("bash", ["-c", `bash -c '${args.check}'`], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^CHECK OK$/m);
});

// ---- the guards the launcher ships, run directly ---------------------------

test("the hook files --print-settings names deny a force push and a test deletion", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A") } });
  writeConfig(r.home, "r", { CLONE: r.clone, SPECS: r.specsDir, BASE: "main", CHECK: "/x/check" });
  const { settings } = printSettings(r, "r");
  const [route, tests] = settings.hooks.PreToolUse[0].hooks.map((h) => h.command.match(/^node '(.*)'$/)[1]);

  const bare = join(r.root, "bare");
  mkdirSync(bare, { recursive: true });
  const fire = (hook, payload, cwd) =>
    spawnSync(process.execPath, [hook], { input: JSON.stringify(payload), encoding: "utf8", cwd });

  const denied = fire(route, { tool_name: "Bash", tool_input: { command: "git push --force origin main" }, cwd: bare }, bare);
  assert.match(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, /^deny$/);

  const hookRepo = join(r.root, "hookrepo");
  mkdirSync(join(hookRepo, "tests"), { recursive: true });
  const git = (...a) => execFileSync("git", a, { cwd: hookRepo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(hookRepo, "tests", "a.test.mjs"), 'test("keeps", () => {});\n');
  writeFileSync(join(hookRepo, "src.mjs"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");

  git("rm", "-q", join("tests", "a.test.mjs"));
  const del = fire(tests, { tool_name: "Bash", tool_input: { command: "git commit -m x" }, cwd: hookRepo }, hookRepo);
  assert.match(JSON.parse(del.stdout).hookSpecificOutput.permissionDecisionReason, /deletes test file\(s\): tests\/a\.test\.mjs/);

  git("reset", "-q", "--hard", "HEAD");
  writeFileSync(join(hookRepo, "src.mjs"), "export const a = 2;\n");
  git("add", "src.mjs");
  const ok = fire(tests, { tool_name: "Bash", tool_input: { command: "git commit -m x" }, cwd: hookRepo }, hookRepo);
  assert.equal(ok.stdout, "", "a commit that touches no test must pass");
});

// ---- Codex diff review round 1: four holes around the launcher's own check ----

// The bound needs coreutils `timeout` (init's preflight requires it on a real machine); a bare macOS
// runner has none, and the launcher then runs the check unbounded, as documented.
const HAS_TIMEOUT = spawnSync("bash", ["-c", "command -v timeout"]).status === 0;

test("a unit that rewrites the config's CHECK for the next run is FAILED, the config is restored, and the night ends", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A"), "02-b.md": spec("B") } });
  const check = genCheck(join(r.root, "gen"), "check", "echo CHECK OK");
  const stateDir = writeConfig(r.home, "r", { CLONE: r.clone, SPECS: r.specsDir, BASE: "main", CHECK: check.path, CHECK_SHA: check.sha });
  const before = readFileSync(join(stateDir, "config"), "utf8");
  // The worker leaves the trusted script alone and poisons the config instead: a trivial check2 for next time.
  const poison = [
    `printf '#!/usr/bin/env bash\\necho CHECK OK\\n' > "${join(r.root, "gen", "check2")}"; chmod 755 "${join(r.root, "gen", "check2")}"`,
    `sed -i '' -e 's#^CHECK=.*#CHECK=${join(r.root, "gen", "check2")}#' -e 's#^CHECK_SHA=.*#CHECK_SHA=deadbeef#' "${join(stateDir, "config")}"`,
    PASS_UNIT,
  ].join("\n");
  const out = runNightwatch(r, { positional: ["r"], stateName: "r", env: { FAKE_NW_SCRIPT: poison } });

  assert.equal(out.code, 1);
  assert.match(out.journal, /STOP: config changed during 01-a unit 1; restored it/);
  assert.match(out.journal, /01-a: FAILED; branch/);
  assert.doesNotMatch(out.journal, /PASS, landed on/);
  assert.doesNotMatch(out.journal, /02-b:/);
  assert.equal(readFileSync(join(stateDir, "config"), "utf8"), before);
});

test("the launcher's own check runs under UNIT_TIMEOUT, so a hanging check cannot hold the night", { skip: !HAS_TIMEOUT && "no coreutils timeout on PATH" }, () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A") } });
  const check = genCheck(join(r.root, "gen"), "check", "sleep 30; echo CHECK OK");
  writeConfig(r.home, "r", { CLONE: r.clone, SPECS: r.specsDir, BASE: "main", CHECK: check.path, CHECK_SHA: check.sha });
  const out = runNightwatch(r, { positional: ["r"], stateName: "r", env: { FAKE_NW_SCRIPT: PASS_UNIT, UNIT_TIMEOUT: "2s" }, timeout: 60000 });

  assert.match(out.journal, /01-a: launcher check: exit=124/);
  assert.doesNotMatch(out.journal, /PASS, landed on/);
});

test("a clone path with no slash, such as `.` from inside the clone, is a clone and not a name", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A") } });
  const res = spawnSync("bash", [RUN_SH, ".", r.specsDir, "--print-settings"], {
    cwd: r.clone, encoding: "utf8",
    env: { PATH: `${r.bin}:${process.env.PATH}`, HOME: r.home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });

  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stderr, /no config for/);
  assert.match(res.stdout, /"hooks"/);
});

test("a repo whose scripts/check is a committed symlink still passes the launcher's check", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A") } });
  writeFileSync(join(r.clone, "scripts", "check-common"), "#!/usr/bin/env bash\ncd \"$(dirname \"$0\")/..\" && test -f README.md && echo CHECK OK\n");
  chmodSync(join(r.clone, "scripts", "check-common"), 0o755);
  execFileSync("rm", [join(r.clone, "scripts", "check")]);
  execFileSync("ln", ["-s", "check-common", join(r.clone, "scripts", "check")]);
  r.git("add", "-A"); r.git("commit", "-q", "-m", "check is a symlink"); r.git("push", "-q", "origin", "main");
  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: PASS_UNIT } });

  assert.equal(out.code, 0, out.stderr);
  assert.match(out.journal, /01-a: PASS, landed on/);
  const lg = readFileSync(join(r.state, "outcomes", "01-a", "u1-logs", "launcher-check.log"), "utf8").trim().split("\n");
  assert.deepEqual(lg.slice(-2), ["CHECK OK", "exit=0"]);
});

test("a background process the unit leaves behind dies with the unit, so it cannot rewrite the config afterwards", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A") } });
  const check = genCheck(join(r.root, "gen"), "check", "echo CHECK OK");
  const stateDir = writeConfig(r.home, "r", { CLONE: r.clone, SPECS: r.specsDir, BASE: "main", CHECK: check.path, CHECK_SHA: check.sha });
  const before = readFileSync(join(stateDir, "config"), "utf8");
  const orphan = [
    `(sleep 3; sed -i '' -e 's#^CHECK_SHA=.*#CHECK_SHA=deadbeef#' "${join(stateDir, "config")}") >/dev/null 2>&1 &`,
    PASS_UNIT,
  ].join("\n");
  const out = runNightwatch(r, { positional: ["r"], stateName: "r", env: { FAKE_NW_SCRIPT: orphan } });
  execFileSync("sleep", ["4"]);

  assert.equal(out.code, 0, out.stderr);
  assert.match(out.journal, /01-a: PASS, landed on/);
  assert.equal(readFileSync(join(stateDir, "config"), "utf8"), before, "the orphan never got to write");
});

test("the launcher's own check is also bounded by the deadline, not only by UNIT_TIMEOUT", { skip: !HAS_TIMEOUT && "no coreutils timeout on PATH" }, () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A") } });
  const check = genCheck(join(r.root, "gen"), "check", "sleep 30; echo CHECK OK");
  writeConfig(r.home, "r", { CLONE: r.clone, SPECS: r.specsDir, BASE: "main", CHECK: check.path, CHECK_SHA: check.sha });
  const t0 = Date.now();
  const out = runNightwatch(r, { positional: ["r"], stateName: "r", env: { FAKE_NW_SCRIPT: PASS_UNIT, DEADLINE: "2s", UNIT_TIMEOUT: "3m", CHECK_GRACE_S: "1" }, timeout: 60000 });

  assert.match(out.journal, /01-a: launcher check: exit=124/);
  assert.ok(Date.now() - t0 < 20000, `took ${Date.now() - t0} ms`);
});

test("a kept branch cut before another outcome landed is rebased onto the landing branch, then lands", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A", "Units: 1") } });
  const date = "2026-01-01"; // DATE is an env override in run.sh; the launcher's own is local time
  r.git("switch", "-q", "-c", `nw/${date}/01-a`);
  writeFileSync(join(r.clone, "a.txt"), "a\n");
  r.git("add", "-A"); r.git("commit", "-q", "-m", "a: earlier unit");
  r.git("switch", "-q", "-c", `nightwatch/${date}`, "main");
  writeFileSync(join(r.clone, "other.txt"), "other\n");
  r.git("add", "-A"); r.git("commit", "-q", "-m", "other outcome landed");
  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: PASS_UNIT, DATE: date } });

  assert.match(out.journal, /01-a: rebased onto nightwatch\/\S+ at \w+; the unit verifies the rebased tree/);
  assert.match(out.journal, /01-a: PASS, landed on/);
  assert.doesNotMatch(out.journal, /fast-forward .* failed/);
});

test("a kept branch whose rebase conflicts is BLOCKED before any unit runs, and the branch is kept", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A", "Units: 1") } });
  const date = "2026-01-01"; // DATE is an env override in run.sh; the launcher's own is local time
  r.git("switch", "-q", "-c", `nw/${date}/01-a`);
  writeFileSync(join(r.clone, "README.md"), "branch version\n");
  r.git("add", "-A"); r.git("commit", "-q", "-m", "a: edits README");
  r.git("switch", "-q", "-c", `nightwatch/${date}`, "main");
  writeFileSync(join(r.clone, "README.md"), "landed version\n");
  r.git("add", "-A"); r.git("commit", "-q", "-m", "other outcome edits README");
  const out = runNightwatch(r, { env: { FAKE_NW_SCRIPT: PASS_UNIT, DATE: date } });

  assert.match(out.journal, /01-a: BLOCKED, rebase onto nightwatch\/\S+ conflicts in README\.md; branch kept/);
  assert.doesNotMatch(out.journal, /01-a u1:/);
  assert.ok(branches(r).includes(`nw/${date}/01-a`));
  assert.equal(r.git("rev-parse", "--abbrev-ref", "HEAD"), `nightwatch/${date}`);
});

// ---- the plugin's agents travel with the launcher --------------------------

test("--print-settings ships worker and verifier through --agents, and the verifier cannot write", () => {
  const r = nightwatchRepo({ specs: { "01-a.md": spec("A") } });
  writeConfig(r.home, "r", { CLONE: r.clone, SPECS: r.specsDir, BASE: "main", CHECK: "/x/check" });

  const { agents } = printSettings(r, "r");

  assert.deepEqual(Object.keys(agents).sort(), ["verifier", "worker"]);
  assert.equal(agents.worker.model, "sonnet");
  assert.equal(agents.worker.effort, "medium");
  assert.match(agents.worker.prompt, /STOP and report the conflict/);
  assert.equal(agents.verifier.effort, "low");
  assert.deepEqual(agents.verifier.disallowedTools, ["Write", "Edit", "NotebookEdit"]);
  assert.doesNotMatch(agents.verifier.prompt, /<!--/, "HTML comments are stripped from the prompt");
});

test("the plugin's worker is the same text as the user-level worker, when one exists", { skip: !existsSync(join(process.env.HOME || "", ".claude", "agents", "worker.md")) && "no ~/.claude/agents/worker.md here" }, () => {
  const strip = (t) => t.replace(/<!--[\s\S]*?-->/g, "").trim();
  const plugin = strip(readFileSync(join(PLUGIN, "agents", "worker.md"), "utf8"));
  const user = strip(readFileSync(join(process.env.HOME, ".claude", "agents", "worker.md"), "utf8"));
  assert.equal(plugin, user);
});

test("the engine's Reconcile and Verify phases dispatch the verifier, and Implement the worker", () => {
  const engine = readFileSync(join(PLUGIN, "nightwatch", "nightwatch.mjs"), "utf8");
  assert.equal((engine.match(/agentType: 'verifier'/g) || []).length, 4);
  assert.equal((engine.match(/agentType: 'worker'/g) || []).length, 3);
  assert.doesNotMatch(engine, /schema: (VERIFY|RECONCILE), model:/);
});
