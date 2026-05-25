# Retro v3 Implementation Plan

> **Status:** SHIPPED 2026-05-02 as v0.3.0. Tasks 2–8 below describe a counter-file approach that was **abandoned mid-implementation** when a code reviewer reproduced 96% data loss under 50-way parallel `PostToolUse` invocations. The shipped design uses an **append-only event log** with Stop-time aggregation. Spec at `docs/superpowers/specs/2026-05-01-retro-v3-design.md` reflects the final design (see § Open Questions for the pivot rationale). The shipped scripts are `posttooluse-append-event.sh` (not `posttooluse-update-counter.sh`) plus `stop-suggest-retro.sh` and `precompact-suggest-retro.sh`. Tests live in `tests/test_event_log_*.sh`, `tests/test_stop_*.sh`, `tests/test_precompact_*.sh`, and `tests/test_session_id_from_stdin.sh` (regression for the manual-e2e finding that PostToolUse passes session_id in stdin, not env var).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `session-retro` plugin to drop the claude-mem dependency, add deterministic hook-based triggering (PostToolUse counter + Stop threshold + PreCompact safety net), and replace fixed-slot interview with adaptive questions driven by `git diff`. Same plugin name, force-push upgrade, same memory format.

**Architecture:** Pure bash + git + native memory. Three new hook scripts maintain a per-session counter (`PostToolUse`), evaluate thresholds (`Stop`), and always nudge before compaction (`PreCompact`). The `/retro` skill itself reads the counter + git state, runs an adaptive interview, writes memory entries.

**Tech Stack:** bash 3.2+ (macOS default), `jq` (already required by claude-mem ecosystem, document as new requirement), git, Claude Code ≥ 2.1.110. Tests are plain bash scripts with `set -euo pipefail` — no test framework dependency.

**Reference spec:** `docs/superpowers/specs/2026-05-01-retro-v3-design.md`

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `scripts/mark-session-start.sh` | Keep | SessionStart hook — write timestamp marker (existing, working) |
| `scripts/posttooluse-update-counter.sh` | Create | PostToolUse hook — incrementally maintain `score-{session_id}.json` |
| `scripts/stop-suggest-retro.sh` | Create | Stop hook — read counter, evaluate thresholds, emit suggestion if retro-worthy |
| `scripts/precompact-suggest-retro.sh` | Create | PreCompact hook — always emit suggestion (no threshold) |
| `hooks/hooks.json` | Rewrite | Wire all 4 hooks (was just SessionStart) |
| `skills/retro/SKILL.md` | Rewrite | Diff-driven interview (no claude-mem queries) |
| `README.md` | Update | Drop claude-mem from requirements, document upgrade notes |
| `tests/run-all.sh` | Create | Test runner — loops tests/, prints PASS/FAIL summary |
| `tests/test_counter_*.sh` | Create | 4 tests for counter behaviour |
| `tests/test_threshold_*.sh` | Create | 4 tests for Stop hook scoring |
| `tests/test_retro_fired_suppresses.sh` | Create | Suppression flag respected |
| `tests/test_precompact_always_fires.sh` | Create | PreCompact ignores retro-fired flag |
| `.github/workflows/test.yml` | Create or update | CI runs `tests/run-all.sh` |

---

## Task 1: Test runner + first failing test

**Files:**
- Create: `tests/run-all.sh`
- Create: `tests/test_counter_init.sh`

- [ ] **Step 1: Write the test runner**

```bash
mkdir -p tests
cat > tests/run-all.sh <<'EOF'
#!/usr/bin/env bash
# Run all tests in tests/, print PASS/FAIL per file, exit non-zero on any failure.
set -uo pipefail
TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0
FAILED=()
for t in "$TESTS_DIR"/test_*.sh; do
    [ -f "$t" ] || continue
    name=$(basename "$t" .sh)
    if bash "$t" >/dev/null 2>&1; then
        echo "PASS  $name"
        PASS=$((PASS + 1))
    else
        echo "FAIL  $name"
        FAILED+=("$name")
        FAIL=$((FAIL + 1))
    fi
done
echo ""
echo "Summary: $PASS passed, $FAIL failed"
if [ $FAIL -gt 0 ]; then
    echo "Failed tests (re-run individually to see output):"
    for f in "${FAILED[@]}"; do echo "  bash tests/${f}.sh"; done
    exit 1
fi
EOF
chmod +x tests/run-all.sh
```

- [ ] **Step 2: Write the first failing test (counter init)**

```bash
cat > tests/test_counter_init.sh <<'EOF'
#!/usr/bin/env bash
# First PostToolUse call creates the counter file with edits=1, the file_path tracked.
set -euo pipefail
WORKDIR=$(mktemp -d)
trap "rm -rf $WORKDIR" EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
export CLAUDE_SESSION_ID="test-counter-init"

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/posttooluse-update-counter.sh"

# Simulate a PostToolUse hook payload for an Edit
echo '{"tool_name":"Edit","tool_input":{"file_path":"/repo/src/foo.ts"}}' | bash "$SCRIPT"

COUNTER="$WORKDIR/score-test-counter-init.json"
[ -f "$COUNTER" ] || { echo "FAIL: counter file $COUNTER not created"; exit 1; }

EDITS=$(jq '.edits' < "$COUNTER")
[ "$EDITS" = "1" ] || { echo "FAIL: edits should be 1, got $EDITS"; exit 1; }

FILES=$(jq -r '.files_touched | length' < "$COUNTER")
[ "$FILES" = "1" ] || { echo "FAIL: files_touched len should be 1, got $FILES"; exit 1; }

FIRST=$(jq -r '.files_touched[0]' < "$COUNTER")
[ "$FIRST" = "/repo/src/foo.ts" ] || { echo "FAIL: file should be /repo/src/foo.ts, got $FIRST"; exit 1; }

echo "PASS"
EOF
chmod +x tests/test_counter_init.sh
```

- [ ] **Step 3: Run test runner to verify it fails (script doesn't exist yet)**

Run: `bash tests/run-all.sh`
Expected: `FAIL  test_counter_init`, exit code 1.

- [ ] **Step 4: Commit**

```bash
git add tests/
git commit -m "test: add test runner + first failing test for counter init"
```

---

## Task 2: PostToolUse counter — initialisation case

**Files:**
- Create: `scripts/posttooluse-update-counter.sh`

- [ ] **Step 1: Write the script**

```bash
cat > scripts/posttooluse-update-counter.sh <<'EOF'
#!/usr/bin/env bash
# PostToolUse hook: incrementally update score-{session_id}.json with tool counts,
# files touched, and timestamps. Atomic via tmp-then-rename. Silent on success.
set -euo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
[ -z "$TOOL_NAME" ] && exit 0

PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-/tmp/session-retro-data}"
SESSION_ID="${CLAUDE_SESSION_ID:-unknown}"
mkdir -p "$PLUGIN_DATA"
COUNTER="$PLUGIN_DATA/score-${SESSION_ID}.json"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Load existing or create fresh
if [ -f "$COUNTER" ]; then
    SCORE=$(cat "$COUNTER")
else
    SCORE='{"edits":0,"writes":0,"bash_calls":0,"files_touched":[],"first_tool_ts":null,"last_tool_ts":null,"ran_tests":false,"ran_commit":false}'
fi

# Always update timestamps
SCORE=$(echo "$SCORE" | jq --arg now "$NOW" '
    .last_tool_ts = $now
    | if .first_tool_ts == null then .first_tool_ts = $now else . end
')

case "$TOOL_NAME" in
    Edit)
        FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
        SCORE=$(echo "$SCORE" | jq --arg fp "$FILE_PATH" '
            .edits += 1
            | if ($fp != "" and (.files_touched | index($fp) | not)) then .files_touched += [$fp] else . end
        ')
        ;;
    Write)
        FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
        SCORE=$(echo "$SCORE" | jq --arg fp "$FILE_PATH" '
            .writes += 1
            | if ($fp != "" and (.files_touched | index($fp) | not)) then .files_touched += [$fp] else . end
        ')
        ;;
    Bash)
        CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
        SCORE=$(echo "$SCORE" | jq '.bash_calls += 1')
        case "$CMD" in
            *pytest*|*"jest "*|*"go test"*|*"cargo test"*|*"npm test"*|*"npm run test"*|*"bun test"*|*"yarn test"*)
                SCORE=$(echo "$SCORE" | jq '.ran_tests = true')
                ;;
        esac
        case "$CMD" in
            *"git commit"*)
                SCORE=$(echo "$SCORE" | jq '.ran_commit = true')
                ;;
        esac
        ;;
esac

# Atomic write
TMP=$(mktemp "${COUNTER}.XXXXXX")
echo "$SCORE" > "$TMP"
mv "$TMP" "$COUNTER"
exit 0
EOF
chmod +x scripts/posttooluse-update-counter.sh
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bash tests/run-all.sh`
Expected: `PASS  test_counter_init`, summary `1 passed, 0 failed`, exit 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/posttooluse-update-counter.sh
git commit -m "feat: PostToolUse counter — initialise on first Edit"
```

---

## Task 3: Counter — increment + dedupe files

**Files:**
- Create: `tests/test_counter_increment.sh`

- [ ] **Step 1: Write failing test**

```bash
cat > tests/test_counter_increment.sh <<'EOF'
#!/usr/bin/env bash
# Subsequent calls increment counts and dedupe files_touched.
set -euo pipefail
WORKDIR=$(mktemp -d); trap "rm -rf $WORKDIR" EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
export CLAUDE_SESSION_ID="test-incr"
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/posttooluse-update-counter.sh"

# Three Edits, two on same file — files_touched should dedupe to 2 entries
echo '{"tool_name":"Edit","tool_input":{"file_path":"/a.ts"}}' | bash "$SCRIPT"
echo '{"tool_name":"Edit","tool_input":{"file_path":"/b.ts"}}' | bash "$SCRIPT"
echo '{"tool_name":"Edit","tool_input":{"file_path":"/a.ts"}}' | bash "$SCRIPT"
# One Write on a third file
echo '{"tool_name":"Write","tool_input":{"file_path":"/c.ts"}}' | bash "$SCRIPT"

COUNTER="$WORKDIR/score-test-incr.json"
EDITS=$(jq '.edits' < "$COUNTER")
WRITES=$(jq '.writes' < "$COUNTER")
FILES=$(jq -r '.files_touched | length' < "$COUNTER")
[ "$EDITS" = "3" ] || { echo "FAIL: edits should be 3, got $EDITS"; exit 1; }
[ "$WRITES" = "1" ] || { echo "FAIL: writes should be 1, got $WRITES"; exit 1; }
[ "$FILES" = "3" ] || { echo "FAIL: files_touched dedup should be 3, got $FILES"; exit 1; }
echo "PASS"
EOF
chmod +x tests/test_counter_increment.sh
```

- [ ] **Step 2: Run — should already pass since Task 2 implementation handles increments**

Run: `bash tests/run-all.sh`
Expected: both tests PASS.

(If FAIL: review jq `index($fp) | not` logic in the script — the dedupe condition.)

- [ ] **Step 3: Commit**

```bash
git add tests/test_counter_increment.sh
git commit -m "test: counter increments and dedupes files_touched"
```

---

## Task 4: Counter — test/commit detection

**Files:**
- Create: `tests/test_counter_test_detection.sh`
- Create: `tests/test_counter_commit_detection.sh`

- [ ] **Step 1: Write test for `ran_tests`**

```bash
cat > tests/test_counter_test_detection.sh <<'EOF'
#!/usr/bin/env bash
# Bash calls matching pytest/jest/etc set ran_tests=true.
set -euo pipefail
WORKDIR=$(mktemp -d); trap "rm -rf $WORKDIR" EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
export CLAUDE_SESSION_ID="test-tests"
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/posttooluse-update-counter.sh"

echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | bash "$SCRIPT"
RAN=$(jq -r '.ran_tests' < "$WORKDIR/score-test-tests.json")
[ "$RAN" = "false" ] || { echo "FAIL: ran_tests should be false after ls, got $RAN"; exit 1; }

echo '{"tool_name":"Bash","tool_input":{"command":"pytest tests/ -v"}}' | bash "$SCRIPT"
RAN=$(jq -r '.ran_tests' < "$WORKDIR/score-test-tests.json")
[ "$RAN" = "true" ] || { echo "FAIL: ran_tests should be true after pytest, got $RAN"; exit 1; }

# Also check bash_calls incremented
CALLS=$(jq '.bash_calls' < "$WORKDIR/score-test-tests.json")
[ "$CALLS" = "2" ] || { echo "FAIL: bash_calls should be 2, got $CALLS"; exit 1; }

echo "PASS"
EOF
chmod +x tests/test_counter_test_detection.sh
```

- [ ] **Step 2: Write test for `ran_commit`**

```bash
cat > tests/test_counter_commit_detection.sh <<'EOF'
#!/usr/bin/env bash
# Bash calls matching `git commit` set ran_commit=true.
set -euo pipefail
WORKDIR=$(mktemp -d); trap "rm -rf $WORKDIR" EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
export CLAUDE_SESSION_ID="test-commit"
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/posttooluse-update-counter.sh"

echo '{"tool_name":"Bash","tool_input":{"command":"git status"}}' | bash "$SCRIPT"
RAN=$(jq -r '.ran_commit' < "$WORKDIR/score-test-commit.json")
[ "$RAN" = "false" ] || { echo "FAIL: ran_commit should be false after git status, got $RAN"; exit 1; }

echo '{"tool_name":"Bash","tool_input":{"command":"git commit -m '"'"'fix: thing'"'"'"}}' | bash "$SCRIPT"
RAN=$(jq -r '.ran_commit' < "$WORKDIR/score-test-commit.json")
[ "$RAN" = "true" ] || { echo "FAIL: ran_commit should be true after git commit, got $RAN"; exit 1; }

echo "PASS"
EOF
chmod +x tests/test_counter_commit_detection.sh
```

- [ ] **Step 3: Run all tests**

Run: `bash tests/run-all.sh`
Expected: 4 PASS, 0 FAIL.

- [ ] **Step 4: Commit**

```bash
git add tests/test_counter_test_detection.sh tests/test_counter_commit_detection.sh
git commit -m "test: counter detects pytest/jest/git commit in Bash commands"
```

---

## Task 5: Stop hook — no trigger when under threshold

**Files:**
- Create: `tests/test_threshold_no_trigger.sh`
- Create: `scripts/stop-suggest-retro.sh`

- [ ] **Step 1: Write failing test**

```bash
cat > tests/test_threshold_no_trigger.sh <<'EOF'
#!/usr/bin/env bash
# When counter is below all thresholds, Stop hook emits nothing on stdout.
set -euo pipefail
WORKDIR=$(mktemp -d); trap "rm -rf $WORKDIR" EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
export CLAUDE_SESSION_ID="test-quiet"
STOP_SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/stop-suggest-retro.sh"

# 1 edit, 1 file, no commits, no tests, no minutes elapsed — under threshold
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
cat > "$WORKDIR/score-test-quiet.json" <<JSON
{"edits":1,"writes":0,"bash_calls":2,"files_touched":["/a.ts"],"first_tool_ts":"$NOW","last_tool_ts":"$NOW","ran_tests":false,"ran_commit":false}
JSON

OUT=$(echo '{}' | bash "$STOP_SCRIPT")
[ -z "$OUT" ] || { echo "FAIL: expected empty stdout, got: $OUT"; exit 1; }

echo "PASS"
EOF
chmod +x tests/test_threshold_no_trigger.sh
```

- [ ] **Step 2: Verify test fails (script doesn't exist)**

Run: `bash tests/run-all.sh`
Expected: `FAIL  test_threshold_no_trigger` (other 4 still PASS).

- [ ] **Step 3: Implement stop-suggest-retro.sh**

```bash
cat > scripts/stop-suggest-retro.sh <<'EOF'
#!/usr/bin/env bash
# Stop hook: read counter, evaluate thresholds, emit additionalContext suggestion
# if retro-worthy AND no retro fired this session yet. Silent otherwise.
set -euo pipefail

# Hook receives JSON on stdin but we don't currently need it. Drain to avoid SIGPIPE.
cat >/dev/null

PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-/tmp/session-retro-data}"
SESSION_ID="${CLAUDE_SESSION_ID:-unknown}"
COUNTER="$PLUGIN_DATA/score-${SESSION_ID}.json"
FIRED_FLAG="$PLUGIN_DATA/retro-fired-${SESSION_ID}.flag"

# No counter yet → no work to suggest a retro on
[ -f "$COUNTER" ] || exit 0
# Already retro'd this session → suppress
[ -f "$FIRED_FLAG" ] && exit 0

# Read counter values
EDITS=$(jq -r '.edits // 0' < "$COUNTER")
WRITES=$(jq -r '.writes // 0' < "$COUNTER")
BASH_CALLS=$(jq -r '.bash_calls // 0' < "$COUNTER")
FILES_COUNT=$(jq -r '.files_touched | length' < "$COUNTER")
RAN_TESTS=$(jq -r '.ran_tests // false' < "$COUNTER")
RAN_COMMIT=$(jq -r '.ran_commit // false' < "$COUNTER")
FIRST_TS=$(jq -r '.first_tool_ts // empty' < "$COUNTER")
LAST_TS=$(jq -r '.last_tool_ts // empty' < "$COUNTER")

# Compute duration in seconds (BSD date on macOS, GNU date on linux)
DURATION_SEC=0
if [ -n "$FIRST_TS" ] && [ -n "$LAST_TS" ]; then
    if date -u -d "$LAST_TS" +%s >/dev/null 2>&1; then
        # GNU date
        FIRST_S=$(date -u -d "$FIRST_TS" +%s)
        LAST_S=$(date -u -d "$LAST_TS" +%s)
    else
        # BSD date (macOS)
        FIRST_S=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$FIRST_TS" +%s 2>/dev/null || echo 0)
        LAST_S=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$LAST_TS" +%s 2>/dev/null || echo 0)
    fi
    DURATION_SEC=$((LAST_S - FIRST_S))
fi
DURATION_MIN=$((DURATION_SEC / 60))
TOTAL_TOOLS=$((EDITS + WRITES + BASH_CALLS))
EDIT_WRITE=$((EDITS + WRITES))

# Threshold check — any one triggers
TRIGGER=false
TRIGGER_REASON=""
if [ "$EDIT_WRITE" -ge 3 ] && [ "$FILES_COUNT" -ge 2 ]; then
    TRIGGER=true; TRIGGER_REASON="${EDIT_WRITE} edits across ${FILES_COUNT} files"
elif [ "$DURATION_SEC" -ge 1200 ]; then
    TRIGGER=true; TRIGGER_REASON="${DURATION_MIN} minutes of work"
elif [ "$RAN_COMMIT" = "true" ]; then
    TRIGGER=true; TRIGGER_REASON="committed during session"
elif [ "$RAN_TESTS" = "true" ] && [ "$EDIT_WRITE" -ge 2 ]; then
    TRIGGER=true; TRIGGER_REASON="ran tests + ${EDIT_WRITE} edits"
elif [ "$TOTAL_TOOLS" -ge 30 ]; then
    TRIGGER=true; TRIGGER_REASON="${TOTAL_TOOLS} tool calls"
fi

[ "$TRIGGER" = "false" ] && exit 0

# Emit hookSpecificOutput JSON
MSG="[session-retro] This session: ${TRIGGER_REASON}. Suggest running /retro to capture decisions/learnings before /clear."
jq -n --arg msg "$MSG" '{
    hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: $msg
    }
}'
exit 0
EOF
chmod +x scripts/stop-suggest-retro.sh
```

- [ ] **Step 4: Run tests**

Run: `bash tests/run-all.sh`
Expected: 5 PASS (test_threshold_no_trigger now passing).

- [ ] **Step 5: Commit**

```bash
git add tests/test_threshold_no_trigger.sh scripts/stop-suggest-retro.sh
git commit -m "feat: Stop hook — silent under threshold"
```

---

## Task 6: Stop hook — edits + files threshold triggers

**Files:**
- Create: `tests/test_threshold_edits.sh`

- [ ] **Step 1: Write test**

```bash
cat > tests/test_threshold_edits.sh <<'EOF'
#!/usr/bin/env bash
# 3 edits across 2 files triggers a suggestion containing the count.
set -euo pipefail
WORKDIR=$(mktemp -d); trap "rm -rf $WORKDIR" EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
export CLAUDE_SESSION_ID="test-edits"
STOP_SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/stop-suggest-retro.sh"

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
cat > "$WORKDIR/score-test-edits.json" <<JSON
{"edits":3,"writes":0,"bash_calls":5,"files_touched":["/a.ts","/b.ts"],"first_tool_ts":"$NOW","last_tool_ts":"$NOW","ran_tests":false,"ran_commit":false}
JSON

OUT=$(echo '{}' | bash "$STOP_SCRIPT")
[ -n "$OUT" ] || { echo "FAIL: expected stdout, got empty"; exit 1; }
EVENT=$(echo "$OUT" | jq -r '.hookSpecificOutput.hookEventName')
[ "$EVENT" = "Stop" ] || { echo "FAIL: hookEventName should be Stop, got $EVENT"; exit 1; }
MSG=$(echo "$OUT" | jq -r '.hookSpecificOutput.additionalContext')
echo "$MSG" | grep -q "3 edits across 2 files" || { echo "FAIL: msg missing 3 edits / 2 files: $MSG"; exit 1; }
echo "$MSG" | grep -q "/retro" || { echo "FAIL: msg missing /retro: $MSG"; exit 1; }
echo "PASS"
EOF
chmod +x tests/test_threshold_edits.sh
```

- [ ] **Step 2: Run — should already pass with Task 5 implementation**

Run: `bash tests/run-all.sh`
Expected: 6 PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/test_threshold_edits.sh
git commit -m "test: Stop hook triggers on 3 edits across 2 files"
```

---

## Task 7: Stop hook — duration threshold

**Files:**
- Create: `tests/test_threshold_duration.sh`

- [ ] **Step 1: Write test**

```bash
cat > tests/test_threshold_duration.sh <<'EOF'
#!/usr/bin/env bash
# 25 minute session triggers regardless of edit count.
set -euo pipefail
WORKDIR=$(mktemp -d); trap "rm -rf $WORKDIR" EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
export CLAUDE_SESSION_ID="test-dur"
STOP_SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/stop-suggest-retro.sh"

# 1 edit, 1 file (under edit threshold), but 25 minutes elapsed
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
# 25 min ago — works on both macOS BSD date and GNU date
if date -u -v-25M +%s >/dev/null 2>&1; then
    PAST=$(date -u -v-25M +"%Y-%m-%dT%H:%M:%SZ")  # BSD
else
    PAST=$(date -u -d '25 minutes ago' +"%Y-%m-%dT%H:%M:%SZ")  # GNU
fi
cat > "$WORKDIR/score-test-dur.json" <<JSON
{"edits":1,"writes":0,"bash_calls":2,"files_touched":["/a.ts"],"first_tool_ts":"$PAST","last_tool_ts":"$NOW","ran_tests":false,"ran_commit":false}
JSON

OUT=$(echo '{}' | bash "$STOP_SCRIPT")
[ -n "$OUT" ] || { echo "FAIL: expected stdout for 25-min session, got empty"; exit 1; }
MSG=$(echo "$OUT" | jq -r '.hookSpecificOutput.additionalContext')
echo "$MSG" | grep -q "minutes of work" || { echo "FAIL: msg missing duration phrase: $MSG"; exit 1; }
echo "PASS"
EOF
chmod +x tests/test_threshold_duration.sh
```

- [ ] **Step 2: Run tests**

Run: `bash tests/run-all.sh`
Expected: 7 PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/test_threshold_duration.sh
git commit -m "test: Stop hook triggers on 20+ min sessions"
```

---

## Task 8: Stop hook — commit + retro-fired suppression

**Files:**
- Create: `tests/test_threshold_commit.sh`
- Create: `tests/test_retro_fired_suppresses.sh`

- [ ] **Step 1: Write commit-trigger test**

```bash
cat > tests/test_threshold_commit.sh <<'EOF'
#!/usr/bin/env bash
# A git commit during the session triggers, even with 0 edits.
set -euo pipefail
WORKDIR=$(mktemp -d); trap "rm -rf $WORKDIR" EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
export CLAUDE_SESSION_ID="test-commit-trigger"
STOP_SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/stop-suggest-retro.sh"

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
cat > "$WORKDIR/score-test-commit-trigger.json" <<JSON
{"edits":0,"writes":0,"bash_calls":3,"files_touched":[],"first_tool_ts":"$NOW","last_tool_ts":"$NOW","ran_tests":false,"ran_commit":true}
JSON

OUT=$(echo '{}' | bash "$STOP_SCRIPT")
[ -n "$OUT" ] || { echo "FAIL: expected stdout for commit, got empty"; exit 1; }
echo "$OUT" | jq -r '.hookSpecificOutput.additionalContext' | grep -q "committed" || { echo "FAIL: msg missing 'committed': $OUT"; exit 1; }
echo "PASS"
EOF
chmod +x tests/test_threshold_commit.sh
```

- [ ] **Step 2: Write retro-fired suppression test**

```bash
cat > tests/test_retro_fired_suppresses.sh <<'EOF'
#!/usr/bin/env bash
# When retro-fired flag is present, Stop hook stays silent regardless of counter.
set -euo pipefail
WORKDIR=$(mktemp -d); trap "rm -rf $WORKDIR" EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
export CLAUDE_SESSION_ID="test-suppressed"
STOP_SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/stop-suggest-retro.sh"

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
cat > "$WORKDIR/score-test-suppressed.json" <<JSON
{"edits":10,"writes":5,"bash_calls":20,"files_touched":["/a.ts","/b.ts","/c.ts"],"first_tool_ts":"$NOW","last_tool_ts":"$NOW","ran_tests":true,"ran_commit":true}
JSON
# Retro already fired
touch "$WORKDIR/retro-fired-test-suppressed.flag"

OUT=$(echo '{}' | bash "$STOP_SCRIPT")
[ -z "$OUT" ] || { echo "FAIL: expected empty stdout when retro-fired flag present, got: $OUT"; exit 1; }
echo "PASS"
EOF
chmod +x tests/test_retro_fired_suppresses.sh
```

- [ ] **Step 3: Run tests**

Run: `bash tests/run-all.sh`
Expected: 9 PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/test_threshold_commit.sh tests/test_retro_fired_suppresses.sh
git commit -m "test: Stop hook commit trigger + retro-fired flag suppression"
```

---

## Task 9: PreCompact hook

**Files:**
- Create: `tests/test_precompact_always_fires.sh`
- Create: `scripts/precompact-suggest-retro.sh`

- [ ] **Step 1: Write failing test**

```bash
cat > tests/test_precompact_always_fires.sh <<'EOF'
#!/usr/bin/env bash
# PreCompact emits suggestion regardless of state — even if retro-fired flag exists,
# even if there's no counter. PreCompact is a hard "context will be destroyed" event.
set -euo pipefail
WORKDIR=$(mktemp -d); trap "rm -rf $WORKDIR" EXIT
export CLAUDE_PLUGIN_DATA="$WORKDIR"
export CLAUDE_SESSION_ID="test-precompact"
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/precompact-suggest-retro.sh"

# Even with retro-fired flag set, PreCompact should still emit
touch "$WORKDIR/retro-fired-test-precompact.flag"

OUT=$(echo '{}' | bash "$SCRIPT")
[ -n "$OUT" ] || { echo "FAIL: expected non-empty stdout, got empty"; exit 1; }
EVENT=$(echo "$OUT" | jq -r '.hookSpecificOutput.hookEventName')
[ "$EVENT" = "PreCompact" ] || { echo "FAIL: hookEventName should be PreCompact, got $EVENT"; exit 1; }
echo "$OUT" | jq -r '.hookSpecificOutput.additionalContext' | grep -q "compact" || { echo "FAIL: msg missing 'compact': $OUT"; exit 1; }
echo "$OUT" | jq -r '.hookSpecificOutput.additionalContext' | grep -q "/retro" || { echo "FAIL: msg missing '/retro': $OUT"; exit 1; }
echo "PASS"
EOF
chmod +x tests/test_precompact_always_fires.sh
```

- [ ] **Step 2: Verify it fails**

Run: `bash tests/run-all.sh`
Expected: 9 PASS, 1 FAIL.

- [ ] **Step 3: Implement script**

```bash
cat > scripts/precompact-suggest-retro.sh <<'EOF'
#!/usr/bin/env bash
# PreCompact hook: always nudge user to run /retro before context is compacted.
# No threshold, no flag check — context loss is a hard event regardless of prior state.
set -euo pipefail

# Drain stdin
cat >/dev/null

MSG="[session-retro] Context is about to compact. If this session had substantial work, run /retro now to capture decisions before details are lost."
jq -n --arg msg "$MSG" '{
    hookSpecificOutput: {
        hookEventName: "PreCompact",
        additionalContext: $msg
    }
}'
exit 0
EOF
chmod +x scripts/precompact-suggest-retro.sh
```

- [ ] **Step 4: Run tests**

Run: `bash tests/run-all.sh`
Expected: 10 PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/test_precompact_always_fires.sh scripts/precompact-suggest-retro.sh
git commit -m "feat: PreCompact hook — always suggest retro before context loss"
```

---

## Task 10: Wire all 4 hooks in hooks.json

**Files:**
- Modify: `hooks/hooks.json`

- [ ] **Step 1: Rewrite hooks.json**

```bash
cat > hooks/hooks.json <<'EOF'
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/mark-session-start.sh",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/posttooluse-update-counter.sh",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/stop-suggest-retro.sh",
            "timeout": 5
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/precompact-suggest-retro.sh",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
EOF
```

- [ ] **Step 2: Validate JSON is well-formed**

Run: `jq . hooks/hooks.json`
Expected: pretty-printed JSON, exit 0.

- [ ] **Step 3: Commit**

```bash
git add hooks/hooks.json
git commit -m "feat: wire PostToolUse + Stop + PreCompact hooks"
```

---

## Task 11: Rewrite SKILL.md — diff-driven interview

**Files:**
- Modify: `skills/retro/SKILL.md`

- [ ] **Step 1: Replace the entire SKILL.md**

```bash
cat > skills/retro/SKILL.md <<'EOF'
---
description: >
  Run an interactive session retrospective. Reads the session counter (maintained
  by PostToolUse hook) and uses git diff/status/log as memory primer, then walks
  through specific moments via adaptive questions, and writes structured native
  memory entries. Suggest this when a Stop or PreCompact hook has injected a
  retro suggestion, or when the user explicitly asks for one.
  Triggers: "retro", "session summary", "what did we learn", "lessons learned",
  "session retrospective".
---

# Session Retrospective

You are running an interactive session retrospective. Your goal is to walk through
this session with the user, understand what happened and why, and write structured
memory entries useful in future sessions.

The retro reads from two cheap signals: a small per-session counter file (tool
counts, files touched, timestamps) maintained by a PostToolUse hook, and live
git state (`git status`, `git diff --stat`, `git log` since session start). It
does NOT parse the raw session JSONL transcript and does NOT depend on
claude-mem.

## Step 1: Quick-skip gate

Read the counter to decide whether a full retro is worth doing:

```bash
SCORE_FILE="${CLAUDE_PLUGIN_DATA}/score-${CLAUDE_SESSION_ID}.json"
if [ ! -f "$SCORE_FILE" ] || [ "$(jq '.edits + .writes' < "$SCORE_FILE")" -eq 0 ]; then
    echo "This session had no edits/writes. Anything specific you want to capture?"
    # If user says no → exit cleanly with a "clean session, nothing to capture" message.
    # If user says yes → skip directly to Step 4 (open catch-all only).
fi
```

## Step 2: Gather signals

In one bash block, collect the session signals:

```bash
SCORE_FILE="${CLAUDE_PLUGIN_DATA}/score-${CLAUDE_SESSION_ID}.json"
START_FILE="${CLAUDE_PLUGIN_DATA}/session-start-${CLAUDE_SESSION_ID}.txt"
SESSION_START=$(cat "$START_FILE" 2>/dev/null || echo "4 hours ago")

echo "=== counter ==="
jq '.' "$SCORE_FILE" 2>/dev/null
echo "=== git status ==="
git status --short 2>/dev/null || echo "(not a git repo)"
echo "=== git diff stat ==="
git diff --stat 2>/dev/null
echo "=== git log since session start ==="
git log --since="$SESSION_START" --oneline 2>/dev/null
```

If `git status` errors with "not a git repository", skip the diff steps and
proceed with interview-only mode. The counter alone is enough signal.

Surface the recap to the user in plain English. Example:

> "Quick recap: this session you edited `auth.ts` 4 times, added `auth.test.ts`,
> ran tests twice, and made 1 commit. Uncommitted changes in `config.yaml`.
> Want me to walk through?"

## Step 3: Adaptive questions

Pick 3-5 specific moments from the diff/log. Ask **one question at a time**.
Wait for the response before the next question. Examples of good questions:

- "You edited `src/auth.ts` 4 times — what was the iteration about?"
- "You added `tests/auth.test.ts` — what were you trying to verify?"
- "You reverted part of `config.yaml` — what changed your mind?"
- "Your commit `fix: token bug` — what was the actual root cause?"
- "Tests ran 2 times before passing — what was breaking?"

Rules for the question set:
- Each question MUST reference something visible in the diff, log, or counter
- Do NOT ask generic questions ("what did you learn?", "any decisions?") — the
  diff IS the question seed
- Do NOT batch questions
- Do NOT ask about routine successful operations
- Skip a question if the user says "nothing notable" — move on to the next

## Step 4: Open catch-all

After the diff-driven questions:

> "Anything else worth remembering that didn't show up in the diff? Surprises,
> gotchas, things you tried that failed, decisions about approach, corrections
> to my behaviour?"

## Step 5: Write findings

Write to native memory files. Use the existing 3-type taxonomy (these have to
match the format the user's MEMORY.md system already uses):

**Corrections to Claude's behaviour → `feedback`:**
```markdown
---
name: {short name}
description: {one-line description used by future sessions to decide relevance}
type: feedback
---

{The rule or preference}

**Why:** {The reason the user gave}

**How to apply:** {When/where this applies}
```
Filename: `retro_feedback_{topic}.md`

**Decisions, project context → `project`:**
```markdown
---
name: {short name}
description: {one-line description}
type: project
---

{The decision or fact}

**Why:** {The motivation}

**How to apply:** {How this shapes future suggestions}
```
Filename: `retro_project_{topic}.md`

**External resources → `reference`:**
```markdown
---
name: {short name}
description: {one-line description}
type: reference
---

{The resource and what it's useful for}
```
Filename: `retro_reference_{topic}.md`

Write each file via the Write tool, then update the project's MEMORY.md index
(append a one-liner under ~150 chars: `- [Title](file.md) — one-line hook`).
Show the user each entry for confirmation before writing.

## Step 6: Cleanup

```bash
touch "${CLAUDE_PLUGIN_DATA}/retro-fired-${CLAUDE_SESSION_ID}.flag"
```

## Guidelines

- Ask ONE question at a time. Wait for the response.
- Focus on the "why" — decisions, rationale, trade-offs. Not the "what."
- Keep memory entries concise. One entry per distinct learning.
- Only write memories for things genuinely useful in future sessions.
- If the session was routine with no notable decisions, say so. A short
  "clean session, nothing to capture" is fine.
- Never fabricate learnings. If the diff/log doesn't show clear decision
  points, ask the user what they found valuable rather than inventing
  insights.
- The diff is the question seed. Avoid generic prompts.
EOF
```

- [ ] **Step 2: Verify the file is valid markdown with frontmatter**

Run: `head -10 skills/retro/SKILL.md`
Expected: shows the YAML frontmatter (`---` ... `---`) and the first line of the heading.

- [ ] **Step 3: Commit**

```bash
git add skills/retro/SKILL.md
git commit -m "refactor: rewrite SKILL.md for diff-driven interview, drop claude-mem queries"
```

---

## Task 12: Update README — drop claude-mem requirement

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace README content**

```bash
cat > README.md <<'EOF'
# session-retro

Claude Code plugin for interactive session retrospectives. Captures decisions, learnings, and gotchas to native memory after substantial sessions — so they're available in future sessions.

## Why

At the end of a productive Claude Code session, you've made decisions, hit errors, changed approach, discovered patterns. None of it gets captured by default. session-retro fixes that with two complementary mechanisms:

1. **Deterministic suggestions.** A `Stop` hook scores your session (edits, files touched, duration, commits) and suggests `/retro` when work crosses sensible thresholds. A `PreCompact` hook always nudges before context is compacted away.
2. **Diff-driven interview.** When you run `/retro`, the skill reads `git status`, `git diff --stat`, and `git log` since session start, then asks specific questions about the actual changes ("you edited `auth.ts` 4 times — what was the iteration about?"). No generic "what did you learn" prompts.

## What it does

- **Counts your work** — a tiny `PostToolUse` hook maintains a per-session counter (edits, files touched, tools called, commits, test runs)
- **Suggests retros** — `Stop` hook injects a one-liner when thresholds are met; `PreCompact` always suggests
- **Walks you through** — `/retro` uses the counter + git diff to ask specific, non-generic questions, one at a time
- **Writes native memory** — entries land in your project memory dir using `feedback` / `project` / `reference` types with `**Why:**` and `**How to apply:**` slots

## How it works

Four hooks + one skill, all bash:

| Component | What it does |
|---|---|
| `SessionStart` | `mark-session-start.sh` writes the session start timestamp |
| `PostToolUse` (Edit\|Write\|Bash) | `posttooluse-update-counter.sh` updates the per-session score file |
| `Stop` | `stop-suggest-retro.sh` reads the counter and emits a suggestion if retro-worthy |
| `PreCompact` | `precompact-suggest-retro.sh` always emits a suggestion before compaction |
| `/session-retro:retro` | The skill — reads counter + git, walks you through, writes memory |

No external services. No SQLite. No MCP server. No Python. Just bash, jq, git.

## Install

```
/plugin marketplace add jasonm4130/session-retro
/plugin install session-retro@jasonm4130-session-retro
/reload-plugins
```

On first load, Claude Code will prompt you to approve the hooks. This is normal — plugins that execute code require explicit user trust.

## Requirements

- Claude Code ≥ 2.1.110
- bash
- jq
- git (optional — interview-only mode if not in a git repo)

## Usage

### When the hook nudges you

After substantial work, you'll see a Claude-authored line like:
> "[session-retro] This session: 7 edits across 3 files. Suggest running /retro to capture decisions/learnings before /clear."

Run `/retro` when you see it.

### Manual invocation

```
/session-retro:retro
```

Natural-language triggers also work — "retro", "what did we learn", "session summary".

### What gets captured

The skill writes to `${CLAUDE_PROJECT_DIR}/memory/` using three types:

- **`feedback`** — corrections to Claude's behaviour
- **`project`** — decisions, project context
- **`reference`** — external resources

Each entry has `**Why:**` and `**How to apply:**` slots so the rationale survives.

## Migration from v0.2

v0.2 → v3 is a force-push redesign. To upgrade:

```
/plugin update session-retro@jasonm4130-session-retro
/reload-plugins
```

Claude Code will prompt to approve the new hooks (`PostToolUse`, `Stop`, `PreCompact`). Existing memory files keep working — same format. claude-mem is no longer a requirement; remove it if you only had it installed for session-retro.

## Tests

```
bash tests/run-all.sh
```

10 bash tests cover counter init/increment/dedup, test/commit detection, threshold scoring (no-trigger, edits, duration, commit), retro-fired suppression, and PreCompact always-fires.

## License

MIT
EOF
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update README — drop claude-mem requirement, document new hooks"
```

---

## Task 13: CI workflow

**Files:**
- Create or modify: `.github/workflows/test.yml`

- [ ] **Step 1: Check if workflow already exists**

Run: `ls .github/workflows/ 2>/dev/null`
If `test.yml` already exists, read it and adapt. If not, create.

- [ ] **Step 2: Write workflow**

```bash
mkdir -p .github/workflows
cat > .github/workflows/test.yml <<'EOF'
name: tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
    steps:
      - uses: actions/checkout@v4
      - name: Install jq
        run: |
          if ! command -v jq >/dev/null; then
            if [ "${{ matrix.os }}" = "macos-latest" ]; then
              brew install jq
            else
              sudo apt-get update && sudo apt-get install -y jq
            fi
          fi
      - name: Run bash tests
        run: bash tests/run-all.sh
EOF
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: run bash tests on push + PR across ubuntu and macos"
```

---

## Task 14: Manual end-to-end test (no automation possible)

This task isn't TDD — it's a manual verification step in real Claude Code.

- [ ] **Step 1: Reload the plugin locally**

```bash
# In Claude Code:
/plugin marketplace remove jasonm4130-session-retro
# Then reinstall pointing to local checkout — depends on Claude Code's local-plugin support.
# Easiest: push branch, install from fork URL.
```

- [ ] **Step 2: Open a fresh Claude Code session**

Verify SessionStart hook fires (creates `${CLAUDE_PLUGIN_DATA}/session-start-{id}.txt`). Check via:
```bash
ls ${CLAUDE_PLUGIN_DATA}/session-start-*.txt
```

- [ ] **Step 3: Make a few edits in any project**

3+ edits across 2+ files. Verify counter file appears:
```bash
cat ${CLAUDE_PLUGIN_DATA}/score-*.json
```

- [ ] **Step 4: Wait for next assistant turn — Stop hook should inject suggestion**

The next Claude reply should naturally surface "[session-retro] This session: N edits across M files. Suggest running /retro before /clear."

- [ ] **Step 5: Run `/retro`**

Verify:
- Skill reads counter + git diff
- Asks 3-5 specific (non-generic) questions
- Writes memory entries for things you flag worth keeping
- Creates `${CLAUDE_PLUGIN_DATA}/retro-fired-{id}.flag`
- Subsequent Stop hooks stay silent

- [ ] **Step 6: Verify PreCompact behaviour**

Trigger `/compact` manually. Verify the PreCompact suggestion fires (Claude's response after the compact should mention the retro nudge).

- [ ] **Step 7: Document any surprises**

If the manual test surfaces issues, file them as follow-up tasks in this plan or as new commits.

---

## Task 15: Bump version + commit

**Files:**
- Modify: `.claude-plugin/plugin.json`

- [ ] **Step 1: Read current version**

```bash
cat .claude-plugin/plugin.json
```

- [ ] **Step 2: Update version field to `0.3.0` (semver: breaking change to deps)**

Use the Edit tool to change the `"version"` field from whatever it is to `"0.3.0"`. The package will be `@0.3.0` in marketplace listings.

- [ ] **Step 3: Commit + tag**

```bash
git add .claude-plugin/plugin.json
git commit -m "chore: bump version to 0.3.0"
git tag v0.3.0
git push origin main --tags
```

---

## Self-Review

**Spec coverage check:**
- ✅ Drop claude-mem dependency → Task 11 (SKILL.md rewrite), Task 12 (README), Task 9-10 (no claude-mem in any new code)
- ✅ Stop hook with threshold scoring → Tasks 5-8
- ✅ PreCompact hook always fires → Task 9
- ✅ PostToolUse counter → Tasks 2-4
- ✅ Diff-driven interview → Task 11
- ✅ Same memory format → Task 11 (preserved verbatim)
- ✅ Token budget < 15k per retro → designed-in (no JSONL parsing)
- ✅ Tests cover threshold logic + counter behaviour → Tasks 1-9
- ✅ Force-push upgrade, same plugin name → Task 15 (version bump only)
- ✅ Counter file races (open question) → addressed via tmp-then-rename in Task 2
- ✅ Multi-repo / non-repo sessions → handled in Task 11 ("if not a git repo, skip")

**Placeholder scan:** No "TBD" / "TODO" / placeholder phrases. All code blocks complete and runnable.

**Type/name consistency:**
- Counter file shape consistent across all tasks: `{edits, writes, bash_calls, files_touched, first_tool_ts, last_tool_ts, ran_tests, ran_commit}`
- Env var names consistent: `CLAUDE_PLUGIN_DATA`, `CLAUDE_SESSION_ID`, `CLAUDE_PLUGIN_ROOT`
- Filenames consistent: `score-{session_id}.json`, `session-start-{session_id}.txt`, `retro-fired-{session_id}.flag`
- Hook event names match Claude Code spec: `SessionStart`, `PostToolUse`, `Stop`, `PreCompact`

Plan is internally consistent.
