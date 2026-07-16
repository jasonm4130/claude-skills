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
  statSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

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
  cachedTranscriptUsage,
  pickContextTokens,
  shouldResetBands,
  gitBranchDirty,
  modelColor,
  selectRateLimits,
  tokensSuffix,
  visibleWidth,
  truncateEnd,
  assembleStatusLine,
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

// --- cachedTranscriptUsage (Task 3) ---

const assistantLine = (n) => JSON.stringify({
  type: "assistant",
  message: { usage: { input_tokens: n, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
});

test("cachedTranscriptUsage: parses, caches to disk, re-parses when the transcript changes", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-tc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, "t.jsonl");
  writeFileSync(transcript, assistantLine(100) + "\n");

  const first = cachedTranscriptUsage(transcript, dir, "sid");
  assert.ok(first);
  assert.equal(first.inputTokens, 100);

  const cached = JSON.parse(readFileSync(path.join(dir, "transcript-usage-sid.json"), "utf8"));
  assert.equal(typeof cached.mtimeMs, "number");
  assert.equal(typeof cached.size, "number");
  assert.equal(cached.usage.inputTokens, 100, "the cache round-trips the camelCase shape");

  writeFileSync(transcript, assistantLine(100) + "\n" + assistantLine(250) + "\n");
  assert.equal(
    cachedTranscriptUsage(transcript, dir, "sid").inputTokens, 250,
    "a changed transcript is re-parsed, not served stale",
  );
});

test("cachedTranscriptUsage: an UNCHANGED transcript is served from the cache, not re-parsed", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-tc-hit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, "t.jsonl");
  writeFileSync(transcript, assistantLine(100) + "\n");
  const st = statSync(transcript);

  // Prime the cache with a value the transcript does NOT contain. If the implementation re-parses it
  // returns 100; if it honours the key it returns 999. This is the only portable way to prove a HIT
  // rather than a silent re-parse.
  writeFileSync(path.join(dir, "transcript-usage-sid.json"), JSON.stringify({
    transcriptPath: transcript, mtimeMs: st.mtimeMs, size: st.size,
    usage: { inputTokens: 999, cacheCreationTokens: 0, cacheReadTokens: 0 },
  }));

  assert.equal(cachedTranscriptUsage(transcript, dir, "sid").inputTokens, 999, "served from the cache");
});

test("cachedTranscriptUsage: a DIFFERENT transcript is never served another's cache", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-tc-x-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Two no-ID sessions both resolve to sid "unknown" and share one cache file. Give them different
  // transcripts with IDENTICAL size (same byte length) — mtime+size alone could collide.
  const a = path.join(dir, "a.jsonl");
  const b = path.join(dir, "b.jsonl");
  writeFileSync(a, assistantLine(111) + "\n");
  writeFileSync(b, assistantLine(222) + "\n");
  assert.equal(statSync(a).size, statSync(b).size, "same byte length — the collision this guards");

  assert.equal(cachedTranscriptUsage(a, dir, "unknown").inputTokens, 111);
  assert.equal(
    cachedTranscriptUsage(b, dir, "unknown").inputTokens, 222,
    "a different transcript must not be served the first one's usage",
  );
});

test("cachedTranscriptUsage: a corrupt cache file is ignored, not fatal", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-tc2-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, "t.jsonl");
  writeFileSync(transcript, assistantLine(7) + "\n");
  writeFileSync(path.join(dir, "transcript-usage-sid.json"), "{not json");

  assert.equal(cachedTranscriptUsage(transcript, dir, "sid").inputTokens, 7, "falls back to a fresh parse");
});

test("cachedTranscriptUsage: VALID JSON with a malformed usage shape re-parses", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-tc3-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, "t.jsonl");
  writeFileSync(transcript, assistantLine(42) + "\n");
  const st = statSync(transcript);
  // Parses fine, key matches — but usage has no fields. Returning it verbatim yields NaN downstream
  // and bails the bar to "?" while a perfectly good transcript sits on disk.
  writeFileSync(path.join(dir, "transcript-usage-sid.json"), JSON.stringify({
    transcriptPath: transcript, mtimeMs: st.mtimeMs, size: st.size, usage: {},
  }));

  const r = cachedTranscriptUsage(transcript, dir, "sid");
  assert.equal(r.inputTokens, 42, "a structurally-invalid cached usage falls back to a fresh parse");
  assert.equal(Number.isFinite(r.cacheReadTokens), true);
});

test("cachedTranscriptUsage: a missing transcript returns null without throwing", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-tc4-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(cachedTranscriptUsage(path.join(dir, "nope.jsonl"), dir, "sid"), null);
});

test("cachedTranscriptUsage: 'no assistant turn yet' is CACHED, not re-scanned every tick", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-tc5-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, "t.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "user", message: {} }) + "\n"); // no assistant turn

  assert.equal(cachedTranscriptUsage(transcript, dir, "sid"), null);

  // null is a valid, cacheable answer. Early in a session this state persists across many ticks, and
  // re-scanning the whole transcript each time is exactly the expensive path this cache exists to
  // remove — so the miss must be recorded, not just the hit.
  const c = JSON.parse(readFileSync(path.join(dir, "transcript-usage-sid.json"), "utf8"));
  assert.equal(c.usage, null, "the negative result is cached");
  assert.equal(c.transcriptPath, transcript);
  assert.equal(cachedTranscriptUsage(transcript, dir, "sid"), null, "and is served from the cache");
});

// --- pickContextTokens / shouldResetBands (Task 1) ---

test("pickContextTokens: transcript is primary when its sum is positive", () => {
  const transcript = { inputTokens: 100, cacheCreationTokens: 20, cacheReadTokens: 30 };
  const current = { input_tokens: 999, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  assert.equal(pickContextTokens(transcript, current), 150);
});

test("pickContextTokens: falls back to stdin only when transcript is null", () => {
  const current = { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 2 };
  assert.equal(pickContextTokens(null, current), 17);
});

test("pickContextTokens: transcript sum of zero falls through to stdin", () => {
  const transcript = { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const current = { input_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  assert.equal(pickContextTokens(transcript, current), 8);
});

test("pickContextTokens: null when neither source is usable", () => {
  assert.equal(pickContextTokens(null, null), null);
  assert.equal(pickContextTokens(null, {}), null);
});

test("shouldResetBands: resets below threshold", () => {
  assert.equal(shouldResetBands(65, 60, 70, 1), true);
});

test("shouldResetBands: resets on a real decrease while still above threshold", () => {
  // 85% -> 75% compaction: still above 70, but the reading dropped -> reset the ladder
  assert.equal(shouldResetBands(75, 85, 70, 1), true);
});

test("shouldResetBands: does NOT reset on monotonic growth", () => {
  assert.equal(shouldResetBands(76, 75, 70, 1), false);
});

test("shouldResetBands: epsilon absorbs sub-point wobble", () => {
  assert.equal(shouldResetBands(74.6, 75, 70, 1), false); // 0.4 drop < epsilon
});

// --- gitBranchDirty (Task 2) ---

function initRepo(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-git-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const g = (args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  writeFileSync(path.join(dir, "a.txt"), "1");
  g(["add", "a.txt"]);
  g(["commit", "-qm", "init"]);
  return { dir, g };
}

test("gitBranchDirty: clean repo on a branch reports label + dirty 0", (t) => {
  const { dir } = initRepo(t);
  assert.deepEqual(gitBranchDirty(dir), { label: "main", dirty: 0 });
});

test("gitBranchDirty: counts an untracked file as dirty", (t) => {
  const { dir } = initRepo(t);
  writeFileSync(path.join(dir, "b.txt"), "2");
  assert.deepEqual(gitBranchDirty(dir), { label: "main", dirty: 1 });
});

test("gitBranchDirty: detached HEAD reports @<sha>", (t) => {
  const { dir, g } = initRepo(t);
  const sha = g(["rev-parse", "--short", "HEAD"]).stdout.trim();
  g(["checkout", "-q", sha]);
  const r = gitBranchDirty(dir);
  assert.equal(r?.label, "@" + sha);
});

test("gitBranchDirty: null for a non-git directory", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-nongit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(gitBranchDirty(dir), null);
});

// --- modelColor / selectRateLimits / tokensSuffix (Task 3) ---

test("modelColor: Fable is amber, others plain", () => {
  assert.equal(modelColor("Fable 5"), "amber");
  assert.equal(modelColor("claude-fable-5"), "amber");
  assert.equal(modelColor("Opus 4.8"), "plain");
  assert.equal(modelColor("Sonnet 5"), "plain");
});

test("selectRateLimits: drops absent/below-threshold, keeps surfaced, flags red", () => {
  assert.deepEqual(selectRateLimits(undefined, 50), []);
  assert.deepEqual(selectRateLimits({}, 50), []);
  assert.deepEqual(
    selectRateLimits({ five_hour: { used_percentage: 45 }, seven_day: { used_percentage: 84.6 } }, 50),
    [{ label: "7d", pct: 84, red: true }], // 5h below 50 dropped; 7d surfaced + red
  );
  assert.deepEqual(
    selectRateLimits({ five_hour: { used_percentage: 60 } }, 50),
    [{ label: "5h", pct: 60, red: false }], // 7d absent -> dropped, no NaN
  );
});

test("selectRateLimits: non-numeric used_percentage is dropped, never NaN", () => {
  assert.deepEqual(selectRateLimits({ five_hour: { used_percentage: "oops" }, seven_day: {} }, 50), []);
});

test("tokensSuffix: rounds to thousands", () => {
  assert.equal(tokensSuffix(287400), "(287k)");
  assert.equal(tokensSuffix(1000), "(1k)");
});

// --- visibleWidth / truncateEnd / assembleStatusLine (Task 4) ---

test("visibleWidth: ignores ANSI SGR escapes", () => {
  assert.equal(visibleWidth("\x1b[0;31mabc\x1b[0m"), 3);
  assert.equal(visibleWidth("main"), 4);
});

test("truncateEnd: leaves short strings, ellipsizes long ones", () => {
  assert.equal(truncateEnd("main", 24), "main");
  assert.equal(truncateEnd("feature/very-long-branch-name", 10), "feature/v…");
  assert.equal(truncateEnd("x", 0), "");
});

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("assembleStatusLine: calm line — core + model, no conditional segments", () => {
  const line = strip(assembleStatusLine({
    identity: "claude-skills", branch: "main", dirty: 0,
    pctInt: 24, tokens: 96000, model: "Opus 4.8", rateLimits: [], budget: 120,
  }));
  assert.equal(line, "claude-skills ⎇main · ██░░░░░░░░ 24% · Opus 4.8");
});

test("assembleStatusLine: busy line — dirty, red tokens, rate-limits with warn", () => {
  const line = strip(assembleStatusLine({
    identity: "claude-skills-t2", branch: "sdd/t2", dirty: 5,
    pctInt: 71, tokens: 287000, model: "Fable 5",
    rateLimits: [{ label: "5h", pct: 84, red: true }, { label: "7d", pct: 21, red: false }],
    budget: 120,
  }));
  assert.equal(line, "claude-skills-t2 ⎇sdd/t2 ±5 · ███████░░░ 71% (287k) · Fable 5 · ⚠ 5h 84% 7d 21%");
});

test("assembleStatusLine: tokens suffix only appears when red (>=70)", () => {
  const green = strip(assembleStatusLine({
    identity: "x", branch: null, dirty: 0, pctInt: 40, tokens: 160000,
    model: "Opus 4.8", rateLimits: [], budget: 120,
  }));
  assert.ok(!green.includes("("), "no token suffix below red");
});

test("assembleStatusLine: width drops rate-limits first, then dirty, then shortens model", () => {
  const d = {
    identity: "claude-skills-t2", branch: "sdd/t2", dirty: 5, pctInt: 71, tokens: 287000,
    model: "Fable 5", rateLimits: [{ label: "5h", pct: 84, red: true }], budget: 44,
  };
  const line = strip(assembleStatusLine(d));
  assert.ok(!line.includes("5h"), "rate-limits dropped first");
  assert.ok(visibleWidth(line) <= 44 || !line.includes("±5"), "dirty dropped next when still over");
});

test("assembleStatusLine: budget-aware clamp fits a narrow known width", () => {
  const line = assembleStatusLine({
    identity: "some-long-identity-name", branch: "a-fairly-long-branch", dirty: 3,
    pctInt: 55, tokens: null, model: "Sonnet 5",
    rateLimits: [{ label: "5h", pct: 90, red: true }], budget: 40,
  });
  assert.ok(visibleWidth(line) <= 40, `expected <=40 cols, got ${visibleWidth(line)}: ${strip(line)}`);
  assert.ok(strip(line).includes("55%"), "core is never dropped");
});
