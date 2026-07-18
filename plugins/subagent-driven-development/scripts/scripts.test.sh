#!/usr/bin/env bash
# Smoke test for the SDD bash helpers.
set -euo pipefail
dir=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/repo" && cd "$tmp/repo"
git init -q && git config user.email t@t && git config user.name t
# Suppress any global hooks (e.g. a maintainer's gitleaks pre-commit hook) so
# this test's commits are hermetic regardless of the host's git config.
mkdir "$tmp/nohooks" && git config core.hooksPath "$tmp/nohooks"

# sdd-workspace creates a self-ignoring workspace
ws=$("$dir/sdd-workspace")
[ -d "$ws" ] || { echo "FAIL: workspace dir missing"; exit 1; }
[ "$(cat "$ws/.gitignore")" = "*" ] || { echo "FAIL: gitignore not self-ignoring"; exit 1; }

# task-brief extracts a single Task block
printf '# Task 1\nalpha\n\n# Task 2\nbeta\n' > plan.md
out=$("$dir/task-brief" plan.md 2 | sed 's/^wrote //; s/:.*//')
grep -q beta "$out" || { echo "FAIL: brief missing task 2 body"; exit 1; }
grep -q alpha "$out" && { echo "FAIL: brief leaked task 1"; exit 1; }

# review-package builds a 2-commit range package
echo a > f && git add f && git commit -qm a
base=$(git rev-parse HEAD)
echo b >> f && git commit -qam b
head=$(git rev-parse HEAD)
pkg=$("$dir/review-package" "$base" "$head" | sed 's/^wrote //; s/:.*//')
grep -q "## Diff" "$pkg" || { echo "FAIL: package missing diff section"; exit 1; }

# review-package must not execute textconv/external-diff drivers (host-side code
# execution risk when packaging untrusted trees — e.g. harness-seeded corpus arms).
cat > "$tmp/evil.sh" <<EOF
#!/bin/sh
touch "$tmp/pwned"
cat "\$1"
EOF
chmod +x "$tmp/evil.sh"
echo "f diff=evil" > .gitattributes
git config diff.evil.textconv "$tmp/evil.sh"
echo d >> f && git commit -qam d
head2=$(git rev-parse HEAD)
pkg2=$("$dir/review-package" "$base" "$head2" | sed 's/^wrote //; s/:.*//')
[ ! -e "$tmp/pwned" ] || { echo "FAIL: textconv driver executed during packaging"; exit 1; }
grep -q "^+d" "$pkg2" || { echo "FAIL: package missing raw diff content"; exit 1; }
git config --unset diff.evil.textconv && rm .gitattributes

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
