// @ts-check
// Tests for the consolidation drift engine in lib.mjs.
//
// Every anomaly path asserts SILENCE (null), never staleness. That is the property
// under test, and it is what removes the shallow-clone special-casing the predecessor
// design needed: a nudge toward optional work must never fire on "I cannot tell".

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_CONSOLIDATE_THRESHOLD,
  RECORD_REL,
  gitRepoRoot,
  isAncestor,
  readConsolidationStamp,
  resolveConsolidateThreshold,
  computeConsolidationDrift,
  repoHash,
} from "../scripts/lib.mjs";

/**
 * @param {string} cmd
 * @param {string} cwd
 */
function sh(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Build a throwaway repo with one initial commit. */
function newRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), "dsg-drift-"));
  sh("git init -q -b main", root);
  sh("git config user.email t@t.t && git config user.name t", root);
  writeFileSync(path.join(root, "seed.txt"), "0");
  sh("git add seed.txt", root);
  sh('git commit -q -m "seed"', root);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Write the record naming `audited`, then commit it. Mirrors what `--init` and a
 * re-stamp do: the stamp is HEAD *before* the record commit.
 * @param {string} root
 * @param {string} [audited]
 */
function stamp(root, audited) {
  const sha = audited ?? sh("git rev-parse HEAD", root);
  writeFileSync(
    path.join(root, RECORD_REL),
    `docs-sync: audited=${sha}\nLast documentation consolidation: 2026-07-25T00:00:00Z\n`,
  );
  sh(`git add ${RECORD_REL}`, root);
  sh('git commit -q -m "docs: consolidate"', root);
  return sha;
}

/**
 * Add `n` commits. Empty commits: `rev-list --count` counts them the same as any
 * other, and they avoid both the filename-collision trap of a per-call counter and
 * ~8s of file I/O in the boundary test.
 * @param {string} root
 * @param {number} n
 */
function commits(root, n) {
  for (let i = 0; i < n; i++) sh(`git commit -q --allow-empty -m "c${i}"`, root);
}

// ---- reading the record ----

test("no record → null", () => {
  const r = newRepo();
  try {
    assert.equal(readConsolidationStamp(r.root), null);
  } finally {
    r.cleanup();
  }
});

test("committed record with no audited= line → null", () => {
  const r = newRepo();
  try {
    writeFileSync(path.join(r.root, RECORD_REL), "just some prose\n");
    sh(`git add ${RECORD_REL}`, r.root);
    sh('git commit -q -m "x"', r.root);
    assert.equal(readConsolidationStamp(r.root), null);
  } finally {
    r.cleanup();
  }
});

test("committed record with a malformed SHA → null", () => {
  const r = newRepo();
  try {
    writeFileSync(path.join(r.root, RECORD_REL), "docs-sync: audited=nothex!!\n");
    sh(`git add ${RECORD_REL}`, r.root);
    sh('git commit -q -m "x"', r.root);
    assert.equal(readConsolidationStamp(r.root), null);
  } finally {
    r.cleanup();
  }
});

test("committed record → returns the audited SHA, lowercased", () => {
  const r = newRepo();
  try {
    const sha = stamp(r.root);
    assert.equal(readConsolidationStamp(r.root), sha.toLowerCase());
  } finally {
    r.cleanup();
  }
});

test("record written but NEVER committed → null (an abandoned init cannot silence a stale repo)", () => {
  const r = newRepo();
  try {
    const head = sh("git rev-parse HEAD", r.root);
    writeFileSync(path.join(r.root, RECORD_REL), `docs-sync: audited=${head}\n`);
    assert.equal(readConsolidationStamp(r.root), null);
  } finally {
    r.cleanup();
  }
});

test("record deleted from the working tree → null, before the deletion is committed", () => {
  const r = newRepo();
  try {
    stamp(r.root);
    assert.notEqual(readConsolidationStamp(r.root), null);
    unlinkSync(path.join(r.root, RECORD_REL));
    assert.equal(readConsolidationStamp(r.root), null);
  } finally {
    r.cleanup();
  }
});

test("working-tree copy hand-edited → the COMMITTED SHA wins", () => {
  const r = newRepo();
  try {
    const real = stamp(r.root);
    commits(r.root, 3);
    const forged = sh("git rev-parse HEAD", r.root);
    writeFileSync(path.join(r.root, RECORD_REL), `docs-sync: audited=${forged}\n`);
    assert.equal(readConsolidationStamp(r.root), real.toLowerCase());
  } finally {
    r.cleanup();
  }
});

test("not a git repo → null everywhere", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsg-nogit-"));
  try {
    assert.equal(gitRepoRoot(dir), null);
    assert.equal(readConsolidationStamp(dir), null);
    assert.equal(computeConsolidationDrift(dir, "a".repeat(40), 50), null);
    // null, NOT false: callers delete state on a verified `false`, and "git could
    // not answer" is not a verified absence.
    assert.equal(isAncestor(dir, "a".repeat(40)), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isAncestor: a missing object is a verified false, not an unknown", () => {
  const r = newRepo();
  try {
    assert.equal(isAncestor(r.root, "0".repeat(40)), false);
    assert.equal(isAncestor(r.root, "not-a-sha"), false);
    assert.equal(isAncestor(r.root, sh("git rev-parse HEAD", r.root)), true);
  } finally {
    r.cleanup();
  }
});

// ---- drift counting ----

test("fresh record → count 1, not stale (the record commit itself)", () => {
  const r = newRepo();
  try {
    const sha = stamp(r.root);
    const d = computeConsolidationDrift(r.root, sha, DEFAULT_CONSOLIDATE_THRESHOLD);
    // Assert 1, not 0, so nobody later "corrects" this with a pathspec exclusion —
    // `rev-list --count A..HEAD -- ':(exclude)path'` triggers history simplification
    // and stops meaning what it looks like.
    assert.deepEqual(d, { stale: false, count: 1 });
  } finally {
    r.cleanup();
  }
});

test("threshold boundary: 48 further commits (count 49) not stale; 49 further (count 50) stale", () => {
  const r = newRepo();
  try {
    const sha = stamp(r.root);
    commits(r.root, 48);
    assert.deepEqual(computeConsolidationDrift(r.root, sha, 50), { stale: false, count: 49 });
    commits(r.root, 1);
    assert.deepEqual(computeConsolidationDrift(r.root, sha, 50), { stale: true, count: 50 });
  } finally {
    r.cleanup();
  }
});

test("audited object absent from the repo → null, silent", () => {
  const r = newRepo();
  try {
    const d = computeConsolidationDrift(r.root, "0".repeat(40), 50);
    assert.equal(d, null);
  } finally {
    r.cleanup();
  }
});

test("audited present but not an ancestor (rewritten history) → null, silent", () => {
  const r = newRepo();
  try {
    sh("git checkout -q -b side", r.root);
    writeFileSync(path.join(r.root, "side.txt"), "s");
    sh("git add side.txt", r.root);
    sh('git commit -q -m "side"', r.root);
    const orphan = sh("git rev-parse HEAD", r.root);
    sh("git checkout -q main", r.root);
    commits(r.root, 2);

    assert.equal(isAncestor(r.root, orphan), false);
    assert.equal(computeConsolidationDrift(r.root, orphan, 50), null);
  } finally {
    r.cleanup();
  }
});

// ---- shallow clones: both variants land on the same silent path ----

test("shallow --depth 1: audited commit unfetched → null, silent", () => {
  const origin = newRepo();
  const dest = mkdtempSync(path.join(os.tmpdir(), "dsg-shallow-"));
  try {
    const sha = stamp(origin.root);
    commits(origin.root, 3);
    rmSync(dest, { recursive: true, force: true });
    sh(`git clone -q --depth 1 file://${origin.root} ${dest}`, os.tmpdir());

    assert.equal(computeConsolidationDrift(dest, sha, 50), null);
  } finally {
    origin.cleanup();
    rmSync(dest, { recursive: true, force: true });
  }
});

test("shallow --depth 1 --no-single-branch: object alive via another branch, path to HEAD cut → null, silent", () => {
  // Asserted separately from the case above on purpose. Under the predecessor design
  // this was a DISTINCT bug that hid behind the fix for the first one: the object is
  // present (so cat-file succeeds) but the path to HEAD is truncated, so an ancestry
  // check answers "no" for a commit that IS an ancestor upstream. Only a separate
  // test proves the anomaly-is-silence rule actually covers both.
  const origin = newRepo();
  const dest = mkdtempSync(path.join(os.tmpdir(), "dsg-shallow2-"));
  try {
    const sha = stamp(origin.root);
    sh(`git branch keepalive ${sha}`, origin.root);
    commits(origin.root, 3);
    rmSync(dest, { recursive: true, force: true });
    sh(`git clone -q --depth 1 --no-single-branch file://${origin.root} ${dest}`, os.tmpdir());

    assert.equal(computeConsolidationDrift(dest, sha, 50), null);
  } finally {
    origin.cleanup();
    rmSync(dest, { recursive: true, force: true });
  }
});

// ---- threshold parsing ----

test("threshold: only a plain positive integer is honoured", () => {
  const bad = ["0", "-5", "foo", "", "3.5", " ", "1e3", "0x10"];
  for (const raw of bad) {
    assert.equal(
      resolveConsolidateThreshold({ DOCS_SYNC_CONSOLIDATE_THRESHOLD: raw }),
      DEFAULT_CONSOLIDATE_THRESHOLD,
      `"${raw}" should fall back to the default`,
    );
  }
  assert.equal(resolveConsolidateThreshold({}), DEFAULT_CONSOLIDATE_THRESHOLD);
  assert.equal(resolveConsolidateThreshold({ DOCS_SYNC_CONSOLIDATE_THRESHOLD: "  12  " }), 12);
  assert.equal(resolveConsolidateThreshold({ DOCS_SYNC_CONSOLIDATE_THRESHOLD: "1" }), 1);
});

// ---- repo keying ----

test("repoHash is stable, 12 hex chars, and distinguishes repos", () => {
  const a = repoHash("/a/b");
  assert.equal(a, repoHash("/a/b"));
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.notEqual(a, repoHash("/a/c"));
});
