#!/usr/bin/env node
// @ts-check
// UserPromptSubmit hook: consume the shipgate flag → agent-directed
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
} from "./lib.mjs";

const raw = await readStdin();
const payload = safeJsonParse(raw);
const sessionId = resolveSessionId(payload);
const dataDir = resolveDataDir("ship-gate-data");
const flag = path.join(dataDir, `shipgate-nudge-${sessionId}.flag`);

if (!existsSync(flag)) process.exit(0);

/** @type {string} */
let detail;
try {
  detail = readFileSync(flag, "utf8");
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
  `[ship-gate] Unshipped work: ${detail}. Before this session winds down, run /code-review on the branch diff, then finish the branch (push + PR — e.g. commit-commands:commit-push-pr) or state explicitly to the user what remains unshipped and why.`,
);
process.exit(0);
