// @ts-check
// Repo invariant: the shared primitives duplicated across every plugin's
// `scripts/lib.mjs` must stay byte-identical.
//
// Claude Code plugins cannot share files across plugin boundaries, so five plugins
// (gates, domain-modeling, handoff, session-retro, ship-gate) each carry their own
// `lib.mjs` copy of the same handful of helpers. That duplication is deliberate and
// unavoidable — but it has a failure mode that is silent and expensive: a bug gets
// fixed in one copy and left in the other four. That is not hypothetical.
// `handoff`'s statusLine↔hook data-dir split (0.10.0) was a bug in exactly this
// shape, and the docs-sync gate had independently hit the same class and solved it
// a different way.
//
// The count moves. Folding design-gate-guard, docs-sync-guard and
// workflow-model-guard into `gates` retired two copies at once: their hook-I/O
// helpers were already byte-identical, so one `lib.mjs` now serves all four gates.
// Nothing below is keyed to the number — the plugin set and the helper names are
// both derived from the tree, so a merge or a split is picked up with no edit here.
//
// This test does not try to prove the copies are *semantically* equivalent —
// that is undecidable in general and overkill here. It asserts something
// stricter and far cheaper to check: any function name exported by two or more
// `lib.mjs` files must have identical source text in all of them. If a
// divergence is ever genuinely wanted, the fix is to rename the diverging copy
// so it is no longer claiming to be the shared primitive.
//
// The name list is DERIVED, not hardcoded: add a new helper to two plugins and
// it is covered automatically, with no edit here.
//
// Scope note: `export function` / `export async function` only. `export const`
// declarations in these files are all plugin-specific (gates' RECORD_REL,
// DEFAULT_CONSOLIDATE_THRESHOLD) and never duplicated, so extracting
// them would add parsing complexity for no coverage.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every `plugins/<name>/scripts/lib.mjs` in the repo.
 * @returns {{ plugin: string, src: string }[]}
 */
function libFiles() {
  const out = [];
  for (const plugin of readdirSync(join(root, "plugins")).sort()) {
    let src;
    try {
      src = readFileSync(join(root, "plugins", plugin, "scripts", "lib.mjs"), "utf8");
    } catch {
      continue; // plugin has no lib.mjs — fine, most don't need one.
    }
    out.push({ plugin, src });
  }
  return out;
}

/**
 * Extract each exported function's full source text, keyed by name.
 *
 * These files are prettier-formatted with a two-space indent, so a function ends
 * at the first following line that is exactly `}`. That is a formatting
 * assumption, not a parser — but it is one the whole repo already holds, and a
 * violation makes this test fail loudly rather than silently under-match.
 * @param {string} src
 * @returns {Map<string, string>}
 */
function exportedFunctions(src) {
  const lines = src.split("\n");
  const found = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = /^export (?:async )?function ([A-Za-z_$][\w$]*)\(/.exec(lines[i]);
    if (!m) continue;
    let end = i;
    while (end < lines.length && lines[end] !== "}") end++;
    assert.ok(
      end < lines.length,
      `unterminated function ${m[1]} — no line equal to "}" after line ${i + 1}`,
    );
    found.set(m[1], lines.slice(i, end + 1).join("\n"));
  }
  return found;
}

const files = libFiles();

test("the repo still has multiple lib.mjs copies to compare", () => {
  // Guards the test itself: if the extraction silently found nothing, every
  // assertion below would vacuously pass and the invariant would be unguarded.
  assert.ok(
    files.length >= 2,
    `expected 2+ plugins with scripts/lib.mjs, found ${files.length}`,
  );
});

test("every helper duplicated across plugins is byte-identical", () => {
  /** @type {Map<string, { plugin: string, body: string }[]>} */
  const byName = new Map();
  for (const { plugin, src } of files) {
    for (const [name, body] of exportedFunctions(src)) {
      const list = byName.get(name) || [];
      list.push({ plugin, body });
      byName.set(name, list);
    }
  }

  /** @type {string[]} */
  const shared = [];
  for (const [name, copies] of byName) {
    if (copies.length < 2) continue; // unique to one plugin — nothing to drift against.
    shared.push(name);

    const [first, ...rest] = copies;
    for (const other of rest) {
      if (other.body === first.body) continue;

      // Point at the first differing line rather than dumping two function bodies.
      const a = first.body.split("\n");
      const b = other.body.split("\n");
      let ln = 0;
      while (ln < a.length && ln < b.length && a[ln] === b[ln]) ln++;
      assert.fail(
        `lib.mjs drift in ${name}(): ${first.plugin} and ${other.plugin} differ at line ${ln + 1} of the function.\n` +
          `  ${first.plugin}: ${JSON.stringify(a[ln] ?? "<end of function>")}\n` +
          `  ${other.plugin}: ${JSON.stringify(b[ln] ?? "<end of function>")}\n` +
          `These copies exist only because plugins cannot share files. Fix the bug in every copy, ` +
          `or rename the diverging one so it stops claiming to be the shared primitive.`,
      );
    }
  }

  // A second self-guard: the shared set should not silently empty out. If a
  // refactor leaves every helper unique, that is worth noticing deliberately.
  assert.ok(
    shared.length > 0,
    "no helper is defined in 2+ lib.mjs files — the drift invariant is now unguarded",
  );
});
