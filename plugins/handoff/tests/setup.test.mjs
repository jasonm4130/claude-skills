// @ts-check
// Tests for setup.mjs: stable statusLine wrapper generation and settings.json patching.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const setupScript = path.join(here, "..", "scripts", "setup.mjs");

/**
 * Creates a temporary CLAUDE_HOME directory with a fake plugin cache.
 * @param {object} [opts]
 * @param {string[]} [opts.versions] - version strings to create under the fake cache
 * @param {string[]} [opts.extraDirs] - extra (non-semver) dir names to create
 * @returns {{ dir: string, claudeDir: string, settingsPath: string, wrapperPath: string, cacheBase: string }}
 */
function mkFakeHome(opts = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-setup-test-"));
  const claudeDir = path.join(dir, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const settingsPath = path.join(claudeDir, "settings.json");
  const wrapperPath = path.join(claudeDir, "handoff-statusline.mjs");

  const cacheBase = path.join(
    claudeDir,
    "plugins",
    "cache",
    "jasonm4130-claude-skills",
    "handoff",
  );

  for (const ver of opts.versions ?? []) {
    const scriptDir = path.join(cacheBase, ver, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(
      path.join(scriptDir, "status-and-flag.mjs"),
      `// fake status-and-flag.mjs for version ${ver}\n`,
    );
  }

  for (const extra of opts.extraDirs ?? []) {
    mkdirSync(path.join(cacheBase, extra, "scripts"), { recursive: true });
    writeFileSync(
      path.join(cacheBase, extra, "scripts", "status-and-flag.mjs"),
      `// fake for ${extra}\n`,
    );
  }

  return { dir, claudeDir, settingsPath, wrapperPath, cacheBase };
}

/**
 * @param {string[]} extraArgs
 * @param {{ dir: string, claudeDir: string }} fakeHome
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runSetup(extraArgs, fakeHome) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [setupScript, ...extraArgs], {
      env: {
        ...process.env,
        // Override home so setup.mjs writes to our temp dir
        CLAUDE_HOME_OVERRIDE: fakeHome.claudeDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    child.stdin.end();
  });
}

// --- Cleanup helper ---
/** @param {string} dir */
function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// ============================================================================
// setup.mjs — wrapper file tests
// ============================================================================

test("setup.mjs writes handoff-statusline.mjs to claudeDir", async (t) => {
  const fakeHome = mkFakeHome({ versions: ["0.2.1"] });
  t.after(() => cleanup(fakeHome.dir));

  const result = await runSetup([], fakeHome);
  assert.equal(result.code, 0, `setup failed: ${result.stderr}`);
  assert.ok(
    existsSync(fakeHome.wrapperPath),
    `wrapper not created at ${fakeHome.wrapperPath}`,
  );
});

test("setup.mjs points statusLine command at the wrapper, not versioned path", async (t) => {
  const fakeHome = mkFakeHome({ versions: ["0.2.1"] });
  t.after(() => cleanup(fakeHome.dir));

  await runSetup([], fakeHome);

  const settings = JSON.parse(readFileSync(fakeHome.settingsPath, "utf8"));
  const cmd = settings.statusLine?.command ?? "";

  // Must point at the wrapper file in claudeDir
  assert.ok(
    cmd.includes("handoff-statusline.mjs"),
    `command should reference handoff-statusline.mjs, got: ${cmd}`,
  );
  // Must NOT embed a versioned cache path
  assert.ok(
    !cmd.includes("plugins/cache"),
    `command should not contain versioned plugins/cache path, got: ${cmd}`,
  );
});

test("generated wrapper runs the resolved script in-process, not as a child", async (t) => {
  const fakeHome = mkFakeHome({ versions: ["0.2.1"] });
  t.after(() => cleanup(fakeHome.dir));

  await runSetup([], fakeHome);
  const wrapper = readFileSync(fakeHome.wrapperPath, "utf8");

  // The statusLine is the most frequently invoked script in the plugin, and a child
  // process costs a second Node cold start per render (~30ms of pure startup, measured
  // 73.9ms -> 40.4ms for byte-identical output). Spawning must not creep back in.
  assert.ok(
    !wrapper.includes("child_process"),
    "wrapper must not spawn a child process — that doubles Node startup per render",
  );
  assert.match(wrapper, /await import\(/, "wrapper should import the resolved script in-process");
  // A bare absolute path is not a valid import specifier on Windows.
  assert.match(
    wrapper,
    /pathToFileURL\(resolvedScript\)/,
    "wrapper must convert the resolved path to a file URL before importing",
  );
  // The old child.on("error") fallback rendered "?" — the catch must preserve it.
  assert.match(
    wrapper,
    /catch \{\s*process\.stdout\.write\("\?/,
    "wrapper must still degrade to '?' when the resolved script fails to load",
  );
});

test("setup.mjs is idempotent: running twice produces same result", async (t) => {
  const fakeHome = mkFakeHome({ versions: ["0.2.1"] });
  t.after(() => cleanup(fakeHome.dir));

  const r1 = await runSetup([], fakeHome);
  assert.equal(r1.code, 0, `first run failed: ${r1.stderr}`);

  const wrapper1 = readFileSync(fakeHome.wrapperPath, "utf8");
  const settings1 = readFileSync(fakeHome.settingsPath, "utf8");

  const r2 = await runSetup([], fakeHome);
  assert.equal(r2.code, 0, `second run failed: ${r2.stderr}`);

  const wrapper2 = readFileSync(fakeHome.wrapperPath, "utf8");
  const settings2 = readFileSync(fakeHome.settingsPath, "utf8");

  assert.equal(wrapper1, wrapper2, "wrapper content changed on second run");
  assert.equal(settings1, settings2, "settings.json changed on second run");
});

// ============================================================================
// setup.mjs — migration: old versioned statusLine should be replaced without --force
// ============================================================================

test("setup.mjs replaces old versioned statusLine without --force", async (t) => {
  const fakeHome = mkFakeHome({ versions: ["0.2.1"] });
  t.after(() => cleanup(fakeHome.dir));

  // Pre-seed settings.json with the OLD versioned form
  const oldCmd = `node "${path.join(fakeHome.claudeDir, "plugins", "cache", "jasonm4130-claude-skills", "handoff", "0.2.1", "scripts", "status-and-flag.mjs")}"`;
  writeFileSync(
    fakeHome.settingsPath,
    JSON.stringify({ statusLine: { type: "command", command: oldCmd } }, null, 2) + "\n",
  );

  const result = await runSetup([], fakeHome);
  assert.equal(result.code, 0, `setup failed: ${result.stderr}`);

  const settings = JSON.parse(readFileSync(fakeHome.settingsPath, "utf8"));
  const cmd = settings.statusLine?.command ?? "";
  assert.ok(
    cmd.includes("handoff-statusline.mjs"),
    `should have replaced old versioned path, got: ${cmd}`,
  );
});

test("setup.mjs exits 1 without --force when unrelated statusLine exists", async (t) => {
  const fakeHome = mkFakeHome({ versions: ["0.2.1"] });
  t.after(() => cleanup(fakeHome.dir));

  writeFileSync(
    fakeHome.settingsPath,
    JSON.stringify(
      { statusLine: { type: "command", command: 'node "/some/other/script.mjs"' } },
      null,
      2,
    ) + "\n",
  );

  const result = await runSetup([], fakeHome);
  assert.equal(result.code, 1, "should fail without --force for unrelated statusLine");
});

test("setup.mjs --force overwrites unrelated statusLine", async (t) => {
  const fakeHome = mkFakeHome({ versions: ["0.2.1"] });
  t.after(() => cleanup(fakeHome.dir));

  writeFileSync(
    fakeHome.settingsPath,
    JSON.stringify(
      { statusLine: { type: "command", command: 'node "/some/other/script.mjs"' } },
      null,
      2,
    ) + "\n",
  );

  const result = await runSetup(["--force"], fakeHome);
  assert.equal(result.code, 0, `--force run failed: ${result.stderr}`);

  const settings = JSON.parse(readFileSync(fakeHome.settingsPath, "utf8"));
  assert.ok(settings.statusLine?.command?.includes("handoff-statusline.mjs"));
});

// ============================================================================
// Wrapper script logic — semver resolution
// ============================================================================

/**
 * Import the wrapper resolution logic by loading the wrapper generated by setup.
 * Instead of exec-testing the wrapper inline (it'd stdin-block on status-and-flag),
 * we test the semver-picking logic by importing a helper module, or by providing
 * a fake status script that just echoes a known string.
 *
 * Strategy: write a fake CLAUDE_HOME with specific versions, run setup to produce
 * the wrapper, then exec the wrapper in an env that points at that fake home, and
 * check it picks the right version (by observing which fake script was called).
 */

/**
 * Create a fake home with versioned fake scripts that each emit their version.
 * @param {string[]} versions
 * @param {string[]} [orphaned] versions to mark with an `.orphaned_at` marker,
 *   the way Claude Code marks a superseded or rolled-back cache directory
 * @returns {{ dir: string, claudeDir: string, settingsPath: string, wrapperPath: string }}
 */
function mkFakeHomeWithVersionedEchos(versions, orphaned = []) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-setup-ver-"));
  const claudeDir = path.join(dir, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const cacheBase = path.join(
    claudeDir,
    "plugins",
    "cache",
    "jasonm4130-claude-skills",
    "handoff",
  );

  for (const ver of versions) {
    const scriptDir = path.join(cacheBase, ver, "scripts");
    mkdirSync(scriptDir, { recursive: true });
    // Writes the version string to stdout and exits 0
    writeFileSync(
      path.join(scriptDir, "status-and-flag.mjs"),
      `#!/usr/bin/env node\nprocess.stdout.write("version:${ver}\\n");\nprocess.exit(0);\n`,
    );
  }

  for (const ver of orphaned) {
    // Real markers hold a millisecond timestamp; only presence is load-bearing.
    writeFileSync(path.join(cacheBase, ver, ".orphaned_at"), `${1784199698635}`);
  }

  return {
    dir,
    claudeDir,
    settingsPath: path.join(claudeDir, "settings.json"),
    wrapperPath: path.join(claudeDir, "handoff-statusline.mjs"),
  };
}

/**
 * Run the wrapper file directly, passing stdin.
 * @param {string} wrapperPath
 * @param {string} claudeDir
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function execWrapper(wrapperPath, claudeDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapperPath], {
      env: { ...process.env, CLAUDE_HOME_OVERRIDE: claudeDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    child.stdin.end();
  });
}

// The wrapper's upgrade/rollback contract:
//   run the highest cached version that Claude Code has NOT marked `.orphaned_at`.
// Resolution stays dynamic so an upgrade doesn't break the absolute path that
// ~/.claude/settings.json points at (the next two tests). The orphan filter is
// what stops "highest cached" from silently defeating a rollback or resurrecting
// a version the user uninstalled (the three after that).

test("wrapper picks highest semver: 0.10.0 beats 0.3.0 and 0.2.1", async (t) => {
  const fakeHome = mkFakeHomeWithVersionedEchos(["0.2.1", "0.10.0", "0.3.0"]);
  t.after(() => cleanup(fakeHome.dir));

  // Run setup to produce the wrapper in the fake home
  const setupResult = await runSetup([], {
    dir: fakeHome.dir,
    claudeDir: fakeHome.claudeDir,
  });
  assert.equal(setupResult.code, 0, `setup failed: ${setupResult.stderr}`);

  // Run the wrapper — it should delegate to 0.10.0's fake script
  const result = await execWrapper(fakeHome.wrapperPath, fakeHome.claudeDir);
  assert.ok(
    result.stdout.includes("version:0.10.0"),
    `expected version:0.10.0, got stdout: ${result.stdout}`,
  );
});

test("wrapper ignores non-semver directory names (latest, tmp, 0.2)", async (t) => {
  const fakeHome = mkFakeHomeWithVersionedEchos(["0.3.0"]);
  t.after(() => cleanup(fakeHome.dir));

  // Add non-semver dirs manually
  const cacheBase = path.join(
    fakeHome.claudeDir,
    "plugins",
    "cache",
    "jasonm4130-claude-skills",
    "handoff",
  );
  for (const bad of ["latest", "tmp", "0.2"]) {
    const d = path.join(cacheBase, bad, "scripts");
    mkdirSync(d, { recursive: true });
    // If the wrapper accidentally picks these, the output would contain the bad dir name
    writeFileSync(
      path.join(d, "status-and-flag.mjs"),
      `#!/usr/bin/env node\nprocess.stdout.write("bad:${bad}\\n");\nprocess.exit(0);\n`,
    );
  }

  const setupResult = await runSetup([], {
    dir: fakeHome.dir,
    claudeDir: fakeHome.claudeDir,
  });
  assert.equal(setupResult.code, 0, `setup failed: ${setupResult.stderr}`);

  const result = await execWrapper(fakeHome.wrapperPath, fakeHome.claudeDir);
  assert.ok(
    result.stdout.includes("version:0.3.0"),
    `expected version:0.3.0 (ignored non-semver dirs), got: ${result.stdout}`,
  );
  assert.ok(
    !result.stdout.includes("bad:"),
    `wrapper picked a non-semver dir, got: ${result.stdout}`,
  );
});

test("wrapper skips orphaned versions: a rollback to 0.7.0 takes effect", async (t) => {
  // 0.8.0 is still on disk but marked orphaned — the state left behind by a
  // rollback or an uninstall. Selecting it would silently undo the rollback.
  const fakeHome = mkFakeHomeWithVersionedEchos(["0.7.0", "0.8.0"], ["0.8.0"]);
  t.after(() => cleanup(fakeHome.dir));

  const setupResult = await runSetup([], {
    dir: fakeHome.dir,
    claudeDir: fakeHome.claudeDir,
  });
  assert.equal(setupResult.code, 0, `setup failed: ${setupResult.stderr}`);

  const result = await execWrapper(fakeHome.wrapperPath, fakeHome.claudeDir);
  assert.ok(
    result.stdout.includes("version:0.7.0"),
    `expected version:0.7.0 (0.8.0 is orphaned), got stdout: ${result.stdout}`,
  );
});

test("wrapper still upgrades across orphaned predecessors", async (t) => {
  // The normal post-upgrade state: every superseded version carries a marker,
  // the installed one does not. The wrapper must follow the upgrade.
  const fakeHome = mkFakeHomeWithVersionedEchos(
    ["0.6.0", "0.7.0", "0.8.0"],
    ["0.6.0", "0.7.0"],
  );
  t.after(() => cleanup(fakeHome.dir));

  const setupResult = await runSetup([], {
    dir: fakeHome.dir,
    claudeDir: fakeHome.claudeDir,
  });
  assert.equal(setupResult.code, 0, `setup failed: ${setupResult.stderr}`);

  const result = await execWrapper(fakeHome.wrapperPath, fakeHome.claudeDir);
  assert.ok(
    result.stdout.includes("version:0.8.0"),
    `expected version:0.8.0, got stdout: ${result.stdout}`,
  );
});

test("wrapper outputs '?' when every cached version is orphaned", async (t) => {
  // Plugin uninstalled: nothing is activated, so render nothing rather than
  // resurrect a version the user removed.
  const fakeHome = mkFakeHomeWithVersionedEchos(["0.7.0", "0.8.0"], ["0.7.0", "0.8.0"]);
  t.after(() => cleanup(fakeHome.dir));

  const setupResult = await runSetup([], {
    dir: fakeHome.dir,
    claudeDir: fakeHome.claudeDir,
  });
  assert.equal(setupResult.code, 0, `setup failed: ${setupResult.stderr}`);

  const result = await execWrapper(fakeHome.wrapperPath, fakeHome.claudeDir);
  assert.equal(result.code, 0, `wrapper should exit 0, got: ${result.code}`);
  assert.equal(
    result.stdout.trim(),
    "?",
    `wrapper should render '?' when all versions are orphaned, got: ${result.stdout}`,
  );
});

test("wrapper outputs '?' and exits 0 when no versions found", async (t) => {
  // Create a fake home with no versioned scripts
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-setup-empty-"));
  const claudeDir = path.join(dir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  t.after(() => cleanup(dir));

  const fakeHome = { dir, claudeDir };
  const setupResult = await runSetup([], fakeHome);
  assert.equal(setupResult.code, 0, `setup failed: ${setupResult.stderr}`);

  const wrapperPath = path.join(claudeDir, "handoff-statusline.mjs");
  const result = await execWrapper(wrapperPath, claudeDir);
  assert.equal(result.code, 0, `wrapper should exit 0, got: ${result.code}`);
  assert.ok(result.stdout.trim() === "?", `wrapper should output '?', got: ${result.stdout}`);
});
