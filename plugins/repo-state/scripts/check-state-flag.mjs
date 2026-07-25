#!/usr/bin/env node
// @ts-check
// UserPromptSubmit hook: consume the repo-state drift flag → agent-directed
// additionalContext. Fire-once per flag set.

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  readStdin,
  safeJsonParse,
  resolveSessionId,
  resolveDataDir,
  emitAdditionalContext,
  STATE_DOC_REL,
} from "./lib.mjs";

const raw = await readStdin();
const payload = safeJsonParse(raw);
const sessionId = resolveSessionId(payload);
const dataDir = resolveDataDir("repo-state-data");
const flag = path.join(dataDir, `repostate-nudge-${sessionId}.flag`);

if (!existsSync(flag)) process.exit(0);

/** @type {string} */
let detail;
try {
  detail = readFileSync(flag, "utf8").trim();
} catch {
  process.exit(0);
}
try {
  unlinkSync(flag);
} catch {
  // best-effort — fire-once is desirable but a failed unlink shouldn't block emission
}

emitAdditionalContext(
  "UserPromptSubmit",
  `[repo-state] ${STATE_DOC_REL} is ${detail}. Run /repo-state refresh to reconcile it against the ` +
    `diff since its stamp, or tell the user it is stale and why you are not refreshing it now.`,
);
process.exit(0);
