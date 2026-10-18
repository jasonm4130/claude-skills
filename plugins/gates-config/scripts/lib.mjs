// @ts-check
// Shared helpers for the gates-config plugin's scripts. Stdlib only.
// The hook-I/O surface below is duplicated in the other plugins' lib.mjs — CC plugins
// can't share files across plugin boundaries, so the duplication is intentional and
// `scripts/lib-drift.test.mjs` keeps every copy byte-identical.

import process from "node:process";

/**
 * Is this guard named in GATES_DISABLE?
 *
 *   "env": { "GATES_DISABLE": "docs-sync,agent-model" }
 *
 * A Claude Code settings.json `env` block reaches hook subprocesses, so one
 * variable turns a guard off for a single project or for every session, with no
 * config file to find, parse or fail on. `go/config.go` reads the same variable
 * the same way, and it is the side that runs: the hook calls the binary only, and
 * the .mjs guard is the reference implementation its tests run.
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
