// The committed plugins/gates/bin/ccguard is only checkable because its build is
// reproducible, and it is only reproducible with one Go toolchain and one set of
// flags. CI rebuilds it and compares bytes, so any drift in either reads as "the
// binary is stale" on a PR that touched neither. These tests keep the pin and the
// flags in one place each.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("go.mod pins a patch toolchain, and mise.toml pins the same one", () => {
  const toolchain = read("plugins/gates/go/go.mod").match(/^toolchain go(\d+\.\d+\.\d+)$/m);
  assert.ok(toolchain, "plugins/gates/go/go.mod has no `toolchain goX.Y.Z` line");
  const mise = read("mise.toml").match(/^go\s*=\s*"([^"]+)"/m);
  assert.ok(mise, "mise.toml pins no go version");
  assert.equal(mise[1], toolchain[1], "mise.toml and go.mod pin different Go toolchains");
});

test("CI installs exactly go.mod's toolchain patch and lets the directive apply", () => {
  const ci = read(".github/workflows/ci.yml");
  // go-version-file resolves the `go 1.27` line to the newest 1.27.x, so CI reads
  // the `toolchain` line itself and hands setup-go that exact patch.
  assert.match(ci, /sed -n 's\/\^toolchain go\/\/p' plugins\/gates\/go\/go\.mod/);
  const versions = [...ci.matchAll(/^\s*go-version:\s*(.+)$/gm)].map((m) => m[1].trim());
  assert.deepEqual(versions, ["${{ steps.gotoolchain.outputs.version }}"], "a floating go-version overrides the go.mod pin");
  assert.doesNotMatch(ci, /go-version-file:/, "go-version-file installs the newest patch, not the pinned one");
  // A runner defaulting to GOTOOLCHAIN=local silently ignores the directive.
  assert.match(ci, /GOTOOLCHAIN: auto/);
});

test("build.sh builds with exactly the go.mod toolchain, not a newer local one", () => {
  // go.mod's `toolchain` line is a minimum: under GOTOOLCHAIN=auto a newer local Go
  // builds with itself. setup-go installs the newest 1.27.x from the `go 1.27` line,
  // so CI went red the day 1.27.2 shipped. GOTOOLCHAIN=<exact> is the only pin.
  const build = read("plugins/gates/go/build.sh");
  assert.match(build, /^export GOTOOLCHAIN=.*\btoolchain\b.*go\.mod/m);
  // CI checks what it just built, not only what is committed, so a toolchain
  // mismatch reports as drift rather than as a stale binary.
  assert.match(read(".github/workflows/ci.yml"), /go version -m \/tmp\/fresh-universal/);
});

test("only build.sh writes out the ccguard build flags", () => {
  // Dated plans and research are records of what was true then; they are not
  // instructions anything runs.
  const SKIP = new Set([".git", "node_modules", "research", "plans", "superpowers"]);
  /** @param {string} dir @returns {string[]} */
  function walk(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (SKIP.has(e.name)) return [];
      const abs = join(dir, e.name);
      if (e.isDirectory()) return walk(abs);
      return e.isFile() && /\.(md|mjs|js|sh|ya?ml)$/.test(e.name) ? [abs] : [];
    });
  }
  const offenders = walk(root)
    .map((abs) => relative(root, abs))
    .filter((p) => p !== "plugins/gates/go/build.sh" && p !== "scripts/go-toolchain-pin.test.mjs")
    .filter((p) => /-ldflags/.test(read(p)));
  assert.deepEqual(offenders, [], "point these at plugins/gates/go/build.sh instead of retyping its flags");
});
