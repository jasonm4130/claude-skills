#!/usr/bin/env node
// @ts-check
// UserPromptSubmit hook: consume the CONTEXT.md flag → agent-directed
// additionalContext, and record the repo as offered so it is never asked again.

import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  readStdin,
  safeJsonParse,
  resolveSessionId,
  resolveDataDir,
  emitAdditionalContext,
} from "./lib.mjs";

const raw = await readStdin();
const payload = safeJsonParse(raw);
const sessionId = resolveSessionId(payload);
const dataDir = resolveDataDir("domain-modeling-data");
const flag = path.join(dataDir, `context-md-nudge-${sessionId}.flag`);

if (!existsSync(flag)) process.exit(0);

/** @type {string} */
let repo;
try {
  repo = readFileSync(flag, "utf8").trim();
} catch {
  process.exit(0);
}
if (repo.length === 0) process.exit(0);

try {
  unlinkSync(flag);
} catch {
  // best-effort — fire-once is desirable but a failed unlink shouldn't block emission
}

// Burn the one ask now that it is actually reaching the user.
try {
  appendFileSync(path.join(dataDir, "context-md-offered.txt"), `${repo}\n`);
} catch {
  // best-effort — worst case the offer repeats in a later session
}

emitAdditionalContext(
  "UserPromptSubmit",
  `[domain-modeling] \`${repo}\` has a CLAUDE.md but no CONTEXT.md, and this session edited source there. ` +
    `Offer the user — once, as a single line alongside the work, then keep going — to run the domain-modeling skill ` +
    `and pin down the project's domain terms. Do not start one unprompted and do not re-offer: this fires once per repo, ever.`,
);
process.exit(0);
