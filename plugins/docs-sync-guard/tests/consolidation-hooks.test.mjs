// @ts-check
// Tests for the consolidation trigger hooks: Stop arms a flag, UserPromptSubmit
// consumes it fire-once. Hooks run as child processes with synthetic payloads —
// the same contract Claude Code uses at runtime.
//
// State files live in CLAUDE_PLUGIN_DATA, which each test points at a throwaway dir
// so runs cannot see each other's flags.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  realpathSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { RECORD_REL, repoHash, deferMarkerPath } from "../scripts/lib.mjs";

const STOP = fileURLToPath(
  new URL("../scripts/stop-check-consolidation-drift.mjs", import.meta.url),
);
const PROMPT = fileURLToPath(
  new URL("../scripts/check-consolidation-flag.mjs", import.meta.url),
);
const DEFER = fileURLToPath(
  new URL("../scripts/defer-consolidation.mjs", import.meta.url),
);

/**
 * @param {string} cmd
 * @param {string} cwd
 */
function sh(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * @param {string} hook
 * @param {object} payload
 * @param {string} dataDir
 * @param {Record<string,string>} [extraEnv]
 */
function run(hook, payload, dataDir, extraEnv = {}) {
  const res = spawnSync("node", [hook], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, ...extraEnv },
  });
  return { status: res.status, stdout: res.stdout ?? "" };
}

/** Repo with a seed commit, a committed record, and `extra` commits after it. */
function scenario(extra = 0) {
  // realpath, because the hooks key state files off `git rev-parse --show-toplevel`,
  // which prints the REAL path. On macOS mkdtemp hands back /var/... while git says
  // /private/var/..., so without this the test computes a different repoHash than the
  // hook does and looks for a flag filename that never existed. Same /var symlink
  // gotcha this plugin's CLAUDE.md already records for the commit gate.
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "dsg-hooks-")));
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "dsg-data-"));
  sh("git init -q -b main", root);
  sh("git config user.email t@t.t && git config user.name t", root);
  sh('git commit -q --allow-empty -m "seed"', root);
  const audited = sh("git rev-parse HEAD", root);
  writeFileSync(path.join(root, RECORD_REL), `docs-sync: audited=${audited}\n`);
  sh(`git add ${RECORD_REL}`, root);
  sh('git commit -q -m "docs: consolidate"', root);
  for (let i = 0; i < extra; i++) sh(`git commit -q --allow-empty -m "c${i}"`, root);
  return {
    root,
    dataDir,
    audited,
    // Takes the session id: asserting "no flag" against a hardcoded sid would pass
    // vacuously whenever the run under test used a different one.
    flag: (sid = "sid1") => path.join(dataDir, `consolidate-nudge-${sid}-${repoHash(root)}.flag`),
    deferFile: () => /** @type {string} */ (deferMarkerPath(root)),
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

const T = (n) => ({ DOCS_SYNC_CONSOLIDATE_THRESHOLD: String(n) });

// ---- Stop: when to arm ----

test("no record → no flag", () => {
  const s = scenario(50);
  try {
    rmSync(path.join(s.root, RECORD_REL));
    const { status } = run(STOP, { session_id: "sid1", cwd: s.root }, s.dataDir, T(5));
    assert.equal(status, 0);
    assert.equal(existsSync(s.flag()), false);
  } finally {
    s.cleanup();
  }
});

test("record deleted from the working tree → no flag (opt-out)", () => {
  const s = scenario(50);
  try {
    rmSync(path.join(s.root, RECORD_REL));
    run(STOP, { session_id: "sid1", cwd: s.root }, s.dataDir, T(5));
    assert.equal(existsSync(s.flag()), false);
  } finally {
    s.cleanup();
  }
});

test("threshold boundary: count 49 → no flag; count 50 → flag", () => {
  // The record commit is 1, so `extra` of 48 gives count 49.
  const below = scenario(48);
  try {
    run(STOP, { session_id: "sid1", cwd: below.root }, below.dataDir, T(50));
    assert.equal(existsSync(below.flag()), false, "count 49 must not arm");
  } finally {
    below.cleanup();
  }

  const at = scenario(49);
  try {
    run(STOP, { session_id: "sid1", cwd: at.root }, at.dataDir, T(50));
    assert.equal(existsSync(at.flag()), true, "count 50 must arm");
  } finally {
    at.cleanup();
  }
});

test("throttle: a second Stop at the same HEAD does not re-arm", () => {
  const s = scenario(10);
  try {
    run(STOP, { session_id: "sid1", cwd: s.root }, s.dataDir, T(5));
    assert.equal(existsSync(s.flag()), true);
    rmSync(s.flag());
    run(STOP, { session_id: "sid1", cwd: s.root }, s.dataDir, T(5));
    assert.equal(existsSync(s.flag()), false, "unchanged HEAD must not re-arm");
  } finally {
    s.cleanup();
  }
});

test("a new commit re-arms the throttle", () => {
  const s = scenario(10);
  try {
    run(STOP, { session_id: "sid1", cwd: s.root }, s.dataDir, T(5));
    rmSync(s.flag());
    sh('git commit -q --allow-empty -m "more"', s.root);
    run(STOP, { session_id: "sid1", cwd: s.root }, s.dataDir, T(5));
    assert.equal(existsSync(s.flag()), true);
  } finally {
    s.cleanup();
  }
});

// ---- Stop: defer ----

test("defer suppresses until threshold further commits", () => {
  const s = scenario(10);
  try {
    writeFileSync(s.deferFile(), sh("git rev-parse HEAD", s.root));
    run(STOP, { session_id: "sid1", cwd: s.root }, s.dataDir, T(5));
    assert.equal(existsSync(s.flag()), false, "deferred → silent");

    sh('git commit -q --allow-empty -m "a"', s.root);
    run(STOP, { session_id: "sid2", cwd: s.root }, s.dataDir, T(5));
    assert.equal(existsSync(s.flag("sid2")), false, "1 commit past defer → still silent");

    for (let i = 0; i < 5; i++) sh(`git commit -q --allow-empty -m "b${i}"`, s.root);
    run(STOP, { session_id: "sid1", cwd: s.root }, s.dataDir, T(5));
    assert.equal(existsSync(s.flag()), true, "threshold past defer → arms again");
  } finally {
    s.cleanup();
  }
});

test("defer survives a NEW session — it is repo-keyed, not session-keyed", () => {
  // Keying the defer by session would silently reduce "not now" to "not this
  // session", which is the single behaviour defer exists to prevent.
  const s = scenario(10);
  try {
    writeFileSync(s.deferFile(), sh("git rev-parse HEAD", s.root));
    run(STOP, { session_id: "a-totally-different-session", cwd: s.root }, s.dataDir, T(5));
    const flags = readdirSync(s.dataDir).filter((f) => f.endsWith(".flag"));
    assert.deepEqual(flags, [], "a fresh session must still respect the defer");
  } finally {
    s.cleanup();
  }
});

test("a defer holding a non-ancestor SHA is dropped, so defer keeps working afterwards", () => {
  // The danger is not one wrong nudge — it is that `rev-list --count <orphan>..HEAD`
  // walks the whole rewritten branch, so the bogus SHA yields a huge count forever
  // and defer is silently dead for this repo from then on. Dropping it restores the
  // feature. The defer check only runs when drift is already stale, so the scenario
  // has to be past the threshold to reach it at all.
  const s = scenario(10);
  try {
    sh("git checkout -q -b side", s.root);
    sh('git commit -q --allow-empty -m "orphan"', s.root);
    const orphan = sh("git rev-parse HEAD", s.root);
    sh("git checkout -q main", s.root);
    writeFileSync(s.deferFile(), orphan);

    run(STOP, { session_id: "sid1", cwd: s.root }, s.dataDir, T(5));
    assert.equal(existsSync(s.deferFile()), false, "stale defer must be dropped");
    assert.equal(existsSync(s.flag()), true, "ordinary drift decides once it is gone");

    // And a fresh defer works again — the point of dropping it.
    rmSync(s.flag());
    writeFileSync(s.deferFile(), sh("git rev-parse HEAD", s.root));
    run(STOP, { session_id: "sid2", cwd: s.root }, s.dataDir, T(5));
    assert.equal(existsSync(s.flag()), false, "re-deferring must suppress again");
  } finally {
    s.cleanup();
  }
});

test("git entirely unavailable → exit 0, no output, and no state touched", () => {
  const s = scenario(10);
  try {
    writeFileSync(s.deferFile(), sh("git rev-parse HEAD", s.root));
    // Absolute node path so the interpreter still starts, but an empty PATH so no
    // `git` can be found. Spawning "node" here would fail with ENOENT and the test
    // would pass for the wrong reason.
    const res = spawnSync(process.execPath, [STOP], {
      input: JSON.stringify({ session_id: "sid1", cwd: s.root }),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "/nonexistent",
        CLAUDE_PLUGIN_DATA: s.dataDir,
        DOCS_SYNC_CONSOLIDATE_THRESHOLD: "5",
      },
    });
    assert.equal(res.status, 0);
    assert.equal((res.stdout ?? "").trim(), "");
    assert.equal(existsSync(s.deferFile()), true, "a broken git must not erase a defer");
    assert.equal(existsSync(s.flag()), false);
  } finally {
    s.cleanup();
  }
});

test("the --defer COMMAND writes where the Stop hook reads — no shared env var", () => {
  // The reason this is a script and not skill prose: CLAUDE_PLUGIN_DATA is not
  // exported to session shells, so a defer path derived from it would be written
  // somewhere the hook never looks. This runs the real command with that variable
  // absent, exactly as a session would, and then checks the hook honours it.
  const s = scenario(10);
  try {
    const env = { ...process.env };
    delete env.CLAUDE_PLUGIN_DATA;
    const res = spawnSync(process.execPath, [DEFER, s.root], { encoding: "utf8", env });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(existsSync(s.deferFile()), true, "the command must create the marker");

    run(STOP, { session_id: "sid1", cwd: s.root }, s.dataDir, T(5));
    assert.equal(existsSync(s.flag()), false, "the hook must honour the deferral");

    const cleared = spawnSync(process.execPath, [DEFER, s.root, "--clear"], {
      encoding: "utf8",
      env,
    });
    assert.equal(cleared.status, 0);
    assert.equal(existsSync(s.deferFile()), false);
    run(STOP, { session_id: "sid2", cwd: s.root }, s.dataDir, T(5));
    assert.equal(existsSync(s.flag("sid2")), true, "clearing lets the nudge fire again");
  } finally {
    s.cleanup();
  }
});

test("the path the SKILL tells the agent to run actually resolves", () => {
  // The skill can only use its own base directory: CLAUDE_PLUGIN_ROOT and
  // CLAUDE_PLUGIN_DATA are both unset in session shells, so a command built from
  // either expands to a broken path and fails with MODULE_NOT_FOUND. This pins the
  // documented relative hop so renaming or moving the script breaks a test rather
  // than breaking /docs-consolidate --defer silently.
  const skillDir = fileURLToPath(new URL("../skills/docs-consolidate", import.meta.url));
  const asDocumented = path.join(skillDir, "..", "..", "scripts", "defer-consolidation.mjs");
  assert.equal(existsSync(asDocumented), true, `skill points at a missing file: ${asDocumented}`);
  assert.equal(realpathSync(asDocumented), realpathSync(DEFER));

  const skillText = readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
  assert.match(skillText, /\.\.\/\.\.\/scripts\/defer-consolidation\.mjs/);
  assert.doesNotMatch(
    skillText.replace(/Do \*\*not\*\* use `\$\{CLAUDE_PLUGIN_ROOT\}`[\s\S]*?available here\./, ""),
    /\$\{CLAUDE_PLUGIN_ROOT\}/,
    "the skill must not instruct the agent to use a hook-only variable",
  );
});

test("an unreadable defer marker is silence, not permission to nudge", () => {
  const s = scenario(10);
  try {
    writeFileSync(s.deferFile(), sh("git rev-parse HEAD", s.root));
    chmodSync(s.deferFile(), 0o000);
    run(STOP, { session_id: "sid1", cwd: s.root }, s.dataDir, T(5));
    assert.equal(existsSync(s.flag()), false, "cannot-tell must not arm a deferred nudge");
  } finally {
    try {
      chmodSync(s.deferFile(), 0o644);
    } catch {
      /* already gone */
    }
    s.cleanup();
  }
});

test("an empty defer marker is also silence", () => {
  const s = scenario(10);
  try {
    writeFileSync(s.deferFile(), "   \n");
    run(STOP, { session_id: "sid1", cwd: s.root }, s.dataDir, T(5));
    assert.equal(existsSync(s.flag()), false);
  } finally {
    s.cleanup();
  }
});

test("the defer marker is not a committable file", () => {
  const s = scenario(0);
  try {
    spawnSync(process.execPath, [DEFER, s.root], { encoding: "utf8" });
    assert.equal(sh("git status --porcelain", s.root), "", "must leave the tree clean");
  } finally {
    s.cleanup();
  }
});

// ---- UserPromptSubmit: consuming ----

test("consumes the flag fire-once and emits additionalContext", () => {
  const s = scenario(10);
  try {
    run(STOP, { session_id: "sid1", cwd: s.root }, s.dataDir, T(5));
    assert.equal(existsSync(s.flag()), true);

    const first = run(PROMPT, { session_id: "sid1", cwd: s.root }, s.dataDir);
    const out = JSON.parse(first.stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "UserPromptSubmit");
    assert.match(out.additionalContext, /docs-consolidate/);
    assert.equal(existsSync(s.flag()), false, "flag must be consumed");

    const second = run(PROMPT, { session_id: "sid1", cwd: s.root }, s.dataDir);
    assert.equal(second.stdout.trim(), "", "fire-once");
  } finally {
    s.cleanup();
  }
});

test("opting out between arming and consuming stays silent", () => {
  // Stop arms at the end of a turn; the user deletes .docs-sync before the next
  // prompt. The documented contract is that a deleted record goes silent immediately,
  // so an already-armed flag must not still speak.
  const s = scenario(10);
  try {
    run(STOP, { session_id: "sid1", cwd: s.root }, s.dataDir, T(5));
    assert.equal(existsSync(s.flag()), true);

    rmSync(path.join(s.root, RECORD_REL));
    const res = run(PROMPT, { session_id: "sid1", cwd: s.root }, s.dataDir);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "", "opt-out must win over an armed flag");
    assert.equal(existsSync(s.flag()), false, "and the stale flag must be cleared");
  } finally {
    s.cleanup();
  }
});

test("flags do not leak across repos in one session", () => {
  // Stop ends a turn in repo A; the user changes to repo B before the next prompt.
  // Session-only keying would consume A's flag and tell the agent to consolidate B.
  const a = scenario(10);
  const b = scenario(0);
  try {
    run(STOP, { session_id: "sid1", cwd: a.root }, a.dataDir, T(5));
    assert.equal(existsSync(a.flag()), true);

    const inB = run(PROMPT, { session_id: "sid1", cwd: b.root }, a.dataDir);
    assert.equal(inB.stdout.trim(), "", "must stay silent in repo B");
    assert.equal(existsSync(a.flag()), true, "A's flag must survive");

    const backInA = run(PROMPT, { session_id: "sid1", cwd: a.root }, a.dataDir);
    assert.match(JSON.parse(backInA.stdout).hookSpecificOutput.additionalContext, /docs-consolidate/);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

// ---- fail open ----

test("both hooks exit 0 and stay silent on malformed stdin and non-repo cwd", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsg-nogit-"));
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "dsg-data-"));
  try {
    for (const hook of [STOP, PROMPT]) {
      const bad = spawnSync("node", [hook], {
        input: "not json",
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
      });
      assert.equal(bad.status, 0);
      assert.equal((bad.stdout ?? "").trim(), "");

      // Valid JSON that is not a payload object. `safeJsonParse("[]")` returns an array, which
      // is `typeof "object"` and not null, so a null-only guard lets it through to the ambient
      // cwd and session "unknown" — the same defect as malformed stdin, one step further in.
      const notAnObject = spawnSync("node", [hook], {
        input: "[]",
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
      });
      assert.equal(notAnObject.status, 0);
      assert.equal((notAnObject.stdout ?? "").trim(), "");

      const nonRepo = run(hook, { session_id: "sid1", cwd: dir }, dataDir);
      assert.equal(nonRepo.status, 0);
      assert.equal(nonRepo.stdout.trim(), "");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
