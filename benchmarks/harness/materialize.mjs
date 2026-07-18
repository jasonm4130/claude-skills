// Materialize one corpus arm as a committed throwaway worktree.
// Self mode inits a repo from the item's base/ tree; repo mode adds a detached
// worktree to the mined repo at baseSha. Both then apply + commit the arm patch
// with hooks and diff drivers suppressed, and fixed identity/dates so shas are
// byte-stable (they feed cache keys).
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

export const FIXED_GIT_ENV = {
  GIT_AUTHOR_NAME: "bench", GIT_AUTHOR_EMAIL: "bench@local",
  GIT_COMMITTER_NAME: "bench", GIT_COMMITTER_EMAIL: "bench@local",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", env: { ...process.env, ...FIXED_GIT_ENV },
  }).trim();
}

export function materializeArm({ itemDir, meta, arm, scratchRoot }) {
  if (!["clean", "seeded"].includes(arm)) throw new Error(`bad arm: ${arm}`);
  const scratch = mkdtempSync(join(scratchRoot, `bench-${meta.id}-${arm}-`));
  const nohooks = join(scratch, "nohooks");
  mkdirSync(nohooks);
  const noHook = ["-c", `core.hooksPath=${nohooks}`];
  let worktree, baseSha, cleanup;

  if (meta.repo === "self") {
    worktree = join(scratch, "repo");
    mkdirSync(worktree);
    cpSync(join(itemDir, "base"), worktree, { recursive: true });
    git(["init", "-q"], worktree);
    git(["add", "-A"], worktree);
    git([...noHook, "commit", "-q", "--no-verify", "-m", "base"], worktree);
    baseSha = git(["rev-parse", "HEAD"], worktree);
    cleanup = () => rmSync(scratch, { recursive: true, force: true });
  } else {
    const repo = meta.repo.replace(/^~(?=\/)/, process.env.HOME ?? "~");
    worktree = join(scratch, "repo");
    // LOCAL CLONE, not `worktree add`: a fresh clone has fresh config, so the
    // mined repo's hooks, clean/smudge filters, and textconv drivers simply do
    // not exist here (in-tree .gitattributes referencing an undefined filter is
    // pass-through). It also makes cleanup a plain directory delete — nothing
    // is ever registered in the source repo, even when a patch fails to apply.
    git(["clone", "-q", "--no-checkout", repo, worktree]);
    git(["rev-parse", "--verify", `${meta.baseSha}^{commit}`], worktree); // throws if pruned
    git([...noHook, "checkout", "-q", "--detach", meta.baseSha], worktree);
    baseSha = meta.baseSha;
    cleanup = () => rmSync(scratch, { recursive: true, force: true });
  }

  const patch = join(itemDir, `${arm}.patch`);
  git([...noHook, "apply", "--whitespace=nowarn", patch], worktree);
  git(["add", "-A"], worktree);
  git([...noHook, "commit", "-q", "--no-verify", "-m", `arm:${arm}`], worktree);
  const armSha = git(["rev-parse", "HEAD"], worktree);
  return { worktree, baseSha, armSha, cleanup };
}
