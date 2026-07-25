#!/usr/bin/env node
// @ts-check
// `/docs-consolidate --defer` — silence the consolidation nudge until the repo has
// moved another threshold's worth of commits.
//
// This exists as a script rather than as instructions in the skill because the marker
// path has to be computed the same way the Stop hook computes it. Telling the agent to
// "write the defer file" cannot work: CLAUDE_PLUGIN_DATA is not exported to session
// shells, so a hand-rolled path would land somewhere the hook never looks.
//
// Usage: node defer-consolidation.mjs [repoPath]   (defaults to cwd)

import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import process from "node:process";
import { gitRepoRoot, git, deferMarkerPath, resolveConsolidateThreshold } from "./lib.mjs";

const target = process.argv[2] || process.cwd();
const clear = process.argv.includes("--clear");

const repoRoot = gitRepoRoot(target);
if (repoRoot === null) {
  console.error(`docs-sync: ${target} is not inside a git work tree.`);
  process.exit(1);
}

const marker = deferMarkerPath(repoRoot);
if (marker === null) {
  console.error("docs-sync: could not locate the git directory.");
  process.exit(1);
}

if (clear) {
  if (existsSync(marker)) unlinkSync(marker);
  console.log("docs-sync: deferral cleared — the nudge can fire again.");
  process.exit(0);
}

const head = git(["rev-parse", "HEAD"], repoRoot);
if (head === null) {
  console.error("docs-sync: could not resolve HEAD.");
  process.exit(1);
}

writeFileSync(marker, `${head}\n`);
console.log(
  `docs-sync: consolidation deferred at ${head.slice(0, 12)}. ` +
    `The nudge stays silent until this repo is ${resolveConsolidateThreshold()} commits past it. ` +
    `Clear it early with --clear.`,
);
process.exit(0);
