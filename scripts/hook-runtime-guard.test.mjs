// @ts-check
// Node hooks must use exec form, never a shell.
//
// Claude Code picks the hook shell per platform: sh on macOS/Linux, Git Bash on
// Windows, but PowerShell on native Windows when Git Bash is absent. Any shell
// syntax in a hook command is therefore a portability trap — a POSIX probe such as
// `command -v node >/dev/null 2>&1 || exit 0` is invalid PowerShell and errors
// before node ever runs, breaking the hook on a supported configuration.
//
// Exec form (`command` + `args`) sidesteps the whole problem: Claude Code resolves
// `command` on PATH and spawns it directly with no shell on any platform, so there is
// no dialect to get wrong. It also drops the `sh -c` fork — measured 45.6ms through a
// shell launcher vs 37.7ms exec form, on hooks that run on every matching tool call.
//
// The trade this encodes: `node` is an external prerequisite (Claude Code ships a
// self-contained native binary and its documented system requirements do not include
// Node), so on a machine without it the spawn fails and Claude Code shows a
// non-blocking "hook error" per event. That failure is loud and self-diagnosing,
// which is preferred here over carrying a shell launcher whose Windows branch this
// repo cannot test — CI runs ubuntu and macos only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginsDir = join(repoRoot, "plugins");

/** @returns {Array<{plugin: string, event: string, hook: any}>} */
function allHooks() {
  /** @type {Array<{plugin: string, event: string, hook: any}>} */
  const out = [];
  for (const plugin of readdirSync(pluginsDir)) {
    const manifest = join(pluginsDir, plugin, "hooks", "hooks.json");
    if (!existsSync(manifest)) continue;
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    for (const [event, matchers] of Object.entries(parsed.hooks ?? {})) {
      for (const matcher of /** @type {any[]} */ (matchers)) {
        for (const hook of matcher.hooks ?? []) out.push({ plugin, event, hook });
      }
    }
  }
  return out;
}

test("every node hook uses exec form, not a shell command string", () => {
  const offenders = [];
  for (const { plugin, event, hook } of allHooks()) {
    const command = hook.command;
    if (typeof command !== "string") continue;
    // A node hook in exec form has command exactly "node"; in shell form the binary
    // name is embedded in a command string that a shell has to tokenize.
    const isExecNode = command === "node" && Array.isArray(hook.args);
    const mentionsNode = /(^|[;&|\s])node(\s|$)/.test(command);
    if (mentionsNode && !isExecNode) offenders.push(`${plugin} ${event}: ${command}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `these run node through a shell, so they depend on the platform's shell dialect:\n  ${offenders.join("\n  ")}`,
  );
});

test("exec-form hooks carry no shell metacharacters in command or args", () => {
  for (const { plugin, event, hook } of allHooks()) {
    if (hook.command !== "node") continue;
    for (const arg of hook.args ?? []) {
      // ${CLAUDE_PLUGIN_ROOT} is substituted by Claude Code as a plain string, not by a
      // shell, so it is the one brace/dollar construct that belongs here — strip it
      // before looking for syntax that would only ever mean something to a shell.
      const rest = arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", "");
      assert.doesNotMatch(
        rest,
        /[;&|><$(){}]/,
        `${plugin} ${event}: arg "${arg}" contains shell syntax, which exec form never interprets`,
      );
    }
    // `shell` is ignored in exec form — carrying it would imply a guarantee it can't make.
    assert.equal(hook.shell, undefined, `${plugin} ${event}: "shell" is ignored when args is set`);
  }
});

test("every exec-form hook names a script that exists", () => {
  for (const { plugin, event, hook } of allHooks()) {
    if (hook.command !== "node") continue;
    const args = hook.args ?? [];
    assert.equal(args.length, 1, `${plugin} ${event}: expected exactly one script arg`);
    const rel = args[0].replace("${CLAUDE_PLUGIN_ROOT}/", "");
    const script = join(pluginsDir, plugin, rel);
    assert.ok(existsSync(script), `${plugin} ${event}: hook targets missing script ${script}`);
  }
});

test("no plugin still ships the retired shell launcher", () => {
  const leftovers = readdirSync(pluginsDir).filter((p) =>
    existsSync(join(pluginsDir, p, "hooks", "run-hook.cmd")),
  );
  assert.deepEqual(leftovers, [], `run-hook.cmd is superseded by exec form: ${leftovers.join(", ")}`);
});
