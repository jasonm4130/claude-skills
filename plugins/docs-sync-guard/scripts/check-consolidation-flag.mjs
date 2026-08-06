#!/usr/bin/env node
// @ts-check
// UserPromptSubmit hook: consume a flag armed by stop-check-consolidation-drift.mjs
// and inject the nudge. Fire-once — the flag is deleted before the message is
// emitted, so a crash mid-write cannot leave it re-firing every prompt.
//
// The repo hash comes from THIS hook's own cwd, not from the flag. A session that
// ends a turn in repo A and then prompts from repo B must not be told to consolidate
// B: it simply finds no flag for B, and A's flag waits until the session returns.

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  readStdin,
  safeJsonParse,
  resolveSessionId,
  resolveDataDir,
  repoHash,
  gitRepoRoot,
  readConsolidationStamp,
  emitAdditionalContext,
} from "./lib.mjs";

/**
 * @typedef {object} PromptInput
 * @property {string} [session_id]
 * @property {string} [cwd]
 */

const raw = await readStdin();
const payload = /** @type {PromptInput | null} */ (safeJsonParse(raw));
// A payload that does not parse is "cannot tell", and every anomaly here is silent.
// Falling through to process.cwd() made a malformed call speak for whatever repo the
// hook happened to be spawned in, under session id "unknown" — invisible until that
// repo crossed the drift threshold, at which point the pair of hooks armed and then
// consumed a flag nobody's session owned. The sibling PreToolUse guard already exits
// here; these two were the outliers. An array passes `safeJsonParse` (it is an object), so
// check the shape, not just null: stdin of `[]` would otherwise take the same ambient path.
if (payload === null || typeof payload !== "object" || Array.isArray(payload)) process.exit(0);
const cwd =
  payload && typeof payload.cwd === "string" && payload.cwd.length > 0
    ? payload.cwd
    : process.cwd();

const repoRoot = gitRepoRoot(cwd);
if (repoRoot === null) process.exit(0);

const sessionId = resolveSessionId(payload);
const dataDir = resolveDataDir("docs-sync-guard-data");
const flagFile = path.join(dataDir, `consolidate-nudge-${sessionId}-${repoHash(repoRoot)}.flag`);
if (!existsSync(flagFile)) process.exit(0);

/** @type {string} */
let count = "";
try {
  count = readFileSync(flagFile, "utf8").trim();
} catch {
  // fall through — the nudge is still worth sending without the number
}

try {
  unlinkSync(flagFile);
} catch {
  // best-effort; a stale flag is re-consumed harmlessly next prompt
}

// Re-check the record before speaking. Stop armed this flag at the end of the last
// turn; the user may have opted out since by deleting `.docs-sync`, and the contract
// says a deleted record goes silent immediately. Consuming the flag above and
// returning here is deliberate — the opt-out should also clear anything already armed.
if (readConsolidationStamp(repoRoot) === null) process.exit(0);

const scale = count ? `${count} commits` : "a lot";
emitAdditionalContext(
  "UserPromptSubmit",
  `This repo has moved ${scale} since its documentation was last checked for internal ` +
    `consistency. Docs that were each updated correctly in isolation can still contradict ` +
    `one another, and they only grow unless something prunes them.\n\n` +
    `Consider running the docs-sync-guard:docs-consolidate skill — it audits and reports, it does not rewrite ` +
    `anything on its own. /docs-consolidate --defer silences this until the repo has ` +
    `moved that far again. Nothing here blocks: finish what you were doing first.`,
);
process.exit(0);
