#!/usr/bin/env node
// @ts-check
// UserPromptSubmit hook: consume the CONTEXT.md flag → agent-directed
// additionalContext, and record the repo as offered so it is never asked again.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  readStdin,
  safeJsonParse,
  resolveSessionId,
  resolveDataDir,
  repoClaimPath,
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

// Burn the one ask now that it is actually reaching the user. O_CREAT|O_EXCL is
// what makes "once per repo" hold: two sessions in the same repo can both carry
// a flag here, and only the one that creates the claim gets to speak.
try {
  writeFileSync(repoClaimPath(dataDir, repo), `${repo}\n`, { flag: "wx" });
} catch (err) {
  // Someone else claimed it first — they are making the offer, so stay quiet.
  if (/** @type {NodeJS.ErrnoException} */ (err).code === "EEXIST") process.exit(0);
  // Any other write failure: prefer making the offer over losing it. Worst case
  // it repeats in a later session.
}

emitAdditionalContext(
  "UserPromptSubmit",
  `[domain-modeling] \`${repo}\` has a CLAUDE.md but no CONTEXT.md, and this session edited source there. ` +
    `Offer the user — once, as a single line alongside the work, then keep going — to run the domain-modeling:domain-modeling skill ` +
    `and pin down the project's domain terms. Do not start one unprompted and do not re-offer: this fires once per repo, ever.`,
);
process.exit(0);
