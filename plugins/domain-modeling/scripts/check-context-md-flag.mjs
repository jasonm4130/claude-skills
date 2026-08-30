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
  emitOffer,
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

// Re-check the condition before speaking. The flag was written at Stop, and the
// user gets a whole turn boundary to act before their next prompt arrives — long
// enough to create the CONTEXT.md themselves. Emitting on the stale flag would
// tell them a file they just wrote doesn't exist, and would spend the permanent
// one-per-repo claim to say it.
if (
  !existsSync(path.join(repo, "CLAUDE.md")) ||
  existsSync(path.join(repo, "CONTEXT.md")) ||
  existsSync(path.join(repo, "CONTEXT-MAP.md"))
) {
  process.exit(0);
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

emitOffer(
  "UserPromptSubmit",
  `[domain-modeling] \`${repo}\` has a CLAUDE.md but no CONTEXT.md, and you edited source there this session. ` +
    `A glossary pins the domain's canonical names so future sessions spend fewer tokens reasoning about vocabulary. ` +
    `Say the word and I'll run the domain-modeling skill; otherwise I'll leave it — this offer fires once per repo, ever.`,
  `[domain-modeling] The user has just been shown a one-line offer to build a CONTEXT.md glossary for \`${repo}\`. ` +
    `Do not start one unprompted and do not repeat the offer; act only if they take it up.`,
);
process.exit(0);
