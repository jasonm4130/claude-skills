// @ts-check
// Tests for scripts/update-plugins.sh's dependency step: after updating, it
// re-runs `claude plugin install` for each of this marketplace's plugins that
// `claude plugin list --json` reports with an unsatisfied dependency, because
// Claude Code installs only one missing dependency per install.
//
// A stub `claude` on PATH stands in for the CLI, and HOME points at a temp dir
// holding just the marketplace metadata, so nothing touches a real install.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./update-plugins.sh", import.meta.url));
const MARKETPLACE = "jasonm4130-claude-skills";

// The stub reads its world from state.json and appends each install to installs.log.
// Each install of a plugin satisfies one of its missing dependencies, as the real
// CLI does, unless `neverResolves` is set.
const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = path.dirname(process.argv[1]);
const statePath = path.join(dir, "state.json");
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const [, , ...args] = process.argv;
const cmd = args.slice(0, 2).join(" ");
if (cmd === "plugin list") {
  if (state.listFails) process.exit(1);
  process.stdout.write(JSON.stringify(state.plugins.map((p) => ({
    id: p.id,
    errorDetails: p.missing > 0
      ? [{ type: "dependency-unsatisfied", plugin: p.id, dependency: "dep@x" }]
      : [],
  }))));
} else if (cmd === "plugin install") {
  fs.appendFileSync(path.join(dir, "installs.log"), args[2] + "\\n");
  const p = state.plugins.find((q) => q.id === args[2]);
  if (p && !state.neverResolves) p.missing -= 1;
  fs.writeFileSync(statePath, JSON.stringify(state));
}
`;

/**
 * @param {{ plugins: { id: string, missing: number }[], listFails?: boolean, neverResolves?: boolean }} state
 */
function run(state) {
  const home = mkdtempSync(path.join(os.tmpdir(), "update-plugins-"));
  try {
    const bin = path.join(home, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "claude"), STUB);
    chmodSync(path.join(bin, "claude"), 0o755);
    writeFileSync(path.join(bin, "state.json"), JSON.stringify(state));
    writeFileSync(path.join(bin, "installs.log"), "");

    // An install always has the cache dir; the script's snapshot() fails without it.
    mkdirSync(path.join(home, ".claude/plugins/cache", MARKETPLACE), { recursive: true });
    const meta = path.join(home, ".claude/plugins/marketplaces", MARKETPLACE, ".claude-plugin");
    mkdirSync(meta, { recursive: true });
    writeFileSync(
      path.join(meta, "marketplace.json"),
      JSON.stringify({ plugins: [{ name: "gates", version: "0.7.0" }] }),
    );

    const res = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    });
    const installs = readFileSync(path.join(bin, "installs.log"), "utf8").split("\n").filter(Boolean);
    return { status: res.status, stdout: res.stdout, stderr: res.stderr, installs };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const SUMMARY = /nothing to fetch/;
const GATES = `gates@${MARKETPLACE}`;

test("re-installs a plugin once per missing dependency, then prints the summary", () => {
  const r = run({ plugins: [{ id: GATES, missing: 3 }] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.installs, [GATES, GATES, GATES]);
  assert.match(r.stdout, SUMMARY);
});

test("installs nothing when no dependency is missing", () => {
  const r = run({ plugins: [{ id: GATES, missing: 0 }] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.installs, []);
  assert.match(r.stdout, SUMMARY);
});

test("leaves another marketplace's plugins alone", () => {
  const r = run({ plugins: [{ id: "bundle@someone-else", missing: 2 }] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.installs, []);
});

test("stops after 8 passes when a dependency never installs", () => {
  const r = run({ plugins: [{ id: GATES, missing: 1 }], neverResolves: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.installs.length, 8);
  assert.match(r.stdout, SUMMARY);
});

test("a failed plugin listing is reported, and the summary still prints", () => {
  const r = run({ plugins: [], listFails: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /could not list plugins/);
  assert.match(r.stdout, SUMMARY);
});
