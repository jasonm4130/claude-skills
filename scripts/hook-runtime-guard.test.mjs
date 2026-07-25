// @ts-check
// Node-invoking hooks must go through the polyglot launcher, which probes for node.
//
// Claude Code no longer requires Node: the native install ships a self-contained
// binary, and even the npm package "installs the same native binary... [which] does
// not itself invoke Node" (code.claude.com/docs/en/setup — the system requirements
// list OS/RAM/shell/ripgrep and no Node). So `node` on PATH is an external
// prerequisite this repo must probe for, not something the host guarantees. Without
// a probe a node-less machine gets exit 127, which Claude Code treats as a
// NON-BLOCKING error: the guard fails open AND every matching event prints a "hook
// error" notice — on a PreToolUse:Bash matcher, every Bash call.
//
// The probe cannot live inline in hooks.json. Claude Code picks the hook shell per
// platform: sh on macOS/Linux, Git Bash on Windows, but PowerShell on native Windows
// when Git Bash is absent. `command -v` / `>&2` / `exec` are not valid PowerShell, so
// an inline POSIX probe errors before node runs and breaks a supported configuration
// that plain `node "<script>"` had worked on. Hence run-hook.cmd: a polyglot batch/sh
// launcher (the pattern obra/superpowers uses) that probes on both paths.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
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

test("no hooks.json command invokes node directly", () => {
  const offenders = allHookCommands()
    .filter(({ command }) => /(^|[;&|\s])node\s/.test(command))
    .map(({ plugin, event, command }) => `${plugin} ${event}: ${command}`);
  assert.deepEqual(
    offenders,
    [],
    `these bypass the launcher, so they carry no node probe:\n  ${offenders.join("\n  ")}`,
  );
});

test("every launcher-based hook names a script that exists", () => {
  for (const { plugin, event, command } of allHookCommands()) {
    const m = /run-hook\.cmd" (\S+)/.exec(command);
    if (!m) continue;
    const script = join(pluginsDir, plugin, "scripts", `${m[1]}.mjs`);
    assert.ok(existsSync(script), `${plugin} ${event}: launcher targets missing script ${script}`);
  }
});

test("each launcher probes for node on BOTH the batch and POSIX paths", () => {
  const plugins = new Set(
    allHookCommands()
      .filter(({ command }) => command.includes("run-hook.cmd"))
      .map(({ plugin }) => plugin),
  );
  assert.ok(plugins.size > 0, "fixture drift: no plugin routes hooks through run-hook.cmd");

  for (const plugin of plugins) {
    const launcher = join(pluginsDir, plugin, "hooks", "run-hook.cmd");
    assert.ok(existsSync(launcher), `${plugin}: hooks.json references a missing run-hook.cmd`);
    const body = readFileSync(launcher, "utf8");

    // Polyglot framing: sh must swallow the batch block as a heredoc.
    assert.match(body, /^: << 'CMDBLOCK'/, `${plugin}: launcher must open with the sh heredoc guard`);
    assert.match(body, /^CMDBLOCK$/m, `${plugin}: launcher must close the heredoc`);

    // Windows/cmd path — PowerShell invokes .cmd via cmd.exe.
    assert.match(body, /where node >nul 2>nul/, `${plugin}: launcher must probe for node in batch`);
    assert.match(body, /exit \/b 0/, `${plugin}: batch probe must skip with exit 0, not an error`);

    // POSIX path.
    assert.match(
      body,
      /command -v node >\/dev\/null 2>&1 \|\| \{[^}]*exit 0[^}]*\}/,
      `${plugin}: launcher must probe for node in sh and skip with exit 0`,
    );
    // exec so a blocking exit 2 from the hook script cannot be masked by the shell.
    assert.match(body, /exec node /, `${plugin}: launcher must exec node so its exit code propagates`);

    // sh has to be able to execve it.
    assert.ok(
      (statSync(launcher).mode & 0o111) !== 0,
      `${plugin}: run-hook.cmd must be executable or sh -c cannot run it`,
    );
  }
});

test("shell hook scripts that invoke node probe for it too", () => {
  // superpowers-core is an owned fork (see its README), not a pristine vendor, so its
  // hook script is in scope for the same guarantee. It is a #!/bin/sh script, so it was
  // already unusable on native Windows without Git Bash — the probe below is about the
  // node prerequisite, not that pre-existing platform limitation.
  const script = join(pluginsDir, "superpowers-core", "hooks", "session-start");
  const body = readFileSync(script, "utf8");
  assert.match(body, /(^|[;&|\s])node\s/, "fixture drift: this script no longer invokes node");
  assert.match(
    body,
    /command -v node >\/dev\/null 2>&1 \|\|/,
    "superpowers-core/hooks/session-start invokes node without probing for it",
  );
});
