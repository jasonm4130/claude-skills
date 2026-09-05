// Shared scaffolding for the process-level tests: a throwaway repo with a
// bare `origin`, rendered by init.mjs, and a PATH of fake `gh`/`claude`
// binaries that answer from environment variables instead of GitHub.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main as init } from "../scripts/init.mjs";

export const PLAN = `# Smoke plan

## Global Constraints
- none

### Task 1: first
- [ ] do the first thing

### Task 2: second
- [ ] do the second thing

## Open Questions
`;

/** A repo with the loop rendered, a plan committed, and pushed to a bare origin. */
export function nightshiftRepo({ plan = PLAN, planPath = "docs/plans/smoke.md", initArgs = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ns-repo-"));
  const dir = join(root, "repo");
  // Under a github.com/ path so originSlug reads it as o/r while stays fetchable.
  const origin = join(root, "github.com", "o", "r.git");
  mkdirSync(dir);
  mkdirSync(join(root, "github.com", "o"), { recursive: true });
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false"); // a global signing key (1Password, gpg) would prompt and hang the test
  git("remote", "add", "origin", origin);
  mkdirSync(join(dir, "docs", "plans"), { recursive: true });
  writeFileSync(join(dir, planPath), plan);
  writeFileSync(join(dir, "README.md"), "# smoke\n");
  git("add", "-A");
  git("commit", "-q", "-m", "plan");
  const rc = init(["--repo", dir, "--stack", "generic", "--plan", planPath, ...initArgs], () => {});
  if (rc !== 0) throw new Error(`init exited ${rc}`);
  git("add", "-A");
  git("commit", "-q", "-m", "nightshift scaffold");
  git("push", "-q", "-u", "origin", "main");
  return { root, dir, origin, git };
}

/** Fake gh/claude on PATH. Behaviour comes from FAKE_* environment variables. */
export function shims(root) {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
# Fake gh for tests. Every answer is an environment variable.
args="$*"
case "$1 $2" in
  "auth status") exit 0 ;;
  "variable get") v=\${FAKE_GH_STATE:-}; [ -n "$v" ] || { echo "variable not found" >&2; exit 1; }; echo "$v" ;;
  "label list") printf '%s\\n' "\${FAKE_GH_LABELS-land,land:blocked,land:retry}" | tr ',' '\\n' | grep . ; exit 0 ;;
  "pr list")
    case "$args" in
      *"--state open"*) printf '%s\\n' "\${FAKE_GH_OPEN_PR:-}" | grep . ;;
      *"--state closed"*"labels"*) [ "\${FAKE_GH_CLOSED_RETRY:-0}" = 1 ] || printf '%s\\n' "\${FAKE_GH_CLOSED_PR:-}" | grep . ;;
      *"--state closed"*) printf '%s\\n' "\${FAKE_GH_CLOSED_PR:-}" | grep . ;;
    esac; exit 0 ;;
  "api "*)
    case "$args" in
      *"/protection"*) if [ "\${FAKE_GH_PROTECTED:-0}" = 0 ]; then echo "HTTP 404: Branch not protected" >&2; exit 1; else echo "\${FAKE_GH_PROTECTED}"; fi ;;
      *"/check-runs"*) printf '%s\\n' "\${FAKE_GH_CHECK_RUNS:-}" | grep . ; exit 0 ;;
      *) echo "fake gh: unhandled api $args" >&2; exit 1 ;;
    esac ;;
  *) echo "fake gh: unhandled $args" >&2; exit 1 ;;
esac
`);
  writeFileSync(join(bin, "claude"), `#!/usr/bin/env bash\necho "9.9.9 (fake)"\n`);
  for (const f of ["gh", "claude"]) chmodSync(join(bin, f), 0o755);
  return `${bin}:${process.env.PATH}`;
}
