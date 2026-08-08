#!/usr/bin/env node
// @ts-check
// PreToolUse hook (matcher: Bash): gate `git commit` on docs staying in sync with
// plugin code. Docs drift is the classic silent failure — code lands, README/CLAUDE.md
// go stale, and by the next session nobody remembers what changed. Research (2026-07)
// says the working designs block at the commit boundary (turn-end nudges never reach
// the model: Stop-hook stdout isn't injected into context) and carry an explicit
// what-NOT-to-flag list so the gate doesn't become noise people ack reflexively.
//
// Decision table (plugins/ monorepo layout only — silent anywhere else):
//   - command isn't a `git commit`            → allow silently.
//   - command contains `docs-sync:ack`        → allow (deliberate no-doc-impact call;
//                                               the marker lands in the commit message,
//                                               so the judgment is auditable later).
//     Heredoc bodies are stripped before that check, EXCEPT for the stdin-message
//     form (`git commit -F -` / `--file=-` / `--file -`) where the body *is* the
//     message. Without that carve-out the marker could work or be auditable, never
//     both: inside the heredoc it was stripped, outside it never reached the message.
//     Every other heredoc stays stripped — this plugin's own README documents the
//     literal token and must not thereby bypass the gate.
//   - staged/added executable plugin code (scripts|hooks|agents|workflows) without a
//     staged README.md or CLAUDE.md in the SAME plugin → deny with the plugin names.
//   - tests, version bumps (plugin.json/marketplace.json), and skills/commands
//     markdown (self-documenting prompt files) never trigger the gate.
//
// "Staged" is a union of: `git diff --cached`, paths named in `git add` segments of
// the same compound command (they aren't staged yet when the hook runs), and — for
// `commit -a` — modified tracked files. Pathspecs passed directly to `git commit`
// are NOT parsed (rare in agent usage); any git error fails open.

import process from "node:process";
import path from "node:path";
import { realpathSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readStdin, safeJsonParse, emitPermissionDecision } from "./lib.mjs";

/**
 * @typedef {object} PreToolUseInput
 * @property {string} [tool_name]
 * @property {string} [cwd]
 * @property {{ command?: string }} [tool_input]
 */

/** Executable plugin surface — changes here are what docs describe. */
const CODE_RE = /^plugins\/([^/]+)\/(scripts|hooks|agents|workflows)\//;
/** Never-flag list: tests and test fixtures inside those dirs. */
const TEST_RE = /(^|\/)tests?\/|\.test\.[a-z]+$/;

/**
 * Run a git command in `cwd`, returning stdout lines or null on any failure.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string[] | null}
 */
function git(cwd, args) {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Remove heredoc bodies from a command before anything else parses it.
 *
 * A heredoc body is literal text being written, not commands to run. Without
 * this, `cat >> notes.md <<'EOF' … git add x && git commit … EOF` reads as a real
 * commit and the gate denies a command that never commits anything. Hit twice for
 * real while writing tests for the quoting fix below — the test file's own
 * fixture strings tripped the gate that the tests exercise.
 *
 * Deliberately simpler than design-gate-guard's full tokenizer: that one needs to
 * know which command *starts* a segment, so it must track quotes to find segment
 * boundaries. Here we only need the bodies gone, and a heredoc body always runs
 * from the line after the introducer to a line equal to the delimiter.
 * @param {string} command
 * @returns {string}
 */
function splitHeredocs(command) {
  const lines = command.split("\n");
  const out = [];
  /** @type {{ intro: string, body: string }[]} */
  const bodies = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    // ALL heredocs on the line, in order: `cmd <<'A' <<'B'` queues two bodies
    // back to back. Consuming only the first left the second body in the
    // "stripped" command, where it was indistinguishable from real shell — the
    // marker check found it there, and commit detection and the `git add` union
    // saw it too.
    const intro = lines[i]; // captured before the body loop advances `i`
    const introducers = [
      ...intro.matchAll(/<<(-?)\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w.-]*))/g),
    ];
    if (introducers.length === 0) continue;
    for (const m of introducers) {
      const delim = m[2] ?? m[3] ?? m[4];
      const strip = m[1] === "-";
      /** @type {string[]} */
      const body = [];
      // Consume the body, up to and including the terminator line.
      while (++i < lines.length) {
        const cmp = strip ? lines[i].replace(/^\t+/, "") : lines[i];
        if (cmp === delim) break;
        body.push(lines[i]);
      }
      // Bodies are kept WITH their introducer line. A body only means something
      // for a given command if that command is the one it was redirected into —
      // scanning every body in a compound command lets a decoy heredoc elsewhere
      // launder the marker for a commit whose message never carried it.
      bodies.push({ intro, body: body.join("\n") });
    }
  }
  return { stripped: out.join("\n"), bodies };
}

/**
 * True when the commit reads its message from stdin — `-F -`, `--file=-`,
 * `--file -`. In that form the heredoc body IS the commit message, so the ack
 * marker legitimately lives there and must be honoured. `-F msg.txt` is a file,
 * not stdin, and does not qualify.
 * @param {string} command  the heredoc-stripped form
 * @returns {boolean}
 */
function readsMessageFromStdin(command) {
  return /(?:^|\s)(?:-F|--file)(?:=|\s+)-(?=\s|$)/m.test(command);
}

/**
 * True when this heredoc introducer line is itself a `git commit` reading its
 * message from stdin — i.e. its body really is the commit message.
 *
 * Three separate bypasses forced this to be token-based rather than regex-based,
 * each found by review after the previous fix:
 *   1. `echo git commit -F - <<'DOC'` — every token present, but `echo` consumes
 *      the heredoc. The command HEAD must be git.
 *   2. `echo 'note; git commit -F - ' <<'DOC'` — splitting on `;` without
 *      honouring quotes FABRICATES a git-headed segment out of quoted text. So
 *      the line is tokenised with the quote-aware splitArgs, and operators only
 *      count as separators when they appear as their own unquoted token.
 *   3. `git commit -F - <<'ACK' <<'MSG'` — bash applies the LAST redirection, so
 *      the first body is discarded; carrying the marker there authorised a
 *      message that never had it. More than one heredoc on the line is refused.
 *
 * Anything unrecognised denies, which is the correct direction here: the cost of
 * a false deny is one `-m` flag, the cost of a false allow is a silent bypass.
 * @param {string} intro
 * @returns {boolean}
 */
function introIsGitCommitFromStdin(intro) {
  const tokens = splitArgs(intro);
  // Ambiguous stdin redirection — refuse rather than guess which body wins.
  if (tokens.filter((t) => t.startsWith("<<")).length !== 1) return false;

  /** @type {string[][]} */
  const segments = [[]];
  for (const t of tokens) {
    if (t === ";" || t === "&&" || t === "||" || t === "|" || t === "&") {
      segments.push([]);
      continue;
    }
    segments[segments.length - 1].push(t);
  }

  return segments.some(
    (seg) =>
      seg.length > 0 &&
      /^(?:\S*\/)?git$/.test(seg[0]) &&
      seg.includes("commit") &&
      readsMessageFromStdin(seg.join(" ")),
  );
}

/**
 * Split a command-line argument string the way a shell words it: honouring single
 * quotes, double quotes and backslash escapes, and splitting only on UNQUOTED
 * whitespace.
 *
 * A bare `.split(/\s+/)` fragments any quoted path containing a space. Real case:
 * `git add "Daily/2026-08-03 - Daily.md"` yielded `Daily/2026-08-03`, `-`,
 * `Daily.md"` — the `-` was dropped as a flag, `Daily.md` passed the markdown
 * skip, and the extensionless `Daily/2026-08-03` was classified as CODE, denying
 * a markdown-only commit in an Obsidian vault where every note has a space in its
 * name.
 * @param {string} s
 * @returns {string[]}
 */
function splitArgs(s) {
  const out = [];
  let cur = "";
  let started = false;
  /** @type {string | null} */
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      // Inside "" a backslash escapes " \ $ ` ; inside '' nothing is special.
      if (quote === '"' && c === "\\" && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) {
        cur += s[++i];
        started = true;
        continue;
      }
      if (c === quote) quote = null;
      else {
        cur += c;
        started = true;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      continue;
    }
    if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (started) {
        out.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

/**
 * Extract paths named in `git add …` segments of a compound command — they aren't
 * in the index yet when the hook inspects it. Flags are skipped.
 * @param {string} command
 * @returns {string[]}
 */
function pathsFromGitAdd(command) {
  const paths = [];
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    const m = /\bgit\s+(?:-C\s+\S+\s+)?add\s+(.*)$/.exec(segment.trim());
    if (!m) continue;
    for (const tok of splitArgs(m[1])) {
      if (!tok || tok.startsWith("-")) continue;
      paths.push(tok);
    }
  }
  return paths;
}

const raw = await readStdin();
const payload = /** @type {PreToolUseInput | null} */ (safeJsonParse(raw));

if (!payload || payload.tool_name !== "Bash") process.exit(0);

// Heredoc bodies are stripped BEFORE any detection: text being written to a file
// is not a command. Everything below — commit detection, the ack marker, and the
// `git add` path union — reads the stripped form, so a heredoc that merely
// mentions a commit neither triggers the gate nor bypasses it.
const { stripped: command, bodies: heredocBodies } = splitHeredocs(
  typeof payload.tool_input?.command === "string" ? payload.tool_input.command : "",
);

// Only gate commits; `git -C x commit` counts, `git commitish-tool` doesn't.
if (!/\bgit\b[^;&|]*\bcommit\b/.test(command)) process.exit(0);

// Explicit no-doc-impact ack — ends up in the commit message, auditable later.
if (command.includes("docs-sync:ack")) process.exit(0);

// Same marker, but written where a `git commit -F -` message actually lives.
// Scoped twice over, because each scope closes a different bypass:
//   1. only the stdin-message form — a heredoc that merely *documents* the
//      marker (this plugin's own README does) must not authorise anything;
//   2. only the body whose OWN introducer line is a `git commit` reading stdin —
//      otherwise a decoy heredoc launders the marker for a commit whose message
//      never carried it, whether the decoy is `cat >/dev/null <<'DOC'` or the
//      token-bearing `echo git commit -F - <<'DOC'`.
// A commit split across lines won't match and will deny: fail-closed is the
// right direction for a bypass check.
if (
  heredocBodies.some(
    (h) => introIsGitCommitFromStdin(h.intro) && h.body.includes("docs-sync:ack"),
  )
) {
  process.exit(0);
}

let cwd = typeof payload.cwd === "string" && payload.cwd.length ? payload.cwd : process.cwd();
// git prints the REAL toplevel path; symlinked cwds (macOS /var → /private/var)
// would otherwise break the relative-path computation for `git add` unions.
try {
  cwd = realpathSync(cwd);
} catch {
  /* keep as-is; git() fails open below if it's truly unusable */
}

const rootLines = git(cwd, ["rev-parse", "--show-toplevel"]);
if (!rootLines || !rootLines[0]) process.exit(0); // not a git repo → fail open.
const root = rootLines[0];

// Union of what this commit will contain (repo-relative paths).
const staged = new Set(git(root, ["diff", "--cached", "--name-only"]) || []);
if (/\bcommit\b[^;&|]*(\s-\w*a|\s--all\b)/.test(command)) {
  for (const f of git(root, ["diff", "--name-only"]) || []) staged.add(f);
}
for (const p of pathsFromGitAdd(command)) {
  const rel = path.relative(root, path.resolve(cwd, p));
  if (rel && !rel.startsWith("..")) staged.add(rel);
}

// ---- Rule 1: plugins/ monorepo pairs (per-plugin precision) ----
const codePlugins = new Set();
const docPlugins = new Set();
for (const f of staged) {
  const code = CODE_RE.exec(f);
  if (code && !TEST_RE.test(f)) codePlugins.add(code[1]);
  const doc = /^plugins\/([^/]+)\/(README\.md|CLAUDE\.md)$/.exec(f);
  if (doc) docPlugins.add(doc[1]);
}
const violatingPlugins = [...codePlugins].filter((p) => !docPlugins.has(p)).sort();

// ---- Rule 2: generic nearest-covering-doc (any repo) ----
// The failure path this guards: the system changes, agent-facing docs don't, and a
// future session reads those docs as the source of truth and acts on stale claims.
// For each changed non-plugins code file, walk up from its directory to the repo
// root; the nearest level holding a README.md/CLAUDE.md/AGENTS.md is the covering
// doc set. A repo with no such docs anywhere above the file has nothing to drift.
const DOC_BASENAMES = ["README.md", "CLAUDE.md", "AGENTS.md"];
// `.docs-sync` is this plugin's own consolidation record. It is not Markdown, so
// without this entry rule 2 would treat it as code, walk up for its covering doc,
// find the root README.md unstaged, and deny — blocking `/docs-consolidate --init`
// and every routine re-stamp in any repo that has a root README (i.e. all of them).
// Exempting the record does not exempt the commit: real code staged alongside it is
// still caught, because each path is classified independently.
const SKIP_RE =
  /\.(md|markdown)$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|uv\.lock|poetry\.lock|LICENSE[^/]*|\.gitignore|\.gitattributes|\.editorconfig|\.docs-sync)$|\.lock$|(^|\/)\.claude-plugin\//;

/** @type {Map<string, { docs: string[], files: string[] }>} */
const genericViolations = new Map();
for (const f of staged) {
  if (f.startsWith("plugins/")) continue; // rule 1 territory
  if (TEST_RE.test(f) || SKIP_RE.test(f)) continue;
  let dir = path.posix.dirname(f);
  /** @type {{ docs: string[] } | null} */
  let covering = null;
  for (;;) {
    const prefix = dir === "." ? "" : `${dir}/`;
    const docs = DOC_BASENAMES.map((b) => prefix + b).filter((d) =>
      existsSync(path.join(root, d)),
    );
    if (docs.length) {
      covering = { docs };
      break;
    }
    if (dir === ".") break;
    dir = path.posix.dirname(dir);
  }
  if (!covering || covering.docs.some((d) => staged.has(d))) continue;
  const key = covering.docs.join(", ");
  const entry = genericViolations.get(key) || { docs: covering.docs, files: [] };
  entry.files.push(f);
  genericViolations.set(key, entry);
}

if (!violatingPlugins.length && !genericViolations.size) process.exit(0);

const parts = [];
if (violatingPlugins.length) {
  parts.push(
    `executable code in plugin${violatingPlugins.length === 1 ? "" : "s"} ` +
      `${violatingPlugins.map((p) => `"${p}"`).join(", ")} without that plugin's ` +
      "README.md or CLAUDE.md staged",
  );
}
for (const { docs, files } of genericViolations.values()) {
  parts.push(
    `${files.length} code file${files.length === 1 ? "" : "s"} (e.g. ${files[0]}) ` +
      `whose covering doc${docs.length === 1 ? "" : "s"} (${docs.join(", ")}) ` +
      "are untouched",
  );
}

const reason =
  `docs-sync-guard: this commit changes ${parts.join("; and ")}. A future agent ` +
  "session will read those docs as the source of truth and act on stale claims. " +
  "If behavior, structure, or usage changed, update and stage the covering docs in " +
  "the same commit. If this change genuinely has no doc impact (pure refactor, " +
  'comment fix), add "docs-sync:ack" to the commit message and re-run — either in ' +
  "a -m string, or in the heredoc body of a `git commit -F -`. In any other " +
  "heredoc the marker is ignored.";

emitPermissionDecision("deny", reason);
process.exit(0);
