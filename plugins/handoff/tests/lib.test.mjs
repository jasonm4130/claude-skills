// @ts-check
// Unit tests for shared lib.mjs helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

import { safeJsonParse, readContainedFile, dirContainedIn } from "../scripts/lib.mjs";

test("safeJsonParse returns object for valid JSON", () => {
  assert.deepEqual(safeJsonParse('{"a":1}'), { a: 1 });
});

test("safeJsonParse returns null for invalid JSON", () => {
  assert.equal(safeJsonParse("not json"), null);
});

test("safeJsonParse returns null for empty input", () => {
  assert.equal(safeJsonParse(""), null);
});

test("safeJsonParse returns null for non-object JSON", () => {
  assert.equal(safeJsonParse("42"), null);
  assert.equal(safeJsonParse('"str"'), null);
  assert.equal(safeJsonParse("null"), null);
});

test("readContainedFile: reads a plain file, refuses non-bare names", (t) => {
  // realpathSync the temp base: on macOS os.tmpdir() sits under /var -> /private/var.
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "handoff-read-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  writeFileSync(path.join(base, "handoff.md"), "the handoff body");
  mkdirSync(path.join(base, "sub"));
  writeFileSync(path.join(base, "sub", "nested.md"), "nested");

  assert.equal(readContainedFile(base, "handoff.md"), "the handoff body");
  assert.equal(readContainedFile(base, "missing.md"), null, "a nonexistent file is refused");
  assert.equal(readContainedFile(base, "../../.env"), null, "traversal is refused");
  assert.equal(readContainedFile(base, "sub/nested.md"), null, "only bare filenames are accepted");
  assert.equal(readContainedFile(base, "/etc/passwd"), null, "absolute paths are refused");
  assert.equal(readContainedFile(base, ".."), null);
  assert.equal(readContainedFile(base, ""), null);
  assert.equal(readContainedFile(base, "bad\0name.md"), null, "a NUL byte must not throw");
  assert.equal(readContainedFile(base, "sub"), null, "a directory is not a regular file");
});

test("readContainedFile: refuses a symlinked target", { skip: process.platform === "win32" }, (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "handoff-symlink-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, "handoffs");
  mkdirSync(base);
  writeFileSync(path.join(root, "secret.env"), "API_KEY=super-secret-value");
  symlinkSync(path.join(root, "secret.env"), path.join(base, "innocent.md"));

  assert.equal(readContainedFile(base, "innocent.md"), null, "O_NOFOLLOW must refuse, not follow");
});

test("readContainedFile: a FIFO is refused without hanging", { skip: process.platform === "win32" }, (t) => {
  // A plain open() on a FIFO blocks until a writer appears — the reason the open must be
  // non-blocking. If this test times out, O_NONBLOCK is missing.
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "handoff-fifo-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  execFileSync("mkfifo", [path.join(base, "trap.md")]);

  assert.equal(readContainedFile(base, "trap.md"), null, "a FIFO is not a regular file");
});

test("dirContainedIn: true inside the root, false for an escaping symlink", { skip: process.platform === "win32" }, (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "handoff-dir-")));
  const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), "handoff-out-")));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const inner = path.join(root, ".claude", "handoffs");
  mkdirSync(inner, { recursive: true });
  assert.equal(dirContainedIn(root, inner), true);

  const escaped = path.join(root, "escaped");
  symlinkSync(outside, escaped);
  assert.equal(dirContainedIn(root, escaped), false, ".claude/handoffs symlinked out must not pass");
  assert.equal(dirContainedIn(root, path.join(root, "nope")), false, "a missing dir is not contained");
});
