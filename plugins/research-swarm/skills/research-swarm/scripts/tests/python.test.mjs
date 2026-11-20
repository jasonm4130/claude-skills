// @ts-check
// Runs the research-swarm Python unittest suite from the repo's node test runner,
// so CI (which runs only *.test.mjs) covers the stdlib-only Python scripts too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const probe = spawnSync("python3", ["--version"], { encoding: "utf8" });

test("research-swarm python unittests pass", { skip: probe.status !== 0 && "python3 not on PATH" }, () => {
  const r = spawnSync("python3", ["-m", "unittest", "discover", "-s", here], {
    cwd: dirname(here),
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    timeout: 120000,
  });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 0, out);
  assert.match(out, /^OK\b/m, out);
});
