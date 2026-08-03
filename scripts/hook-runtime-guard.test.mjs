// @ts-check
// Hook commands must stay in shell form. Do not "modernise" them to exec form.
//
// This test exists because that migration was attempted and reverted, and the reason
// is not visible from the hooks.json files themselves.
//
// Exec form (`command: "node"`, `args: [script]`) is genuinely nicer: Claude Code
// spawns the binary directly with no shell, so there is no sh-vs-PowerShell dialect
// to get wrong and no quoting problem for paths with spaces. It is also marginally
// faster — measured 37.7ms vs 41.1ms per invocation, on hooks that fire on every
// matching tool call.
//
// The blocker is compatibility, and it has no workaround:
//
//   1. `args` was added in Claude Code 2.1.139 ("Added hook `args: string[]` field
//      (exec form) that spawns the command directly without a shell" — CHANGELOG).
//      The hooks docs page carries no min-version marker for it; the changelog is the
//      authority. Do not read the docs page's silence as "no requirement".
//   2. On an older host `args` is ignored, so `command: "node"` degrades to
//      `sh -c "node"`. node then reads the hook's JSON payload from stdin AS
//      JAVASCRIPT and dies with a SyntaxError, so the guard never runs and fails open.
//   3. There is no way to stop that install. `engines` is NOT a recognised plugin.json
//      field — `claude plugin validate --strict` reports "Unknown field 'engines' ...
//      Claude Code ignores unrecognized fields at load time", and the plugin manifest
//      reference defines no minimum-version mechanism at all. The `engines` values in
//      this repo are documentation, not enforcement.
//
// So exec form trades a few milliseconds for a silently unguarded window on any host
// between the plugin's real floor and 2.1.139, with nothing able to prevent it.
// Shell form works on every version and every platform.
//
// Revisit only when the oldest Claude Code worth supporting is >= 2.1.139, or when a
// real minimum-version mechanism ships. Then delete this test with the migration.
//
// ---------------------------------------------------------------------------
// ccguard (2026-08-03): the compiled guards do NOT change the above.
//
// `design-gate-guard` and `workflow-model-guard` now run a committed Rust binary
// (`bin/ccguard <subcommand>`) with `|| node "…/scripts/….mjs"` as fallback. That
// is still shell form — the shell is what evaluates the `||` — so every argument
// above continues to apply unchanged.
//
// Worth noting for whoever revisits this: the failure mode in point 2 is specific
// to node being an *interpreter taking a script argument*. A binary invoked
// directly has no analogue, because there is no source-code-as-payload step to
// degrade into. So a full migration away from node would dissolve this test's
// central problem rather than work around it — but only once no hook shells out
// to node at all, which is not the case today.
//
// The fallback's residual risk, accepted: if the binary were to emit output and
// *then* fail, node would run too and stdout would carry two envelopes. The
// binary writes only at the very end of a decision and the release profile sets
// `panic = "abort"`, so there is no partial-output-then-nonzero-exit path.
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
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

test("no hook uses exec form (`args`) — unsupported before Claude Code 2.1.139", () => {
  const offenders = allHooks()
    .filter(({ hook }) => Array.isArray(hook.args))
    .map(({ plugin, event }) => `${plugin} ${event}`);
  assert.deepEqual(
    offenders,
    [],
    `exec form silently disables these hooks on hosts older than 2.1.139, and ` +
      `engines cannot prevent the install — see this file's header:\n  ${offenders.join("\n  ")}`,
  );
});

test("every hook command points at a target that exists", () => {
  // ALL plugin-root references, not just the first: a command may name both a
  // compiled binary and its `.mjs` fallback (see the ccguard note in the header),
  // and checking only the head would leave the fallback path unverified — which
  // is precisely the path that runs when something has already gone wrong.
  for (const { plugin, event, hook } of allHooks()) {
    const command = hook.command;
    if (typeof command !== "string") continue;
    for (const m of command.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/g)) {
      const target = join(pluginsDir, plugin, m[1]);
      assert.ok(existsSync(target), `${plugin} ${event}: hook targets missing file ${target}`);
    }
  }
});

test("every committed hook binary is executable", () => {
  // git tracks the +x mode bit, so this survives clone — but a binary added
  // without it produces a "Permission denied" exit 126, which the `||` fallback
  // silently swallows into the slow node path. Silent is the problem: the guard
  // would still work and nobody would notice the binary was dead weight.
  for (const plugin of readdirSync(pluginsDir)) {
    const binDir = join(pluginsDir, plugin, "bin");
    if (!existsSync(binDir)) continue;
    for (const entry of readdirSync(binDir)) {
      const target = join(binDir, entry);
      const mode = statSync(target).mode;
      assert.ok(mode & 0o111, `${plugin}: bin/${entry} is not executable (mode ${mode.toString(8)})`);
    }
  }
});

test("`engines` is treated as documentation, never as a compatibility gate", () => {
  // Pinned so a future reader does not repeat the mistake of raising this floor and
  // believing it prevents anything. Claude Code ignores the field entirely.
  for (const plugin of readdirSync(pluginsDir)) {
    const manifestPath = join(pluginsDir, plugin, ".claude-plugin", "plugin.json");
    if (!existsSync(manifestPath)) continue;
    const engines = JSON.parse(readFileSync(manifestPath, "utf8")).engines;
    if (engines === undefined) continue;
    assert.match(
      engines["claude-code"] ?? "",
      /^>=\d+\.\d+\.\d+$/,
      `${plugin}: engines.claude-code should stay a plain ">=x.y.z" note`,
    );
  }
});
