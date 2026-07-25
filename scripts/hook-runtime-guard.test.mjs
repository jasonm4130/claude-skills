// @ts-check
// Every hook that shells out to `node` must first probe that node exists.
//
// Claude Code no longer requires Node: the native install ships a self-contained
// binary, and even the npm package "installs the same native binary... [which]
// does not itself invoke Node" (docs.claude.com/en/docs/claude-code/setup, system
// requirements list OS/RAM/shell/ripgrep and no Node). So `node` on PATH is an
// external prerequisite this repo must probe for, not something the host guarantees.
//
// Without the probe, a user without node gets exit 127 from `sh -c`, which Claude
// Code treats as a NON-BLOCKING error: the guard fails open AND the transcript shows
// a "hook error" notice on every matching event. On a PreToolUse:Bash matcher that is
// every Bash call. Silent skip is the lesser evil (a guard that cannot run cannot
// guard either way); the reason still reaches `claude --debug` via stderr, which on
// exit 0 goes to the debug log rather than the transcript.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginsDir = join(repoRoot, "plugins");

/** @returns {Array<{plugin: string, event: string, command: string}>} */
function allHookCommands() {
  /** @type {Array<{plugin: string, event: string, command: string}>} */
  const out = [];
  for (const plugin of readdirSync(pluginsDir)) {
    const manifest = join(pluginsDir, plugin, "hooks", "hooks.json");
    if (!existsSync(manifest)) continue;
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    for (const [event, matchers] of Object.entries(parsed.hooks ?? {})) {
      for (const matcher of /** @type {any[]} */ (matchers)) {
        for (const hook of matcher.hooks ?? []) {
          if (typeof hook.command === "string") out.push({ plugin, event, command: hook.command });
        }
      }
    }
  }
  return out;
}

test("every hooks.json command that runs node probes for node first", () => {
  const offenders = [];
  for (const { plugin, event, command } of allHookCommands()) {
    // Only commands that actually invoke the node binary are in scope.
    if (!/(^|[;&|\s])node\s/.test(command)) continue;
    const probes = command.includes("command -v node >/dev/null 2>&1 ||");
    // `exec` so node's exit code reaches Claude Code unchanged — a wrapping shell
    // would otherwise be free to mask a blocking exit 2.
    const execs = /exec\s+node\s/.test(command);
    if (!probes || !execs) offenders.push(`${plugin} ${event}: ${command}`);
  }
  assert.deepEqual(offenders, [], `hook commands invoke node without a probe:\n  ${offenders.join("\n  ")}`);
});

test("the probe skips silently rather than failing the hook", () => {
  for (const { plugin, event, command } of allHookCommands()) {
    if (!/(^|[;&|\s])node\s/.test(command)) continue;
    assert.match(
      command,
      /\|\|\s*\{[^}]*exit 0[^}]*\}/,
      `${plugin} ${event}: probe must exit 0 (non-zero is a visible per-call hook error)`,
    );
    assert.match(
      command,
      />&2/,
      `${plugin} ${event}: probe must explain itself on stderr so it is visible under --debug`,
    );
  }
});

test("shell hook scripts that invoke node probe for it too", () => {
  // superpowers-core is an owned fork (see its README), not a pristine vendor, so its
  // hook script is in scope for the same guarantee.
  const script = join(pluginsDir, "superpowers-core", "hooks", "session-start");
  const body = readFileSync(script, "utf8");
  assert.match(body, /(^|[;&|\s])node\s/, "fixture drift: this script no longer invokes node");
  assert.match(
    body,
    /command -v node >\/dev\/null 2>&1 \|\|/,
    "superpowers-core/hooks/session-start invokes node without probing for it",
  );
});
