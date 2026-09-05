// Scaffolding for the nightwatch launcher tests: a throwaway clone with a bare
// `origin`, an isolated $HOME (so $STATE is per-test), and fake `gh`/`claude`
// binaries on PATH.
//
// The fake `claude` ignores every flag. It finds the one argument carrying the
// workflow args JSON and reads `repo`, `spec`, `unit` and `runDir` out of it —
// that is how it knows which result file this unit is meant to write. It then
// runs the shell snippet in $FAKE_NW_SCRIPT from inside the clone with these
// variables exported:
//
//   REPO SPEC UNIT SLUG RUNDIR STATEDIR RESULT
//
// and prints a driver envelope (cost and turns) on stdout, exactly as the real
// `claude -p --output-format json` does.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RUN_SH = join(HERE, "..", "nightwatch", "run.sh");

const FAKE_GH = String.raw`#!/usr/bin/env bash
# Fake gh for the nightwatch tests: the kill switch answers from the environment.
case "$1 $2" in
  "variable get") v=$FAKE_GH_STATE; [ -n "$v" ] || v=run; echo "$v" ;;
  "auth status") exit 0 ;;
  *) exit 0 ;;
esac
`;

const FAKE_CLAUDE = String.raw`#!/usr/bin/env bash
# Fake claude -p for the nightwatch tests. See nightwatch-fixtures.mjs.
prompt=""
for a in "$@"; do
  case "$a" in *runDir*) prompt=$a ;; esac
done
REPO=$(printf '%s' "$prompt" | sed -n 's/.*"repo":"\([^"]*\)".*/\1/p')
SPEC=$(printf '%s' "$prompt" | sed -n 's/.*"spec":"\([^"]*\)".*/\1/p')
UNIT=$(printf '%s' "$prompt" | sed -n 's/.*"unit":\([0-9][0-9]*\).*/\1/p')
RUNDIR=$(printf '%s' "$prompt" | sed -n 's/.*"runDir":"\([^"]*\)".*/\1/p')
SLUG=$(basename "$RUNDIR")
STATEDIR=$(cd "$RUNDIR/../.." && pwd)
printf '%s\n' "$prompt" >> "$STATEDIR/prompts.log"
RESULT=$RUNDIR/u$UNIT.result.json
export REPO SPEC UNIT SLUG RUNDIR STATEDIR RESULT
cd "$REPO" || exit 1
if [ -n "$FAKE_NW_SCRIPT" ]; then eval "$FAKE_NW_SCRIPT"; fi
echo '{"total_cost_usd":0.5,"num_turns":3}'
`;

/**
 * A clone with a bare origin, an isolated HOME, and the fakes on PATH.
 * `specs` maps a file name (`01-a.md`) to its text.
 */
export function nightwatchRepo({ specs = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "nw-repo-"));
  const clone = join(root, "repo");
  // Under a github.com/ path so the shape matches the other fixtures.
  const origin = join(root, "github.com", "o", "r.git");
  mkdirSync(join(root, "github.com", "o"), { recursive: true });
  mkdirSync(clone);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const git = (...a) => execFileSync("git", a, { cwd: clone, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false"); // a global signing key would prompt and hang the test
  git("remote", "add", "origin", origin);
  // scripts/check is committed: preflight refuses a dirty clone and `git clean -fdq`
  // runs after every unit, so an uncommitted fixture file would vanish mid-run.
  mkdirSync(join(clone, "scripts"), { recursive: true });
  // Discriminating on purpose: it passes only from the clone root, so a test
  // that reads CHECK OK has positively proved where the launcher ran it.
  writeFileSync(
    join(clone, "scripts", "check"),
    '#!/usr/bin/env bash\ncd "$(dirname "$0")/.." || exit 1\ntest -f README.md || { echo "wrong cwd"; exit 1; }\necho CHECK OK\n',
  );
  chmodSync(join(clone, "scripts", "check"), 0o755);
  writeFileSync(join(clone, "README.md"), "# nightwatch fixture\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  git("push", "-q", "-u", "origin", "main");

  const specsDir = join(root, "specs");
  mkdirSync(specsDir);
  for (const [name, text] of Object.entries(specs)) writeFileSync(join(specsDir, name), text);

  const home = join(root, "home");
  mkdirSync(home);
  const state = join(home, ".local", "state", "nightwatch", "repo");

  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  writeFileSync(join(bin, "claude"), FAKE_CLAUDE);
  for (const f of ["gh", "claude"]) chmodSync(join(bin, f), 0o755);

  return { root, clone, origin, specsDir, home, state, bin, git };
}

/** Run the launcher against a fixture. Returns its output and the state files. */
export function runNightwatch(r, { env = {}, args = [], timeout = 120000, positional, runSh = RUN_SH, stateName } = {}) {
  const res = spawnSync("bash", [runSh, ...(positional || [r.clone, r.specsDir]), ...args], {
    encoding: "utf8",
    timeout,
    env: {
      PATH: `${r.bin}:${process.env.PATH}`,
      HOME: r.home,
      DEADLINE: "1h",
      POLL_S: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      FAKE_NW_SCRIPT: "",
      FAKE_GH_STATE: "run",
      ...env,
    },
  });
  const slurp = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  // `run.sh <name>` keeps its state under that name, not under the clone's basename.
  const st = stateName ? join(r.home, ".local", "state", "nightwatch", stateName) : r.state;
  return {
    code: res.status,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    state: st,
    journal: slurp(join(st, "journal.md")),
    decisions: slurp(join(st, "decisions.jsonl")),
    landed: slurp(join(st, "landed")),
    controlOffset: slurp(join(st, "control.offset")).trim(),
    prompts: slurp(join(st, "prompts.log")),
  };
}

/**
 * The config file `init.mjs` writes and `run.sh <name>` reads. Returns the
 * state directory it created.
 */
export function writeConfig(home, name, kv = {}) {
  const dir = join(home, ".local", "state", "nightwatch", name);
  mkdirSync(dir, { recursive: true });
  const text = Object.entries({ NAME: name, ...kv })
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  writeFileSync(join(dir, "config"), `${text}\n`);
  return dir;
}

/** `git branch --list` in the clone, one name per line. */
export function branches(r) {
  return execFileSync("git", ["branch", "--format=%(refname:short)"], { cwd: r.clone, encoding: "utf8" }).trim().split("\n").filter(Boolean);
}

/** A commit object that no ref reaches — a landed row pointing here is stale. */
export function unreachableCommit(r) {
  const tree = execFileSync("git", ["hash-object", "-t", "tree", "-w", "/dev/null"], { cwd: r.clone, encoding: "utf8" }).trim();
  return execFileSync("git", ["commit-tree", tree, "-m", "unrelated"], { cwd: r.clone, encoding: "utf8" }).trim();
}

/** A minimal spec with the headings the launcher and the specs dir expect. */
export function spec(title, headers = "") {
  return `# ${title}\n\nRepo: /does/not/matter\n${headers}\n## Outcome\n\nDo the thing.\n\n## Acceptance\n\n- \`bash scripts/check\` prints CHECK OK.\n\n## Non-goals\n\n- nothing\n\n## Context\n\n- none\n`;
}

// ---- FAKE_NW_SCRIPT snippets -------------------------------------------------
// `commit` makes one commit on the outcome branch; the rest write the unit result.
// __RUNDIR__ / __UNIT__ are substituted by the snippet itself at run time.

export const COMMIT = String.raw`echo "$SLUG u$UNIT" > "nw-$SLUG-$UNIT.txt"; git add -A; git commit -q -m "$SLUG u$UNIT"`;

/** Write a unit result. `json` is a JS object; string values may use the placeholders. */
export function writeResult(json) {
  const text = JSON.stringify(json);
  if (text.includes("'")) throw new Error("no single quotes in fixture results");
  return `printf '%s\\n' '${text}' | sed "s|__RUNDIR__|$RUNDIR|g; s|__UNIT__|$UNIT|g" > "$RESULT"`;
}

/** A verify log the evidence gate accepts, plus the results entry that names it. */
export const WRITE_LOG = String.raw`mkdir -p "$RUNDIR/u$UNIT-logs"; printf 'CHECK OK\nexit=0\n' > "$RUNDIR/u$UNIT-logs/verify-1.log"`;

export const VERIFY_OK = {
  results: [{ command: "bash scripts/check", exit: 0, tail: "CHECK OK", log: "__RUNDIR__/u__UNIT__-logs/verify-1.log" }],
  allPass: true,
};

const base = (state, extra = {}) => ({ state, unit: 1, unitTitle: `${state} unit`, summary: "fixture", blockedReason: "", commits: ["c"], ...extra });

/** PASS with a real verify log, so the evidence gate is satisfied. */
export const PASS_UNIT = [COMMIT, WRITE_LOG, writeResult(base("PASS", { verify: VERIFY_OK }))].join("\n");
/** PASS whose verify log names a file nothing wrote. */
export const PASS_NO_LOG = [COMMIT, writeResult(base("PASS", { verify: VERIFY_OK }))].join("\n");
/** PASS that verified nothing at all: no command, no log, so no evidence. */
export const PASS_NO_RESULTS = [COMMIT, writeResult(base("PASS", { verify: { results: [], allPass: true, checkOk: true, clean: true } }))].join("\n");
/** CONTINUE: the launcher runs another unit. */
export const CONTINUE_UNIT = [COMMIT, writeResult(base("CONTINUE"))].join("\n");
/** FAILED, with work committed: the branch is kept for the morning. */
export const FAILED_UNIT = [COMMIT, writeResult(base("FAILED"))].join("\n");
/** A commit and no result file at all: the workflow died after doing work. */
export const DIED_UNIT = [COMMIT, `echo "boom: the workflow threw" >&2`].join("\n");
