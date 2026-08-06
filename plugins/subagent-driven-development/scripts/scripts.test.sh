#!/usr/bin/env bash
# Smoke test for the SDD bash helpers.
set -euo pipefail
dir=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/repo" && cd "$tmp/repo"
git init -q && git config user.email t@t && git config user.name t

# sdd-workspace creates a self-ignoring workspace
ws=$("$dir/sdd-workspace")
[ -d "$ws" ] || { echo "FAIL: workspace dir missing"; exit 1; }
[ "$(cat "$ws/.gitignore")" = "*" ] || { echo "FAIL: gitignore not self-ignoring"; exit 1; }

# task-brief extracts a single Task block
printf '# Task 1\nalpha\n\n# Task 2\nbeta\n' > plan.md
out=$("$dir/task-brief" plan.md 2 | sed 's/^wrote //; s/:.*//')
grep -q beta "$out" || { echo "FAIL: brief missing task 2 body"; exit 1; }
grep -q alpha "$out" && { echo "FAIL: brief leaked task 1"; exit 1; }

# task-brief: task ids are whole tokens, and headings bound the block.
# Regression for issues #75 (non-numeric ids unextractable; the preceding task
# silently over-ran them) — a brief that quietly contains eight tasks is worse
# than one that fails.
cat > ids.md <<'PLAN'
### Task 9: nine
nine-body

### Task 9A: nine-a
nine-a-body

#### Files
sub-body

### Task 16: sixteen
sixteen-body

### Tasks 17 and 18 are RETIRED
retired-body

### Task N1: en-one
en-one-body

## Appendix
appendix-body
PLAN
brief() { "$dir/task-brief" ids.md "$1" | sed 's/^wrote //; s/:.*//'; }
b=$(brief 9)
grep -q nine-body "$b" || { echo "FAIL: task 9 body missing"; exit 1; }
grep -q nine-a-body "$b" && { echo "FAIL: task 9 swallowed task 9A"; exit 1; }
b=$(brief 9A)
grep -q nine-a-body "$b" || { echo "FAIL: task 9A body missing"; exit 1; }
grep -q sub-body "$b" || { echo "FAIL: deeper subheading dropped from task 9A"; exit 1; }
grep -q sixteen-body "$b" && { echo "FAIL: task 9A ran into task 16"; exit 1; }
b=$(brief N3 2>/dev/null) && { echo "FAIL: absent task N3 should exit non-zero"; exit 1; }
b=$(brief N1)
grep -q en-one-body "$b" || { echo "FAIL: non-numeric task N1 not extracted"; exit 1; }
grep -q appendix-body "$b" && { echo "FAIL: shallower heading did not end the task"; exit 1; }
b=$(brief 16)
grep -q sixteen-body "$b" || { echo "FAIL: task 16 body missing"; exit 1; }
grep -q retired-body "$b" && { echo "FAIL: task 16 ran into the RETIRED note"; exit 1; }
grep -q en-one-body "$b" && { echo "FAIL: task 16 ran into task N1"; exit 1; }

# review-package builds a 2-commit range package
echo a > f && git add f && git commit -qm a
base=$(git rev-parse HEAD)
echo b >> f && git commit -qam b
head=$(git rev-parse HEAD)
pkg=$("$dir/review-package" "$base" "$head" | sed 's/^wrote //; s/:.*//')
grep -q "## Diff" "$pkg" || { echo "FAIL: package missing diff section"; exit 1; }

# sdd-worktree: fresh create on the sdd/tN branch
repo=$(pwd -P)
base=$(git rev-parse HEAD)
wt=$("$dir/sdd-worktree" "$repo" "$base" 7)
[ "$wt" = "${repo}-t7" ] || { echo "FAIL: unexpected worktree path: $wt"; exit 1; }
[ -d "$wt" ] || { echo "FAIL: worktree missing"; exit 1; }
[ "$(git -C "$wt" rev-parse --abbrev-ref HEAD)" = "sdd/t7" ] || { echo "FAIL: wrong branch"; exit 1; }
[ "$(git -C "$wt" rev-parse HEAD)" = "$base" ] || { echo "FAIL: not at base"; exit 1; }

# sdd-worktree: reuse when the tip descends from base (escalation re-entry)
echo x > "$wt/x" && git -C "$wt" add x && git -C "$wt" commit -qm x
tip=$(git -C "$wt" rev-parse HEAD)
wt2=$("$dir/sdd-worktree" "$repo" "$base" 7)
[ "$(git -C "$wt2" rev-parse HEAD)" = "$tip" ] || { echo "FAIL: reuse lost commits"; exit 1; }

# sdd-worktree: stale worktree (tip does not descend from new base) is recreated
echo c >> f && git commit -qam c
nb=$(git rev-parse HEAD)
wt3=$("$dir/sdd-worktree" "$repo" "$nb" 7)
[ "$(git -C "$wt3" rev-parse HEAD)" = "$nb" ] || { echo "FAIL: stale worktree not recreated"; exit 1; }

# sdd-worktree: branch survives worktree removal -> re-added from the branch
git worktree remove --force "$wt3"
wt4=$("$dir/sdd-worktree" "$repo" "$nb" 7)
[ "$(git -C "$wt4" rev-parse HEAD)" = "$nb" ] || { echo "FAIL: branch-only re-add failed"; exit 1; }

# sdd-worktree: a registered-but-deleted (prunable) worktree is reclaimed, not fatal
wt5=$("$dir/sdd-worktree" "$repo" "$nb" 8)
rm -rf "$wt5"                     # directory gone, .git/worktrees metadata survives
wt6=$("$dir/sdd-worktree" "$repo" "$nb" 8) || { echo "FAIL: prunable worktree was fatal"; exit 1; }
[ -d "$wt6" ] || { echo "FAIL: prunable worktree not recreated"; exit 1; }
[ "$(git -C "$wt6" rev-parse HEAD)" = "$nb" ] || { echo "FAIL: recreated worktree not at base"; exit 1; }

# -C WORKDIR: artifacts land in the target repo even when invoked from another
# repo's cwd (regression: briefs used to land in whatever repo the agent's shell
# happened to be in — the wave-parallel cross-repo leak).
mkdir "$tmp/elsewhere" && git -C "$tmp/elsewhere" init -q
cd "$tmp/elsewhere" # deliberately the WRONG cwd for everything below
ws2=$("$dir/sdd-workspace" "$repo")
[ "$ws2" = "$repo/.sdd" ] || { echo "FAIL: sdd-workspace ignored WORKDIR arg: $ws2"; exit 1; }
out2=$("$dir/task-brief" -C "$repo" "$repo/plan.md" 2 | sed 's/^wrote //; s/:.*//')
case "$out2" in
  "$repo/.sdd/"*) ;;
  *) echo "FAIL: task-brief -C wrote outside workdir: $out2"; exit 1 ;;
esac
grep -q beta "$out2" || { echo "FAIL: task-brief -C brief missing task 2 body"; exit 1; }
pkg2=$("$dir/review-package" -C "$repo" "$base" "$nb" | sed 's/^wrote //; s/:.*//')
case "$pkg2" in
  "$repo/.sdd/"*) ;;
  *) echo "FAIL: review-package -C wrote outside workdir: $pkg2"; exit 1 ;;
esac
# refs $base/$nb exist only in $repo — success proves git honored -C too
grep -q "## Diff" "$pkg2" || { echo "FAIL: review-package -C package missing diff"; exit 1; }
# legacy no-arg behavior still resolves from cwd
ws3=$("$dir/sdd-workspace")
[ "$ws3" = "$(pwd -P)/.sdd" ] || { echo "FAIL: no-arg sdd-workspace changed behavior: $ws3"; exit 1; }
echo "OK"
