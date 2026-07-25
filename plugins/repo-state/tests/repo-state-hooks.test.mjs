// @ts-check
// Tests for the repo-state hooks. Each test builds a real throwaway git repo, writes a
// docs/CURRENT_STATE.md with a chosen stamp, and runs a hook as a child process with a
// synthetic payload — the same contract Claude Code uses at runtime.
//
// The two load-bearing behaviours, per the plan:
//   1. Threshold boundary in BOTH directions (24 silent / 25 stale) — a guard that fires
//      constantly gets ignored, and one that never fires is decoration.
//   2. Fail open on every error path — this hook must never be the reason a session breaks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONSTART = join(pluginRoot, "scripts", "sessionstart-check-staleness.mjs");
const STOP = join(pluginRoot, "scripts", "stop-check-state-drift.mjs");
const CONSUME = join(pluginRoot, "scripts", "check-state-flag.mjs");
const DOC_REL = "docs/CURRENT_STATE.md";

/** @param {string[]} args @param {string} cwd */
function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@e",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@e",
    },
  }).trim();
}

/** Fresh repo with one initial commit. @returns {string} repo path */
function newRepo() {
  const dir = mkdtempSync(join(os.tmpdir(), "repo-state-test-"));
  git(["init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  git(["add", "seed.txt"], dir);
  git(["commit", "-qm", "seed"], dir);
  return dir;
}

/** @param {string} dir @param {number} n @param {string} [prefix] */
function commitN(dir, n, prefix = "f") {
  for (let i = 0; i < n; i++) {
    writeFileSync(join(dir, `${prefix}${i}.txt`), `${i}\n`);
    git(["add", `${prefix}${i}.txt`], dir);
    git(["commit", "-qm", `${prefix}${i}`], dir);
  }
}

/** Write the state doc with an explicit stamp commit. Does NOT commit it. */
function writeDoc(dir, stampSha, body = "# state\n") {
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(
    join(dir, DOC_REL),
    `<!-- repo-state: commit=${stampSha} generated=2026-07-25T00:00:00Z -->\n\n${body}`,
  );
}

/** @param {string} script @param {object} payload @param {Record<string,string>} [env] */
function runHook(script, payload, env = {}) {
  const res = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: res.status, stdout: (res.stdout || "").trim(), stderr: res.stderr || "" };
}

/** Parse a hookSpecificOutput envelope. */
function parsed(stdout) {
  return JSON.parse(stdout).hookSpecificOutput;
}

function dataDir() {
  return mkdtempSync(join(os.tmpdir(), "repo-state-data-"));
}

// ---------------------------------------------------------------- silence paths

test("doc absent → silent (unadopted repos never see this plugin)", () => {
  const dir = newRepo();
  try {
    const r = runHook(SESSIONSTART, { cwd: dir, session_id: "s1" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stamp == HEAD → silent", () => {
  const dir = newRepo();
  try {
    writeDoc(dir, git(["rev-parse", "HEAD"], dir));
    const r = runHook(SESSIONSTART, { cwd: dir, session_id: "s1" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- threshold, both directions

test("24 commits behind → silent (below default threshold)", () => {
  const dir = newRepo();
  try {
    const stamp = git(["rev-parse", "HEAD"], dir);
    commitN(dir, 24);
    writeDoc(dir, stamp);
    const r = runHook(SESSIONSTART, { cwd: dir, session_id: "s1" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "", "24 is below the 25 default and must stay quiet");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("25 commits behind → stale warning naming the count", () => {
  const dir = newRepo();
  try {
    const stamp = git(["rev-parse", "HEAD"], dir);
    commitN(dir, 25);
    writeDoc(dir, stamp);
    const r = runHook(SESSIONSTART, { cwd: dir, session_id: "s1" });
    assert.equal(r.status, 0);
    const out = parsed(r.stdout);
    assert.equal(out.hookEventName, "SessionStart");
    assert.match(out.additionalContext, /25 commit/);
    assert.match(out.additionalContext, /CURRENT_STATE\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------- the self-re-arming bug (P2, round 2)

test("doc-only commit on a fresh stamp → drift 0, silent", () => {
  const dir = newRepo();
  try {
    const stamp = git(["rev-parse", "HEAD"], dir);
    writeDoc(dir, stamp);
    git(["add", DOC_REL], dir);
    git(["commit", "-qm", "docs: refresh current state"], dir);
    const r = runHook(SESSIONSTART, { cwd: dir, session_id: "s1" }, { REPO_STATE_DRIFT_THRESHOLD: "1" });
    assert.equal(r.status, 0);
    assert.equal(
      r.stdout,
      "",
      "the doc's own commit must not count as drift, or every refresh re-arms itself",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- rewritten / unknown history

test("stamp not an ancestor of HEAD (rebased away) → stale", () => {
  const dir = newRepo();
  try {
    commitN(dir, 1, "orphan");
    const stamp = git(["rev-parse", "HEAD"], dir);
    git(["reset", "-q", "--hard", "HEAD~1"], dir); // stamp is now off the branch
    commitN(dir, 1, "replacement");
    writeDoc(dir, stamp);
    const r = runHook(SESSIONSTART, { cwd: dir, session_id: "s1" });
    assert.equal(r.status, 0);
    assert.match(parsed(r.stdout).additionalContext, /CURRENT_STATE\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stamp SHA absent from the repo entirely → stale, no crash", () => {
  const dir = newRepo();
  try {
    writeDoc(dir, "0".repeat(40));
    const r = runHook(SESSIONSTART, { cwd: dir, session_id: "s1" });
    assert.equal(r.status, 0, "must not crash on an unknown object");
    assert.match(parsed(r.stdout).additionalContext, /CURRENT_STATE\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------- threshold env validation

for (const bad of ["0", "-5", "foo", "", "2.5"]) {
  test(`REPO_STATE_DRIFT_THRESHOLD=${JSON.stringify(bad)} → falls back to 25`, () => {
    const dir = newRepo();
    try {
      const stamp = git(["rev-parse", "HEAD"], dir);
      commitN(dir, 24);
      writeDoc(dir, stamp);
      const r = runHook(
        SESSIONSTART,
        { cwd: dir, session_id: "s1" },
        { REPO_STATE_DRIFT_THRESHOLD: bad },
      );
      assert.equal(r.status, 0);
      assert.equal(r.stdout, "", `${JSON.stringify(bad)} must not become warn-always`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("REPO_STATE_DRIFT_THRESHOLD=5 is honoured when valid", () => {
  const dir = newRepo();
  try {
    const stamp = git(["rev-parse", "HEAD"], dir);
    commitN(dir, 5);
    writeDoc(dir, stamp);
    const r = runHook(
      SESSIONSTART,
      { cwd: dir, session_id: "s1" },
      { REPO_STATE_DRIFT_THRESHOLD: "5" },
    );
    assert.equal(r.status, 0);
    assert.match(parsed(r.stdout).additionalContext, /5 commit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------- fail-open paths

test("non-git cwd → exit 0, silent", () => {
  const dir = mkdtempSync(join(os.tmpdir(), "repo-state-nongit-"));
  try {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, DOC_REL), "<!-- repo-state: commit=deadbeef generated=x -->\n");
    const r = runHook(SESSIONSTART, { cwd: dir, session_id: "s1" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt stamp → exit 0, silent", () => {
  const dir = newRepo();
  try {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, DOC_REL), "no stamp here at all\n");
    const r = runHook(SESSIONSTART, { cwd: dir, session_id: "s1" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed payload → exit 0, no crash", () => {
  const res = spawnSync(process.execPath, [SESSIONSTART], {
    input: "not json at all",
    encoding: "utf8",
  });
  assert.equal(res.status, 0);
});

// ------------------------------------------------------------- Stop → flag → consume

test("Stop arms the flag once per HEAD; a second Stop on unchanged HEAD is silent", () => {
  const dir = newRepo();
  const data = dataDir();
  try {
    const stamp = git(["rev-parse", "HEAD"], dir);
    commitN(dir, 25);
    writeDoc(dir, stamp);
    const env = { CLAUDE_PLUGIN_DATA: data };

    const first = runHook(STOP, { cwd: dir, session_id: "s9" }, env);
    assert.equal(first.status, 0);

    const consumed = runHook(CONSUME, { session_id: "s9" }, env);
    assert.equal(consumed.status, 0);
    assert.match(parsed(consumed.stdout).additionalContext, /repo-state/);
    assert.equal(parsed(consumed.stdout).hookEventName, "UserPromptSubmit");

    // Same HEAD → must not re-arm.
    runHook(STOP, { cwd: dir, session_id: "s9" }, env);
    const again = runHook(CONSUME, { session_id: "s9" }, env);
    assert.equal(again.stdout, "", "unchanged HEAD must not re-arm the nudge");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

test("UserPromptSubmit consumes the flag fire-once", () => {
  const dir = newRepo();
  const data = dataDir();
  try {
    const stamp = git(["rev-parse", "HEAD"], dir);
    commitN(dir, 25);
    writeDoc(dir, stamp);
    const env = { CLAUDE_PLUGIN_DATA: data };
    runHook(STOP, { cwd: dir, session_id: "s10" }, env);

    const first = runHook(CONSUME, { session_id: "s10" }, env);
    assert.notEqual(first.stdout, "", "first consume emits");
    const second = runHook(CONSUME, { session_id: "s10" }, env);
    assert.equal(second.stdout, "", "flag is fire-once");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

test("Stop stays silent when the doc is fresh", () => {
  const dir = newRepo();
  const data = dataDir();
  try {
    writeDoc(dir, git(["rev-parse", "HEAD"], dir));
    const env = { CLAUDE_PLUGIN_DATA: data };
    runHook(STOP, { cwd: dir, session_id: "s11" }, env);
    const consumed = runHook(CONSUME, { session_id: "s11" }, env);
    assert.equal(consumed.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});
