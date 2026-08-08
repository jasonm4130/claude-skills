// @ts-check
// Shared helpers for session-retro plugin scripts. Stdlib only.
// Duplicated surface mirrors plugins/handoff/scripts/lib.mjs — CC plugins can't
// share files across plugin boundaries, so the duplication is intentional.

import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";

/**
 * Read all of stdin as a utf8 string.
 * @returns {Promise<string>}
 */
export async function readStdin() {
  // A TTY never reaches EOF, so waiting for "end" would hang a hand-run script
  // forever. Hooks always pipe, so this only affects interactive invocation.
  if (process.stdin.isTTY) return "";
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    process.stdin.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    process.stdin.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", reject);
  });
}

/**
 * Parse JSON without throwing.
 * @param {string} raw
 * @returns {object | null}
 */
export function safeJsonParse(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Resolve session_id from a parsed hook payload, with env fallback.
 * @param {object | null} payload
 * @returns {string}
 */
export function resolveSessionId(payload) {
  if (payload && typeof /** @type {any} */ (payload).session_id === "string") {
    const sid = /** @type {any} */ (payload).session_id;
    if (sid.length > 0) return sid;
  }
  const envSid = process.env.CLAUDE_SESSION_ID;
  if (typeof envSid === "string" && envSid.length > 0) return envSid;
  return "unknown";
}

/**
 * Resolve CLAUDE_PLUGIN_DATA, creating the directory if needed.
 * Falls back to `os.tmpdir() + "/<fallbackName>"`.
 * @param {string} fallbackName
 * @returns {string}
 */
export function resolveDataDir(fallbackName) {
  const fromEnv = process.env.CLAUDE_PLUGIN_DATA;
  const dir =
    typeof fromEnv === "string" && fromEnv.length > 0
      ? fromEnv
      : path.join(os.tmpdir(), fallbackName);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort; downstream writers will surface real errors
  }
  return dir;
}

/**
 * Emit a hookSpecificOutput envelope to stdout (issue #53682 safe form).
 * Writes a single JSON object plus trailing newline.
 * @param {string} eventName
 * @param {string} additionalContext
 */
export function emitAdditionalContext(eventName, additionalContext) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(payload) + "\n");
}

// Shared with stop-write-retro-flag.mjs. The PostToolUse hook classifies the
// *full* command before the byte budget can clip it, so a classifier buried in
// the middle of an oversized command survives; Stop still re-checks the stored
// command so pre-v2 events keep working.
export const TESTS_RE =
  /pytest|jest |go test|cargo test|npm test|npm run test|bun test|yarn test/;
export const COMMIT_RE = /git commit/;

/**
 * Classify a Bash command. Returns null when nothing matched, so the common
 * case adds no bytes to the event.
 * @param {unknown} cmd
 * @returns {{ t?: true, c?: true } | null}
 */
export function classifyCommand(cmd) {
  if (typeof cmd !== "string" || cmd.length === 0) return null;
  /** @type {{ t?: true, c?: true }} */
  const out = {};
  if (TESTS_RE.test(cmd)) out.t = true;
  if (COMMIT_RE.test(cmd)) out.c = true;
  return out.t || out.c ? out : null;
}

/**
 * ISO-8601 UTC timestamp ("YYYY-MM-DDTHH:MM:SSZ"). No fractional seconds.
 * @returns {string}
 */
export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Distinct sids recorded in retro-processed.jsonl (append-only ledger of
 * sessions already retro'd). Malformed lines are skipped.
 * @param {string} dataDir
 * @returns {Set<string>}
 */
function readProcessedSet(dataDir) {
  /** @type {Set<string>} */
  const set = new Set();
  try {
    const lines = readFileSync(
      path.join(dataDir, "retro-processed.jsonl"),
      "utf8",
    ).split("\n");
    for (const line of lines) {
      if (line.length === 0) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e && typeof e.sid === "string" && e.sid.length > 0) set.add(e.sid);
    }
  } catch {
    // no ledger yet
  }
  return set;
}

/**
 * One-time upgrade migration. If retro-processed.jsonl is absent, seed it from
 * legacy state: every worthy sid whose ts <= lastRetroMs — the set the old
 * timestamp watermark treated as already retro'd. Entries newer than the last
 * retro stay unprocessed, exactly as the old prune left them. Idempotent: the
 * ledger's existence is the guard, so it runs at most once. This is the ONLY
 * place a timestamp touches membership, and only to reproduce the legacy cut.
 * @param {string} dataDir
 */
export function migrateProcessedLedger(dataDir) {
  const processedPath = path.join(dataDir, "retro-processed.jsonl");
  if (existsSync(processedPath)) return;

  let lastRetroMs = 0;
  try {
    const t = Date.parse(
      readFileSync(path.join(dataDir, "last-retro.txt"), "utf8").trim(),
    );
    if (Number.isFinite(t)) lastRetroMs = t;
  } catch {
    // no last-retro → nothing is legacy-done
  }

  /** @type {string[]} */
  const seeded = [];
  /** @type {Set<string>} */
  const seen = new Set();
  try {
    const lines = readFileSync(
      path.join(dataDir, "retro-worthy.jsonl"),
      "utf8",
    ).split("\n");
    for (const line of lines) {
      if (line.length === 0) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (!e || typeof e.sid !== "string" || e.sid.length === 0) continue;
      if (seen.has(e.sid)) continue;
      seen.add(e.sid);
      const t = Date.parse(typeof e.ts === "string" ? e.ts : "");
      if (Number.isFinite(t) && t <= lastRetroMs) seeded.push(e.sid);
    }
  } catch {
    // no worthy log → seed nothing, but still create the ledger below
  }

  // Create the ledger (even empty) so the guard trips on later runs. Use an
  // exclusive create ('wx'): if another migration OR a concurrent
  // mark-retro-done append created it between our existsSync check and here, the
  // write throws EEXIST and we leave that writer's content intact — never a
  // read-then-overwrite that could clobber a concurrent append. Losing the race
  // just means the ledger already exists, which is the desired end state.
  try {
    const body = seeded
      .map((sid) => JSON.stringify({ ts: nowIso(), sid }))
      .join("\n");
    writeFileSync(processedPath, body.length > 0 ? body + "\n" : "", {
      flag: "wx",
    });
  } catch {
    // EEXIST (already created) or best-effort failure — nothing to do.
  }
}

/**
 * The unprocessed worthy sessions: distinct sids in retro-worthy.jsonl (first-seen
 * file order, newest-last) minus any sid in retro-processed.jsonl. Pure identity
 * set-difference — no timestamp comparison. Runs the upgrade migration first.
 * @param {string} dataDir
 * @returns {{ sid: string, reasons: string }[]}
 */
export function unprocessedWorthySessions(dataDir) {
  migrateProcessedLedger(dataDir);
  const processedSet = readProcessedSet(dataDir);
  /** @type {{ sid: string, reasons: string }[]} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  let lines;
  try {
    lines = readFileSync(
      path.join(dataDir, "retro-worthy.jsonl"),
      "utf8",
    ).split("\n");
  } catch {
    return out;
  }
  for (const line of lines) {
    if (line.length === 0) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e.sid !== "string" || e.sid.length === 0) continue;
    if (seen.has(e.sid)) continue;
    seen.add(e.sid);
    if (processedSet.has(e.sid)) continue;
    out.push({
      sid: e.sid,
      reasons: typeof e.reasons === "string" ? e.reasons : "",
    });
  }
  return out;
}
