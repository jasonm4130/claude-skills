// @ts-check
// collect-batch-sessions.mjs: invoked once by /retro (Step 1). Resolves the
// batch of unprocessed worthy sessions (retro-worthy.jsonl minus
// retro-processed.jsonl) plus the current session, aggregates each session's
// event log, and emits one JSON snapshot to stdout AND retro-batch-{sid}.json.
// Membership is pure identity set-difference — never a timestamp cutoff.

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "scripts", "collect-batch-sessions.mjs");

/**
 * @param {string} stdin
 * @param {Record<string, string>} env
 * @param {string[]} args
 */
function run(stdin, env, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function mkTmp() {
  return mkdtempSync(path.join(os.tmpdir(), "test-session-retro-cbs-"));
}

/** @param {number} days */
function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * @param {string} dir
 * @param {Array<{ts:string,sid:string,reasons?:string}>} entries
 */
function writeWorthy(dir, entries) {
  const body = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(path.join(dir, "retro-worthy.jsonl"), body);
}

/**
 * @param {string} dir
 * @param {string[]} sids
 */
function writeProcessed(dir, sids) {
  const body = sids.map((sid) => JSON.stringify({ ts: isoDaysAgo(1), sid })).join("\n") + "\n";
  writeFileSync(path.join(dir, "retro-processed.jsonl"), body);
}

/**
 * @param {string} dir
 * @param {string} sid
 * @param {Array<{tool:string,file_path?:string,command?:string}>} events
 */
function writeEvents(dir, sid, events) {
  const body =
    events
      .map((e) =>
        JSON.stringify({
          ts: isoDaysAgo(2),
          tool: e.tool,
          input: e.file_path
            ? { file_path: e.file_path }
            : e.command
              ? { command: e.command }
              : {},
        }),
      )
      .join("\n") + "\n";
  writeFileSync(path.join(dir, `events-${sid}.jsonl`), body);
}

/**
 * @typedef {{sid:string, isCurrent?:boolean, startDate?:(string|null),
 *   edits:number, writes:number, bashCalls:number, filesTouched:string[],
 *   reasons:string, firstTs:(string|null), lastTs:(string|null)}} BatchSession
 * @typedef {{boundaryTs:string, processedSids:string[], totalSessions:number,
 *   cappedFrom?:number, batch:BatchSession[]}} BatchSnapshot
 */

/**
 * parse the collector's stdout JSON
 * @param {string} stdout
 * @returns {BatchSnapshot}
 */
function parse(stdout) {
  return JSON.parse(stdout);
}

test("fallback: no worthy log → batch is just the current session, no processed sids", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeEvents(tmp, "cur", [{ tool: "Edit", file_path: "/a.ts" }]);

  const { code, stdout } = await run("", { CLAUDE_PLUGIN_DATA: tmp }, ["cur"]);
  assert.equal(code, 0);
  const out = parse(stdout);
  assert.equal(out.batch.length, 1);
  assert.equal(out.batch[0].sid, "cur");
  assert.equal(out.batch[0].isCurrent, true);
  assert.deepEqual(out.processedSids, []);
  assert.ok(Number.isFinite(Date.parse(out.boundaryTs)), "boundaryTs is ISO");
});

test("3 unprocessed worthy sids + current are all in the batch", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeWorthy(tmp, [
    { ts: isoDaysAgo(3), sid: "w1", reasons: "3 edits across 2 files" },
    { ts: isoDaysAgo(2), sid: "w2", reasons: "committed during session" },
    { ts: isoDaysAgo(1), sid: "w3", reasons: "40 tool calls" },
  ]);
  for (const s of ["w1", "w2", "w3"]) writeEvents(tmp, s, [{ tool: "Edit", file_path: "/x.ts" }]);
  writeEvents(tmp, "cur", [{ tool: "Write", file_path: "/y.ts" }]);

  const { code, stdout } = await run("", { CLAUDE_PLUGIN_DATA: tmp }, ["cur"]);
  assert.equal(code, 0);
  const out = parse(stdout);
  const sids = out.batch.map((b) => b.sid).sort();
  assert.deepEqual(sids, ["cur", "w1", "w2", "w3"]);
  assert.deepEqual([...out.processedSids].sort(), ["w1", "w2", "w3"]);
  assert.equal(out.batch.filter((b) => b.isCurrent).length, 1);
  // stored reasons carried through
  const w2 = out.batch.find((b) => b.sid === "w2");
  assert.ok(w2);
  assert.equal(w2.reasons, "committed during session");
});

test("sids in retro-processed.jsonl are excluded (identity, not timestamp)", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeWorthy(tmp, [
    { ts: isoDaysAgo(3), sid: "done1", reasons: "a" },
    { ts: isoDaysAgo(2), sid: "todo1", reasons: "b" },
  ]);
  writeProcessed(tmp, ["done1"]);
  for (const s of ["done1", "todo1"]) writeEvents(tmp, s, [{ tool: "Edit", file_path: "/z.ts" }]);

  const { code, stdout } = await run("", { CLAUDE_PLUGIN_DATA: tmp }, ["cur"]);
  assert.equal(code, 0);
  const out = parse(stdout);
  const sids = out.batch.map((b) => b.sid).sort();
  assert.deepEqual(sids, ["cur", "todo1"], "done1 excluded via processed ledger");
  assert.deepEqual(out.processedSids, ["todo1"]);
});

test("current sid with its own worthy line: one entry, isCurrent, AND in processedSids", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeWorthy(tmp, [
    { ts: isoDaysAgo(2), sid: "other", reasons: "a" },
    { ts: isoDaysAgo(1), sid: "cur", reasons: "current is worthy too" },
  ]);
  for (const s of ["other", "cur"]) writeEvents(tmp, s, [{ tool: "Edit", file_path: "/c.ts" }]);

  const { code, stdout } = await run("", { CLAUDE_PLUGIN_DATA: tmp }, ["cur"]);
  assert.equal(code, 0);
  const out = parse(stdout);
  const curEntries = out.batch.filter((b) => b.sid === "cur");
  assert.equal(curEntries.length, 1, "current appears exactly once, not duplicated");
  assert.equal(curEntries[0].isCurrent, true);
  assert.ok(out.processedSids.includes("cur"), "current worthy line must be marked processed");
});

test("worthy sid with a missing events file: included with zero counts, no crash", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeWorthy(tmp, [{ ts: isoDaysAgo(1), sid: "ghost", reasons: "committed during session" }]);
  // no events-ghost.jsonl on disk

  const { code, stdout } = await run("", { CLAUDE_PLUGIN_DATA: tmp }, ["cur"]);
  assert.equal(code, 0);
  const out = parse(stdout);
  const ghost = out.batch.find((b) => b.sid === "ghost");
  assert.ok(ghost, "ghost session still present");
  assert.equal(ghost.edits, 0);
  assert.equal(ghost.writes, 0);
  assert.deepEqual(ghost.filesTouched, []);
});

test("malformed jsonl lines in the worthy log are skipped, not fatal", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(
    path.join(tmp, "retro-worthy.jsonl"),
    [
      JSON.stringify({ ts: isoDaysAgo(2), sid: "good", reasons: "a" }),
      "{ not json",
      "",
      JSON.stringify({ ts: isoDaysAgo(1), sid: "good2", reasons: "b" }),
    ].join("\n") + "\n",
  );

  const { code, stdout } = await run("", { CLAUDE_PLUGIN_DATA: tmp }, ["cur"]);
  assert.equal(code, 0);
  const out = parse(stdout);
  const sids = out.batch.map((b) => b.sid).sort();
  assert.deepEqual(sids, ["cur", "good", "good2"]);
});

test("backlog past RETRO_BATCH_MAX_SESSIONS is capped oldest-first (FIFO drain)", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeWorthy(tmp, [
    { ts: isoDaysAgo(4), sid: "b1", reasons: "a" }, // oldest
    { ts: isoDaysAgo(3), sid: "b2", reasons: "b" },
    { ts: isoDaysAgo(2), sid: "b3", reasons: "c" }, // newest
  ]);

  const { code, stdout } = await run("", { CLAUDE_PLUGIN_DATA: tmp, RETRO_BATCH_MAX_SESSIONS: "2" }, ["cur"]);
  assert.equal(code, 0);
  const out = parse(stdout);
  assert.equal(out.cappedFrom, 3, "reports the pre-cap worthy count");
  assert.equal(out.processedSids.length, 2, "only kept worthy sids get marked processed");
  // Oldest-first drain: b1 + b2 kept, newest b3 dropped and left unprocessed so
  // the backlog can't starve — b3 gets picked up by a later retro.
  assert.deepEqual([...out.processedSids].sort(), ["b1", "b2"]);
  assert.ok(!out.processedSids.includes("b3"), "newest dropped, left unprocessed");
});

test("per-session aggregation: edits/writes/bash/files counted from the event log", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeWorthy(tmp, [{ ts: isoDaysAgo(1), sid: "agg", reasons: "x" }]);
  writeEvents(tmp, "agg", [
    { tool: "Edit", file_path: "/a.ts" },
    { tool: "Edit", file_path: "/a.ts" },
    { tool: "Edit", file_path: "/b.ts" },
    { tool: "Write", file_path: "/c.ts" },
    { tool: "Bash", command: "npm test" },
  ]);

  const { code, stdout } = await run("", { CLAUDE_PLUGIN_DATA: tmp }, ["cur"]);
  assert.equal(code, 0);
  const agg = parse(stdout).batch.find((b) => b.sid === "agg");
  assert.ok(agg);
  assert.equal(agg.edits, 3);
  assert.equal(agg.writes, 1);
  assert.equal(agg.bashCalls, 1);
  assert.deepEqual([...agg.filesTouched].sort(), ["/a.ts", "/b.ts", "/c.ts"]);
});

test("snapshot is persisted to retro-batch-{sid}.json matching stdout", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeWorthy(tmp, [{ ts: isoDaysAgo(1), sid: "w", reasons: "x" }]);
  writeEvents(tmp, "w", [{ tool: "Edit", file_path: "/a.ts" }]);

  const { code, stdout } = await run("", { CLAUDE_PLUGIN_DATA: tmp }, ["cur"]);
  assert.equal(code, 0);
  const persistedPath = path.join(tmp, "retro-batch-cur.json");
  assert.ok(existsSync(persistedPath), "retro-batch-{sid}.json written");
  assert.deepEqual(JSON.parse(readFileSync(persistedPath, "utf8")), parse(stdout));
});

test("migration: absent retro-processed.jsonl seeds legacy-done (ts <= lastRetro) sids once", async (t) => {
  const tmp = mkTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeWorthy(tmp, [
    { ts: isoDaysAgo(20), sid: "legacy1", reasons: "a" },
    { ts: isoDaysAgo(19), sid: "legacy2", reasons: "b" },
    { ts: isoDaysAgo(1), sid: "fresh", reasons: "c" },
  ]);
  writeFileSync(path.join(tmp, "last-retro.txt"), isoDaysAgo(10));
  // no retro-processed.jsonl

  const { code, stdout } = await run("", { CLAUDE_PLUGIN_DATA: tmp }, ["cur"]);
  assert.equal(code, 0);
  const out = parse(stdout);
  const sids = out.batch.map((b) => b.sid).sort();
  assert.deepEqual(sids, ["cur", "fresh"], "legacy-done sessions not re-interviewed");

  const processed = readFileSync(path.join(tmp, "retro-processed.jsonl"), "utf8");
  assert.match(processed, /"sid":"legacy1"/);
  assert.match(processed, /"sid":"legacy2"/);
  assert.doesNotMatch(processed, /"sid":"fresh"/, "fresh stays unprocessed");

  // second run is idempotent — no new legacy lines
  const before = readFileSync(path.join(tmp, "retro-processed.jsonl"), "utf8");
  await run("", { CLAUDE_PLUGIN_DATA: tmp }, ["cur2"]);
  const after = readFileSync(path.join(tmp, "retro-processed.jsonl"), "utf8");
  assert.equal(after, before, "migration does not re-seed on subsequent runs");
});
