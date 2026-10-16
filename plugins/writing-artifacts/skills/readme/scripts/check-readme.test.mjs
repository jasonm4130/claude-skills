// @ts-check
// Tests for check-readme.mjs. Each test builds a throwaway repo in a temp dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { checkReadme, githubSlugger } from "./check-readme.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-readme.mjs");

/**
 * Build a repo from a map of relative path → content.
 * @param {Record<string, string>} files
 */
function repo(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "check-readme-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

/**
 * Run the checker on README.md in a fresh repo; return the findings and clean up.
 * @param {Record<string, string>} files
 * @param {Partial<import("./check-readme.mjs").Options>} [opts]
 */
function check(files, opts = {}) {
  const dir = repo(files);
  try {
    return checkReadme({ readme: path.join(dir, "README.md"), root: dir, ...opts });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** @param {{kind: string}[]} findings @param {string} kind */
const ofKind = (findings, kind) => findings.filter((f) => f.kind === kind);

// --- GitHub slug rules -------------------------------------------------------

test("slugger lowercases, drops punctuation and joins words with hyphens", () => {
  const s = githubSlugger();
  assert.equal(s.slug("Getting Started!"), "getting-started");
  assert.equal(s.slug("What's new in 2.0?"), "whats-new-in-20");
  assert.equal(s.slug("snake_case stays"), "snake_case-stays");
});

test("slugger numbers repeated headings", () => {
  const s = githubSlugger();
  assert.equal(s.slug("Usage"), "usage");
  assert.equal(s.slug("Usage"), "usage-1");
  assert.equal(s.slug("Usage"), "usage-2");
});

test("slugger drops emoji but keeps the space it leaves, so the slug starts with a hyphen", () => {
  const s = githubSlugger();
  assert.equal(s.slug("🚀 Quick start"), "-quick-start");
  assert.equal(s.slug("Install 📦"), "install-");
});

test("slugger keeps non-Latin letters", () => {
  assert.equal(githubSlugger().slug("Über café"), "über-café");
});

// --- backticked paths --------------------------------------------------------

test("a backticked path that exists passes", () => {
  const f = check({ "README.md": "See `src/index.js` and `docs/`.\n", "src/index.js": "", "docs/a.md": "" });
  assert.deepEqual(ofKind(f, "path"), []);
});

test("a backticked path that does not exist is flagged with its line", () => {
  const f = check({ "README.md": "# T\n\nRun `src/missing.js` first.\n", "src/index.js": "" });
  const p = ofKind(f, "path");
  assert.equal(p.length, 1);
  assert.equal(p[0].line, 3);
  assert.match(p[0].message, /src\/missing\.js/);
});

test("a bare file name is a convention, not a path; with ./ it is checked", () => {
  const f = check({ "README.md": "Edit your `CLAUDE.md`.\n\nCopy `./config.example.json`.\n" });
  assert.deepEqual(ofKind(f, "path").map((x) => x.line), [3]);
});

test("a path under a folder the repo does not have is not treated as a repo path", () => {
  const f = check({ "README.md": "Writes `.cache/out.json` and reads `vendor/x.md`.\n" });
  assert.deepEqual(ofKind(f, "path"), []);
});

test("a gitignored path is a runtime artifact, not a broken reference", () => {
  const dir = repo({ ".gitignore": "/.claude/handoffs/\n", ".claude/settings.json": "{}", "README.md": "Saved to `.claude/handoffs/`; see `.claude/gone.json`.\n" });
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const f = checkReadme({ readme: path.join(dir, "README.md"), root: dir, cli: [], private: false });
    const p = ofKind(f, "path");
    assert.equal(p.length, 1);
    assert.match(p[0].message, /gone\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a path with a :line suffix is checked without the suffix", () => {
  const f = check({ "README.md": "See `src/a.js:12`.\n", "src/a.js": "" });
  assert.deepEqual(ofKind(f, "path"), []);
});

test("code spans that are not repo paths are ignored", () => {
  const f = check({
    "README.md":
      "Use `owner/repo`, `application/json`, `node:test`, `--flag`, `https://x.dev/a.md`, `<dir>/file.md`, `*.md` and `YYYY-MM-DD.md`.\n",
  });
  assert.deepEqual(ofKind(f, "path"), []);
});

test("an absolute machine path is flagged", () => {
  const f = check({ "README.md": "Lives in `/Users/someone/repo/a.md`.\n" });
  assert.equal(ofKind(f, "path").length, 1);
});

test("paths inside fenced code blocks are not treated as backticked paths", () => {
  const f = check({ "README.md": "```\ncat `nope/x.md`\n```\n" });
  assert.deepEqual(ofKind(f, "path"), []);
});

// --- relative links and anchors ---------------------------------------------

test("a relative link to a missing file is flagged", () => {
  const f = check({ "README.md": "[Setup](docs/setup.md)\n" });
  const l = ofKind(f, "link");
  assert.equal(l.length, 1);
  assert.match(l[0].message, /docs\/setup\.md/);
});

test("relative links resolve from the README's folder, and / from the repo root", () => {
  const f = check({ "README.md": "[a](docs/a.md) [b](/docs/a.md) [c](./docs/)\n", "docs/a.md": "# A\n" });
  assert.deepEqual(ofKind(f, "link"), []);
});

test("external links are not checked", () => {
  const f = check({ "README.md": "[x](https://example.invalid/missing) [m](mailto:a@example.invalid)\n" });
  assert.deepEqual(ofKind(f, "link"), []);
});

test("an in-page anchor must match a heading slug", () => {
  const f = check({ "README.md": "# Tool\n\n[go](#getting-started) [bad](#get-started)\n\n## Getting Started\n" });
  const a = ofKind(f, "anchor");
  assert.equal(a.length, 1);
  assert.match(a[0].message, /#get-started/);
});

test("emoji headings: the hyphen-led slug resolves and the naive one is flagged", () => {
  const f = check({
    "README.md": "# Tool\n\n- [Quick start](#-quick-start)\n- [Wrong](#quick-start)\n\n## 🚀 Quick start\n",
  });
  const a = ofKind(f, "anchor");
  assert.equal(a.length, 1);
  assert.match(a[0].message, /#quick-start/);
  assert.match(a[0].message, /-quick-start/, "the message suggests the slug that exists");
});

test("an anchor into another Markdown file is checked against that file's headings", () => {
  const f = check({
    "README.md": "[ok](docs/loop.md#catch-up) [bad](docs/loop.md#catchup)\n",
    "docs/loop.md": "# Loop\n\n## Catch up\n",
  });
  const a = ofKind(f, "anchor");
  assert.equal(a.length, 1);
  assert.match(a[0].message, /catchup/);
});

test("repeated headings get numbered anchors", () => {
  const f = check({ "README.md": "[a](#usage-1)\n\n## Usage\n\n## Usage\n" });
  assert.deepEqual(ofKind(f, "anchor"), []);
});

test("setext headings, inline code and links in headings produce GitHub's slug", () => {
  const f = check({
    "README.md": "[a](#the-agentos-cli) [b](#see-the-docs)\n\nThe `agentos` CLI\n=================\n\n## See [the docs](https://x.invalid)\n",
  });
  assert.deepEqual(ofKind(f, "anchor"), []);
});

test("explicit HTML anchors count as targets", () => {
  const f = check({ "README.md": '<a name="legacy"></a>\n\n[x](#legacy)\n' });
  assert.deepEqual(ofKind(f, "anchor"), []);
});

test("headings inside code fences are not anchors", () => {
  const f = check({ "README.md": "[x](#fake)\n\n```md\n## Fake\n```\n" });
  assert.equal(ofKind(f, "anchor").length, 1);
});

test("reference-style link definitions are checked", () => {
  const f = check({ "README.md": "See [setup][s].\n\n[s]: docs/setup.md\n" });
  assert.equal(ofKind(f, "link").length, 1);
});

test("image sources are checked as links", () => {
  const f = check({ "README.md": '![shot](assets/shot.png)\n\n<img src="assets/logo.svg">\n' });
  assert.equal(ofKind(f, "link").length, 2);
});

// --- commands ----------------------------------------------------------------

const PKG = JSON.stringify({ name: "demo", version: "1.2.3", scripts: { build: "x", test: "x", "lint:fix": "x" } });

test("package-manager commands must name a package.json script", () => {
  const f = check({
    "package.json": PKG,
    "README.md": [
      "```bash",
      "pnpm install",
      "pnpm build",
      "pnpm run lint:fix",
      "npm run deploy",
      "npm test",
      "yarn start",
      "```",
      "",
      "Or run `pnpm typecheck`.",
      "",
    ].join("\n"),
  });
  const c = ofKind(f, "command").map((x) => x.message);
  assert.equal(c.length, 3, c.join("\n"));
  assert.ok(c.some((m) => /deploy/.test(m)));
  assert.ok(c.some((m) => /start/.test(m)));
  assert.ok(c.some((m) => /typecheck/.test(m)));
});

test("a script command with no package.json is flagged", () => {
  const f = check({ "README.md": "```sh\nnpm run build\n```\n" });
  assert.equal(ofKind(f, "command").length, 1);
});

test("prompts, comments, chains and console output are handled", () => {
  const f = check({
    "package.json": PKG,
    "README.md": [
      "```console",
      "$ pnpm build && pnpm nope",
      "pnpm output-line-not-a-command",
      "```",
      "```sh",
      "# pnpm commented",
      "cd app; pnpm test",
      "```",
      "",
    ].join("\n"),
  });
  const c = ofKind(f, "command");
  assert.equal(c.length, 1);
  assert.match(c[0].message, /nope/);
});

test("filtered or directory-scoped workspace commands are skipped", () => {
  const f = check({ "package.json": PKG, "README.md": "```sh\npnpm --filter web dev\npnpm -C app dev\n```\n" });
  assert.deepEqual(ofKind(f, "command"), []);
});

test("node <file> must name a file that exists; globs are left to the shell", () => {
  const f = check({ "README.md": "```sh\nnode bin/cli.mjs\nnode src/gone.ts status\nnode --test tests/*.test.mjs\n```\n", "bin/cli.mjs": "" });
  const c = ofKind(f, "command");
  assert.equal(c.length, 1);
  assert.match(c[0].message, /src\/gone\.ts/);
});

test("subcommands of a declared CLI must appear in its --help output", () => {
  const cli = 'console.log("Usage: demo <command>\\n\\nCommands:\\n  status   show state\\n  open     open the view");\n';
  const f = check(
    {
      "cli.mjs": cli,
      "README.md": "```sh\ndemo status\ndemo open\ndemo launch\n```\n\nThen `demo catchup`.\n",
    },
    { cli: [{ name: "demo", help: "node cli.mjs --help" }] },
  );
  const c = ofKind(f, "command").map((x) => x.message);
  assert.equal(c.length, 2, c.join("\n"));
  assert.ok(c.some((m) => /launch/.test(m)));
  assert.ok(c.some((m) => /catchup/.test(m)));
});

test("a CLI whose help command fails is reported once", () => {
  const f = check(
    { "README.md": "```sh\ndemo status\n```\n" },
    { cli: [{ name: "demo", help: "node does-not-exist.mjs --help" }] },
  );
  const c = ofKind(f, "command");
  assert.equal(c.length, 1);
  assert.match(c[0].message, /help/);
});

// --- emoji and leftovers ----------------------------------------------------

test("emoji in prose and headings are flagged; code, © and ™ are not", () => {
  const f = check({ "README.md": "## 🚀 Start\n\nFast ✨ and done.\n\n```\n✓ ok\n```\n\n`✅` © 2026 Acme™\n" });
  const e = ofKind(f, "emoji");
  assert.equal(e.length, 2);
  assert.deepEqual(e.map((x) => x.line), [1, 3]);
});

test("leftover TODO, FIXME and TBD are flagged, including in HTML comments", () => {
  const f = check({ "README.md": "# T\n\n<!-- TODO -->\n\nInstall: TBD.\n\nFIXME later\n\n`TODO` in code is fine.\n" });
  assert.deepEqual(ofKind(f, "leftover").map((x) => x.line), [3, 5, 7]);
});

test("a clean README has no findings", () => {
  const f = check({
    "package.json": PKG,
    LICENSE: "MIT",
    "docs/setup.md": "# Setup\n\n## Requirements\n",
    "README.md": [
      "# demo",
      "",
      "demo builds things. See [requirements](docs/setup.md#requirements) and [usage](#usage).",
      "",
      "## Usage",
      "",
      "```sh",
      "pnpm install",
      "pnpm build",
      "```",
      "",
      "The entry point is `docs/setup.md`.",
      "",
    ].join("\n"),
  });
  assert.deepEqual(f, []);
});

// --- badges ------------------------------------------------------------------

test("a workflow badge whose workflow file is missing is flagged", () => {
  const f = check({
    ".github/workflows/ci.yml": "on: push\n",
    "README.md": [
      "[![CI](https://github.com/o/r/actions/workflows/ci.yml/badge.svg)](https://github.com/o/r/actions)",
      "![Release](https://github.com/o/r/actions/workflows/release.yml/badge.svg)",
      "![Old](https://img.shields.io/github/actions/workflow/status/o/r/old.yml)",
      "",
    ].join("\n"),
  });
  const b = ofKind(f, "badge").map((x) => x.message);
  assert.equal(b.length, 2, b.join("\n"));
  assert.ok(b.some((m) => /release\.yml/.test(m)));
  assert.ok(b.some((m) => /old\.yml/.test(m)));
});

test("a license badge with no LICENSE file is flagged", () => {
  const f = check({ "README.md": "![License: MIT](https://img.shields.io/badge/license-MIT-blue)\n" });
  const b = ofKind(f, "badge");
  assert.equal(b.length, 1);
  assert.match(b[0].message, /LICENSE/);
});

test("a license badge passes when LICENSE (any common name) exists", () => {
  const f = check({ "LICENSE.md": "MIT", "README.md": "![license](https://img.shields.io/github/license/o/r)\n" });
  assert.deepEqual(ofKind(f, "badge"), []);
});

test("a static version badge must match the manifest version", () => {
  const ok = check({ "package.json": PKG, "README.md": "![version](https://img.shields.io/badge/version-1.2.3-blue)\n" });
  assert.deepEqual(ofKind(ok, "badge"), []);
  const vOk = check({ "package.json": PKG, "README.md": "![v](https://img.shields.io/badge/version-v1.2.3-blue)\n" });
  assert.deepEqual(ofKind(vOk, "badge"), []);
  const bad = check({ "package.json": PKG, "README.md": "![version](https://img.shields.io/badge/version-1.1.0-blue)\n" });
  const b = ofKind(bad, "badge");
  assert.equal(b.length, 1);
  assert.match(b[0].message, /1\.1\.0/);
  assert.match(b[0].message, /1\.2\.3/);
});

test("a version badge is compared with plugin.json when there is no package.json", () => {
  const f = check({
    ".claude-plugin/plugin.json": JSON.stringify({ name: "p", version: "0.4.0" }),
    "README.md": "![version](https://img.shields.io/badge/version-0.3.0-blue)\n",
  });
  assert.equal(ofKind(f, "badge").length, 1);
});

test("shields.io badges that query GitHub are flagged on a private repo only", () => {
  const readme = "![license](https://img.shields.io/github/license/o/r)\n![CI](https://img.shields.io/github/actions/workflow/status/o/r/ci.yml)\n";
  const files = { LICENSE: "MIT", ".github/workflows/ci.yml": "", "README.md": readme };
  assert.deepEqual(ofKind(check(files), "badge"), []);
  const priv = ofKind(check(files, { private: true }), "badge");
  assert.equal(priv.length, 2);
  assert.match(priv[0].message, /private/);
});

// --- CLI ---------------------------------------------------------------------

test("the CLI prints file:line findings and exits 1, or exits 0 when clean", () => {
  const dir = repo({ "README.md": "# T\n\n[x](missing.md)\n" });
  try {
    let out = "";
    let code = 0;
    try {
      execFileSync(process.execPath, [SCRIPT, "README.md"], { cwd: dir, encoding: "utf8" });
    } catch (e) {
      code = /** @type {any} */ (e).status;
      out = /** @type {any} */ (e).stdout;
    }
    assert.equal(code, 1);
    assert.match(out, /^README\.md:3: link /m);

    writeFileSync(path.join(dir, "README.md"), "# T\n");
    const clean = execFileSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
    assert.match(clean, /no findings/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI takes --cli name=help-command and --json", () => {
  const dir = repo({
    "cli.mjs": 'console.log("Commands: status");\n',
    "README.md": "```sh\ndemo status\ndemo nope\n```\n",
  });
  try {
    let out = "";
    try {
      execFileSync(process.execPath, [SCRIPT, "--json", "--cli", "demo=node cli.mjs --help"], { cwd: dir, encoding: "utf8" });
    } catch (e) {
      out = /** @type {any} */ (e).stdout;
    }
    const findings = JSON.parse(out);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "command");
    assert.match(findings[0].message, /nope/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
