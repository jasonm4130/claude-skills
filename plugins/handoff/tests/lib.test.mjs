// @ts-check
// Unit tests for shared lib.mjs helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  symlinkSync,
  realpathSync,
  utimesSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import {
  safeJsonParse,
  resolveSessionId,
  resolveDataDir,
  nowIso,
  lastAssistantUsageFromTranscript,
  readContainedFile,
  dirContainedIn,
  claimBand,
  bandMarkerPath,
  resetBands,
  acquireInflightLock,
} from "../scripts/lib.mjs";

test("safeJsonParse returns object for valid JSON", () => {
  assert.deepEqual(safeJsonParse('{"a":1}'), { a: 1 });
});

test("safeJsonParse returns null for invalid JSON", () => {
  assert.equal(safeJsonParse("not json"), null);
});

test("safeJsonParse returns null for empty input", () => {
  assert.equal(safeJsonParse(""), null);
});

test("safeJsonParse returns null for non-object JSON", () => {
  assert.equal(safeJsonParse("42"), null);
  assert.equal(safeJsonParse('"str"'), null);
  assert.equal(safeJsonParse("null"), null);
});

test("resolveSessionId prefers payload.session_id", () => {
  assert.equal(resolveSessionId({ session_id: "abc" }), "abc");
});

test("resolveSessionId falls back to env, then 'unknown'", () => {
  const prev = process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  assert.equal(resolveSessionId(null), "unknown");
  process.env.CLAUDE_SESSION_ID = "envsid";
  assert.equal(resolveSessionId(null), "envsid");
  assert.equal(resolveSessionId({}), "envsid");
  if (prev === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = prev;
});

test("resolveDataDir uses CLAUDE_PLUGIN_DATA when set", (t) => {
  const dir = path.join(os.tmpdir(), `handoff-lib-test-${randomUUID()}`);
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
    rmSync(dir, { recursive: true, force: true });
  });
  const resolved = resolveDataDir("handoff-data");
  assert.equal(resolved, dir);
  assert.ok(existsSync(dir), "data dir should be created");
});

test("resolveDataDir falls back to tmpdir/<fallbackName>", (t) => {
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;
  const fallback = `handoff-fallback-${randomUUID()}`;
  t.after(() => {
    if (prev !== undefined) process.env.CLAUDE_PLUGIN_DATA = prev;
    rmSync(path.join(os.tmpdir(), fallback), { recursive: true, force: true });
  });
  const resolved = resolveDataDir(fallback);
  assert.equal(resolved, path.join(os.tmpdir(), fallback));
  assert.ok(existsSync(resolved));
});

test("nowIso returns YYYY-MM-DDTHH:MM:SSZ", () => {
  const ts = nowIso();
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

// --- lastAssistantUsageFromTranscript tests ---

function mkTmpDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-lib-transcript-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeTranscript(dir, lines) {
  const filePath = path.join(dir, `${randomUUID()}.jsonl`);
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n"));
  return filePath;
}

test("lastAssistantUsageFromTranscript: returns null for nonexistent path", () => {
  const result = lastAssistantUsageFromTranscript("/nonexistent/path/to/file.jsonl");
  assert.equal(result, null);
});

test("lastAssistantUsageFromTranscript: returns null for empty file", (t) => {
  const dir = mkTmpDir(t);
  const filePath = path.join(dir, "empty.jsonl");
  writeFileSync(filePath, "");
  const result = lastAssistantUsageFromTranscript(filePath);
  assert.equal(result, null);
});

test("lastAssistantUsageFromTranscript: returns null when no assistant entries exist", (t) => {
  const dir = mkTmpDir(t);
  const filePath = writeTranscript(dir, [
    { type: "user", message: { content: "hello" } },
    { type: "system", message: { content: "system msg" } },
  ]);
  const result = lastAssistantUsageFromTranscript(filePath);
  assert.equal(result, null);
});

test("lastAssistantUsageFromTranscript: returns usage from last main-chain assistant entry", (t) => {
  const dir = mkTmpDir(t);
  const filePath = writeTranscript(dir, [
    {
      type: "assistant",
      isSidechain: false,
      message: { usage: { input_tokens: 100, cache_creation_input_tokens: 500, cache_read_input_tokens: 1000 } },
    },
    {
      type: "assistant",
      isSidechain: false,
      message: { usage: { input_tokens: 200, cache_creation_input_tokens: 600, cache_read_input_tokens: 2000 } },
    },
  ]);
  const result = lastAssistantUsageFromTranscript(filePath);
  assert.deepEqual(result, { inputTokens: 200, cacheCreationTokens: 600, cacheReadTokens: 2000 });
});

test("lastAssistantUsageFromTranscript: skips sidechain entries (isSidechain: true)", (t) => {
  const dir = mkTmpDir(t);
  const filePath = writeTranscript(dir, [
    {
      type: "assistant",
      isSidechain: false,
      message: { usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    },
    {
      type: "assistant",
      isSidechain: true,
      message: { usage: { input_tokens: 9999, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    },
  ]);
  const result = lastAssistantUsageFromTranscript(filePath);
  assert.deepEqual(result, { inputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0 });
});

test("lastAssistantUsageFromTranscript: handles missing usage fields as 0", (t) => {
  const dir = mkTmpDir(t);
  const filePath = writeTranscript(dir, [
    {
      type: "assistant",
      message: { usage: { input_tokens: 50 } },
    },
  ]);
  const result = lastAssistantUsageFromTranscript(filePath);
  assert.deepEqual(result, { inputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 });
});

test("lastAssistantUsageFromTranscript: handles entry with no usage object", (t) => {
  const dir = mkTmpDir(t);
  const filePath = writeTranscript(dir, [
    {
      type: "assistant",
      message: {},
    },
  ]);
  const result = lastAssistantUsageFromTranscript(filePath);
  assert.deepEqual(result, { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 });
});

test("lastAssistantUsageFromTranscript: tolerates malformed JSON lines mixed with valid ones", (t) => {
  const dir = mkTmpDir(t);
  const filePath = path.join(dir, "mixed.jsonl");
  writeFileSync(
    filePath,
    [
      JSON.stringify({ type: "assistant", isSidechain: false, message: { usage: { input_tokens: 77 } } }),
      "this is not valid json {{{",
      "",
      JSON.stringify({ type: "user", message: {} }),
    ].join("\n"),
  );
  // The last valid assistant entry is the first line (scanning backwards, user line is skipped, bad line is skipped)
  const result = lastAssistantUsageFromTranscript(filePath);
  assert.deepEqual(result, { inputTokens: 77, cacheCreationTokens: 0, cacheReadTokens: 0 });
});

test("lastAssistantUsageFromTranscript: isSidechain undefined is treated as main-chain", (t) => {
  const dir = mkTmpDir(t);
  const filePath = writeTranscript(dir, [
    {
      type: "assistant",
      // isSidechain not present
      message: { usage: { input_tokens: 42, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 } },
    },
  ]);
  const result = lastAssistantUsageFromTranscript(filePath);
  assert.deepEqual(result, { inputTokens: 42, cacheCreationTokens: 10, cacheReadTokens: 5 });
});

test("readContainedFile: reads a plain file, refuses non-bare names", (t) => {
  // realpathSync the temp base: on macOS os.tmpdir() sits under /var -> /private/var.
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "handoff-read-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  writeFileSync(path.join(base, "handoff.md"), "the handoff body");
  mkdirSync(path.join(base, "sub"));
  writeFileSync(path.join(base, "sub", "nested.md"), "nested");

  assert.equal(readContainedFile(base, "handoff.md"), "the handoff body");
  assert.equal(readContainedFile(base, "missing.md"), null, "a nonexistent file is refused");
  assert.equal(readContainedFile(base, "../../.env"), null, "traversal is refused");
  assert.equal(readContainedFile(base, "sub/nested.md"), null, "only bare filenames are accepted");
  assert.equal(readContainedFile(base, "/etc/passwd"), null, "absolute paths are refused");
  assert.equal(readContainedFile(base, ".."), null);
  assert.equal(readContainedFile(base, ""), null);
  assert.equal(readContainedFile(base, "bad\0name.md"), null, "a NUL byte must not throw");
  assert.equal(readContainedFile(base, "sub"), null, "a directory is not a regular file");
});

test("readContainedFile: refuses a symlinked target", { skip: process.platform === "win32" }, (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "handoff-symlink-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, "handoffs");
  mkdirSync(base);
  writeFileSync(path.join(root, "secret.env"), "API_KEY=super-secret-value");
  symlinkSync(path.join(root, "secret.env"), path.join(base, "innocent.md"));

  assert.equal(readContainedFile(base, "innocent.md"), null, "O_NOFOLLOW must refuse, not follow");
});

test("readContainedFile: a FIFO is refused without hanging", { skip: process.platform === "win32" }, (t) => {
  // A plain open() on a FIFO blocks until a writer appears — the reason the open must be
  // non-blocking. If this test times out, O_NONBLOCK is missing.
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "handoff-fifo-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  execFileSync("mkfifo", [path.join(base, "trap.md")]);

  assert.equal(readContainedFile(base, "trap.md"), null, "a FIFO is not a regular file");
});

test("dirContainedIn: true inside the root, false for an escaping symlink", { skip: process.platform === "win32" }, (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "handoff-dir-")));
  const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), "handoff-out-")));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const inner = path.join(root, ".claude", "handoffs");
  mkdirSync(inner, { recursive: true });
  assert.equal(dirContainedIn(root, inner), true);

  const escaped = path.join(root, "escaped");
  symlinkSync(outside, escaped);
  assert.equal(dirContainedIn(root, escaped), false, ".claude/handoffs symlinked out must not pass");
  assert.equal(dirContainedIn(root, path.join(root, "nope")), false, "a missing dir is not contained");
});

// --- claimBand / bandMarkerPath / resetBands / acquireInflightLock (Task 1) ---

test("claimBand: exactly one of N callers claiming the same band wins", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-claim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // The EEXIST branch, reached deterministically — no child processes, no hoping two spawns overlap.
  const results = [0, 1, 2, 3].map(() => claimBand(dir, "sid", 70, 0));
  assert.deepEqual(results, [true, false, false, false], "the first claim wins; the rest see EEXIST");
  assert.equal(existsSync(bandMarkerPath(dir, "sid", 70, 0)), true);
});

test("claimBand: different bands are independent claims", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-claim2-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(claimBand(dir, "sid", 70, 0), true);
  assert.equal(claimBand(dir, "sid", 70, 1), true, "band 1 is a separate claim from band 0");
  assert.equal(claimBand(dir, "sid", 70, 1), false, "but band 1 is still claim-once");
});

test("claimBand: a band's identity includes its threshold", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-claim3-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // "band 0" means 70-80% under a threshold of 70 and 80-90% under a threshold of 80 — different
  // bands, so different markers. This is about marker identity, NOT about what happens when a user
  // changes HANDOFF_THRESHOLD_PCT: the transition gate governs that, and it may never reach here.
  assert.equal(claimBand(dir, "sid", 70, 0), true);
  assert.equal(claimBand(dir, "sid", 80, 0), true, "a different threshold is a different band");
  assert.equal(claimBand(dir, "sid", 70, 0), false, "…and each is still claim-once");
});

test("claimBand: an unwritable data dir returns false rather than throwing", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-claim4-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The statusline must never die on a state-write failure.
  assert.equal(claimBand(path.join(dir, "does-not-exist"), "sid", 70, 0), false);
});

test("resetBands: clears this session's ladder across thresholds, leaves other sessions alone", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-reset-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  claimBand(dir, "mine", 70, 0);
  claimBand(dir, "mine", 80, 1);
  claimBand(dir, "other", 70, 0);

  resetBands(dir, "mine");

  assert.equal(existsSync(bandMarkerPath(dir, "mine", 70, 0)), false);
  assert.equal(existsSync(bandMarkerPath(dir, "mine", 80, 1)), false, "reset spans thresholds");
  assert.equal(existsSync(bandMarkerPath(dir, "other", 70, 0)), true, "another session is untouched");
  assert.equal(claimBand(dir, "mine", 70, 0), true, "after a reset, the band can be claimed again");
});

test("resetBands: a session id that PREFIXES another does not eat its markers", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-reset2-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  claimBand(dir, "a", 70, 0);
  claimBand(dir, "a-x", 70, 0); // "handoff-fired-a-x-t70-b0" starts with "handoff-fired-a-"

  resetBands(dir, "a");

  assert.equal(existsSync(bandMarkerPath(dir, "a", 70, 0)), false, "our own marker is cleared");
  assert.equal(
    existsSync(bandMarkerPath(dir, "a-x", 70, 0)), true,
    "a bare-prefix match would have deleted this — the reset must anchor on the full marker name",
  );
});

test("acquireInflightLock: acquires when free, refuses when a LIVE holder is present", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "l.lock");

  assert.equal(acquireInflightLock(lock, 2000), true, "a free lock is acquired");
  assert.equal(readFileSync(lock, "utf8"), String(process.pid));

  // A live holder (this process), fresh. A second acquire must lose — and must NOT overwrite the pid.
  assert.equal(acquireInflightLock(lock, 2000), false, "a held lock is not stolen");
  assert.equal(readFileSync(lock, "utf8"), String(process.pid), "the holder's lock is intact");
});

test("acquireInflightLock: refuses to displace a LIVE holder even past the lease", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-lock2-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "l.lock");
  writeFileSync(lock, String(process.pid)); // this process is alive
  const old = new Date(Date.now() - 30_000);
  utimesSync(lock, old, old); // and its lock is far past the 2s lease

  // There is NO statusLine timeout, so a slow invocation can outlive any lease we pick. Age alone
  // must never justify a break — this is the bug that produced double-fires in 0.5.1.
  assert.equal(acquireInflightLock(lock, 2000), false, "an old lock held by a LIVE process is not stale");
  assert.equal(readFileSync(lock, "utf8"), String(process.pid));
});

test("acquireInflightLock: breaks a lock that is BOTH past the lease AND held by a dead pid", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-lock3-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "l.lock");
  writeFileSync(lock, "2147483646"); // a pid that cannot exist
  const old = new Date(Date.now() - 30_000);
  utimesSync(lock, old, old);

  assert.equal(acquireInflightLock(lock, 2000), true, "a dead holder's stale lock must not freeze the bar forever");
  assert.equal(readFileSync(lock, "utf8"), String(process.pid), "we are the new holder");
});

test("acquireInflightLock: a FRESH empty lock is not treated as a dead holder", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-lock4-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "l.lock");
  writeFileSync(lock, ""); // create() has returned but write() has not landed yet

  // parseInt("") is NaN. Treating NaN as "dead" would steal the lock from a live process mid-write —
  // one of the four races that killed 0.5.1.
  assert.equal(acquireInflightLock(lock, 2000), false, "an unparseable pid is NOT proof the holder is dead");
  assert.equal(readFileSync(lock, "utf8"), "", "the mid-write holder's lock is untouched");
});

test("acquireInflightLock: an ANCIENT empty lock is broken — a crash must not freeze the bar forever", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-lock5-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "l.lock");
  writeFileSync(lock, ""); // a process died between create() and write()
  const ancient = new Date(Date.now() - 60_000);
  utimesSync(lock, ancient, ancient);

  // The complement of the test above, and the reason EMPTY_LOCK_GRACE_MS exists: if "unparseable"
  // meant "alive" forever, this lock would be immortal and every future invocation would replay a
  // stale render or "?" — the bar would freeze permanently. The create→write window is microseconds,
  // so a lock still empty after 10s is a corpse.
  assert.equal(acquireInflightLock(lock, 2000), true, "an ancient empty lock is breakable");
  assert.equal(readFileSync(lock, "utf8"), String(process.pid), "we are the new holder");
});
