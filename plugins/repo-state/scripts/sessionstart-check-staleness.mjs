#!/usr/bin/env node
// @ts-check
// SessionStart hook: warn when docs/CURRENT_STATE.md no longer describes HEAD.
//
// This is the load-bearing half of the plugin. A generated orientation doc that
// silently goes stale is worse than no doc: the agent reads it, believes it, and
// reports confident irrelevance rather than a visible failure. The warning has to
// land BEFORE the doc is read, which is why it fires at session start rather than
// waiting for the drift nudge to arm at the end of a turn.
//
// Silent by design when the doc is absent — the doc's presence IS the per-repo
// opt-in, so unadopted repos never hear from this plugin.

import process from "node:process";
import {
  readStdin,
  safeJsonParse,
  emitAdditionalContext,
  gitRepoRoot,
  readStamp,
  resolveThreshold,
  computeDrift,
  describeDrift,
  STATE_DOC_REL,
} from "./lib.mjs";

const raw = await readStdin();
const payload = safeJsonParse(raw);
const cwd =
  payload && typeof /** @type {any} */ (payload).cwd === "string" && /** @type {any} */ (payload).cwd.length > 0
    ? /** @type {any} */ (payload).cwd
    : process.cwd();

const repoRoot = gitRepoRoot(cwd);
if (!repoRoot) process.exit(0);

const stamp = readStamp(repoRoot);
if (!stamp) process.exit(0);

const drift = computeDrift(repoRoot, stamp.commit, resolveThreshold());
if (!drift || !drift.stale) process.exit(0);

emitAdditionalContext(
  "SessionStart",
  `[repo-state] ${STATE_DOC_REL} is stale: ${describeDrift(drift)}. ` +
    `Treat its claims as unverified — check anything load-bearing against the source before relying on it, ` +
    `and prefer reading the code over quoting the doc. Run /repo-state refresh to bring it current.`,
);
process.exit(0);
