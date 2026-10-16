// @ts-check
// Shared helpers for the gates-models plugin's scripts. Stdlib only.
// The hook-I/O surface below is duplicated in the other plugins' lib.mjs — CC plugins
// can't share files across plugin boundaries, so the duplication is intentional and
// `scripts/lib-drift.test.mjs` keeps every copy byte-identical.

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
 * Emit a PreToolUse permission-decision envelope to stdout.
 * `deny` feeds `reason` back to Claude as feedback; `ask` prompts the user;
 * `allow` skips the interactive prompt. Writes a single JSON object plus newline.
 * @param {"allow" | "deny" | "ask"} decision
 * @param {string} reason
 */
export function emitPermissionDecision(decision, reason) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(payload) + "\n");
}

/**
 * Is this guard named in GATES_DISABLE?
 *
 *   "env": { "GATES_DISABLE": "docs-sync,agent-model" }
 *
 * A Claude Code settings.json `env` block reaches hook subprocesses, so one
 * variable turns a guard off for a single project or for every session, with no
 * config file to find, parse or fail on. The committed ccguard binary reads the
 * same variable the same way (its source ships in the gates-config plugin).
 *
 * Both sides are load-bearing. The binary exits 0 when a guard is disabled, so
 * `|| node` never fires on a machine that runs it — and fires on every machine
 * that does not.
 *
 * Matching is exact. An unrecognised name disables nothing and says nothing,
 * which is the same fail-open posture the guards themselves hold.
 *
 * @param {string} name
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isGuardDisabled(name, env = process.env) {
  const raw = env.GATES_DISABLE;
  if (typeof raw !== "string") return false;
  return raw.split(",").some((field) => field.trim() === name);
}
