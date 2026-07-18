import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, cpSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateItemDir, validateCorpusDirs, DEFAULT_CORPUS } from "./validate.mjs";

const GOOD = join(DEFAULT_CORPUS, "synthetic-0001");

function corruptedCopy(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "bench-item-"));
  cpSync(GOOD, dir, { recursive: true });
  mutate(dir);
  return dir;
}

test("the committed corpus is valid — this test gates CI", () => {
  const results = validateCorpusDirs([DEFAULT_CORPUS]);
  assert.ok(results.length >= 1);
  for (const r of results) assert.deepEqual(r.errors, [], `${r.item}: ${r.errors.join("; ")}`);
});

test("missing brief is an error", () => {
  const dir = corruptedCopy((d) => unlinkSync(join(d, "brief.md")));
  assert.ok(validateItemDir(dir).errors.some((e) => e.includes("brief.md")));
  rmSync(dir, { recursive: true, force: true });
});

test("span outside the seeded hunks is an error", () => {
  const dir = corruptedCopy((d) => {
    const t = JSON.parse(readFileSync(join(d, "truth.json"), "utf8"));
    writeFileSync(join(d, "truth.json"), JSON.stringify({ ...t, span: [500, 501] }));
  });
  assert.ok(validateItemDir(dir).errors.some((e) => e.includes("covers truth span")));
  rmSync(dir, { recursive: true, force: true });
});

test("a patch that does not apply at base is an error", () => {
  const dir = corruptedCopy((d) =>
    writeFileSync(join(d, "base", "src", "parse-duration.mjs"), "export const totally = 'different';\n"));
  assert.ok(validateItemDir(dir).errors.some((e) => e.includes("does not apply")));
  rmSync(dir, { recursive: true, force: true });
});

test("unresolvable mined repo: warning by default, error with requireRepos", () => {
  const dir = corruptedCopy((d) => {
    writeFileSync(join(d, "item.json"), JSON.stringify({
      id: "mined-gone", tranche: "mined", repo: "/nonexistent/repo",
      baseSha: "a".repeat(40), private: true, language: "js",
    }));
    rmSync(join(d, "base"), { recursive: true, force: true });
  });
  const dflt = validateItemDir(dir);
  assert.deepEqual(dflt.errors, []);
  assert.ok(dflt.warnings.some((w) => w.includes("unresolvable")));
  assert.ok(validateItemDir(dir, { requireRepos: true }).errors.some((e) => e.includes("unresolvable")));
  rmSync(dir, { recursive: true, force: true });
});
