#!/usr/bin/env node
// @ts-check
// Invoked by the /retro skill after a successful interview: records the
// per-session fired flag plus the cross-session last-retro timestamp.
// Session id comes from stdin payload or argv[2].

import { writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  readStdin,
  safeJsonParse,
  resolveSessionId,
  resolveDataDir,
  nowIso,
} from "./lib.mjs";

/**
 * @typedef {object} MarkRetroDoneInput
 * @property {string} [session_id]
 */

const raw = await readStdin();
const payload = /** @type {MarkRetroDoneInput | null} */ (safeJsonParse(raw));
const argSid =
  typeof process.argv[2] === "string" && process.argv[2].length > 0
    ? process.argv[2]
    : null;
const sessionId = argSid ?? resolveSessionId(payload);
const dataDir = resolveDataDir("session-retro-data");

try {
  writeFileSync(path.join(dataDir, `retro-fired-${sessionId}.flag`), nowIso());
  writeFileSync(path.join(dataDir, "last-retro.txt"), nowIso());
} catch {
  // best-effort
}
process.exit(0);
