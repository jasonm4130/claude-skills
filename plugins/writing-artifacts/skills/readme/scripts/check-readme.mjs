#!/usr/bin/env node
// @ts-check
// check-readme.mjs: the mechanical half of the readme skill.
//
// Checks a README against the repository it describes, and prints one line per
// finding as `<file>:<line>: <kind> <message>`. Exit 0 when clean, 1 on any
// finding, 2 on bad usage. Stdlib only.
//
//   node check-readme.mjs [README.md] [--root <dir>] [--cli <name>=<help command>]...
//                         [--private] [--json]
//
// Kinds:
//   path      a backticked repo path that does not exist, or a machine path
//   link      a relative link or image whose target does not exist
//   anchor    a #anchor that matches no heading under GitHub's slug rules
//   command   a package-manager script, `node <file>` or CLI subcommand that
//             the repo does not have
//   badge     a badge whose target is missing or disagrees with the manifest
//   emoji     an emoji in prose or a heading
//   leftover  TODO, FIXME, TBD or lorem ipsum left in the text
//
// The reading checks (first screen, funnel order, terms, tone) stay in SKILL.md:
// a script cannot judge them.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @typedef {{name: string, help: string}} Cli
 * @typedef {{readme: string, root: string, cli: Cli[], private: boolean}} Options
 * @typedef {{line: number, kind: string, message: string}} Finding
 */

// --- GitHub heading slugs -----------------------------------------------------

/**
 * GitHub's heading anchors, after github-slugger: lowercase, drop every
 * character that is not a letter, mark, decimal or letter number, connector
 * punctuation, space or hyphen, turn spaces into hyphens, and number repeats.
 * An emoji is dropped but its trailing space is kept, so "🚀 Quick start"
 * becomes "-quick-start".
 */
export function githubSlugger() {
  /** @type {Map<string, number>} */
  const seen = new Map();
  return {
    /** @param {string} text */
    slug(text) {
      const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{Nd}\p{Nl}\p{Pc} -]/gu, "").replace(/ /g, "-");
      let slug = base;
      let n = seen.get(base) ?? 0;
      while (seen.has(slug)) slug = `${base}-${++n}`;
      seen.set(base, n);
      seen.set(slug, 0);
      return slug;
    },
  };
}

/** Reduce heading Markdown to the text GitHub renders, which is what it slugs. */
function headingText(/** @type {string} */ raw) {
  return raw
    .replace(/\s+#+\s*$/, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/\*+|~~/g, "")
    .replace(/(^|\s)_{1,2}([^_]+)_{1,2}(?=\s|$)/g, "$1$2")
    .trim();
}

// --- Markdown scanning --------------------------------------------------------

/**
 * @typedef {{n: number, text: string, prose: string, code: string[]}} ProseLine
 * @typedef {{n: number, text: string, lang: string}} CodeLine
 */

/**
 * Split Markdown into prose lines (with inline code spans pulled out) and
 * fenced-code lines (with their fence's language).
 * @param {string} src
 */
function scan(src) {
  const lines = src.split(/\r?\n/);
  /** @type {ProseLine[]} */
  const prose = [];
  /** @type {CodeLine[]} */
  const code = [];
  /** @type {{char: string, len: number, lang: string} | null} */
  let fence = null;
  lines.forEach((text, i) => {
    const n = i + 1;
    const open = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)/.exec(text);
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(text);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = null;
      else code.push({ n, text, lang: fence.lang });
      return;
    }
    if (open) {
      fence = { char: open[1][0], len: open[1].length, lang: open[2].toLowerCase() };
      return;
    }
    /** @type {string[]} */
    const spans = [];
    const stripped = text.replace(/(`+)(.+?)\1(?!`)/g, (_, _ticks, body) => {
      spans.push(body.trim());
      return " ";
    });
    prose.push({ n, text, prose: stripped, code: spans });
  });
  return { prose, code };
}

/**
 * Every anchor a Markdown file offers: its heading slugs and explicit
 * `<a name>` / `id` attributes.
 * @param {string} src
 */
function anchorsOf(src) {
  const slugger = githubSlugger();
  const anchors = new Set();
  const { prose } = scan(src);
  prose.forEach((l, i) => {
    const atx = /^ {0,3}#{1,6}\s+(.*)$/.exec(l.text);
    if (atx) anchors.add(slugger.slug(headingText(atx[1])));
    const next = prose[i + 1];
    if (!atx && next && next.n === l.n + 1 && l.text.trim() && /^ {0,3}(=+|-+)\s*$/.test(next.text) && !/^\s*[-*+]\s|^\s*>/.test(l.text)) {
      anchors.add(slugger.slug(headingText(l.text.trim())));
    }
    for (const m of l.text.matchAll(/<[a-z][^>]*\b(?:name|id)=["']([^"']+)["']/gi)) anchors.add(m[1]);
  });
  return anchors;
}

// --- Repository facts ---------------------------------------------------------

/** @param {string} root */
function readPackageJson(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/** The project's version from the first manifest that declares one. */
function manifestVersion(/** @type {string} */ root) {
  for (const rel of ["package.json", ".claude-plugin/plugin.json"]) {
    try {
      const v = JSON.parse(readFileSync(path.join(root, rel), "utf8")).version;
      if (typeof v === "string") return { version: v, file: rel };
    } catch {}
  }
  for (const rel of ["pyproject.toml", "Cargo.toml"]) {
    try {
      const m = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(path.join(root, rel), "utf8"));
      if (m) return { version: m[1], file: rel };
    } catch {}
  }
  return null;
}

const LICENSE_FILES = /^(licen[cs]e|copying)(\.(md|txt|rst))?$/i;

function hasLicense(/** @type {string} */ root) {
  try {
    return readdirSync(root).some((f) => LICENSE_FILES.test(f));
  } catch {
    return false;
  }
}

/** A gitignored path is a runtime artifact (`.claude/handoffs/`), not a broken reference. */
function gitIgnored(/** @type {string} */ root, /** @type {string} */ rel) {
  return spawnSync("git", ["-C", root, "check-ignore", "-q", "--no-index", rel.replace(/^\.\//, "")]).status === 0;
}

// --- Checks -------------------------------------------------------------------

const FILE_EXT = /\.(md|markdown|mdx|json|jsonc|js|mjs|cjs|ts|mts|cts|tsx|jsx|ya?ml|toml|sh|bash|zsh|py|go|rs|rb|txt|lock|html|css|scss|svg|png|jpe?g|gif|webp|sql|ini|cfg|conf|xml|csv|swift|kt|java|c|h|cpp)$/i;

/**
 * Is a code span a repo path worth checking? Returns the path to check, or null.
 * @param {string} token
 * @param {(rel: string) => boolean} exists
 */
function pathCandidate(token, exists) {
  if (/\s|:\/\/|^-|[<>*{}$|?!=,;()[\]"'@]|YYYY|\.\.\./.test(token)) return null;
  let p = token.replace(/#.*$/, "").replace(/:\d+(-\d+)?$/, "");
  if (!p || p.includes(":")) return null;
  if (p.startsWith("/")) return /^\/(Users|home)\/[^/]+/.test(p) ? p : null;
  if (p.startsWith("~")) return null;
  if (p.startsWith("./") || p.startsWith("../")) return p;
  // A bare name (`CLAUDE.md`, `settings.json`) usually names a convention, not a
  // file in this repo, and `owner/repo` looks like a path. So a path is checked
  // only when its first folder exists here: then a missing rest is a real break.
  const first = p.split("/")[0];
  if (!p.includes("/") || first === ".git" || !exists(first)) return null;
  return p;
}

const NPM_SCRIPT_ALIASES = new Set(["test", "t", "tst", "start", "stop", "restart"]);
const PNPM_BUILTINS = new Set(
  "add install i update up upgrade remove rm uninstall un link ln unlink import rebuild rb prune fetch dedupe patch patch-commit audit list ls ll la outdated why licenses exec dlx create env setup store config c init publish pack root bin server deploy help self-update cat-file cat-index find-hash approve-builds ignored-builds".split(" "),
);
const YARN_BUILTINS = new Set(
  "add install remove upgrade up init dlx exec info why workspace workspaces config cache global link unlink pack publish version set plugin constraints node bin help npm explain dedupe patch patch-commit".split(" "),
);

/** @param {Options} opts @returns {Finding[]} */
export function checkReadme(opts) {
  const readme = path.resolve(opts.readme);
  const root = path.resolve(opts.root);
  const readmeDir = path.dirname(readme);
  const src = readFileSync(readme, "utf8");
  const { prose, code } = scan(src);
  /** @type {Finding[]} */
  const findings = [];
  const add = (/** @type {number} */ line, /** @type {string} */ kind, /** @type {string} */ message) =>
    findings.push({ line, kind, message });
  const existsIn = (/** @type {string} */ rel) =>
    existsSync(path.join(root, rel)) || existsSync(path.join(readmeDir, rel));

  // Paths in backticks.
  for (const l of prose) {
    for (const span of l.code) {
      const p = pathCandidate(span, existsIn);
      if (!p) continue;
      if (p.startsWith("/")) add(l.n, "path", `\`${span}\` is a machine-specific path; use a repo-relative one`);
      else if (!existsIn(p) && !gitIgnored(root, p)) add(l.n, "path", `\`${span}\` does not exist in the repo`);
    }
  }

  // Links, images and their anchors.
  /** @type {Map<string, Set<string>>} */
  const anchorCache = new Map();
  const anchorsFor = (/** @type {string} */ file) => {
    if (!anchorCache.has(file)) anchorCache.set(file, anchorsOf(readFileSync(file, "utf8")));
    return /** @type {Set<string>} */ (anchorCache.get(file));
  };
  /** @param {number} n @param {string} target */
  const checkTarget = (n, target) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return;
    const [rawPath, rawAnchor] = target.replace(/\?[^#]*/, "").split("#", 2);
    let rel;
    try {
      rel = decodeURIComponent(rawPath);
    } catch {
      rel = rawPath;
    }
    const file = !rel ? readme : rel.startsWith("/") ? path.join(root, rel) : path.join(readmeDir, rel);
    if (rel && !existsSync(file)) {
      add(n, "link", `${target} points at ${path.relative(root, file) || "."}, which does not exist`);
      return;
    }
    if (rawAnchor === undefined || !/\.(md|markdown)$/i.test(file) || !statSync(file).isFile()) return;
    let anchor = rawAnchor;
    try {
      anchor = decodeURIComponent(rawAnchor);
    } catch {}
    const anchors = anchorsFor(file);
    if (anchors.has(anchor) || anchors.has(anchor.toLowerCase())) return;
    const trim = (/** @type {string} */ s) => s.replace(/^-+|-+$/g, "");
    const near = [...anchors].find((a) => trim(a) === trim(anchor.toLowerCase()));
    const where = file === readme ? "this README" : path.relative(root, file);
    add(n, "anchor", `#${anchor} matches no heading in ${where}${near ? ` (did you mean #${near}?)` : ""}`);
  };

  /** @type {{n: number, alt: string, src: string}[]} */
  const images = [];
  for (const l of prose) {
    let text = l.prose;
    text = text.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_, alt, s) => {
      images.push({ n: l.n, alt, src: s });
      return "IMG";
    });
    for (const m of text.matchAll(/<(?:img|source)\b[^>]*?\bsrc=["']([^"']+)["'][^>]*>/gi)) {
      const alt = /\balt=["']([^"']*)["']/i.exec(m[0]);
      images.push({ n: l.n, alt: alt ? alt[1] : "", src: m[1] });
    }
    for (const m of text.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) checkTarget(l.n, m[1]);
    for (const m of text.matchAll(/<a\b[^>]*?\bhref=["']([^"']+)["']/gi)) checkTarget(l.n, m[1]);
    const def = /^ {0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+.*)?$/.exec(text);
    if (def) checkTarget(l.n, def[1]);
  }
  for (const img of images) checkTarget(img.n, img.src);

  // Badges.
  const version = manifestVersion(root);
  for (const { n, alt, src } of images) {
    const workflow =
      /github\.com\/[^/]+\/[^/]+\/actions\/workflows\/([^/?#]+)\/badge\.svg/.exec(src) ??
      /img\.shields\.io\/github\/actions\/workflow\/status\/[^/]+\/[^/]+\/([^/?#]+)/.exec(src);
    if (workflow && !existsSync(path.join(root, ".github", "workflows", workflow[1]))) {
      add(n, "badge", `workflow badge points at .github/workflows/${workflow[1]}, which does not exist`);
    }
    const isLicense = /shields\.io\/(github\/license|badge\/licen[cs]e|npm\/l\/)/i.test(src) || /^licen[cs]e/i.test(alt);
    if (isLicense && !hasLicense(root)) add(n, "badge", "license badge, but the repo has no LICENSE file");
    const stat = /img\.shields\.io\/badge\/([^?#/]+)/.exec(src);
    if (stat && version) {
      const parts = decodeURIComponent(stat[1]).replace(/--/g, "\0").split("-").map((s) => s.replace(/\0/g, "-").replace(/_/g, " "));
      const [label, message] = parts.length >= 3 ? parts : ["", parts[0]];
      if (/^v$|version|release/i.test(label) || (/version/i.test(alt) && parts.length >= 2)) {
        const shown = message.replace(/^v/i, "");
        if (shown !== version.version) add(n, "badge", `version badge says ${message}, but ${version.file} says ${version.version}`);
      }
    }
    if (opts.private && /img\.shields\.io\/github\//.test(src)) {
      add(n, "badge", "shields.io cannot read a private repo; use GitHub's own workflow badge (actions/workflows/<file>/badge.svg) or a static badge");
    }
  }

  // Commands.
  const pkg = readPackageJson(root);
  const scripts = pkg && typeof pkg.scripts === "object" && pkg.scripts ? pkg.scripts : null;
  /** @type {Map<string, {ok: boolean, text: string, error?: string}>} */
  const helpCache = new Map();
  const help = (/** @type {Cli} */ cli) => {
    if (!helpCache.has(cli.name)) {
      const r = spawnSync(cli.help, { shell: true, cwd: root, encoding: "utf8", timeout: 15000 });
      const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
      helpCache.set(cli.name, r.status === 0 ? { ok: true, text } : { ok: false, text, error: r.error ? r.error.message : `exit ${r.status}` });
    }
    return /** @type {{ok: boolean, text: string, error?: string}} */ (helpCache.get(cli.name));
  };
  const reportedCli = new Set();
  /** @param {number} n @param {string} script @param {string} cmd */
  const needScript = (n, script, cmd) => {
    if (!scripts) add(n, "command", `\`${cmd}\` runs script "${script}", but there is no package.json with scripts`);
    else if (!(script in scripts)) add(n, "command", `\`${cmd}\` runs script "${script}", which package.json does not define`);
  };
  /** @param {number} n @param {string} segment */
  const checkCommand = (n, segment) => {
    const cmd = segment.trim().replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, "");
    if (!cmd) return;
    const cli = (opts.cli ?? []).find((c) => cmd === c.name || cmd.startsWith(c.name + " "));
    if (cli) {
      const sub = cmd.slice(cli.name.length).trim().split(/\s+/)[0];
      if (!sub || sub.startsWith("-") || /[<$[{]/.test(sub)) return;
      const h = help(cli);
      if (!h.ok) {
        if (!reportedCli.has(cli.name)) add(n, "command", `could not read help for ${cli.name}: \`${cli.help}\` failed (${h.error})`);
        reportedCli.add(cli.name);
        return;
      }
      const esc = sub.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`(^|[^\\w-])${esc}([^\\w-]|$)`, "m").test(h.text)) {
        add(n, "command", `\`${cli.name} ${sub}\`: "${sub}" does not appear in \`${cli.help}\``);
      }
      return;
    }
    const [bin, ...args] = cmd.split(/\s+/);
    const a0 = args[0] ?? "";
    if (/[<$]/.test(a0)) return;
    if (bin === "npm") {
      if (["run", "run-script", "rum", "urn"].includes(a0) && args[1] && !args[1].startsWith("-")) needScript(n, args[1], cmd);
      else if (NPM_SCRIPT_ALIASES.has(a0)) {
        const s = { t: "test", tst: "test" }[a0] ?? a0;
        if (!(s === "start" && existsIn("server.js"))) needScript(n, s, cmd);
      }
    } else if (bin === "pnpm" || bin === "yarn") {
      if (!a0 || a0.startsWith("-")) return;
      if (a0 === "run") {
        if (args[1] && !args[1].startsWith("-")) needScript(n, args[1], cmd);
        return;
      }
      if ((bin === "pnpm" ? PNPM_BUILTINS : YARN_BUILTINS).has(a0)) return;
      if (existsIn(path.join("node_modules", ".bin", a0))) return;
      needScript(n, a0, cmd);
    } else if (bin === "bun") {
      if (a0 === "run" && args[1] && !args[1].startsWith("-") && !FILE_EXT.test(args[1])) needScript(n, args[1], cmd);
    } else if (bin === "node") {
      if (args.some((x) => /^(-e|-p|--eval|--print)$/.test(x))) return;
      const file = args.find((x) => !x.startsWith("-"));
      if (file && !/[<$*]/.test(file) && !existsIn(file)) add(n, "command", `\`${cmd}\` runs ${file}, which does not exist`);
    }
  };
  const SHELL_LANGS = new Set(["", "sh", "bash", "shell", "zsh", "console", "shell-session", "sh-session"]);
  for (const c of code) {
    if (!SHELL_LANGS.has(c.lang)) continue;
    let line = c.text.trim();
    const prompt = /^[$%]\s+/.exec(line);
    if (/^(console|shell-session|sh-session)$/.test(c.lang) && !prompt) continue;
    if (prompt) line = line.slice(prompt[0].length);
    if (line.startsWith("#")) continue;
    line = line.replace(/\s+#.*$/, "");
    for (const seg of line.split(/&&|\|\||;|\|/)) checkCommand(c.n, seg);
  }
  const RUNNERS = /^(npm|pnpm|yarn|bun|node)\s/;
  for (const l of prose) {
    for (const span of l.code) {
      if (RUNNERS.test(span) || (opts.cli ?? []).some((c) => span.startsWith(c.name + " "))) {
        for (const seg of span.split(/&&|\|\||;|\|/)) checkCommand(l.n, seg);
      }
    }
  }

  // Emoji and leftovers, in prose only.
  for (const l of prose) {
    if (/\p{Extended_Pictographic}/u.test(l.prose.replace(/[©®™]/g, ""))) add(l.n, "emoji", "emoji in the text; say it in words");
    const left = /\b(TODO|FIXME|TBD)\b/.exec(l.prose) ?? /lorem ipsum/i.exec(l.prose);
    if (left) add(l.n, "leftover", `leftover "${left[0]}"`);
  }

  return findings.sort((a, b) => a.line - b.line);
}

// --- CLI ----------------------------------------------------------------------

function gitRoot(/** @type {string} */ dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return dir;
  }
}

function main(/** @type {string[]} */ argv) {
  /** @type {Cli[]} */
  const cli = [];
  let readme = "README.md";
  let root = "";
  let priv = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") root = argv[++i] ?? "";
    else if (a === "--private") priv = true;
    else if (a === "--json") json = true;
    else if (a === "--cli") {
      const spec = argv[++i] ?? "";
      const eq = spec.indexOf("=");
      if (eq < 1) {
        console.error(`--cli needs <name>=<help command>, got "${spec}"`);
        return 2;
      }
      cli.push({ name: spec.slice(0, eq).trim(), help: spec.slice(eq + 1).trim() });
    } else if (a === "-h" || a === "--help") {
      console.log("usage: check-readme.mjs [README.md] [--root <dir>] [--cli <name>=<help command>]... [--private] [--json]");
      return 0;
    } else if (a.startsWith("-")) {
      console.error(`unknown option ${a}`);
      return 2;
    } else readme = a;
  }
  if (!existsSync(readme)) {
    console.error(`${readme}: not found`);
    return 2;
  }
  const findings = checkReadme({
    readme,
    root: root || gitRoot(path.dirname(path.resolve(readme))),
    cli,
    private: priv,
  });
  if (json) console.log(JSON.stringify(findings, null, 2));
  else if (findings.length === 0) console.log(`${readme}: no findings`);
  else for (const f of findings) console.log(`${readme}:${f.line}: ${f.kind} ${f.message}`);
  return findings.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
