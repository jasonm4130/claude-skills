#!/usr/bin/env node
// Runner CLI: validates the corpus, materializes every arm × adapter × trial
// cell, runs adapters through a two-lane concurrency pool (codex serialized,
// everyone else four-wide), judges seeded findings for a mechanism match, and
// writes a stratified scorecard. Cached by content-derived keys so unchanged
// cells (especially Codex) never re-spend quota on a re-run.
import { createHash } from "node:crypto";
import {
  mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { validateCorpusDirs, DEFAULT_CORPUS } from "./validate.mjs";
import { materializeArm } from "./materialize.mjs";
import { cacheKey, CellCache } from "./cache.mjs";
import { makeCellRecord } from "./model.mjs";
import { runClaude } from "./claude-cli.mjs";
import { matchCell, MATCHER_CONFIG } from "./matcher.mjs";
import { computeScorecard, renderMarkdown, populationId } from "./scorecard.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_RESULTS_BASE = join(HERE, "..", "results");
const DEFAULT_BASELINES_PATH = join(HERE, "..", "baselines.json");
const PRIVATE_CORPUS = join(homedir(), "Work", "Git", "claude-skills-bench-corpus", "reviewer");

// Cache-key label for codex cells: codex.mjs owns its real default model and
// is never told a Claude model name (policy). This is just a stable, non-Claude
// discriminator — a change to codex.mjs's actual default still invalidates the
// cache via adapterVersion (a hash of that file's bytes), so this label never
// needs to track the real model string.
const CODEX_MODEL_LABEL = "codex-default";

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleItems(items, n, seed) {
  const rand = mulberry32(seed);
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(n, pool.length)).sort((a, b) => a.id.localeCompare(b.id));
}

export function hashItemContent(itemDir) {
  const files = [];
  (function walk(dir, rel) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, relPath);
      else if (entry.isFile()) files.push(relPath);
    }
  })(itemDir, "");
  files.sort();
  const hash = createHash("sha256");
  for (const relPath of files) {
    hash.update(relPath);
    hash.update("\0");
    hash.update(readFileSync(join(itemDir, relPath)));
  }
  return hash.digest("hex");
}

export function expandCells({ items, arms, adapterIds, trialsFor }) {
  const cells = [];
  for (const item of items) for (const arm of arms) for (const adapter of adapterIds) {
    for (let trial = 0; trial < trialsFor(adapter); trial++) cells.push({ item, arm, adapter, trial });
  }
  return cells;
}

export function parseRunArgs(argv) {
  const config = {
    adapters: null, arms: ["clean", "seeded"], trials: 3, codexTrials: 1,
    seed: 42, model: "sonnet", effort: "medium", sample: null,
    noCache: false, allowMissing: false, results: null, baselines: null,
    corpusDirs: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--adapters": config.adapters = next().split(","); break;
      case "--arms": config.arms = next().split(","); break;
      case "--trials": config.trials = Number(next()); break;
      case "--codex-trials": config.codexTrials = Number(next()); break;
      case "--seed": config.seed = Number(next()); break;
      case "--model": config.model = next(); break;
      case "--effort": config.effort = next(); break;
      case "--sample": config.sample = Number(next()); break;
      case "--no-cache": config.noCache = true; break;
      case "--allow-missing": config.allowMissing = true; break;
      case "--results": config.results = next(); break;
      case "--baselines": config.baselines = next(); break;
      default: throw new Error(`unknown arg: ${a}`);
    }
  }
  for (const [flag, v] of [["--trials", config.trials], ["--codex-trials", config.codexTrials]]) {
    if (!Number.isInteger(v) || v < 1) {
      throw new Error(`${flag} must be a positive integer, got ${v} — zero cells would score as a green run`);
    }
  }
  if (config.sample !== null && (!Number.isInteger(config.sample) || config.sample < 1)) {
    throw new Error(`--sample must be a positive integer, got ${config.sample}`);
  }
  return config;
}

export function loadBaseline(path, pid) {
  let data;
  try { data = JSON.parse(readFileSync(path, "utf8")); }
  catch { return { baseline: null, baselinesExist: false }; }
  const baselines = Array.isArray(data.baselines) ? data.baselines : [];
  const baseline = baselines.find((b) => b.populationId === pid) ?? null;
  return { baseline, baselinesExist: baselines.length > 0 };
}

function defaultCorpusDirs() {
  const dirs = [DEFAULT_CORPUS];
  if (existsSync(PRIVATE_CORPUS)) dirs.push(PRIVATE_CORPUS);
  return dirs;
}

async function loadDefaultAdapters() {
  const mods = await Promise.all([
    import("./adapters/code-review.mjs"),
    import("./adapters/sdd-reviewer.mjs"),
    import("./adapters/codex.mjs"),
  ]);
  const registry = {};
  for (const m of mods) registry[m.ADAPTER_ID] = { ADAPTER_ID: m.ADAPTER_ID, version: m.version, review: m.review };
  return registry;
}

// ~15-line promise pool: `concurrency` workers pull from a shared cursor over
// `tasks`, each awaiting `worker` before taking the next — no dependency.
async function runPool(tasks, worker, concurrency) {
  if (tasks.length === 0) return [];
  const results = new Array(tasks.length);
  let next = 0;
  async function lane() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await worker(tasks[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, lane));
  return results;
}

export async function runHarness(config, deps = {}) {
  const requireRepos = !config.allowMissing;
  const corpusDirs = config.corpusDirs ?? defaultCorpusDirs();
  const validated = validateCorpusDirs(corpusDirs, { requireRepos });
  const problems = validated.filter((r) => r.errors.length > 0);
  if (problems.length > 0) {
    for (const r of problems) for (const e of r.errors) console.error(`ERROR ${r.item}: ${e}`);
    console.error(`${problems.length} item(s) failed validation — aborting run.`);
    return { scorecard: null, resultsDir: null, exitCode: 2 };
  }

  let items = validated.map((r) => ({
    id: r.item,
    itemDir: r.itemDir,
    meta: JSON.parse(readFileSync(join(r.itemDir, "item.json"), "utf8")),
    truth: JSON.parse(readFileSync(join(r.itemDir, "truth.json"), "utf8")),
    brief: readFileSync(join(r.itemDir, "brief.md"), "utf8"),
  }));
  const dupes = [...new Set(items.map((i) => i.id).filter((id, i, a) => a.indexOf(id) !== i))];
  if (dupes.length) {
    console.error(`duplicate item id(s) across corpus dirs: ${dupes.join(", ")} — aborting run (colliding truths would score against the wrong oracle).`);
    return { scorecard: null, resultsDir: null, exitCode: 2 };
  }
  if (config.sample) items = sampleItems(items, config.sample, config.seed);

  const truthsById = {};
  for (const it of items) truthsById[it.id] = it.truth;

  const manifestHash = cacheKey(
    items.map((it) => ({ id: it.id, hash: hashItemContent(it.itemDir) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );

  const registry = deps.adapters ?? await loadDefaultAdapters();
  const adapterIds = config.adapters ?? Object.keys(registry);
  const unknown = adapterIds.filter((id) => !registry[id]);
  if (unknown.length) throw new Error(`unknown adapter(s): ${unknown.join(", ")}`);

  const resultsBase = config.results ?? DEFAULT_RESULTS_BASE;
  const cellCache = new CellCache(join(resultsBase, "cache"));

  async function runCell(cell) {
    const { item, arm, adapter, trial } = cell;
    const adapterImpl = registry[adapter];
    const adapterVersion = adapterImpl.version();
    const isCodex = adapter === "codex";
    const effModel = isCodex ? CODEX_MODEL_LABEL : config.model;
    const effEffort = isCodex ? config.effort : null;
    const key = cacheKey({
      itemContent: hashItemContent(item.itemDir), arm, adapter, adapterVersion,
      model: effModel, effort: effEffort, trial,
    });

    if (!config.noCache) {
      const cached = cellCache.get(key);
      if (cached) {
        return makeCellRecord({
          item: item.id, arm, adapter, adapterVersion, trial, cacheHit: true,
          status: cached.status, verdict: cached.verdict, findings: cached.findings,
          tokens: cached.tokens, wallMs: cached.wallMs, error: cached.error ?? null,
        });
      }
    }

    let materialized = null;
    let outcome;
    try {
      materialized = materializeArm({ itemDir: item.itemDir, meta: item.meta, arm, scratchRoot: tmpdir() });
      const scratchDir = join(dirname(materialized.worktree), "scratch");
      mkdirSync(scratchDir, { recursive: true });
      const reviewArgs = {
        worktree: materialized.worktree,
        diffRange: `${materialized.baseSha}..${materialized.armSha}`,
        brief: item.brief, scratchDir,
      };
      if (isCodex) reviewArgs.effort = config.effort; // never pass a Claude model to codex
      else reviewArgs.model = config.model;
      outcome = await adapterImpl.review(reviewArgs);
    } catch (e) {
      outcome = { status: "error", error: String(e?.message ?? e) };
    } finally {
      materialized?.cleanup();
    }

    const record = makeCellRecord({
      item: item.id, arm, adapter, adapterVersion, trial, cacheHit: false,
      status: outcome.status, verdict: outcome.verdict ?? null, findings: outcome.findings ?? [],
      tokens: outcome.tokens ?? null, wallMs: outcome.wallMs ?? null, error: outcome.error ?? null,
    });

    if (outcome.status === "ok") {
      cellCache.put(key, {
        status: outcome.status, verdict: outcome.verdict, findings: outcome.findings,
        tokens: outcome.tokens, wallMs: outcome.wallMs, error: null,
      });
    }
    return record;
  }

  const trialsFor = (adapterId) => (adapterId === "codex" ? config.codexTrials : config.trials);
  const cells = expandCells({ items, arms: config.arms, adapterIds, trialsFor });
  const codexCells = cells.filter((c) => c.adapter === "codex");
  const otherCells = cells.filter((c) => c.adapter !== "codex");
  const [otherRecords, codexRecords] = await Promise.all([
    runPool(otherCells, runCell, 4),
    runPool(codexCells, runCell, 1),
  ]);
  const records = [...otherRecords, ...codexRecords];

  const judgeRunClaude = deps.judgeRunClaude ?? runClaude;
  for (const record of records) {
    if (record.arm !== "seeded" || record.status !== "ok") continue;
    const truth = truthsById[record.item];
    const match = await matchCell(record, truth, { cache: cellCache, deps: { runClaude: judgeRunClaude } });
    record.match = match;
    // Judge outage on a seeded cell must surface as harness unreliability, not
    // as a reviewer miss — drop it out of scored cells into the error gates.
    if (match.errors.length > 0 && !match.catch) record.status = "oracle-error";
  }

  const scConfig = {
    arms: config.arms,
    trialsPolicy: { default: config.trials, codex: config.codexTrials },
    adapters: Object.fromEntries(adapterIds.map((id) => [
      id, { version: registry[id].version(), model: id === "codex" ? CODEX_MODEL_LABEL : config.model },
    ])),
    matcher: MATCHER_CONFIG,
  };
  const pid = populationId({ manifestHash, config: scConfig });
  const baselinesPath = config.baselines ?? DEFAULT_BASELINES_PATH;
  const { baseline, baselinesExist } = loadBaseline(baselinesPath, pid);

  const scorecard = computeScorecard({
    records, truthsById, manifestHash, config: scConfig, baseline, baselinesExist,
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(resultsBase, "runs", stamp);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "records.jsonl"), `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  writeFileSync(join(runDir, "scorecard.json"), JSON.stringify(scorecard, null, 2));
  const md = renderMarkdown(scorecard);
  writeFileSync(join(runDir, "scorecard.md"), md);
  console.log(md);

  return { scorecard, resultsDir: runDir, exitCode: scorecard.exitCode };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const result = await runHarness(parseRunArgs(process.argv.slice(2)));
  process.exit(result.exitCode);
}
