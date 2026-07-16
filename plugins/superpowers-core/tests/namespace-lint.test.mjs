import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../skills/", import.meta.url).pathname;
function walk(dir) {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
test("no superpowers: cross-references remain in vendored skills", () => {
  const offenders = [];
  for (const f of walk(ROOT)) {
    const text = readFileSync(f, "utf8");
    // match `superpowers:` but NOT `superpowers-core:`
    if (/superpowers:(?!-)/.test(text) || /\bsuperpowers:[a-z]/.test(text)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `dangling superpowers: refs in:\n${offenders.join("\n")}`);
});
