#!/usr/bin/env node
// @ts-check
// scripts/check-version-bumps.mjs
//
// CI gate: fail the branch if a plugin's shipped payload changed vs the merge base
// without a strict semver version *increase* in its plugin.json. It compares the
// committed trees (`<base>...HEAD`), so it is immune to how the commit was formed —
// `git commit <pathspec>`, `--amend`, and version *downgrades* all get caught, which
// a commit-time hook could not reliably do.
//
// Surface = deny-list: the whole plugins/<name>/ tree ships to the install cache, so
// ANY changed file under it requires a bump EXCEPT the dev-only set:
//   - plugins/<name>/.claude-plugin/**  (manifest — where the version itself lives)
//   - any tests/ dir, or any *.test.* file
//   - the plugin's own top-level README.md / CLAUDE.md
//
// Marketplace ↔ plugin.json version equality is enforced separately by
// scripts/repo-consistency.test.mjs, so an increase here implies the marketplace
// entry increased too.
//
//   CI:     node scripts/check-version-bumps.mjs <baseSha>
//   local:  node scripts/check-version-bumps.mjs main

import process from "node:process";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Run git in `cwd`; throws on non-zero exit (caller decides fail-open vs fail-loud).
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/**
 * Content of `path` at `ref`, or null if it does not exist there.
 * @param {string} cwd @param {string} ref @param {string} path
 * @returns {string | null}
 */
function showAtRef(cwd, ref, path) {
  try {
    return execFileSync("git", ["-C", cwd, "show", `${ref}:${path}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/**
 * Parse a plugin.json blob's `version` string; null if unreadable/absent.
 * @param {string | null} blob
 * @returns {string | null}
 */
function versionOf(blob) {
  if (blob == null) return null;
  try {
    const v = JSON.parse(blob).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Strict x.y.z → numeric triple, else null.
 * @param {string | null} v
 * @returns {[number, number, number] | null}
 */
function semver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * @param {[number, number, number]} a @param {[number, number, number]} b
 * @returns {boolean} a > b
 */
function gt(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/**
 * Is a plugin-relative path exempt from requiring a bump?
 * @param {string} rel
 * @returns {boolean}
 */
// Exported so the shipped-payload surface is defined in exactly one place —
// repo-consistency.test.mjs scans the same set for dangling out-of-payload
// citations, and a second copy of this rule would drift from this one.
export function isExempt(rel) {
  if (rel.startsWith(".claude-plugin/")) return true;
  if (/(^|\/)tests?\//.test(rel)) return true;
  if (/\.test\.[a-z0-9]+$/i.test(rel)) return true;
  if (rel === "README.md" || rel === "CLAUDE.md") return true;
  return false;
}

/**
 * @typedef {{ plugin: string, baseVersion: string|null, headVersion: string|null, reason: string }} Violation
 */

/**
 * @param {{ cwd: string, baseRef: string }} opts
 * @returns {{ violations: Violation[] }}
 */
export function checkVersionBumps({ cwd, baseRef }) {
  const mergeBase = git(cwd, ["merge-base", baseRef, "HEAD"]);
  const changed = git(cwd, ["diff", "--name-only", mergeBase, "HEAD"])
    .split("\n")
    .filter(Boolean);

  const touched = new Set();
  for (const f of changed) {
    const m = /^plugins\/([^/]+)\/(.+)$/.exec(f);
    if (!m) continue;
    if (isExempt(m[2])) continue;
    touched.add(m[1]);
  }

  /** @type {Violation[]} */
  const violations = [];
  for (const plugin of [...touched].sort()) {
    const rel = `plugins/${plugin}/.claude-plugin/plugin.json`;
    const headBlob = showAtRef(cwd, "HEAD", rel);
    if (headBlob === null) continue; // plugin.json gone at HEAD → plugin removed, skip
    const baseBlob = showAtRef(cwd, mergeBase, rel);
    if (baseBlob === null) continue; // new-in-branch plugin → nothing to bump

    const headV = versionOf(headBlob);
    const baseV = versionOf(baseBlob);
    const h = semver(headV);
    const b = semver(baseV);
    if (!h || !b || !gt(h, b)) {
      violations.push({
        plugin,
        baseVersion: baseV,
        headVersion: headV,
        reason: !h
          ? `HEAD version ${JSON.stringify(headV)} is not a valid x.y.z`
          : !b
            ? `base version ${JSON.stringify(baseV)} is not a valid x.y.z`
            : `version not increased (${baseV} → ${headV})`,
      });
    }
  }
  return { violations };
}

/** @returns {boolean} true when run as `node check-version-bumps.mjs`, not imported. */
function invokedDirectly() {
  try {
    return realpathSync(process.argv[1] || "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const baseRef = process.argv[2] || "origin/main";
  let result;
  try {
    result = checkVersionBumps({ cwd: process.cwd(), baseRef });
  } catch (e) {
    console.error(
      `check-version-bumps: could not diff against "${baseRef}": ${e instanceof Error ? e.message : e}`,
    );
    process.exit(2);
  }
  if (result.violations.length === 0) {
    console.log(`✓ version-bump-check: every changed plugin bumped its version (base ${baseRef}).`);
    process.exit(0);
  }
  console.error("✗ version-bump-check: shipped plugin content changed without a version increase:\n");
  for (const v of result.violations) console.error(`  - ${v.plugin}: ${v.reason}`);
  console.error(
    "\nBump each with:  node scripts/bump-plugin.mjs <plugin> <patch|minor|major>" +
      "\n(updates plugin.json + marketplace.json together, in sync).",
  );
  process.exit(1);
}
