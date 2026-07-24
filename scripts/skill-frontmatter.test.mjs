// @ts-check
// scripts/skill-frontmatter.test.mjs
//
// `claude plugin validate` rejects a SKILL.md whose frontmatter is invalid YAML —
// most commonly an unquoted plain scalar `description:` containing a `": "` or
// " #" sequence, which YAML reads as starting a nested mapping/comment and fails
// to parse. Node has no bundled YAML parser and this repo adds no new dependency,
// so this test implements a small fail-closed parser for the exact frontmatter
// subset SKILL.md files use (flat `key: value`, single/double-quoted scalars,
// `>`/`|` block scalars) and walks every plugins/*/skills/*/SKILL.md with it.
//
// Fail-closed: anything the parser cannot confidently parse throws, which fails
// the test — it never silently accepts a value it isn't sure about. This must
// flag exactly the files `claude plugin validate` flags, no more, no fewer (see
// the task report for the cross-check).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string} raw frontmatter body (between the `---` delimiters) */
function parseFrontmatter(raw) {
  const lines = raw.split("\n");
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    const m = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[i]);
    if (!m) throw new Error(`line ${i + 1}: not a "key: value" pair: ${JSON.stringify(lines[i])}`);
    const [, key, rawVal] = m;
    if (rawVal === "") throw new Error(`line ${i + 1}: empty value for "${key}"`);
    // Block scalar (folded `>` / literal `|`): gather indented continuation lines.
    if (rawVal === ">" || rawVal === "|") {
      const body = [];
      let indent = null;
      while (i + 1 < lines.length && (lines[i + 1].trim() === "" || /^\s/.test(lines[i + 1]))) {
        i++;
        const cur = lines[i];
        if (cur.trim() === "") { body.push(""); continue; }
        const curIndent = cur.length - cur.trimStart().length;
        if (indent === null) indent = curIndent;
        if (curIndent < indent) { i--; break; } // dedent: not part of this block scalar
        body.push(cur.slice(indent));
      }
      const text = rawVal === ">" ? body.join(" ").replace(/ {2,}/g, " ").trim() : body.join("\n").trim();
      if (!text) throw new Error(`line ${i + 1}: empty block scalar for "${key}"`);
      out[key] = text;
      continue;
    }
    // Single/double-quoted scalar: scan for a real closing quote before end-of-line,
    // honoring `''` (single-quote escape) and `\x` (double-quote backslash escape).
    if (rawVal[0] === "'" || rawVal[0] === '"') {
      const q = rawVal[0];
      let body = "", k = 1, closed = false;
      while (k < rawVal.length) {
        if (q === "'" && rawVal[k] === "'" && rawVal[k + 1] === "'") { body += "'"; k += 2; continue; }
        if (rawVal[k] === q) { closed = true; k++; break; }
        if (q === '"' && rawVal[k] === "\\") { body += rawVal[k + 1]; k += 2; continue; }
        body += rawVal[k++];
      }
      if (!closed) throw new Error(`line ${i + 1}: unterminated ${q}-quoted scalar for "${key}"`);
      if (rawVal.slice(k).trim() !== "") throw new Error(`line ${i + 1}: trailing content after quoted scalar for "${key}"`);
      out[key] = body;
      continue;
    }
    // Unquoted plain scalar: ": " starts a nested mapping key, " #" starts a comment —
    // both terminate the scalar early in real YAML, so both must be rejected here.
    if (/: | #/.test(rawVal)) {
      throw new Error(`line ${i + 1}: unquoted plain scalar for "${key}" contains ": " or " #" — must be quoted`);
    }
    out[key] = rawVal.trim();
  }
  return out;
}

/** @param {string} content full SKILL.md content */
function extractFrontmatter(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  if (!m) throw new Error("no --- delimited frontmatter block found");
  return m[1];
}

/** Every plugins/<name>/skills/<skill>/SKILL.md path in the repo. */
function findSkillFiles() {
  const pluginsDir = join(root, "plugins");
  const files = [];
  for (const p of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!p.isDirectory()) continue;
    const skillsDir = join(pluginsDir, p.name, "skills");
    if (!existsSync(skillsDir)) continue;
    for (const s of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!s.isDirectory()) continue;
      const skillMd = join(skillsDir, s.name, "SKILL.md");
      if (existsSync(skillMd)) files.push(skillMd);
    }
  }
  return files;
}

const skillFiles = findSkillFiles();

test("at least one SKILL.md was found (sanity: the walk isn't silently empty)", () => {
  assert.ok(skillFiles.length > 0, "expected plugins/*/skills/*/SKILL.md to find files");
});

for (const file of skillFiles) {
  const rel = file.slice(root.length + 1);
  test(`${rel}: frontmatter parses and has a non-empty description`, () => {
    const content = readFileSync(file, "utf8");
    const raw = extractFrontmatter(content);
    const fm = parseFrontmatter(raw);
    assert.equal(typeof fm.description, "string", `${rel}: description must be present`);
    assert.ok(fm.description.trim().length > 0, `${rel}: description must be non-empty`);
    if ("name" in fm) {
      assert.equal(typeof fm.name, "string", `${rel}: name, if present, must be a string`);
      assert.ok(fm.name.trim().length > 0, `${rel}: name, if present, must be non-empty`);
    }
  });
}
