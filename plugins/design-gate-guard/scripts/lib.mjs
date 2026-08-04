// @ts-check
// Shared helpers for design-gate-guard plugin scripts. Stdlib only.
// Duplicated surface mirrors the other guard plugins' lib.mjs — CC plugins can't
// share files across plugin boundaries, so the duplication is intentional.

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
