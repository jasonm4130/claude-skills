import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const s = readFileSync(join(here, "SKILL.md"), "utf8");

test("frontmatter names the frontend-design skill with a trigger-rich, negatively-scoped description", () => {
  assert.match(s, /^---\nname: frontend-design\n/);
  assert.match(s, /description:.*design/i);
  assert.match(s, /Do NOT use for/);
  assert.match(s, /backend\/API\/data-model/);
});

// The built-in `design` skill builds a canvas of artboards the user tweaks by hand;
// this skill puts design decisions into shipped code. Without the boundary in the
// description, the two match the same "make me a landing page" phrasing.
test("description disclaims the built-in design skill and names the browser route", () => {
  const description = /description: '([\s\S]*?)'\n/.exec(s)?.[1].replace(/''/g, "'");
  assert.ok(description, "description must be a single-quoted frontmatter scalar");
  assert.match(description, /Do NOT use when the user wants a visual mockup, wireframe, canvas, or artboard/);
  assert.match(description, /built-in `design` skill/);
  assert.match(description, /applies design decisions to real code in the repo/);
  assert.match(description, /claude\.ai\/design/);
});

test("documents the light/heavy scope gate and the light-path loop", () => {
  assert.match(s, /Light — design inline/);
  assert.match(s, /Heavy — hand off to the browser/);
  assert.match(s, /Ground it in the subject/);
  assert.match(s, /Design principles/);
  assert.match(s, /### Explore/);
  assert.match(s, /Self-critique/);
  // the loop line is the roadmap a model follows — every step below must appear in it
  assert.match(s, /Work this loop:.*cut the AI tells.*self-critique/);
});

// The claude-design plugin was folded in here; a pointer to it is now a dangling
// reference to a skill nobody has installed.
test("no dangling reference to the retired claude-design skill", () => {
  assert.doesNotMatch(s, /claude-design/);
});

test("heavy path routes both destinations: the built-in canvas and the browser", () => {
  assert.match(s, /Claude Design/);
  assert.match(s, /claude\.ai\/design/);
  assert.match(s, /built-in `design` skill/);
});

test("heavy path emits the paste-ready brief on the goal/layout/content/audience framework", () => {
  assert.match(s, /# Design brief: <what you're building>/);
  assert.match(s, /\*\*Goal\*\*/);
  assert.match(s, /\*\*Audience\*\*/);
  assert.match(s, /\*\*Layout \/ screens\*\*/);
  assert.match(s, /\*\*Content\*\*/);
  assert.match(s, /\*\*Visual direction\*\*/);
  assert.match(s, /\*\*Constraints\*\*/);
  assert.match(s, /\*\*Assets to attach\*\*/);
  assert.match(s, /start simple, then layer in complexity/);
});

// The one Claude Design mechanic worth carrying over: a real design system beats
// prose about one, and /design-sync is how a large repo hands its own components in.
test("heavy path keeps the /design-sync design-system route", () => {
  assert.match(s, /`\/design-sync`/);
});

test("light path carries a concrete anti-tell floor covering every named rule", () => {
  assert.match(s, /### Cut the AI tells/);
  assert.match(s, /\*\*Real assets, not fakes\.\*\*/);
  assert.match(s, /\*\*No invented telemetry or chrome\.\*\*/);
  assert.match(s, /\*\*Vary the section rhythm\.\*\*/);
  assert.match(s, /\*\*Hero discipline\.\*\*/);
  assert.match(s, /\*\*Grids fit their content\.\*\*/);
  assert.match(s, /\*\*One coherent theme per surface\.\*\*/);
  // heading presence alone would still pass if the section were moved under the heavy
  // path, where it does not belong — pin it inside the light path
  const floorAt = s.indexOf("### Cut the AI tells");
  assert.ok(floorAt > s.indexOf("## Light path"), "anti-tell floor must follow the light-path heading");
  assert.ok(floorAt < s.indexOf("## Heavy path"), "anti-tell floor must precede the heavy-path heading");
});
