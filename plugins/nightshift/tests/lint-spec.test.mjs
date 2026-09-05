// lint-spec.mjs: a spec is linted before it costs a night. Each failing case
// here is a defect the first Nightwatch run actually paid for.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { lintSpec, lintDir } from "../nightwatch/lint-spec.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LINT = join(HERE, "..", "nightwatch", "lint-spec.mjs");

// A spec that passes every rule: title, Repo:, all four headings, a
// scripts/check line naming CHECK OK, a cargo run with --bin, a cargo test
// filter with a pinned count, and a written .json artifact declared in Writes:.
const VALID = `# Sample outcome

Repo: sample.
Writes: out.json

## Outcome

Does a thing.

## Acceptance

\`scripts/check\` prints \`CHECK OK\` as its last line. Exists.

1. \`cargo run --release --bin sampled\` exits 0. Introduced by this outcome.
2. \`cargo test bench::\` passes with exactly 5 tests. Introduced by this
   outcome.
3. \`cargo run --release --bin sampled -- --json <tmp>\` writes \`out.json\`.
   Introduced by this outcome.

## Non-goals

- Nothing else.

## Context

None.
`;

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "lint-spec-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a clean spec lints with no problems", () => {
  assert.deepEqual(lintSpec(VALID, { slug: "01-sample", slugs: ["01-sample"] }), []);
});

test("missing title, Repo:, and required headings", () => {
  const text = VALID.replace(/^# Sample outcome\n\n/, "").replace(/^Repo: sample\.\n/m, "").replace(/^## Context\n\nNone\.\n$/m, "");
  const problems = lintSpec(text, { slug: "01-sample", slugs: ["01-sample"] });
  assert.ok(problems.some((p) => p.includes('missing "# title" line')), problems.join("\n"));
  assert.ok(problems.some((p) => p.includes("missing Repo: header")), problems.join("\n"));
  assert.ok(problems.some((p) => p.includes("missing ## Context heading")), problems.join("\n"));
});

test("Acceptance without a scripts/check line naming CHECK OK", () => {
  const text = VALID.replace("`scripts/check` prints `CHECK OK` as its last line. Exists.\n\n", "");
  const problems = lintSpec(text, { slug: "01-sample", slugs: ["01-sample"] });
  assert.ok(
    problems.some((p) => p.includes("Acceptance has no scripts/check line naming CHECK OK")),
    problems.join("\n")
  );
});

test("cargo run -- with no --bin — the night's actual defect", () => {
  const text = VALID.replace(
    "1. `cargo run --release --bin sampled` exits 0. Introduced by this outcome.",
    "1. `cargo run -- search the` exits 0. Introduced by this outcome."
  );
  const problems = lintSpec(text, { slug: "01-sample", slugs: ["01-sample"] });
  assert.ok(
    problems.some((p) => p.includes("cargo run without --bin") && p.includes("cargo run -- search the")),
    problems.join("\n")
  );
});

test("cargo test filter with no pinned count — the night's actual defect", () => {
  const text = VALID.replace(
    "2. `cargo test bench::` passes with exactly 5 tests. Introduced by this\n   outcome.",
    "2. `cargo test export::` passes. Introduced by this outcome."
  );
  const problems = lintSpec(text, { slug: "01-sample", slugs: ["01-sample"] });
  assert.ok(
    problems.some((p) => p.includes("cargo test filter without a pinned count") && p.includes("cargo test export::")),
    problems.join("\n")
  );
});

test("a written artifact mentioned without a Writes: header — the night's actual defect", () => {
  const text = VALID.replace(/^Writes: out\.json\n/m, "").replace(
    "3. `cargo run --release --bin sampled -- --json <tmp>` writes `out.json`.\n   Introduced by this outcome.",
    "3. `uicheck` writes `uicheck.png`. Introduced by this outcome."
  );
  const problems = lintSpec(text, { slug: "01-sample", slugs: ["01-sample"] });
  assert.ok(
    problems.some((p) => p.includes("mentions uicheck.png without a Writes: header entry")),
    problems.join("\n")
  );
});

test("a code span asserting failure informally, not in prose", () => {
  const text = VALID.replace(
    "1. `cargo run --release --bin sampled` exits 0. Introduced by this outcome.",
    "1. `cargo run --release --bin sampled -- FAILS` on bad input. Introduced by this outcome."
  );
  const problems = lintSpec(text, { slug: "01-sample", slugs: ["01-sample"] });
  assert.ok(
    problems.some((p) => p.includes("code span asserts failure informally")),
    problems.join("\n")
  );
});

test("prose describing a must-fail command is not flagged", () => {
  const text = VALID.replace(
    "1. `cargo run --release --bin sampled` exits 0. Introduced by this outcome.",
    "1. `cargo run --release --bin sampled --bad` exits non-zero and is refused. Introduced by this outcome."
  );
  const problems = lintSpec(text, { slug: "01-sample", slugs: ["01-sample"] });
  assert.deepEqual(problems, []);
});

test("Units: must be a positive integer", () => {
  const text = VALID.replace("Repo: sample.\n", "Repo: sample.\nUnits: 0\n");
  const problems = lintSpec(text, { slug: "01-sample", slugs: ["01-sample"] });
  assert.ok(
    problems.some((p) => p.includes("Units: not a positive integer")),
    problems.join("\n")
  );
});

test("Depends: naming itself", () => {
  const text = VALID.replace("Repo: sample.\n", "Repo: sample.\nDepends: 01-sample\n");
  const problems = lintSpec(text, { slug: "01-sample", slugs: ["01-sample"] });
  assert.ok(
    problems.some((p) => p.includes("Depends: names itself")),
    problems.join("\n")
  );
});

test("Depends: naming a slug not in the specs dir", () => {
  const text = VALID.replace("Repo: sample.\n", "Repo: sample.\nDepends: 09-nope\n");
  const problems = lintSpec(text, { slug: "01-sample", slugs: ["01-sample"] });
  assert.ok(
    problems.some((p) => p.includes("Depends: names unknown spec 09-nope")),
    problems.join("\n")
  );
});

test("lintDir: a two-spec Depends: cycle is reported once", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "01-a.md"), VALID.replace("Repo: sample.\n", "Repo: sample.\nDepends: 02-b\n"));
    writeFileSync(join(dir, "02-b.md"), VALID.replace("Repo: sample.\n", "Repo: sample.\nDepends: 01-a\n"));
    const { lines } = lintDir(dir);
    const cycleLines = lines.filter((l) => l.includes("Depends: cycle"));
    assert.equal(cycleLines.length, 1, lines.join("\n"));
    assert.ok(cycleLines[0].startsWith("01-a.md:"), cycleLines[0]);
    assert.ok(cycleLines[0].includes("01-a -> 02-b -> 01-a"), cycleLines[0]);
  });
});

test("lintDir: a single passing spec reports SPEC OK", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "01-a.md"), VALID);
    const { lines, specCount } = lintDir(dir);
    assert.deepEqual(lines, []);
    assert.equal(specCount, 1);
  });
});

test("CLI: prints one line per problem, <file>:<line>: <problem>, and exits 1", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "01-a.md"),
      VALID.replace(
        "1. `cargo run --release --bin sampled` exits 0. Introduced by this outcome.",
        "1. `cargo run -- search the` exits 0. Introduced by this outcome."
      )
    );
    let out = "";
    let code = 0;
    try {
      out = execFileSync(process.execPath, [LINT, "--specs-dir", dir, "01-a.md"], { encoding: "utf8" });
    } catch (e) {
      out = e.stdout;
      code = e.status;
    }
    assert.equal(code, 1);
    const line = out.trim().split("\n")[0];
    assert.match(line, /^01-a\.md:\d+: cargo run without --bin/);
  });
});

test("CLI: SPEC OK (<n> specs) and exit 0 on a clean dir", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "01-a.md"), VALID);
    writeFileSync(join(dir, "02-b.md"), VALID.replace("Repo: sample.\n", "Repo: sample.\nDepends: 01-a\n"));
    const out = execFileSync(process.execPath, [LINT, "--specs-dir", dir], { encoding: "utf8" });
    assert.equal(out.trim(), "SPEC OK (2 specs)");
  });
});
