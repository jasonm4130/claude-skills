import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { parseRunArgs, sampleItems, hashItemContent, expandCells, runHarness, loadBaseline } from "./run.mjs";
import { DEFAULT_CORPUS } from "./validate.mjs";

test("parseRunArgs defaults and overrides", () => {
  const d = parseRunArgs([]);
  assert.equal(d.adapters, null); // null = all registered adapters, resolved in runHarness
  assert.equal(d.trials, 3);
  assert.equal(d.codexTrials, 1);
  assert.equal(d.seed, 42);
  const o = parseRunArgs(["--adapters", "code-review", "--trials", "1", "--sample", "5", "--no-cache", "--allow-missing"]);
  assert.deepEqual(o.adapters, ["code-review"]);
  assert.equal(o.sample, 5);
  assert.equal(o.noCache, true);
  assert.equal(o.allowMissing, true);
});

test("sampleItems is deterministic for a seed and a strict subset", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: `i${i}` }));
  const a = sampleItems(items, 4, 42).map((x) => x.id);
  const b = sampleItems(items, 4, 42).map((x) => x.id);
  assert.deepEqual(a, b);
  assert.equal(a.length, 4);
  assert.notDeepEqual(sampleItems(items, 4, 43).map((x) => x.id), a);
});

test("hashItemContent changes when any item file changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-hash-"));
  execFileSync("cp", ["-R", join(DEFAULT_CORPUS, "synthetic-0001") + "/.", dir]);
  const h1 = hashItemContent(dir);
  assert.equal(h1, hashItemContent(dir));
  execFileSync("bash", ["-c", `echo tweak >> ${JSON.stringify(join(dir, "brief.md"))}`]);
  assert.notEqual(hashItemContent(dir), h1);
  rmSync(dir, { recursive: true, force: true });
});

test("expandCells honors per-adapter trial counts", () => {
  const cells = expandCells({
    items: [{ id: "a" }], arms: ["clean", "seeded"], adapterIds: ["code-review", "codex"],
    trialsFor: (id) => (id === "codex" ? 1 : 3),
  });
  assert.equal(cells.filter((c) => c.adapter === "code-review").length, 6);
  assert.equal(cells.filter((c) => c.adapter === "codex").length, 2);
});

test("loadBaseline selects by populationId; reports whether entries exist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-baseline-"));
  const path = join(dir, "baselines.json");
  const { writeFileSync } = await import("node:fs");
  const { loadBaseline } = await import("./run.mjs");
  writeFileSync(path, JSON.stringify({ baselines: [
    { label: "v1", populationId: "pid-a", adapters: { rev: { catchRate: 1, overRejection: 0 } } },
    { label: "v2", populationId: "pid-b", adapters: { rev: { catchRate: 0.9, overRejection: 1 } } },
  ] }));
  assert.equal(loadBaseline(path, "pid-b").baseline.label, "v2");
  assert.equal(loadBaseline(path, "pid-x").baseline, null);
  assert.equal(loadBaseline(path, "pid-x").baselinesExist, true);
  assert.deepEqual(loadBaseline(join(dir, "missing.json"), "pid-a"), { baseline: null, baselinesExist: false });
  rmSync(dir, { recursive: true, force: true });
});

test("hermetic smoke: stub adapter end-to-end, then full cache hit", async () => {
  const resultsDir = mkdtempSync(join(tmpdir(), "bench-run-"));
  const stub = {
    ADAPTER_ID: "stub",
    version: () => "stub-v1",
    review: async ({ worktree, diffRange }) => {
      const diff = execFileSync("git", ["-C", worktree, "diff", "--no-textconv", "--no-ext-diff", diffRange, "--"], { encoding: "utf8" });
      if (diff.includes("h: 600_000")) {
        return { status: "ok", verdict: "reject", findings: [{ file: "src/parse-duration.mjs", line: 2, severity: "Critical", summary: "wrong hours multiplier", mechanism: "hours multiplier is 600000 not 3600000, so hour durations are one-sixth of correct" }], tokens: { input: 0, output: 0 }, wallMs: 1, raw: {} };
      }
      return { status: "ok", verdict: "pass", findings: [], tokens: { input: 0, output: 0 }, wallMs: 1, raw: {} };
    },
  };
  const deps = {
    adapters: { stub },
    judgeRunClaude: async () => ({ ok: true, structured: { match: true, reason: "stub" } }),
  };
  const config = parseRunArgs(["--adapters", "stub", "--trials", "1", "--results", resultsDir]);
  config.corpusDirs = [DEFAULT_CORPUS];
  const r1 = await runHarness(config, deps);
  assert.equal(r1.exitCode, 0);
  assert.equal(r1.scorecard.adapters.stub.catchRate, 1);
  assert.equal(r1.scorecard.adapters.stub.overRejection, 0);
  const runDir = r1.resultsDir;
  assert.ok(existsSync(join(runDir, "records.jsonl")));
  assert.ok(existsSync(join(runDir, "scorecard.md")));
  const lines = readFileSync(join(runDir, "records.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2); // 1 item × 2 arms × 1 adapter × 1 trial
  const r2 = await runHarness(config, deps);
  const lines2 = readFileSync(join(r2.resultsDir, "records.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(lines2.every((rec) => rec.cacheHit === true));
  rmSync(resultsDir, { recursive: true, force: true });
});

test("non-positive trial counts are rejected — zero cells must not score as a green run", () => {
  assert.throws(() => parseRunArgs(["--trials", "0"]), /positive integer/);
  assert.throws(() => parseRunArgs(["--codex-trials", "-1"]), /positive integer/);
  assert.throws(() => parseRunArgs(["--trials", "1.5"]), /positive integer/);
  assert.throws(() => parseRunArgs(["--sample", "0"]), /positive integer/);
});

test("a sampled run is stamped INFORMATIONAL even with no baselines", async () => {
  const resultsDir = mkdtempSync(join(tmpdir(), "bench-sampled-"));
  const stub = {
    ADAPTER_ID: "stub",
    version: () => "stub-v1",
    review: async () => ({ status: "ok", verdict: "pass", findings: [], tokens: { input: 0, output: 0 }, wallMs: 1, raw: {} }),
  };
  const config = parseRunArgs(["--adapters", "stub", "--trials", "1", "--sample", "1", "--results", resultsDir,
    "--baselines", join(resultsDir, "missing.json")]);
  config.corpusDirs = [DEFAULT_CORPUS];
  const r = await runHarness(config, { adapters: { stub }, judgeRunClaude: async () => ({ ok: true, structured: { match: false, reason: "stub" } }) });
  assert.equal(r.scorecard.status, "INFORMATIONAL");
  assert.equal(r.exitCode, 0);
  rmSync(resultsDir, { recursive: true, force: true });
});

test("malformed baselines file is a hard abort, not silent no-baselines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-badbase-"));
  const bad = join(dir, "baselines.json");
  writeFileSync(bad, "{not json");
  assert.throws(() => loadBaseline(bad, "pid-x"), /unreadable/);
  writeFileSync(bad, JSON.stringify({ baselines: {} }));
  assert.throws(() => loadBaseline(bad, "pid-x"), /malformed/);
  // …and runHarness aborts before spending any adapter call.
  writeFileSync(bad, "{not json");
  const stub = { ADAPTER_ID: "stub", version: () => "v", review: async () => { throw new Error("unreached"); } };
  const config = parseRunArgs(["--adapters", "stub", "--trials", "1", "--results", dir, "--baselines", bad]);
  config.corpusDirs = [DEFAULT_CORPUS];
  const r = await runHarness(config, { adapters: { stub } });
  assert.equal(r.exitCode, 2);
  assert.equal(r.scorecard, null);
  rmSync(dir, { recursive: true, force: true });
});

test("duplicate item ids across corpus dirs abort the run", async () => {
  const resultsDir = mkdtempSync(join(tmpdir(), "bench-dupe-"));
  const stub = { ADAPTER_ID: "stub", version: () => "v", review: async () => { throw new Error("unreached"); } };
  const config = parseRunArgs(["--adapters", "stub", "--trials", "1", "--results", resultsDir]);
  config.corpusDirs = [DEFAULT_CORPUS, DEFAULT_CORPUS]; // same dir twice = guaranteed collision
  const r = await runHarness(config, { adapters: { stub } });
  assert.equal(r.exitCode, 2);
  assert.equal(r.scorecard, null);
  rmSync(resultsDir, { recursive: true, force: true });
});
