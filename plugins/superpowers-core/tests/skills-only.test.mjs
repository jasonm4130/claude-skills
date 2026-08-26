import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";

const ROOT = new URL("../", import.meta.url).pathname;

// The using-skills kernel moved to the owner's global CLAUDE.md; this plugin is
// now five method skills and nothing else. A returning hook or a re-added
// dispatcher skill would restate the rule in a second place.
test("ships the five method skills and no dispatcher", () => {
  const skills = readdirSync(new URL("../skills/", import.meta.url).pathname, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  assert.deepEqual(skills, [
    "brainstorming",
    "systematic-debugging",
    "test-driven-development",
    "writing-plans",
    "writing-skills",
  ]);
});

test("ships no SessionStart hook", () => {
  assert.equal(existsSync(`${ROOT}hooks`), false);
});
