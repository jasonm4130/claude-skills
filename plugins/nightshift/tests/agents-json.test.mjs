// The frontmatter → --agents JSON converter the launcher uses to ship the plugin's agents.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { agentsJson, parseAgent } from "../nightwatch/agents-json.mjs";

test("frontmatter keys become the definition, comma lists become arrays, comments leave the prompt", () => {
  const { name, def } = parseAgent(`---
name: ro
description: Read-only thing.
model: sonnet
effort: low
disallowedTools: Write, Edit
tools: Bash, Read
---

Do the thing.

<!-- a note for humans -->
`);
  assert.equal(name, "ro");
  assert.deepEqual(def, { description: "Read-only thing.", prompt: "Do the thing.", model: "sonnet", effort: "low", tools: ["Bash", "Read"], disallowedTools: ["Write", "Edit"] });
});

test("a file without name or description is refused", () => {
  assert.throws(() => parseAgent("---\nmodel: sonnet\n---\nhi\n"), /name and description/);
  assert.throws(() => parseAgent("no frontmatter here"), /no frontmatter/);
});

test("a directory becomes one object keyed by agent name, in file order", () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-"));
  writeFileSync(join(dir, "b.md"), "---\nname: bee\ndescription: B.\n---\nbee\n");
  writeFileSync(join(dir, "a.md"), "---\nname: ay\ndescription: A.\n---\nay\n");
  writeFileSync(join(dir, "notes.txt"), "ignored");
  assert.deepEqual(Object.keys(agentsJson(dir)), ["ay", "bee"]);
});
