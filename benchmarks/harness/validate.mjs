#!/usr/bin/env node
// Corpus validator. Structural checks always; materialization (apply) checks
// for synthetic items (hermetic) and for mined items whose repo resolves.
// Mined items with unresolvable repos are warnings by default so CI on a fresh
// clone can still validate structure; runs (run.mjs) treat them as failures.
// Usage: node benchmarks/harness/validate.mjs [corpusDir...] [--require-repos]
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { validateItemMeta, validateTruth, spanCovered } from "./schema.mjs";
import { materializeArm } from "./materialize.mjs";

const REQUIRED = ["item.json", "truth.json", "brief.md", "clean.patch", "seeded.patch"];

function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }

export function validateItemDir(itemDir, { requireRepos = false } = {}) {
  const errors = [], warnings = [];
  for (const f of REQUIRED) if (!existsSync(join(itemDir, f))) errors.push(`${f}: missing`);
  if (errors.length) return { errors, warnings };

  let meta = null, truth = null;
  try { meta = readJson(join(itemDir, "item.json")); } catch (e) { errors.push(`item.json: ${e.message}`); }
  try { truth = readJson(join(itemDir, "truth.json")); } catch (e) { errors.push(`truth.json: ${e.message}`); }
  if (errors.length) return { errors, warnings };

  errors.push(...validateItemMeta(meta), ...validateTruth(truth));

  const clean = readFileSync(join(itemDir, "clean.patch"), "utf8");
  const seeded = readFileSync(join(itemDir, "seeded.patch"), "utf8");
  if (clean === seeded) errors.push("seeded.patch: identical to clean.patch");
  if (!readFileSync(join(itemDir, "brief.md"), "utf8").trim()) errors.push("brief.md: empty");
  if (truth?.file) {
    if (!seeded.includes(`+++ b/${truth.file}`)) errors.push(`seeded.patch: does not touch truth file ${truth.file}`);
    else if (Array.isArray(truth.span) && truth.span.length === 2 && !spanCovered(seeded, truth.file, truth.span)) {
      errors.push("seeded.patch: no hunk covers truth span");
    }
  }
  if (errors.length) return { errors, warnings }; // don't materialize structurally broken items

  if (meta.tranche === "synthetic" && !existsSync(join(itemDir, "base"))) {
    errors.push("base/: missing for synthetic item");
    return { errors, warnings };
  }
  const resolvable = meta.tranche === "synthetic"
    || existsSync(join(meta.repo.replace(/^~(?=\/)/, process.env.HOME ?? "~"), ".git"));
  if (!resolvable) {
    (requireRepos ? errors : warnings).push(`repo unresolvable, structural checks only: ${meta.repo}`);
    return { errors, warnings };
  }

  const scratch = mkdtempSync(join(tmpdir(), "bench-validate-"));
  try {
    for (const arm of ["clean", "seeded"]) {
      try { materializeArm({ itemDir, meta, arm, scratchRoot: scratch }).cleanup(); }
      catch (e) { errors.push(`${arm}.patch: does not apply at base (${String(e.message).split("\n")[0]})`); }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  return { errors, warnings };
}

export function validateCorpusDirs(dirs, opts = {}) {
  const results = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) { results.push({ item: dir, itemDir: dir, errors: [`corpus dir missing: ${dir}`], warnings: [] }); continue; }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const itemDir = join(dir, entry.name);
      results.push({ item: entry.name, itemDir, ...validateItemDir(itemDir, opts) });
    }
  }
  return results;
}

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const DEFAULT_CORPUS = join(HERE, "..", "corpus", "reviewer");

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const requireRepos = args.includes("--require-repos");
  const dirs = args.filter((a) => !a.startsWith("--"));
  const results = validateCorpusDirs(dirs.length ? dirs : [DEFAULT_CORPUS], { requireRepos });
  let bad = 0;
  for (const r of results) {
    for (const w of r.warnings) console.error(`WARN  ${r.item}: ${w}`);
    for (const e of r.errors) { console.error(`ERROR ${r.item}: ${e}`); bad++; }
  }
  console.log(`${results.length} item(s), ${bad} error(s)`);
  process.exit(bad ? 1 : 0);
}
