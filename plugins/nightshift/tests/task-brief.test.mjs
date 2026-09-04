// loop/task-brief: one task's section, whole-token ids, headings as boundaries.
// Ported from the bash cases that shipped with subagent-driven-development.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "..", "templates", "loop", "task-brief");

function brief(planText, n) {
  const dir = mkdtempSync(join(tmpdir(), "ns-brief-"));
  try {
    const plan = join(dir, "plan.md");
    writeFileSync(plan, planText);
    const out = join(dir, "out.md");
    const r = spawnSync("bash", [bin, plan, String(n), out], { encoding: "utf8" });
    return { status: r.status, stderr: r.stderr, text: r.status === 0 ? readFileSync(out, "utf8") : "" };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const PLAN = `# Plan

## Global Constraints
- Node 24

### Task 1: alpha
body one

### Task 2: beta
body two
#### sub-heading of task 2
still two

### Task 9: nine
body nine

### Task 9A: nine-a
body nine-a

## Open Questions
none
`;

test("extracts exactly one task, with its own sub-headings, and stops at the next task", () => {
  const r = brief(PLAN, 2);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.text, /^### Task 2: beta/m);
  assert.match(r.text, /still two/);
  assert.doesNotMatch(r.text, /body one|body nine|Open Questions/);
});

test("ids are whole tokens: Task 9 does not swallow Task 9A, and 9A is findable", () => {
  const nine = brief(PLAN, 9);
  assert.match(nine.text, /body nine\n/);
  assert.doesNotMatch(nine.text, /nine-a/);
  const nineA = brief(PLAN, "9A");
  assert.match(nineA.text, /body nine-a/);
});

test("a shallower heading ends the task and a missing task is a loud failure", () => {
  const last = brief(PLAN, "9A");
  assert.doesNotMatch(last.text, /Open Questions/);
  const missing = brief(PLAN, 3);
  assert.equal(missing.status, 3);
  assert.match(missing.stderr, /task 3 not found/);
});

test("a `# Task N` heading inside a code fence is not a boundary", () => {
  const fenced = `# Task 1: one\nsee:\n\`\`\`md\n# Task 2: fake\n\`\`\`\nend of one\n\n# Task 2: two\nreal two\n`;
  const r = brief(fenced, 1);
  assert.match(r.text, /end of one/);
  assert.doesNotMatch(r.text, /real two/);
});
