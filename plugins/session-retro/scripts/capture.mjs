// @ts-check
// session-retro capture: one input-free, redacted JSON line per tool outcome and
// per session start. Registered for SessionStart, PostToolUse, PostToolUseFailure,
// PostToolBatch, PermissionDenied and StopFailure. Records only: no stdout, no
// network, no model. Always exits 0; any error drops the event, never the session.
import fs from "node:fs";

const env = process.env;
const DAY_MS = 864e5;
const KEEP_DAYS = 42;
const MAX_LINE = 4095; // PIPE_BUF - 1: one O_APPEND write stays atomic
const SUBCMD = new Set("git gh pnpm uv npm cargo docker kubectl brew chezmoi op wrangler codex claude modal".split(" "));
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "NotebookEdit", "MultiEdit"]);
const R = "[REDACTED]";
const SECRETS = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_\w{20,}/g,
  /github_pat_\w+/g,
  /xox[abprs]-\S+/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[\w-]{30,}/g,
  /Bearer\s+\S+/gi,
  /eyJ\w+\.\w+\.\S*/g,
  /(token|key|secret|passw(or)?d|pwd|auth\w*)\s*[=:]\s*\S+/gi,
  /op:\/\/\S+/g,
  /[0-9a-fA-F]{32,}/g,
  /[A-Za-z0-9+/=_-]{40,}/g,
];

/** Redact one line of text. A line containing a PEM header goes entirely. */
function redact(s) {
  if (s.includes("-----BEGIN")) return R;
  for (const re of SECRETS) s = s.replace(re, R);
  return s;
}

// Absolute, home and relative paths in error text (spec: never store raw paths).
const PATH_RE = /(?<=^|[\s'"`=(:])(?:~|\.{1,2})?\/[^\s'"`)]+/g;

/** First line of any text-ish value, redacted, <= 160 chars. */
function firstLine(v) {
  const s = text(v).trim().split("\n", 1)[0].slice(0, 2000);
  return s ? redact(s).replace(PATH_RE, "<path>").slice(0, 160) : null;
}

function text(v) {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("\n");
  return "";
}

const pick = (v, re) => (typeof v === "string" && re.test(v) ? v : null);
const NAME = /^[A-Za-z0-9_.:-]{1,96}$/;
const TOKEN = /^[A-Za-z0-9._-]{1,32}$/;

/** Command head: at most two tokens, never arguments. */
function verbOf(cmd) {
  if (typeof cmd !== "string") return null;
  const toks = cmd.trim().split("\n", 1)[0].split(/\s+/);
  let i = 0;
  while (i < toks.length && (/^[A-Za-z_]\w*=/.test(toks[i]) || toks[i] === "sudo" || toks[i] === "env" || (i > 0 && toks[i].startsWith("-")))) i++;
  if (i >= toks.length || !toks[i]) return null;
  const head = toks[i].slice(toks[i].lastIndexOf("/") + 1);
  if (!TOKEN.test(head)) return "?";
  const sub = toks[i + 1];
  if (!SUBCMD.has(head) || !sub || sub.startsWith("-")) return redact(head);
  return redact(`${head} ${TOKEN.test(sub) ? sub : "?"}`);
}

function extOf(p) {
  if (typeof p !== "string") return "none";
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? pick(base.slice(dot).toLowerCase(), /^\.[a-z0-9]{1,8}$/) || "none" : "none";
}

/** Classify a PostToolBatch tool_response for a call no per-tool hook saw. */
function denial(resp, tool) {
  const t = text(resp);
  if (/^PreToolUse:\S* hook|hook error|blocked by .*hook/i.test(t)) return ["hook_deny", firstLine(t)];
  const m = /Permission to use (\S+)/.exec(t);
  if (m && /denied/i.test(t)) return ["rule_deny", `Permission to use ${pick(m[1], NAME) || tool || "?"}`];
  if (/InputValidationError|tool_use_error/.test(t)) return ["input_invalid", firstLine(t.replace(/<\/?tool_use_error>/g, ""))];
  if (/user (doesn't want|rejected|denied)|rejected by the user/i.test(t)) return ["user_reject", firstLine(t)];
  return ["other", firstLine(t)];
}

function readHead(git) {
  const head = fs.readFileSync(`${git}/HEAD`, "utf8").trim();
  if (!head.startsWith("ref: ")) return head;
  const ref = head.slice(5);
  try {
    return fs.readFileSync(`${git}/${ref}`, "utf8").trim();
  } catch {
    const line = fs.readFileSync(`${git}/packed-refs`, "utf8").split("\n").find((l) => l.endsWith(` ${ref}`));
    return line ? line.slice(0, 40) : "";
  }
}

async function context(p) {
  let sha = "?";
  try {
    sha = pick(readHead(`${env.HOME}/.local/share/chezmoi/.git`).slice(0, 12), /^[0-9a-f]{12}$/) || "?";
  } catch {}
  let ver = "?";
  try {
    ver = JSON.parse(fs.readFileSync(`${env.CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`, "utf8")).version;
  } catch {}
  let pstart = null;
  if (/^\d+$/.test(env.CLAUDE_PID || "")) {
    try {
      const { spawnSync } = await import("node:child_process");
      const r = spawnSync("ps", ["-o", "lstart=", "-p", env.CLAUDE_PID], { encoding: "utf8", timeout: 500, env: { PATH: env.PATH, LC_ALL: "C" } });
      const t = Date.parse((r.stdout || "").trim());
      if (t) pstart = new Date(t).toISOString();
    } catch {}
  }
  return { harness: `${sha}+${ver}`, pstart, pid: env.CLAUDE_PID || null, model: pick(p.model, NAME) };
}

function tail(file, n = 65536) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, n));
    fs.readSync(fd, buf, 0, buf.length, size - buf.length);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function sweep(root, now) {
  const cutoff = now - KEEP_DAYS * DAY_MS;
  for (const d of fs.readdirSync(`${root}/events`)) {
    const t = /^\d{4}-\d{2}-\d{2}$/.test(d) ? Date.parse(d) : NaN;
    if (t < cutoff) fs.rmSync(`${root}/events/${d}`, { recursive: true, force: true });
  }
  for (const f of fs.readdirSync(`${root}/ctx`)) {
    const st = fs.statSync(`${root}/ctx/${f}`);
    if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(`${root}/ctx/${f}`);
  }
}

function append(file, dir, line) {
  try {
    fs.appendFileSync(file, line);
  } catch (e) {
    if (/** @type {any} */ (e).code !== "ENOENT") throw e;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, line);
  }
}

async function main() {
  const data = env.CLAUDE_PLUGIN_DATA;
  if (!data) return;
  const p = JSON.parse(fs.readFileSync(0, "utf8"));
  if (!p || typeof p !== "object" || Array.isArray(p)) return;
  const ev = p.hook_event_name;
  const sid = pick(p.session_id, /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/);
  if (!sid || typeof ev !== "string") return;

  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const root = `${data}/v3`;
  const dayDir = `${root}/events/${day}`;
  const file = `${dayDir}/${sid}.jsonl`;
  const ctxFile = `${root}/ctx/${sid}.json`;
  const canary = p.source === "canary";

  let ctx = null;
  if (ev !== "SessionStart") {
    try {
      ctx = JSON.parse(fs.readFileSync(ctxFile, "utf8"));
      if (ctx.pid !== (env.CLAUDE_PID || null)) ctx = null; // new process, e.g. resumed
    } catch {}
  }
  if (!ctx) {
    ctx = await context(p);
    if (ev === "SessionStart" && !ctx.model) {
      try {
        ctx.model = JSON.parse(fs.readFileSync(ctxFile, "utf8")).model || null;
      } catch {}
    }
    if (!canary) {
      try {
        fs.mkdirSync(`${root}/ctx`, { recursive: true });
        fs.writeFileSync(ctxFile + ".tmp", JSON.stringify(ctx));
        fs.renameSync(ctxFile + ".tmp", ctxFile);
      } catch {}
    }
  }

  const tool = pick(p.tool_name, NAME);
  const inp = p.tool_input && typeof p.tool_input === "object" ? p.tool_input : {};
  const base = {
    v: 3,
    ts: new Date(now).toISOString(),
    ev,
    sid,
    outcome: "",
    ok: /** @type {boolean|null} */ (false),
    tool,
    id: typeof p.tool_use_id === "string" ? p.tool_use_id.slice(0, 128) : null,
    verb: tool === "Bash" ? verbOf(inp.command) : null,
    target: tool && FILE_TOOLS.has(tool) ? extOf(inp.file_path ?? inp.notebook_path) : null,
    mcp_server: pick(p.mcp_server, NAME),
    code: null,
    err: null,
    dur_ms: Number.isFinite(p.duration_ms) ? p.duration_ms : null,
    intr: typeof p.is_interrupt === "boolean" ? p.is_interrupt : null,
    sub: typeof p.agent_id === "string" && p.agent_id !== "",
    agent_type: pick(p.agent_type, NAME),
    proj: pick(typeof p.cwd === "string" ? p.cwd.slice(p.cwd.lastIndexOf("/") + 1) : null, /^[A-Za-z0-9._-]{1,64}$/),
    src: null,
    harness: ctx.harness,
    cc: pick((env.CLAUDE_CODE_EXECPATH || "").split("/").pop(), /^[A-Za-z0-9._-]{1,32}$/),
    model: ctx.model,
    pstart: ctx.pstart,
    arm: pick(env.CLAUDE_HEAL_ARM, /^[A-Za-z0-9_-]{1,32}$/),
  };

  /** @type {any[]} */
  const recs = [];
  if (ev === "SessionStart") {
    if (!canary && !fs.existsSync(dayDir)) {
      try {
        sweep(root, now); // first SessionStart of the UTC day
      } catch {}
    }
    recs.push({ ...base, outcome: "session", ok: null, src: pick(p.source, /^[a-z_-]{1,24}$/) });
  } else if (ev === "PostToolUse") {
    recs.push({ ...base, outcome: "ok", ok: true });
  } else if (ev === "PostToolUseFailure") {
    recs.push({ ...base, outcome: p.is_interrupt === true ? "interrupt" : "error", err: firstLine(p.error) });
  } else if (ev === "PermissionDenied") {
    recs.push({ ...base, outcome: "classifier_denied", err: firstLine(p.reason) });
  } else if (ev === "StopFailure") {
    recs.push({ ...base, outcome: "stop_failure", code: pick(p.error, NAME), err: firstLine(p.error_details || p.error) });
  } else if (ev === "PostToolBatch" && Array.isArray(p.tool_calls)) {
    const seen = tail(file);
    let prev = null; // a batch can straddle UTC midnight
    for (const c of p.tool_calls) {
      if (!c || typeof c.tool_use_id !== "string") continue;
      const key = `"id":${JSON.stringify(c.tool_use_id.slice(0, 128))}`;
      if (seen.includes(key)) continue;
      prev ??= tail(`${root}/events/${new Date(now - DAY_MS).toISOString().slice(0, 10)}/${sid}.jsonl`);
      if (prev.includes(key)) continue;
      const t = pick(c.tool_name, NAME);
      const ci = c.tool_input && typeof c.tool_input === "object" ? c.tool_input : {};
      const [code, err] = denial(c.tool_response, t);
      recs.push({
        ...base, outcome: "denied_or_invalid", tool: t, id: c.tool_use_id.slice(0, 128), code, err,
        verb: t === "Bash" ? verbOf(ci.command) : null,
        target: t && FILE_TOOLS.has(t) ? extOf(ci.file_path ?? ci.notebook_path) : null,
        mcp_server: null, dur_ms: null, intr: null,
      });
    }
  } else return;

  // One append per line: each stays under PIPE_BUF, so concurrent writers never interleave.
  for (const r of recs) {
    for (const k in r) if (r[k] === null && k !== "ok") delete r[k];
    let line = JSON.stringify(r);
    if (Buffer.byteLength(line) > MAX_LINE) line = JSON.stringify({ ...r, err: undefined });
    if (Buffer.byteLength(line) <= MAX_LINE) append(file, dayDir, line + "\n");
  }
}

try {
  await main();
} catch {}
process.exitCode = 0;
