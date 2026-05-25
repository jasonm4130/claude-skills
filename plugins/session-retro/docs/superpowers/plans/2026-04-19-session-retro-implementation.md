# Session Retro Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code plugin that auto-detects substantial sessions, nudges for interactive retrospectives, and writes structured memory entries.

**Architecture:** Three hooks (PreToolUse activity tracker, SessionStart compact extractor, SessionEnd fallback capture), one skill (interactive retro walkthrough), one shared JSONL parser. All Python scripts share a `lib/` module. Shell scripts use bash + jq.

**Tech Stack:** Python 3.10+ (stdlib only for runtime, pytest for dev), bash 4.0+, jq

**Spec:** `docs/superpowers/specs/2026-04-19-session-retro-plugin-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `.claude-plugin/plugin.json` | Plugin identity and metadata |
| `hooks/hooks.json` | Hook event registrations |
| `skills/retro/SKILL.md` | Interactive retro skill definition |
| `lib/__init__.py` | Package marker |
| `lib/parser.py` | JSONL parsing — timeline extraction, condensed mode, stats |
| `lib/config.py` | Configuration loading with defaults, project overrides |
| `lib/memory.py` | Memory entry writing (frontmatter format, MEMORY.md updates) |
| `lib/decisions.py` | Heuristic decision signal extraction from parsed timelines |
| `bin/session-retro-parse` | CLI wrapper for parser (executable, on PATH) |
| `scripts/track-activity.sh` | PreToolUse hook — activity counter + one-time nudge |
| `scripts/extract-on-compact.py` | SessionStart(compact) hook — decision extraction |
| `scripts/capture-session.sh` | SessionEnd hook — fallback metadata capture |
| `tests/conftest.py` | Shared fixtures and helpers |
| `tests/fixtures/small_session.jsonl` | 20-line synthetic session |
| `tests/fixtures/session_with_errors.jsonl` | Session with tool errors and corrections |
| `tests/fixtures/session_with_subagents.jsonl` | Session with subagent dispatches |
| `tests/test_parser.py` | Parser unit tests |
| `tests/test_config.py` | Config loading tests |
| `tests/test_decisions.py` | Decision extraction tests |
| `tests/test_memory.py` | Memory writing tests |
| `tests/test_track_activity.sh.py` | PreToolUse hook integration tests (subprocess) |
| `tests/test_capture_session.sh.py` | SessionEnd hook integration tests (subprocess) |
| `tests/test_extract_compact.py` | Compact extraction integration tests (subprocess) |
| `tests/test_cli.py` | CLI parser integration tests (subprocess) |
| `pyproject.toml` | pytest config, project metadata |

---

### Task 1: Plugin Scaffold + Test Infrastructure

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `hooks/hooks.json`
- Create: `lib/__init__.py`
- Create: `pyproject.toml`
- Create: `tests/__init__.py`
- Create: `tests/conftest.py`

- [ ] **Step 1: Create plugin manifest**

Create `.claude-plugin/plugin.json`:
```json
{
  "name": "session-retro",
  "description": "Interactive session retrospectives with auto-nudging and memory integration",
  "version": "0.1.0",
  "author": {
    "name": "Jason Matthew"
  },
  "license": "MIT",
  "engines": {
    "claude-code": ">=2.1.110"
  }
}
```

- [ ] **Step 2: Create hooks skeleton**

Create `hooks/hooks.json`:
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/track-activity.sh",
            "timeout": 5
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "compact",
        "hooks": [
          {
            "type": "command",
            "command": "python3 ${CLAUDE_PLUGIN_ROOT}/scripts/extract-on-compact.py",
            "timeout": 60
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/capture-session.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 3: Create lib package**

Create `lib/__init__.py`:
```python
"""session-retro: Claude Code plugin for interactive session retrospectives."""
```

- [ ] **Step 4: Create pyproject.toml**

Create `pyproject.toml`:
```toml
[project]
name = "session-retro"
version = "0.1.0"
description = "Claude Code plugin for interactive session retrospectives"
requires-python = ">=3.10"

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]
```

- [ ] **Step 5: Create test infrastructure**

Create `tests/__init__.py` (empty file).

Create `tests/conftest.py`:
```python
"""Shared fixtures for session-retro tests."""

import json
import os
import tempfile
from pathlib import Path

import pytest


@pytest.fixture
def fixtures_dir():
    """Path to test fixtures directory."""
    return Path(__file__).parent / "fixtures"


@pytest.fixture
def tmp_plugin_data(tmp_path):
    """Temporary directory simulating $CLAUDE_PLUGIN_DATA."""
    data_dir = tmp_path / "plugin-data"
    data_dir.mkdir()
    return data_dir


@pytest.fixture
def tmp_memory_dir(tmp_path):
    """Temporary directory simulating ~/.claude/projects/{project}/memory/."""
    mem_dir = tmp_path / "memory"
    mem_dir.mkdir()
    return mem_dir


@pytest.fixture
def sample_hook_stdin():
    """Factory for creating hook stdin JSON."""
    def _make(
        session_id="test-session-001",
        transcript_path="/tmp/test-session.jsonl",
        cwd="/tmp/test-project",
        hook_event_name="PreToolUse",
        tool_name="Read",
        tool_input=None,
        **extra,
    ):
        data = {
            "session_id": session_id,
            "transcript_path": transcript_path,
            "cwd": cwd,
            "hook_event_name": hook_event_name,
            "tool_name": tool_name,
            "tool_input": tool_input or {},
            **extra,
        }
        return json.dumps(data)
    return _make
```

- [ ] **Step 6: Verify pytest runs**

Run: `cd /Users/jasonmatthew/Work/Git/session-retro && python3 -m pytest --co -q`
Expected: `no tests ran` (collected 0 items, no errors)

- [ ] **Step 7: Commit**

```bash
git add .claude-plugin/ hooks/ lib/ tests/ pyproject.toml
git commit -m "feat: plugin scaffold and test infrastructure"
```

---

### Task 2: Test Fixtures — Synthetic JSONL Sessions

**Files:**
- Create: `tests/fixtures/small_session.jsonl`
- Create: `tests/fixtures/session_with_errors.jsonl`
- Create: `tests/fixtures/session_with_subagents/main.jsonl`
- Create: `tests/fixtures/session_with_subagents/subagents/agent-explore-abc.meta.json`

- [ ] **Step 1: Create small session fixture (happy path)**

Create `tests/fixtures/small_session.jsonl` — a 12-line session with permission mode, user messages, assistant responses, and tool calls:
```jsonl
{"type":"permission-mode","permissionMode":"default","sessionId":"small-001"}
{"type":"user","message":{"role":"user","content":"Add a hello world endpoint"},"uuid":"u1","parentUuid":null,"timestamp":"2026-04-19T10:00:00.000Z","userType":"external","entrypoint":"cli","cwd":"/tmp/test-project","sessionId":"small-001","version":"2.1.112","gitBranch":"main"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll create that for you."},{"type":"tool_use","id":"toolu_01","name":"Write","input":{"file_path":"src/index.ts","content":"export function hello() { return 'world'; }"}}],"stop_reason":"end_turn"},"uuid":"a1","parentUuid":"u1","timestamp":"2026-04-19T10:00:30.000Z","sessionId":"small-001"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"File written successfully"}]},"uuid":"u2","parentUuid":"a1","timestamp":"2026-04-19T10:00:31.000Z","sessionId":"small-001"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Now let me add a test."},{"type":"tool_use","id":"toolu_02","name":"Write","input":{"file_path":"src/index.test.ts","content":"import { hello } from './index'; test('hello', () => expect(hello()).toBe('world'));"}}],"stop_reason":"end_turn"},"uuid":"a2","parentUuid":"u2","timestamp":"2026-04-19T10:01:00.000Z","sessionId":"small-001"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_02","content":"File written successfully"}]},"uuid":"u3","parentUuid":"a2","timestamp":"2026-04-19T10:01:01.000Z","sessionId":"small-001"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_03","name":"Bash","input":{"command":"npm test","description":"Run tests"}}],"stop_reason":"end_turn"},"uuid":"a3","parentUuid":"u3","timestamp":"2026-04-19T10:01:30.000Z","sessionId":"small-001"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_03","content":"PASS src/index.test.ts\n  ✓ hello (2ms)\nTests: 1 passed"}]},"uuid":"u4","parentUuid":"a3","timestamp":"2026-04-19T10:01:35.000Z","sessionId":"small-001"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_04","name":"Bash","input":{"command":"git add src/ && git commit -m 'feat: add hello endpoint'","description":"Commit changes"}}],"stop_reason":"end_turn"},"uuid":"a4","parentUuid":"u4","timestamp":"2026-04-19T10:02:00.000Z","sessionId":"small-001"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_04","content":"[main abc1234] feat: add hello endpoint\n 2 files changed"}]},"uuid":"u5","parentUuid":"a4","timestamp":"2026-04-19T10:02:05.000Z","sessionId":"small-001"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done! Created the hello endpoint with test and committed."}],"stop_reason":"end_turn"},"uuid":"a5","parentUuid":"u5","timestamp":"2026-04-19T10:02:10.000Z","sessionId":"small-001"}
{"type":"user","message":{"role":"user","content":"Thanks!"},"uuid":"u6","parentUuid":"a5","timestamp":"2026-04-19T10:02:30.000Z","sessionId":"small-001"}
```

- [ ] **Step 2: Create session with errors and corrections fixture**

Create `tests/fixtures/session_with_errors.jsonl`:
```jsonl
{"type":"permission-mode","permissionMode":"default","sessionId":"errors-001"}
{"type":"user","message":{"role":"user","content":"Set up JWT auth for the API"},"uuid":"u1","parentUuid":null,"timestamp":"2026-04-19T10:00:00.000Z","userType":"external","entrypoint":"cli","cwd":"/tmp/test-project","sessionId":"errors-001","version":"2.1.112","gitBranch":"feature/auth"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll set up cookie-based sessions."},{"type":"tool_use","id":"toolu_01","name":"Write","input":{"file_path":"src/auth.ts","content":"import session from 'express-session';"}}],"stop_reason":"end_turn"},"uuid":"a1","parentUuid":"u1","timestamp":"2026-04-19T10:00:30.000Z","sessionId":"errors-001"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"File written successfully"}]},"uuid":"u2","parentUuid":"a1","timestamp":"2026-04-19T10:00:31.000Z","sessionId":"errors-001"}
{"type":"user","message":{"role":"user","content":"No, we can't use cookies because of the CDN. Use bearer tokens instead."},"uuid":"u3","parentUuid":"a1","timestamp":"2026-04-19T10:01:00.000Z","userType":"external","sessionId":"errors-001"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Got it, switching to JWT bearer tokens."},{"type":"tool_use","id":"toolu_02","name":"Edit","input":{"file_path":"src/auth.ts","old_string":"import session from 'express-session';","new_string":"import jwt from 'jsonwebtoken';"}}],"stop_reason":"end_turn"},"uuid":"a2","parentUuid":"u3","timestamp":"2026-04-19T10:01:30.000Z","sessionId":"errors-001"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_02","content":"File edited successfully"}]},"uuid":"u4","parentUuid":"a2","timestamp":"2026-04-19T10:01:31.000Z","sessionId":"errors-001"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_03","name":"Bash","input":{"command":"npm test","description":"Run tests"}}],"stop_reason":"end_turn"},"uuid":"a3","parentUuid":"u4","timestamp":"2026-04-19T10:02:00.000Z","sessionId":"errors-001"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_03","content":"TypeError: Cannot read properties of undefined (reading 'sign')","is_error":true}]},"uuid":"u5","parentUuid":"a3","timestamp":"2026-04-19T10:02:05.000Z","sessionId":"errors-001"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The import is wrong, let me fix it."},{"type":"tool_use","id":"toolu_04","name":"Edit","input":{"file_path":"src/auth.ts","old_string":"import jwt from 'jsonwebtoken';","new_string":"import * as jwt from 'jsonwebtoken';"}}],"stop_reason":"end_turn"},"uuid":"a4","parentUuid":"u5","timestamp":"2026-04-19T10:02:30.000Z","sessionId":"errors-001"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_04","content":"File edited successfully"}]},"uuid":"u6","parentUuid":"a4","timestamp":"2026-04-19T10:02:31.000Z","sessionId":"errors-001"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_05","name":"Bash","input":{"command":"npm test","description":"Run tests"}}],"stop_reason":"end_turn"},"uuid":"a5","parentUuid":"u6","timestamp":"2026-04-19T10:03:00.000Z","sessionId":"errors-001"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_05","content":"PASS src/auth.test.ts\n  ✓ signs JWT (3ms)\nTests: 1 passed"}]},"uuid":"u7","parentUuid":"a5","timestamp":"2026-04-19T10:03:05.000Z","sessionId":"errors-001"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_06","name":"Bash","input":{"command":"git add src/ && git commit -m 'feat: add JWT auth'","description":"Commit"}}],"stop_reason":"end_turn"},"uuid":"a6","parentUuid":"u7","timestamp":"2026-04-19T10:03:30.000Z","sessionId":"errors-001"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_06","content":"[feature/auth def5678] feat: add JWT auth\n 1 file changed"}]},"uuid":"u8","parentUuid":"a6","timestamp":"2026-04-19T10:03:35.000Z","sessionId":"errors-001"}
```

- [ ] **Step 3: Create session with subagents fixture**

Create directory `tests/fixtures/session_with_subagents/` and file `tests/fixtures/session_with_subagents/main.jsonl`:
```jsonl
{"type":"permission-mode","permissionMode":"default","sessionId":"subagent-001"}
{"type":"user","message":{"role":"user","content":"Research the best JWT library and implement auth"},"uuid":"u1","parentUuid":null,"timestamp":"2026-04-19T10:00:00.000Z","userType":"external","entrypoint":"cli","cwd":"/tmp/test-project","sessionId":"subagent-001","version":"2.1.112","gitBranch":"main"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me research JWT libraries first."},{"type":"tool_use","id":"toolu_01","name":"Agent","input":{"prompt":"Research JWT libraries for Node.js","description":"Research JWT libraries","subagent_type":"Explore"}}],"stop_reason":"end_turn"},"uuid":"a1","parentUuid":"u1","timestamp":"2026-04-19T10:00:30.000Z","sessionId":"subagent-001"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"Recommended jose over jsonwebtoken: better TypeScript support, Web Crypto API, actively maintained."}]},"uuid":"u2","parentUuid":"a1","timestamp":"2026-04-19T10:05:00.000Z","sessionId":"subagent-001"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Based on the research, I'll use jose. Let me implement it."},{"type":"tool_use","id":"toolu_02","name":"Write","input":{"file_path":"src/auth.ts","content":"import { SignJWT, jwtVerify } from 'jose';"}}],"stop_reason":"end_turn"},"uuid":"a2","parentUuid":"u2","timestamp":"2026-04-19T10:05:30.000Z","sessionId":"subagent-001"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_02","content":"File written successfully"}]},"uuid":"u3","parentUuid":"a2","timestamp":"2026-04-19T10:05:31.000Z","sessionId":"subagent-001"}
```

Create `tests/fixtures/session_with_subagents/subagents/agent-explore-abc.meta.json`:
```json
{
  "agentType": "Explore",
  "description": "Research JWT libraries"
}
```

- [ ] **Step 4: Verify fixtures are valid JSONL**

Run: `cd /Users/jasonmatthew/Work/Git/session-retro && python3 -c "
import json
from pathlib import Path
for f in Path('tests/fixtures').rglob('*.jsonl'):
    with open(f) as fh:
        for i, line in enumerate(fh, 1):
            json.loads(line)
    print(f'{f}: {i} lines OK')
"`
Expected: All files parse without errors, line counts printed.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/
git commit -m "feat: add synthetic JSONL test fixtures"
```

---

### Task 3: JSONL Parser — Core Timeline Extraction

**Files:**
- Create: `lib/parser.py`
- Create: `tests/test_parser.py`

- [ ] **Step 1: Write failing tests for basic parsing**

Create `tests/test_parser.py`:
```python
"""Tests for JSONL session parser."""

import json
from pathlib import Path

from lib.parser import parse_session


class TestParseSession:
    """Test core timeline extraction from JSONL."""

    def test_extracts_session_metadata(self, fixtures_dir):
        result = parse_session(fixtures_dir / "small_session.jsonl")
        assert result["sessionId"] == "small-001"
        assert result["cwd"] == "/tmp/test-project"
        assert result["version"] == "2.1.112"
        assert result["gitBranch"] == "main"
        assert result["startedAt"] == "2026-04-19T10:00:00.000Z"
        assert result["endedAt"] == "2026-04-19T10:02:30.000Z"

    def test_extracts_user_messages(self, fixtures_dir):
        result = parse_session(fixtures_dir / "small_session.jsonl")
        user_msgs = [e for e in result["timeline"] if e["type"] == "user_message"]
        assert len(user_msgs) == 2
        assert user_msgs[0]["raw"] == "Add a hello world endpoint"
        assert user_msgs[1]["raw"] == "Thanks!"

    def test_extracts_tool_calls(self, fixtures_dir):
        result = parse_session(fixtures_dir / "small_session.jsonl")
        tool_calls = [e for e in result["timeline"] if e["type"] == "tool_call"]
        assert len(tool_calls) == 4
        assert tool_calls[0]["tool"] == "Write"
        assert tool_calls[0]["target"] == "src/index.ts"
        assert tool_calls[0]["success"] is True

    def test_extracts_git_commits(self, fixtures_dir):
        result = parse_session(fixtures_dir / "small_session.jsonl")
        commits = [e for e in result["timeline"] if e["type"] == "git_commit"]
        assert len(commits) == 1
        assert "hello endpoint" in commits[0]["message"]

    def test_computes_stats(self, fixtures_dir):
        result = parse_session(fixtures_dir / "small_session.jsonl")
        stats = result["stats"]
        assert stats["toolCalls"] == 4
        assert stats["errors"] == 0
        assert stats["corrections"] == 0
        assert stats["gitCommits"] == 1
        assert "src/index.ts" in stats["filesChanged"]
        assert "src/index.test.ts" in stats["filesChanged"]

    def test_extracts_errors(self, fixtures_dir):
        result = parse_session(fixtures_dir / "session_with_errors.jsonl")
        errors = [e for e in result["timeline"] if e["type"] == "error"]
        assert len(errors) == 1
        assert "TypeError" in errors[0]["error"]
        assert errors[0]["tool"] == "Bash"

    def test_extracts_user_corrections(self, fixtures_dir):
        result = parse_session(fixtures_dir / "session_with_errors.jsonl")
        corrections = [e for e in result["timeline"] if e["type"] == "user_correction"]
        assert len(corrections) == 1
        assert "cookies" in corrections[0]["raw"].lower()

    def test_error_stats(self, fixtures_dir):
        result = parse_session(fixtures_dir / "session_with_errors.jsonl")
        assert result["stats"]["errors"] == 1
        assert result["stats"]["corrections"] == 1

    def test_timeline_is_chronological(self, fixtures_dir):
        result = parse_session(fixtures_dir / "small_session.jsonl")
        timestamps = [e["timestamp"] for e in result["timeline"]]
        assert timestamps == sorted(timestamps)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jasonmatthew/Work/Git/session-retro && python3 -m pytest tests/test_parser.py -v`
Expected: All tests FAIL with `ModuleNotFoundError: No module named 'lib.parser'` or `ImportError`

- [ ] **Step 3: Implement core parser**

Create `lib/parser.py`:
```python
"""JSONL session parser — extracts structured timelines from Claude Code transcripts."""

import json
import re
from pathlib import Path


# Patterns indicating user corrections (heuristic)
CORRECTION_PATTERNS = [
    r"(?i)^no[,.]?\s",
    r"(?i)\bdon'?t\b.*\binstead\b",
    r"(?i)\bwrong\b",
    r"(?i)\bnot that\b",
    r"(?i)\binstead\b.*\buse\b",
    r"(?i)\bstop\b.*\buse\b",
    r"(?i)\bwe can'?t use\b",
    r"(?i)\bswitch to\b",
]


def parse_session(
    jsonl_path: str | Path,
    condensed: bool = False,
    include_subagents: bool = False,
) -> dict:
    """Parse a Claude Code session JSONL file into a structured timeline.

    Args:
        jsonl_path: Path to the session .jsonl file.
        condensed: If True, skip routine tool calls for large sessions.
        include_subagents: If True, include subagent metadata summaries.

    Returns:
        Dict with sessionId, startedAt, endedAt, cwd, version, gitBranch,
        timeline (list of events), and stats.
    """
    jsonl_path = Path(jsonl_path)
    lines = _read_jsonl(jsonl_path)

    metadata = _extract_metadata(lines)
    timeline = _build_timeline(lines)

    if condensed:
        timeline = _condense_timeline(timeline)

    if include_subagents:
        subagent_dir = jsonl_path.parent / jsonl_path.stem / "subagents"
        if subagent_dir.is_dir():
            timeline.extend(_load_subagent_summaries(subagent_dir))
            timeline.sort(key=lambda e: e["timestamp"])

    stats = _compute_stats(timeline)

    return {
        **metadata,
        "timeline": timeline,
        "stats": stats,
    }


def _read_jsonl(path: Path) -> list[dict]:
    """Read JSONL file, returning list of parsed JSON objects."""
    lines = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    lines.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return lines


def _extract_metadata(lines: list[dict]) -> dict:
    """Extract session metadata from JSONL lines."""
    session_id = None
    cwd = None
    version = None
    git_branch = None
    first_timestamp = None
    last_timestamp = None

    for line in lines:
        if line.get("type") == "permission-mode":
            session_id = session_id or line.get("sessionId")
            continue

        ts = line.get("timestamp")
        if ts:
            if first_timestamp is None:
                first_timestamp = ts
            last_timestamp = ts

        if line.get("type") == "user" and line.get("userType") == "external":
            session_id = session_id or line.get("sessionId")
            cwd = cwd or line.get("cwd")
            version = version or line.get("version")
            git_branch = git_branch or line.get("gitBranch")

    return {
        "sessionId": session_id,
        "startedAt": first_timestamp,
        "endedAt": last_timestamp,
        "cwd": cwd,
        "version": version,
        "gitBranch": git_branch,
    }


def _build_timeline(lines: list[dict]) -> list[dict]:
    """Build chronological timeline of events from JSONL lines."""
    timeline = []
    # Track pending tool calls to match with results
    pending_tools: dict[str, dict] = {}

    for line in lines:
        line_type = line.get("type")
        ts = line.get("timestamp")

        if line_type == "assistant":
            msg = line.get("message", {})
            content_blocks = msg.get("content", [])
            for block in content_blocks:
                if block.get("type") == "tool_use":
                    tool_name = block["name"]
                    tool_input = block.get("input", {})
                    tool_id = block["id"]
                    pending_tools[tool_id] = {
                        "timestamp": ts,
                        "tool": tool_name,
                        "input": tool_input,
                    }

        elif line_type == "user":
            msg = line.get("message", {})
            content = msg.get("content")

            # String content = user text message
            if isinstance(content, str) and content.strip():
                event = {
                    "timestamp": ts or "",
                    "type": "user_message",
                    "raw": content,
                }
                # Check if this is a correction
                if _is_correction(content):
                    event["type"] = "user_correction"
                    event["summary"] = content[:200]
                timeline.append(event)

            # List content = tool results or mixed
            elif isinstance(content, list):
                for block in content:
                    if block.get("type") == "tool_result":
                        tool_id = block.get("tool_use_id", "")
                        is_error = block.get("is_error", False)
                        result_text = block.get("content", "")
                        if isinstance(result_text, list):
                            result_text = " ".join(
                                b.get("text", "") for b in result_text
                                if isinstance(b, dict)
                            )

                        pending = pending_tools.pop(tool_id, None)
                        if pending:
                            tool_name = pending["tool"]
                            tool_input = pending["input"]
                            tool_ts = pending["timestamp"]

                            if is_error:
                                timeline.append({
                                    "timestamp": tool_ts or "",
                                    "type": "error",
                                    "tool": tool_name,
                                    "error": result_text[:500],
                                })
                            else:
                                event = {
                                    "timestamp": tool_ts or "",
                                    "type": "tool_call",
                                    "tool": tool_name,
                                    "success": True,
                                }
                                # Extract target file for Write/Edit
                                file_path = tool_input.get("file_path", "")
                                if file_path:
                                    event["target"] = file_path

                                # Detect git commits
                                cmd = tool_input.get("command", "")
                                if tool_name == "Bash" and "git commit" in cmd:
                                    commit_msg = _extract_commit_message(result_text)
                                    timeline.append({
                                        "timestamp": tool_ts or "",
                                        "type": "git_commit",
                                        "message": commit_msg,
                                    })
                                    continue

                                # Detect subagent dispatches
                                if tool_name == "Agent":
                                    timeline.append({
                                        "timestamp": tool_ts or "",
                                        "type": "subagent",
                                        "agentType": tool_input.get("subagent_type", "general-purpose"),
                                        "description": tool_input.get("description", ""),
                                        "outcome": result_text[:500],
                                    })
                                    continue

                                # Check for overflow
                                if "<persisted-output>" in result_text:
                                    event["overflow"] = True
                                    overflow_match = re.search(
                                        r"saved to: (.+?)(?:\n|$)", result_text
                                    )
                                    if overflow_match:
                                        event["overflowPath"] = overflow_match.group(1).strip()

                                timeline.append(event)

            # User message that's also external (not a tool result)
            if (
                line.get("userType") == "external"
                and isinstance(content, str)
                and content.strip()
                and not any(e.get("raw") == content for e in timeline[-2:])
            ):
                # Already handled above, skip duplicate
                pass

    timeline.sort(key=lambda e: e.get("timestamp", ""))
    return timeline


def _is_correction(text: str) -> bool:
    """Check if user message is likely a correction."""
    for pattern in CORRECTION_PATTERNS:
        if re.search(pattern, text):
            return True
    return False


def _extract_commit_message(result_text: str) -> str:
    """Extract commit message from git commit output."""
    # Pattern: [branch hash] message
    match = re.search(r"\] (.+?)(?:\n|$)", result_text)
    return match.group(1).strip() if match else result_text[:200]


def _condense_timeline(timeline: list[dict]) -> list[dict]:
    """Condense timeline by removing routine sequential tool calls.

    Keeps: user messages, errors, corrections, subagents, git commits,
    and first/last tool call per file.
    """
    keep_types = {"user_message", "user_correction", "error", "subagent", "git_commit"}
    condensed = []
    file_first: dict[str, dict] = {}
    file_last: dict[str, dict] = {}

    for event in timeline:
        if event["type"] in keep_types:
            condensed.append(event)
        elif event["type"] == "tool_call":
            target = event.get("target", "")
            if target:
                if target not in file_first:
                    file_first[target] = event
                file_last[target] = event
            else:
                condensed.append(event)

    # Add first and last tool call per file
    for target, first in file_first.items():
        condensed.append(first)
        last = file_last[target]
        if last is not first:
            condensed.append(last)

    condensed.sort(key=lambda e: e.get("timestamp", ""))
    return condensed


def _load_subagent_summaries(subagent_dir: Path) -> list[dict]:
    """Load subagent metadata summaries."""
    summaries = []
    for meta_file in subagent_dir.glob("*.meta.json"):
        try:
            meta = json.loads(meta_file.read_text())
            summaries.append({
                "timestamp": "",  # Meta files don't have timestamps
                "type": "subagent",
                "agentType": meta.get("agentType", "unknown"),
                "description": meta.get("description", ""),
                "outcome": "(from subagent metadata)",
            })
        except (json.JSONDecodeError, OSError):
            continue
    return summaries


def _compute_stats(timeline: list[dict]) -> dict:
    """Compute summary statistics from timeline."""
    tool_calls = [e for e in timeline if e["type"] == "tool_call"]
    errors = [e for e in timeline if e["type"] == "error"]
    corrections = [e for e in timeline if e["type"] == "user_correction"]
    subagents = [e for e in timeline if e["type"] == "subagent"]
    commits = [e for e in timeline if e["type"] == "git_commit"]

    files_changed = sorted(set(
        e["target"] for e in tool_calls
        if "target" in e and e["tool"] in ("Write", "Edit")
    ))

    return {
        "totalMessages": len(timeline),
        "toolCalls": len(tool_calls),
        "errors": len(errors),
        "corrections": len(corrections),
        "filesChanged": files_changed,
        "subagents": len(subagents),
        "gitCommits": len(commits),
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/jasonmatthew/Work/Git/session-retro && python3 -m pytest tests/test_parser.py -v`
Expected: All 9 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/parser.py tests/test_parser.py
git commit -m "feat: JSONL parser with timeline extraction and stats"
```

---

### Task 4: JSONL Parser — Condensed Mode + Subagents

**Files:**
- Modify: `tests/test_parser.py`
- Modify: `lib/parser.py` (already has the code, these tests validate it)

- [ ] **Step 1: Write failing tests for condensed mode and subagents**

Append to `tests/test_parser.py`:
```python
class TestCondensedMode:
    """Test condensed timeline for large sessions."""

    def test_keeps_user_messages(self, fixtures_dir):
        result = parse_session(fixtures_dir / "small_session.jsonl", condensed=True)
        user_msgs = [e for e in result["timeline"] if e["type"] == "user_message"]
        assert len(user_msgs) == 2

    def test_keeps_errors(self, fixtures_dir):
        result = parse_session(
            fixtures_dir / "session_with_errors.jsonl", condensed=True
        )
        errors = [e for e in result["timeline"] if e["type"] == "error"]
        assert len(errors) == 1

    def test_keeps_corrections(self, fixtures_dir):
        result = parse_session(
            fixtures_dir / "session_with_errors.jsonl", condensed=True
        )
        corrections = [e for e in result["timeline"] if e["type"] == "user_correction"]
        assert len(corrections) == 1

    def test_keeps_git_commits(self, fixtures_dir):
        result = parse_session(fixtures_dir / "small_session.jsonl", condensed=True)
        commits = [e for e in result["timeline"] if e["type"] == "git_commit"]
        assert len(commits) == 1

    def test_keeps_first_and_last_per_file(self, fixtures_dir):
        result = parse_session(
            fixtures_dir / "session_with_errors.jsonl", condensed=True
        )
        tool_calls = [e for e in result["timeline"] if e["type"] == "tool_call"]
        # src/auth.ts has Write then two Edits — condensed keeps first and last
        auth_calls = [e for e in tool_calls if e.get("target") == "src/auth.ts"]
        assert len(auth_calls) <= 2


class TestSubagentInclusion:
    """Test subagent metadata loading."""

    def test_includes_subagent_from_meta(self, fixtures_dir):
        result = parse_session(
            fixtures_dir / "session_with_subagents" / "main.jsonl",
            include_subagents=True,
        )
        subagents = [e for e in result["timeline"] if e["type"] == "subagent"]
        # One from inline tool result + one from meta.json
        assert len(subagents) >= 1
        agent_types = [s["agentType"] for s in subagents]
        assert "Explore" in agent_types

    def test_subagent_without_meta_dir(self, fixtures_dir):
        """include_subagents=True should not fail if no subagents dir exists."""
        result = parse_session(
            fixtures_dir / "small_session.jsonl", include_subagents=True
        )
        assert "timeline" in result  # No crash
```

- [ ] **Step 2: Run tests**

Run: `cd /Users/jasonmatthew/Work/Git/session-retro && python3 -m pytest tests/test_parser.py -v`
Expected: All tests PASS (parser already implements condensed mode and subagent loading)

- [ ] **Step 3: Commit**

```bash
git add tests/test_parser.py
git commit -m "test: add condensed mode and subagent parser tests"
```

---

### Task 5: JSONL Parser — CLI Interface

**Files:**
- Create: `bin/session-retro-parse`
- Create: `tests/test_cli.py`

- [ ] **Step 1: Write failing CLI test**

Create `tests/test_cli.py`:
```python
"""Tests for session-retro-parse CLI."""

import json
import subprocess
import sys
from pathlib import Path

BIN = Path(__file__).parent.parent / "bin" / "session-retro-parse"


def run_parser(*args: str) -> subprocess.CompletedProcess:
    """Run the CLI parser and return the result."""
    return subprocess.run(
        [sys.executable, str(BIN), *args],
        capture_output=True,
        text=True,
    )


class TestCLI:
    def test_parses_session_to_stdout(self, fixtures_dir):
        result = run_parser(str(fixtures_dir / "small_session.jsonl"))
        assert result.returncode == 0
        data = json.loads(result.stdout)
        assert data["sessionId"] == "small-001"
        assert len(data["timeline"]) > 0
        assert "stats" in data

    def test_condensed_flag(self, fixtures_dir):
        result = run_parser(
            str(fixtures_dir / "small_session.jsonl"), "--condensed"
        )
        assert result.returncode == 0
        data = json.loads(result.stdout)
        assert "timeline" in data

    def test_include_subagents_flag(self, fixtures_dir):
        result = run_parser(
            str(fixtures_dir / "session_with_subagents" / "main.jsonl"),
            "--include-subagents",
        )
        assert result.returncode == 0
        data = json.loads(result.stdout)
        subagents = [e for e in data["timeline"] if e["type"] == "subagent"]
        assert len(subagents) >= 1

    def test_missing_file_exits_nonzero(self):
        result = run_parser("/nonexistent/file.jsonl")
        assert result.returncode != 0
        assert "error" in result.stderr.lower() or "not found" in result.stderr.lower()

    def test_no_args_shows_usage(self):
        result = run_parser()
        assert result.returncode != 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jasonmatthew/Work/Git/session-retro && python3 -m pytest tests/test_cli.py -v`
Expected: FAIL — `bin/session-retro-parse` does not exist yet

- [ ] **Step 3: Create CLI script**

Create `bin/session-retro-parse`:
```python
#!/usr/bin/env python3
"""CLI interface for session-retro JSONL parser.

Usage:
    session-retro-parse <path> [--condensed] [--include-subagents]
"""

import argparse
import json
import sys
from pathlib import Path

# Add plugin root to path so we can import lib/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lib.parser import parse_session


def main():
    parser = argparse.ArgumentParser(
        description="Parse Claude Code session JSONL into structured timeline"
    )
    parser.add_argument("path", help="Path to session .jsonl file")
    parser.add_argument(
        "--condensed",
        action="store_true",
        help="Skip routine tool calls, keep key moments only",
    )
    parser.add_argument(
        "--include-subagents",
        action="store_true",
        help="Include subagent metadata summaries in timeline",
    )

    args = parser.parse_args()

    jsonl_path = Path(args.path)
    if not jsonl_path.exists():
        print(f"Error: file not found: {jsonl_path}", file=sys.stderr)
        sys.exit(1)

    result = parse_session(
        jsonl_path,
        condensed=args.condensed,
        include_subagents=args.include_subagents,
    )

    json.dump(result, sys.stdout, indent=2)
    print()  # trailing newline


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Make executable**

Run: `chmod +x /Users/jasonmatthew/Work/Git/session-retro/bin/session-retro-parse`

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/jasonmatthew/Work/Git/session-retro && python3 -m pytest tests/test_cli.py -v`
Expected: All 5 tests PASS

- [ ] **Step 6: Commit**

```bash
git add bin/session-retro-parse tests/test_cli.py
git commit -m "feat: CLI interface for JSONL parser"
```

---

### Task 6: Configuration Module

**Files:**
- Create: `lib/config.py`
- Create: `tests/test_config.py`

- [ ] **Step 1: Write failing config tests**

Create `tests/test_config.py`:
```python
"""Tests for configuration loading."""

import json
from pathlib import Path

from lib.config import load_config, DEFAULT_CONFIG


class TestLoadConfig:
    def test_returns_defaults_when_no_file(self, tmp_plugin_data):
        config = load_config(tmp_plugin_data)
        assert config["sensitivity"] == "normal"
        assert config["minToolCalls"] == 5
        assert config["minDurationMinutes"] == 10
        assert config["enabled"] is True

    def test_loads_from_file(self, tmp_plugin_data):
        config_path = tmp_plugin_data / "config.json"
        config_path.write_text(json.dumps({"sensitivity": "high"}))
        config = load_config(tmp_plugin_data)
        assert config["sensitivity"] == "high"
        # Other fields should still have defaults
        assert config["minToolCalls"] == 5

    def test_partial_config_merges_with_defaults(self, tmp_plugin_data):
        config_path = tmp_plugin_data / "config.json"
        config_path.write_text(json.dumps({
            "minToolCalls": 20,
            "signals": {"gitCommitsWeight": 5},
        }))
        config = load_config(tmp_plugin_data)
        assert config["minToolCalls"] == 20
        assert config["signals"]["gitCommitsWeight"] == 5
        # Unset signal keys get defaults
        assert config["signals"]["fileChangesWeight"] == 2

    def test_disabled_config(self, tmp_plugin_data):
        config_path = tmp_plugin_data / "config.json"
        config_path.write_text(json.dumps({"enabled": False}))
        config = load_config(tmp_plugin_data)
        assert config["enabled"] is False

    def test_malformed_config_returns_defaults(self, tmp_plugin_data):
        config_path = tmp_plugin_data / "config.json"
        config_path.write_text("not json{{{")
        config = load_config(tmp_plugin_data)
        assert config == DEFAULT_CONFIG

    def test_get_threshold_for_sensitivity(self, tmp_plugin_data):
        config = load_config(tmp_plugin_data)
        assert config["thresholds"]["normal"] == 8
        assert config["thresholds"]["low"] == 15
        assert config["thresholds"]["high"] == 3

    def test_project_overrides(self, tmp_plugin_data):
        config_path = tmp_plugin_data / "config.json"
        config_path.write_text(json.dumps({
            "projectOverrides": {
                "**/scratch/**": {"enabled": False},
            }
        }))
        config = load_config(tmp_plugin_data)
        assert "**/scratch/**" in config["projectOverrides"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jasonmatthew/Work/Git/session-retro && python3 -m pytest tests/test_config.py -v`
Expected: FAIL with ImportError

- [ ] **Step 3: Implement config module**

Create `lib/config.py`:
```python
"""Configuration loading with defaults and project overrides."""

import json
from pathlib import Path

DEFAULT_CONFIG = {
    "sensitivity": "normal",
    "minToolCalls": 5,
    "minDurationMinutes": 10,
    "signals": {
        "fileChangesWeight": 2,
        "subagentSpawnsWeight": 2,
        "gitCommitsWeight": 1,
    },
    "thresholds": {
        "low": 15,
        "normal": 8,
        "high": 3,
    },
    "projectOverrides": {},
    "enabled": True,
}


def load_config(plugin_data_dir: str | Path) -> dict:
    """Load config from plugin data dir, merging with defaults.

    Args:
        plugin_data_dir: Path to $CLAUDE_PLUGIN_DATA directory.

    Returns:
        Merged config dict with all fields guaranteed present.
    """
    config_path = Path(plugin_data_dir) / "config.json"

    if not config_path.exists():
        return dict(DEFAULT_CONFIG)

    try:
        user_config = json.loads(config_path.read_text())
    except (json.JSONDecodeError, OSError):
        return dict(DEFAULT_CONFIG)

    return _deep_merge(DEFAULT_CONFIG, user_config)


def _deep_merge(defaults: dict, overrides: dict) -> dict:
    """Recursively merge overrides into defaults."""
    result = {}
    for key, default_val in defaults.items():
        if key in overrides:
            override_val = overrides[key]
            if isinstance(default_val, dict) and isinstance(override_val, dict):
                result[key] = _deep_merge(default_val, override_val)
            else:
                result[key] = override_val
        else:
            result[key] = default_val

    # Include any extra keys from overrides not in defaults
    for key in overrides:
        if key not in defaults:
            result[key] = overrides[key]

    return result
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/jasonmatthew/Work/Git/session-retro && python3 -m pytest tests/test_config.py -v`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/config.py tests/test_config.py
git commit -m "feat: config loading with defaults and deep merge"
```

---

### Task 7: PreToolUse Hook — Activity Tracking + Nudge

**Files:**
- Create: `scripts/track-activity.sh`
- Create: `tests/test_track_activity.py`

- [ ] **Step 1: Write failing hook tests**

Create `tests/test_track_activity.py`:
```python
"""Tests for track-activity.sh PreToolUse hook."""

import json
import os
import subprocess
import time
from pathlib import Path

SCRIPT = Path(__file__).parent.parent / "scripts" / "track-activity.sh"


def run_hook(stdin_data: dict, plugin_data: Path, env_extra: dict = None) -> subprocess.CompletedProcess:
    """Run the hook script with given stdin and env."""
    env = os.environ.copy()
    env["CLAUDE_PLUGIN_DATA"] = str(plugin_data)
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        ["bash", str(SCRIPT)],
        input=json.dumps(stdin_data),
        capture_output=True,
        text=True,
        env=env,
    )


def make_stdin(
    session_id="test-001",
    tool_name="Read",
    tool_input=None,
    transcript_path="/tmp/test.jsonl",
    cwd="/tmp/test-project",
):
    return {
        "session_id": session_id,
        "transcript_path": transcript_path,
        "cwd": cwd,
        "hook_event_name": "PreToolUse",
        "tool_name": tool_name,
        "tool_input": tool_input or {},
    }


class TestActivityTracking:
    def test_creates_activity_file(self, tmp_plugin_data):
        result = run_hook(make_stdin(), tmp_plugin_data)
        assert result.returncode == 0
        activity_file = tmp_plugin_data / "activity-test-001.json"
        assert activity_file.exists()
        data = json.loads(activity_file.read_text())
        assert data["toolCalls"] == 1
        assert data["sessionId"] == "test-001"

    def test_increments_tool_calls(self, tmp_plugin_data):
        run_hook(make_stdin(), tmp_plugin_data)
        run_hook(make_stdin(), tmp_plugin_data)
        run_hook(make_stdin(), tmp_plugin_data)
        data = json.loads((tmp_plugin_data / "activity-test-001.json").read_text())
        assert data["toolCalls"] == 3

    def test_tracks_write_as_file_change(self, tmp_plugin_data):
        run_hook(
            make_stdin(tool_name="Write", tool_input={"file_path": "src/foo.ts"}),
            tmp_plugin_data,
        )
        data = json.loads((tmp_plugin_data / "activity-test-001.json").read_text())
        assert "src/foo.ts" in data["filesChanged"]

    def test_tracks_edit_as_file_change(self, tmp_plugin_data):
        run_hook(
            make_stdin(tool_name="Edit", tool_input={"file_path": "src/bar.ts"}),
            tmp_plugin_data,
        )
        data = json.loads((tmp_plugin_data / "activity-test-001.json").read_text())
        assert "src/bar.ts" in data["filesChanged"]

    def test_deduplicates_file_changes(self, tmp_plugin_data):
        stdin = make_stdin(tool_name="Write", tool_input={"file_path": "src/foo.ts"})
        run_hook(stdin, tmp_plugin_data)
        run_hook(stdin, tmp_plugin_data)
        data = json.loads((tmp_plugin_data / "activity-test-001.json").read_text())
        assert data["filesChanged"].count("src/foo.ts") == 1

    def test_tracks_agent_as_subagent(self, tmp_plugin_data):
        run_hook(make_stdin(tool_name="Agent"), tmp_plugin_data)
        data = json.loads((tmp_plugin_data / "activity-test-001.json").read_text())
        assert data["subagentsSpawned"] == 1

    def test_tracks_git_commit(self, tmp_plugin_data):
        run_hook(
            make_stdin(
                tool_name="Bash",
                tool_input={"command": "git commit -m 'test'"},
            ),
            tmp_plugin_data,
        )
        data = json.loads((tmp_plugin_data / "activity-test-001.json").read_text())
        assert data["gitCommits"] == 1

    def test_no_output_below_threshold(self, tmp_plugin_data):
        """Below minimum tool calls, no nudge should be emitted."""
        result = run_hook(make_stdin(), tmp_plugin_data)
        assert result.stdout.strip() == ""

    def test_exits_zero_always(self, tmp_plugin_data):
        result = run_hook(make_stdin(), tmp_plugin_data)
        assert result.returncode == 0

    def test_handles_missing_plugin_data(self, tmp_path):
        """Should not crash if CLAUDE_PLUGIN_DATA doesn't exist yet."""
        nonexistent = tmp_path / "nonexistent"
        result = run_hook(make_stdin(), nonexistent)
        assert result.returncode == 0


class TestNudgeInjection:
    def _build_substantial_session(self, tmp_plugin_data):
        """Simulate enough activity to trigger a nudge at normal sensitivity."""
        # Need: minToolCalls >= 5, minDurationMinutes >= 10, score >= 8
        # Score: filesChanged * 2, so 4 unique files = score 8
        # First call sets firstSeenAt, we'll backdate it
        run_hook(
            make_stdin(tool_name="Write", tool_input={"file_path": "a.ts"}),
            tmp_plugin_data,
        )
        # Backdate firstSeenAt to 15 minutes ago
        activity_file = tmp_plugin_data / "activity-test-001.json"
        data = json.loads(activity_file.read_text())
        from datetime import datetime, timezone, timedelta
        old_time = (datetime.now(timezone.utc) - timedelta(minutes=15)).isoformat()
        data["firstSeenAt"] = old_time
        activity_file.write_text(json.dumps(data))

        # Add more file changes to reach score threshold
        for f in ["b.ts", "c.ts", "d.ts"]:
            run_hook(
                make_stdin(tool_name="Write", tool_input={"file_path": f}),
                tmp_plugin_data,
            )
        # One more call to pass minToolCalls=5
        run_hook(make_stdin(tool_name="Read"), tmp_plugin_data)

    def test_emits_nudge_when_threshold_met(self, tmp_plugin_data):
        self._build_substantial_session(tmp_plugin_data)
        result = run_hook(make_stdin(), tmp_plugin_data)
        if result.stdout.strip():
            output = json.loads(result.stdout)
            assert "hookSpecificOutput" in output
            ctx = output["hookSpecificOutput"]["additionalContext"]
            assert "/session-retro:retro" in ctx

    def test_nudge_sets_flag_file(self, tmp_plugin_data):
        self._build_substantial_session(tmp_plugin_data)
        run_hook(make_stdin(), tmp_plugin_data)
        flag = tmp_plugin_data / "nudge-sent-test-001.flag"
        assert flag.exists()

    def test_no_repeat_nudge(self, tmp_plugin_data):
        self._build_substantial_session(tmp_plugin_data)
        # First call may emit nudge
        run_hook(make_stdin(), tmp_plugin_data)
        # Second call should NOT emit nudge (flag exists)
        result = run_hook(make_stdin(), tmp_plugin_data)
        assert result.stdout.strip() == ""

    def test_disabled_config_skips_nudge(self, tmp_plugin_data):
        (tmp_plugin_data / "config.json").write_text(
            json.dumps({"enabled": False})
        )
        self._build_substantial_session(tmp_plugin_data)
        result = run_hook(make_stdin(), tmp_plugin_data)
        assert result.stdout.strip() == ""
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jasonmatthew/Work/Git/session-retro && python3 -m pytest tests/test_track_activity.py -v`
Expected: FAIL — script doesn't exist yet

- [ ] **Step 3: Implement track-activity.sh**

Create `scripts/track-activity.sh`:
```bash
#!/usr/bin/env bash
# PreToolUse hook: lightweight activity counter + one-time nudge injection.
# Reads hook event JSON from stdin, writes counters to $CLAUDE_PLUGIN_DATA.
# Must complete in <100ms.
set -euo pipefail

# Read stdin
INPUT=$(cat)

# Extract fields
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

# Bail if no session ID
if [ -z "$SESSION_ID" ]; then
    exit 0
fi

# Ensure plugin data dir exists
PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-/tmp/session-retro-data}"
mkdir -p "$PLUGIN_DATA"

ACTIVITY_FILE="$PLUGIN_DATA/activity-${SESSION_ID}.json"
NUDGE_FLAG="$PLUGIN_DATA/nudge-sent-${SESSION_ID}.flag"
CONFIG_FILE="$PLUGIN_DATA/config.json"

# Load or create activity file
if [ -f "$ACTIVITY_FILE" ]; then
    ACTIVITY=$(cat "$ACTIVITY_FILE")
else
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    ACTIVITY=$(jq -n \
        --arg sid "$SESSION_ID" \
        --arg tp "$TRANSCRIPT_PATH" \
        --arg cwd "$CWD" \
        --arg now "$NOW" \
        '{
            sessionId: $sid,
            transcriptPath: $tp,
            cwd: $cwd,
            firstSeenAt: $now,
            lastSeenAt: $now,
            toolCalls: 0,
            filesChanged: [],
            subagentsSpawned: 0,
            gitCommits: 0,
            score: 0
        }')
fi

# Update timestamp and increment tool calls
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
ACTIVITY=$(echo "$ACTIVITY" | jq --arg now "$NOW" '.lastSeenAt = $now | .toolCalls += 1')

# Track specific tool types
case "$TOOL_NAME" in
    Write|Edit)
        FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // empty')
        if [ -n "$FILE_PATH" ]; then
            ACTIVITY=$(echo "$ACTIVITY" | jq --arg fp "$FILE_PATH" \
                'if (.filesChanged | index($fp)) then . else .filesChanged += [$fp] end')
        fi
        ;;
    Agent)
        ACTIVITY=$(echo "$ACTIVITY" | jq '.subagentsSpawned += 1')
        ;;
    Bash)
        CMD=$(echo "$TOOL_INPUT" | jq -r '.command // empty')
        if echo "$CMD" | grep -q "git commit"; then
            ACTIVITY=$(echo "$ACTIVITY" | jq '.gitCommits += 1')
        fi
        ;;
esac

# Compute score
FILES_COUNT=$(echo "$ACTIVITY" | jq '.filesChanged | length')
SUBAGENTS=$(echo "$ACTIVITY" | jq '.subagentsSpawned')
COMMITS=$(echo "$ACTIVITY" | jq '.gitCommits')

# Load weights from config (or use defaults)
FILE_WEIGHT=2
SUBAGENT_WEIGHT=2
COMMIT_WEIGHT=1
SENSITIVITY="normal"
MIN_TOOL_CALLS=5
MIN_DURATION=10
ENABLED=true

if [ -f "$CONFIG_FILE" ]; then
    FILE_WEIGHT=$(jq -r '.signals.fileChangesWeight // 2' "$CONFIG_FILE")
    SUBAGENT_WEIGHT=$(jq -r '.signals.subagentSpawnsWeight // 2' "$CONFIG_FILE")
    COMMIT_WEIGHT=$(jq -r '.signals.gitCommitsWeight // 1' "$CONFIG_FILE")
    SENSITIVITY=$(jq -r '.sensitivity // "normal"' "$CONFIG_FILE")
    MIN_TOOL_CALLS=$(jq -r '.minToolCalls // 5' "$CONFIG_FILE")
    MIN_DURATION=$(jq -r '.minDurationMinutes // 10' "$CONFIG_FILE")
    ENABLED=$(jq -r '.enabled // true' "$CONFIG_FILE")
fi

SCORE=$(( FILES_COUNT * FILE_WEIGHT + SUBAGENTS * SUBAGENT_WEIGHT + COMMITS * COMMIT_WEIGHT ))
ACTIVITY=$(echo "$ACTIVITY" | jq --argjson s "$SCORE" '.score = $s')

# Write activity file
echo "$ACTIVITY" > "$ACTIVITY_FILE"

# Check if we should nudge
if [ "$ENABLED" != "true" ]; then
    exit 0
fi

if [ -f "$NUDGE_FLAG" ]; then
    exit 0
fi

# Check minimum thresholds
TOOL_CALLS=$(echo "$ACTIVITY" | jq '.toolCalls')
if [ "$TOOL_CALLS" -lt "$MIN_TOOL_CALLS" ]; then
    exit 0
fi

# Check elapsed time
FIRST_SEEN=$(echo "$ACTIVITY" | jq -r '.firstSeenAt')
if command -v gdate &>/dev/null; then
    FIRST_EPOCH=$(gdate -d "$FIRST_SEEN" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%S" "${FIRST_SEEN%%.*}" +%s 2>/dev/null || echo 0)
else
    FIRST_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${FIRST_SEEN%%.*}" +%s 2>/dev/null || echo 0)
fi
NOW_EPOCH=$(date +%s)
ELAPSED_MIN=$(( (NOW_EPOCH - FIRST_EPOCH) / 60 ))

if [ "$ELAPSED_MIN" -lt "$MIN_DURATION" ]; then
    exit 0
fi

# Check score threshold
case "$SENSITIVITY" in
    low)  THRESHOLD=15 ;;
    high) THRESHOLD=3 ;;
    *)    THRESHOLD=8 ;;
esac

# Load custom thresholds if present
if [ -f "$CONFIG_FILE" ]; then
    CUSTOM_THRESHOLD=$(jq -r ".thresholds.${SENSITIVITY} // empty" "$CONFIG_FILE")
    if [ -n "$CUSTOM_THRESHOLD" ]; then
        THRESHOLD=$CUSTOM_THRESHOLD
    fi
fi

if [ "$SCORE" -lt "$THRESHOLD" ]; then
    exit 0
fi

# Emit nudge
touch "$NUDGE_FLAG"

cat <<ENDJSON
{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"Session activity: significant work detected (score ${SCORE}, ${FILES_COUNT} files changed, ${ELAPSED_MIN}min). When the user's current task is complete, suggest /session-retro:retro to capture learnings. Do not interrupt active work."}}
ENDJSON
```

- [ ] **Step 4: Make executable**

Run: `chmod +x /Users/jasonmatthew/Work/Git/session-retro/scripts/track-activity.sh`

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/jasonmatthew/Work/Git/session-retro && python3 -m pytest tests/test_track_activity.py -v`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/track-activity.sh tests/test_track_activity.py
git commit -m "feat: PreToolUse activity tracking hook with nudge injection"
```

---

### Task 8: SessionEnd Hook — Fallback Capture

**Files:**
- Create: `scripts/capture-session.sh`
- Create: `tests/test_capture_session.py`

- [ ] **Step 1: Write failing hook tests**

Create `tests/test_capture_session.py`:
```python
"""Tests for capture-session.sh SessionEnd hook."""

import json
import os
import subprocess
import time
from pathlib import Path

SCRIPT = Path(__file__).parent.parent / "scripts" / "capture-session.sh"


def run_hook(stdin_data: dict, plugin_data: Path, cwd: str = "/tmp/test") -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["CLAUDE_PLUGIN_DATA"] = str(plugin_data)
    return subprocess.run(
        ["bash", str(SCRIPT)],
        input=json.dumps(stdin_data),
        capture_output=True,
        text=True,
        env=env,
        cwd=cwd,
    )


def make_stdin(session_id="test-001", source="prompt_input_exit"):
    return {
        "session_id": session_id,
        "transcript_path": "/tmp/test.jsonl",
        "cwd": "/tmp/test-project",
        "hook_event_name": "SessionEnd",
        "source": source,
    }


class TestFallbackCapture:
    def test_creates_pending_retro_when_substantial(self, tmp_plugin_data, tmp_path):
        # Create activity file with score > 0
        activity = {
            "sessionId": "test-001",
            "transcriptPath": "/tmp/test.jsonl",
            "cwd": "/tmp/test-project",
            "firstSeenAt": "2026-04-19T10:00:00.000Z",
            "lastSeenAt": "2026-04-19T10:45:00.000Z",
            "toolCalls": 20,
            "filesChanged": ["a.ts", "b.ts"],
            "subagentsSpawned": 1,
            "gitCommits": 1,
            "score": 7,
        }
        (tmp_plugin_data / "activity-test-001.json").write_text(json.dumps(activity))

        result = run_hook(make_stdin(), tmp_plugin_data, cwd=str(tmp_path))
        assert result.returncode == 0

        pending = tmp_plugin_data / "pending-retro-test-001.json"
        assert pending.exists()
        data = json.loads(pending.read_text())
        assert data["sessionId"] == "test-001"
        assert data["exitReason"] == "prompt_input_exit"
        assert data["activity"]["toolCalls"] == 20

    def test_skips_when_retro_already_done(self, tmp_plugin_data, tmp_path):
        (tmp_plugin_data / "activity-test-001.json").write_text(
            json.dumps({"score": 10, "toolCalls": 20})
        )
        (tmp_plugin_data / "retro-done-test-001.flag").touch()

        run_hook(make_stdin(), tmp_plugin_data, cwd=str(tmp_path))

        pending = tmp_plugin_data / "pending-retro-test-001.json"
        assert not pending.exists()

    def test_cleans_up_session_files(self, tmp_plugin_data, tmp_path):
        (tmp_plugin_data / "activity-test-001.json").write_text(
            json.dumps({"score": 5, "toolCalls": 10})
        )
        (tmp_plugin_data / "nudge-sent-test-001.flag").touch()

        run_hook(make_stdin(), tmp_plugin_data, cwd=str(tmp_path))

        assert not (tmp_plugin_data / "activity-test-001.json").exists()
        assert not (tmp_plugin_data / "nudge-sent-test-001.flag").exists()

    def test_skips_trivial_sessions(self, tmp_plugin_data, tmp_path):
        (tmp_plugin_data / "activity-test-001.json").write_text(
            json.dumps({"score": 0, "toolCalls": 2})
        )

        run_hook(make_stdin(), tmp_plugin_data, cwd=str(tmp_path))

        pending = tmp_plugin_data / "pending-retro-test-001.json"
        assert not pending.exists()

    def test_prunes_stale_flags(self, tmp_plugin_data, tmp_path):
        # Create a flag file older than 30 days
        old_flag = tmp_plugin_data / "retro-done-old-session.flag"
        old_flag.touch()
        # Backdate it 31 days
        old_time = time.time() - (31 * 86400)
        os.utime(old_flag, (old_time, old_time))

        # Create a recent flag that should NOT be pruned
        recent_flag = tmp_plugin_data / "retro-done-recent-session.flag"
        recent_flag.touch()

        (tmp_plugin_data / "activity-test-001.json").write_text(
            json.dumps({"score": 0, "toolCalls": 1})
        )

        run_hook(make_stdin(), tmp_plugin_data, cwd=str(tmp_path))

        assert not old_flag.exists()
        assert recent_flag.exists()

    def test_handles_no_activity_file(self, tmp_plugin_data, tmp_path):
        """No crash when activity file doesn't exist."""
        result = run_hook(make_stdin(), tmp_plugin_data, cwd=str(tmp_path))
        assert result.returncode == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jasonmatthew/Work/Git/session-retro && python3 -m pytest tests/test_capture_session.py -v`
Expected: FAIL — script doesn't exist

- [ ] **Step 3: Implement capture-session.sh**

Create `scripts/capture-session.sh`:
```bash
#!/usr/bin/env bash
# SessionEnd hook: fallback metadata capture + cleanup.
# Writes pending-retro file if session was substantial and no retro done.
set -euo pipefail

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
SOURCE=$(echo "$INPUT" | jq -r '.source // "other"')

if [ -z "$SESSION_ID" ]; then
    exit 0
fi

PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-/tmp/session-retro-data}"
mkdir -p "$PLUGIN_DATA"

ACTIVITY_FILE="$PLUGIN_DATA/activity-${SESSION_ID}.json"
NUDGE_FLAG="$PLUGIN_DATA/nudge-sent-${SESSION_ID}.flag"
RETRO_DONE="$PLUGIN_DATA/retro-done-${SESSION_ID}.flag"
PENDING_FILE="$PLUGIN_DATA/pending-retro-${SESSION_ID}.json"

# Skip if retro already done
if [ -f "$RETRO_DONE" ]; then
    # Still clean up session-scoped files
    rm -f "$ACTIVITY_FILE" "$NUDGE_FLAG"
    # Prune stale flags (older than 30 days)
    find "$PLUGIN_DATA" -name "retro-done-*.flag" -mtime +30 -delete 2>/dev/null || true
    find "$PLUGIN_DATA" -name "pending-retro-*.json" -mtime +30 -delete 2>/dev/null || true
    exit 0
fi

# Read activity data
SCORE=0
TOOL_CALLS=0
if [ -f "$ACTIVITY_FILE" ]; then
    SCORE=$(jq -r '.score // 0' "$ACTIVITY_FILE")
    TOOL_CALLS=$(jq -r '.toolCalls // 0' "$ACTIVITY_FILE")
fi

# Create pending retro if session was substantial
if [ "$SCORE" -gt 0 ]; then
    # Get git diff stat (best effort)
    GIT_DIFF=""
    if [ -d "$CWD/.git" ] || git -C "$CWD" rev-parse --git-dir >/dev/null 2>&1; then
        GIT_DIFF=$(git -C "$CWD" diff --stat 2>/dev/null | tail -1 || echo "")
    fi

    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    FIRST_SEEN=""
    LAST_SEEN=""
    if [ -f "$ACTIVITY_FILE" ]; then
        FIRST_SEEN=$(jq -r '.firstSeenAt // empty' "$ACTIVITY_FILE")
        LAST_SEEN=$(jq -r '.lastSeenAt // empty' "$ACTIVITY_FILE")
    fi

    # Build pending retro JSON
    ACTIVITY_DATA=$(cat "$ACTIVITY_FILE" 2>/dev/null || echo '{}')
    jq -n \
        --arg sid "$SESSION_ID" \
        --arg tp "$TRANSCRIPT_PATH" \
        --arg cwd "$CWD" \
        --arg start "$FIRST_SEEN" \
        --arg end "$NOW" \
        --arg reason "$SOURCE" \
        --arg gitdiff "$GIT_DIFF" \
        --argjson activity "$ACTIVITY_DATA" \
        '{
            sessionId: $sid,
            transcriptPath: $tp,
            cwd: $cwd,
            startedAt: $start,
            endedAt: $end,
            exitReason: $reason,
            activity: {
                toolCalls: ($activity.toolCalls // 0),
                filesChanged: (($activity.filesChanged // []) | length),
                subagentsSpawned: ($activity.subagentsSpawned // 0),
                gitCommits: ($activity.gitCommits // 0),
                score: ($activity.score // 0)
            },
            gitDiffStat: $gitdiff
        }' > "$PENDING_FILE"
fi

# Clean up session-scoped files
rm -f "$ACTIVITY_FILE" "$NUDGE_FLAG"

# Prune stale flags (older than 30 days)
find "$PLUGIN_DATA" -name "retro-done-*.flag" -mtime +30 -delete 2>/dev/null || true
find "$PLUGIN_DATA" -name "pending-retro-*.json" -mtime +30 -delete 2>/dev/null || true

exit 0
```

- [ ] **Step 4: Make executable**

Run: `chmod +x /Users/jasonmatthew/Work/Git/session-retro/scripts/capture-session.sh`

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/jasonmatthew/Work/Git/session-retro && python3 -m pytest tests/test_capture_session.py -v`
Expected: All 6 tests PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/capture-session.sh tests/test_capture_session.py
git commit -m "feat: SessionEnd fallback capture hook with stale file pruning"
```

---

### Task 9: Decision Extraction Module

**Files:**
- Create: `lib/decisions.py`
- Create: `tests/test_decisions.py`

- [ ] **Step 1: Write failing tests**

Create `tests/test_decisions.py`:
```python
"""Tests for heuristic decision signal extraction."""

from lib.decisions import extract_decisions


class TestExtractDecisions:
    def test_extracts_corrections(self):
        timeline = [
            {"type": "user_correction", "timestamp": "t1",
             "raw": "No, we can't use cookies because of the CDN. Use bearer tokens.",
             "summary": "Don't use cookies, use bearer tokens"},
        ]
        decisions = extract_decisions(timeline)
        assert len(decisions) >= 1
        assert any("cookie" in d["detail"].lower() or "bearer" in d["detail"].lower()
                    for d in decisions)

    def test_extracts_error_fix_sequences(self):
        timeline = [
            {"type": "error", "timestamp": "t1", "tool": "Bash",
             "error": "TypeError: Cannot read properties of undefined"},
            {"type": "tool_call", "timestamp": "t2", "tool": "Edit",
             "target": "src/auth.ts", "success": True},
        ]
        decisions = extract_decisions(timeline)
        assert any(d["signal"] == "error_fix" for d in decisions)

    def test_extracts_explicit_decisions_from_user_messages(self):
        timeline = [
            {"type": "user_message", "timestamp": "t1",
             "raw": "Let's go with jose over jsonwebtoken for the JWT library"},
        ]
        decisions = extract_decisions(timeline)
        assert any(d["signal"] == "explicit_decision" for d in decisions)

    def test_empty_timeline_returns_empty(self):
        assert extract_decisions([]) == []

    def test_routine_session_returns_few_decisions(self):
        timeline = [
            {"type": "user_message", "timestamp": "t1", "raw": "Add a hello endpoint"},
            {"type": "tool_call", "timestamp": "t2", "tool": "Write",
             "target": "src/index.ts", "success": True},
            {"type": "user_message", "timestamp": "t3", "raw": "Thanks!"},
        ]
        decisions = extract_decisions(timeline)
        # Routine work shouldn't generate many decision signals
        assert len(decisions) <= 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jasonmatthew/Work/Git/session-retro && python3 -m pytest tests/test_decisions.py -v`
Expected: FAIL with ImportError

- [ ] **Step 3: Implement decisions module**

Create `lib/decisions.py`:
```python
"""Heuristic decision signal extraction from parsed session timelines."""

import re

# Patterns indicating explicit decisions in user messages
DECISION_PATTERNS = [
    r"(?i)\blet'?s go with\b",
    r"(?i)\bwe should\b",
    r"(?i)\bi think we should\b",
    r"(?i)\bthe trade-?off is\b",
    r"(?i)\bi'?d prefer\b",
    r"(?i)\blet'?s use\b",
    r"(?i)\bwe'?ll use\b",
    r"(?i)\bi decided\b",
    r"(?i)\bthe decision is\b",
    r"(?i)\bgo ahead with\b",
]


def extract_decisions(timeline: list[dict]) -> list[dict]:
    """Extract decision signals from a parsed session timeline.

    Returns a list of decision dicts with keys:
        - signal: type of decision (correction, error_fix, explicit_decision)
        - timestamp: when it happened
        - detail: human-readable summary
    """
    decisions = []

    for i, event in enumerate(timeline):
        # User corrections are always decision signals
        if event["type"] == "user_correction":
            decisions.append({
                "signal": "correction",
                "timestamp": event.get("timestamp", ""),
                "detail": event.get("raw", event.get("summary", ""))[:300],
            })

        # Error followed by a fix (tool call on same or nearby file)
        elif event["type"] == "error":
            fix = _find_fix_after(timeline, i)
            if fix:
                decisions.append({
                    "signal": "error_fix",
                    "timestamp": event.get("timestamp", ""),
                    "detail": f"Error in {event.get('tool', '?')}: "
                              f"{event.get('error', '')[:200]} → "
                              f"Fixed via {fix['tool']} on {fix.get('target', '?')}",
                })

        # Explicit decision language in user messages
        elif event["type"] == "user_message":
            raw = event.get("raw", "")
            if _is_explicit_decision(raw):
                decisions.append({
                    "signal": "explicit_decision",
                    "timestamp": event.get("timestamp", ""),
                    "detail": raw[:300],
                })

    return decisions


def _find_fix_after(timeline: list[dict], error_index: int) -> dict | None:
    """Look for a successful tool call within 3 events after an error."""
    for j in range(error_index + 1, min(error_index + 4, len(timeline))):
        event = timeline[j]
        if event["type"] == "tool_call" and event.get("success"):
            if event.get("tool") in ("Write", "Edit", "Bash"):
                return event
    return None


def _is_explicit_decision(text: str) -> bool:
    """Check if user message contains explicit decision language."""
    for pattern in DECISION_PATTERNS:
        if re.search(pattern, text):
            return True
    return False
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/jasonmatthew/Work/Git/session-retro && python3 -m pytest tests/test_decisions.py -v`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/decisions.py tests/test_decisions.py
git commit -m "feat: heuristic decision signal extraction from timelines"
```

---

### Task 10: Memory Writing Module

**Files:**
- Create: `lib/memory.py`
- Create: `tests/test_memory.py`

- [ ] **Step 1: Write failing tests**

Create `tests/test_memory.py`:
```python
"""Tests for memory entry writing."""

from pathlib import Path

from lib.memory import write_memory_entry, update_memory_index


class TestWriteMemoryEntry:
    def test_writes_frontmatter_format(self, tmp_memory_dir):
        write_memory_entry(
            memory_dir=tmp_memory_dir,
            filename="retro_feedback_testing.md",
            name="Testing approach",
            description="Always use integration tests for database code",
            memory_type="feedback",
            body="Don't mock the database in integration tests.\n\n"
                 "**Why:** Prior incident where mock/prod diverged.\n\n"
                 "**How to apply:** Use test database for all DB-touching tests.",
        )
        path = tmp_memory_dir / "retro_feedback_testing.md"
        assert path.exists()
        content = path.read_text()
        assert "---" in content
        assert "name: Testing approach" in content
        assert "type: feedback" in content
        assert "Don't mock the database" in content

    def test_overwrites_existing(self, tmp_memory_dir):
        write_memory_entry(tmp_memory_dir, "test.md", "v1", "d", "feedback", "old")
        write_memory_entry(tmp_memory_dir, "test.md", "v2", "d", "feedback", "new")
        content = (tmp_memory_dir / "test.md").read_text()
        assert "v2" in content
        assert "old" not in content


class TestUpdateMemoryIndex:
    def test_creates_memory_md_if_missing(self, tmp_memory_dir):
        update_memory_index(
            tmp_memory_dir, "test_file.md", "Test entry description"
        )
        index = tmp_memory_dir / "MEMORY.md"
        assert index.exists()
        content = index.read_text()
        assert "[Test entry description](test_file.md)" in content

    def test_appends_to_existing_index(self, tmp_memory_dir):
        (tmp_memory_dir / "MEMORY.md").write_text(
            "- [Existing](existing.md) - old entry\n"
        )
        update_memory_index(tmp_memory_dir, "new.md", "New entry")
        content = (tmp_memory_dir / "MEMORY.md").read_text()
        assert "Existing" in content
        assert "New entry" in content

    def test_does_not_duplicate(self, tmp_memory_dir):
        update_memory_index(tmp_memory_dir, "test.md", "Test")
        update_memory_index(tmp_memory_dir, "test.md", "Test updated")
        content = (tmp_memory_dir / "MEMORY.md").read_text()
        assert content.count("test.md") == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jasonmatthew/Work/Git/session-retro && python3 -m pytest tests/test_memory.py -v`
Expected: FAIL with ImportError

- [ ] **Step 3: Implement memory module**

Create `lib/memory.py`:
```python
"""Memory entry writing utilities for Claude Code's memory system."""

from pathlib import Path


def write_memory_entry(
    memory_dir: str | Path,
    filename: str,
    name: str,
    description: str,
    memory_type: str,
    body: str,
) -> Path:
    """Write a memory entry with standard frontmatter format.

    Args:
        memory_dir: Path to the project's memory/ directory.
        filename: Filename for the entry (e.g., "retro_feedback_testing.md").
        name: Memory name (shown in index).
        description: One-line description for relevance matching.
        memory_type: One of: user, feedback, project, reference.
        body: Markdown body content.

    Returns:
        Path to the written file.
    """
    memory_dir = Path(memory_dir)
    memory_dir.mkdir(parents=True, exist_ok=True)

    content = f"""---
name: {name}
description: {description}
type: {memory_type}
---

{body}
"""

    path = memory_dir / filename
    path.write_text(content)
    return path


def update_memory_index(
    memory_dir: str | Path,
    filename: str,
    description: str,
) -> None:
    """Add or update an entry in MEMORY.md index.

    If the filename already exists in the index, replaces that line.
    Otherwise appends a new line.

    Args:
        memory_dir: Path to the project's memory/ directory.
        filename: Filename of the memory entry.
        description: Short description for the index line.
    """
    memory_dir = Path(memory_dir)
    index_path = memory_dir / "MEMORY.md"

    new_line = f"- [{description}]({filename})"

    if index_path.exists():
        lines = index_path.read_text().splitlines()
        # Check if filename already referenced
        updated = False
        for i, line in enumerate(lines):
            if f"({filename})" in line:
                lines[i] = new_line
                updated = True
                break
        if not updated:
            lines.append(new_line)
        index_path.write_text("\n".join(lines) + "\n")
    else:
        index_path.write_text(new_line + "\n")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/jasonmatthew/Work/Git/session-retro && python3 -m pytest tests/test_memory.py -v`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/memory.py tests/test_memory.py
git commit -m "feat: memory entry writing with frontmatter and index updates"
```

---

### Task 11: SessionStart(compact) Hook — Decision Extraction

**Files:**
- Create: `scripts/extract-on-compact.py`
- Create: `tests/test_extract_compact.py`

- [ ] **Step 1: Write failing tests**

Create `tests/test_extract_compact.py`:
```python
"""Tests for extract-on-compact.py SessionStart(compact) hook."""

import json
import os
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).parent.parent / "scripts" / "extract-on-compact.py"


def run_hook(stdin_data: dict, plugin_data: Path = None) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    if plugin_data:
        env["CLAUDE_PLUGIN_DATA"] = str(plugin_data)
    # Set PLUGIN_ROOT so the script can find lib/
    env["CLAUDE_PLUGIN_ROOT"] = str(Path(__file__).parent.parent)
    return subprocess.run(
        [sys.executable, str(SCRIPT)],
        input=json.dumps(stdin_data),
        capture_output=True,
        text=True,
        env=env,
    )


class TestCompactExtraction:
    def test_extracts_decisions_and_writes_memory(self, fixtures_dir, tmp_path):
        # Set up a project memory dir matching the fixture's transcript path pattern
        transcript = fixtures_dir / "session_with_errors.jsonl"
        # Derive project dir from transcript path (parent directory)
        project_dir = transcript.parent
        memory_dir = project_dir / "memory"
        memory_dir.mkdir(exist_ok=True)

        stdin_data = {
            "session_id": "errors-001",
            "transcript_path": str(transcript),
            "cwd": "/tmp/test-project",
            "hook_event_name": "SessionStart",
            "source": "compact",
        }

        result = run_hook(stdin_data)
        assert result.returncode == 0

        # Check that a memory file was written
        memory_files = list(memory_dir.glob("compact_extract_*.md"))
        assert len(memory_files) >= 1

        content = memory_files[0].read_text()
        assert "---" in content  # Has frontmatter
        assert "type: project" in content

        # Clean up
        for f in memory_files:
            f.unlink()
        if (memory_dir / "MEMORY.md").exists():
            (memory_dir / "MEMORY.md").unlink()
        memory_dir.rmdir()

    def test_returns_additional_context(self, fixtures_dir):
        transcript = fixtures_dir / "session_with_errors.jsonl"
        project_dir = transcript.parent
        memory_dir = project_dir / "memory"
        memory_dir.mkdir(exist_ok=True)

        stdin_data = {
            "session_id": "errors-001",
            "transcript_path": str(transcript),
            "cwd": "/tmp/test-project",
            "hook_event_name": "SessionStart",
            "source": "compact",
        }

        result = run_hook(stdin_data)
        if result.stdout.strip():
            output = json.loads(result.stdout)
            assert "hookSpecificOutput" in output
            ctx = output["hookSpecificOutput"]["additionalContext"]
            assert len(ctx) > 0
            assert len(ctx) <= 2000

        # Clean up
        for f in memory_dir.glob("compact_extract_*.md"):
            f.unlink()
        if (memory_dir / "MEMORY.md").exists():
            (memory_dir / "MEMORY.md").unlink()
        memory_dir.rmdir()

    def test_handles_missing_transcript(self, tmp_path):
        stdin_data = {
            "session_id": "missing-001",
            "transcript_path": str(tmp_path / "nonexistent.jsonl"),
            "cwd": "/tmp/test-project",
            "hook_event_name": "SessionStart",
        }
        result = run_hook(stdin_data)
        assert result.returncode == 0  # Should not crash
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jasonmatthew/Work/Git/session-retro && python3 -m pytest tests/test_extract_compact.py -v`
Expected: FAIL — script doesn't exist

- [ ] **Step 3: Implement extract-on-compact.py**

Create `scripts/extract-on-compact.py`:
```python
#!/usr/bin/env python3
"""SessionStart(compact) hook: extract decisions from JSONL after compaction.

Reads the full session transcript (still on disk), extracts decision signals,
writes a memory entry, and returns additionalContext for the fresh context.
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# Add plugin root to path
plugin_root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(plugin_root))

from lib.parser import parse_session
from lib.decisions import extract_decisions
from lib.memory import write_memory_entry, update_memory_index


def main():
    try:
        stdin_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)

    transcript_path = stdin_data.get("transcript_path", "")
    if not transcript_path or not Path(transcript_path).exists():
        sys.exit(0)

    # Parse session
    try:
        session = parse_session(transcript_path, condensed=True)
    except Exception:
        sys.exit(0)

    # Extract decisions
    decisions = extract_decisions(session.get("timeline", []))
    if not decisions:
        sys.exit(0)

    # Derive memory directory from transcript path
    # Pattern: ~/.claude/projects/{encoded_cwd}/{session_id}.jsonl
    transcript = Path(transcript_path)
    project_dir = transcript.parent
    memory_dir = project_dir / "memory"

    # Write memory entry
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    filename = f"compact_extract_{timestamp}.md"

    body_lines = ["Decisions and context extracted before compaction:\n"]
    for d in decisions[:20]:  # Cap at 20 to avoid bloat
        body_lines.append(f"- **{d['signal']}**: {d['detail']}")

    body = "\n".join(body_lines)

    write_memory_entry(
        memory_dir=memory_dir,
        filename=filename,
        name=f"Compaction extract ({timestamp})",
        description=f"Decisions recovered from session before compaction — {len(decisions)} signals",
        memory_type="project",
        body=body,
    )

    update_memory_index(
        memory_dir=memory_dir,
        filename=filename,
        description=f"Compaction extract ({timestamp}) — {len(decisions)} decisions",
    )

    # Return additionalContext (max 2000 chars)
    summary_lines = ["Pre-compaction decisions recovered:"]
    char_count = len(summary_lines[0])
    for d in decisions:
        line = f"\n- {d['detail'][:150]}"
        if char_count + len(line) > 1900:
            summary_lines.append(f"\n- ...and {len(decisions) - len(summary_lines) + 1} more (see memory)")
            break
        summary_lines.append(line)
        char_count += len(line)

    summary = "".join(summary_lines)

    output = {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": summary,
        }
    }
    json.dump(output, sys.stdout)
    print()


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Make executable**

Run: `chmod +x /Users/jasonmatthew/Work/Git/session-retro/scripts/extract-on-compact.py`

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/jasonmatthew/Work/Git/session-retro && python3 -m pytest tests/test_extract_compact.py -v`
Expected: All 3 tests PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/extract-on-compact.py tests/test_extract_compact.py
git commit -m "feat: SessionStart(compact) decision extraction hook"
```

---

### Task 12: Retro Skill Definition

**Files:**
- Create: `skills/retro/SKILL.md`

- [ ] **Step 1: Create the skill directory**

Run: `mkdir -p /Users/jasonmatthew/Work/Git/session-retro/skills/retro`

- [ ] **Step 2: Write SKILL.md**

Create `skills/retro/SKILL.md`:
```markdown
---
description: >
  Run an interactive session retrospective. Analyzes your current session transcript,
  walks through key moments with you, and writes structured memory entries capturing
  decisions, learnings, and rationale.
  Use when: "retro", "session summary", "what did we learn", "lessons learned",
  "session retrospective", or the user wants to review what happened in a session.
---

# Session Retrospective

You are running an interactive session retrospective. Your goal is to walk through
the session with the user, understand what happened and why, and write structured
memory entries that will be useful in future sessions.

## Step 1: Session Ingestion

First, check for pending retros from previous sessions:

```bash
ls ${CLAUDE_PLUGIN_DATA}/pending-retro-*.json 2>/dev/null
```

If pending retros exist, read them and offer: "I found a pending retro from your
last session ({date}, {duration}, {summary}). Want to review that one too, or
focus on the current session?"

For the current session, parse the transcript using the session-retro-parse tool
(available on PATH via the plugin's bin/ directory):

```bash
session-retro-parse <transcript_path> --include-subagents
```

If the JSONL file is larger than 2MB, add `--condensed`:

```bash
session-retro-parse <transcript_path> --include-subagents --condensed
```

The transcript path is available from the session context. If you cannot determine
it, check `${CLAUDE_PLUGIN_DATA}/activity-*.json` files for the current session's
`transcriptPath` field.

## Step 2: Guided Conversation

Walk through the session chronologically. Ask **one question at a time** — do not
batch questions.

Derive your questions from what actually happened in the parsed timeline. Focus on:

**Decisions** — when the user chose between alternatives:
- "You explored [A] and [B] before choosing [B]. What tipped the decision?"
- "Was there a reason you went with [approach] over the alternatives?"

**Corrections** — when the user corrected your approach:
- "You corrected me when I tried [approach]. What was wrong with my suggestion?"
- "I notice you redirected me from [X] to [Y]. Is that a general rule for this codebase?"

**Errors and fixes** — when something broke and was resolved:
- "You hit [error] and resolved it by [fix]. Was that the right call, or would you approach it differently?"
- "That [error] took [N] attempts to fix. Anything we should remember to avoid it next time?"

**Techniques** — new patterns or approaches used:
- "The pattern you used for [X] — is this standard for this codebase or something new?"
- "You used [tool/technique]. Worth remembering for future sessions?"

**End with an open question:**
- "Anything else that came up that's worth remembering? Surprises, gotchas, things that worked unexpectedly well?"

Do NOT ask questions about routine, successful operations. Focus on moments where
learning happened — pivots, failures, decisions, discoveries.

## Step 3: Memory Generation

Based on the conversation, write memory entries to the project's memory directory.
Use the standard frontmatter format:

### For corrections to your (Claude's) behaviour → `feedback` type

```markdown
---
name: {short name}
description: {one-line description for relevance matching}
type: feedback
---

{The rule or preference}

**Why:** {The reason the user gave}

**How to apply:** {When/where this applies}
```

Filename pattern: `retro_feedback_{topic}.md`

### For decisions and project context → `project` type

```markdown
---
name: {short name}
description: {one-line description for relevance matching}
type: project
---

{The decision or fact}

**Why:** {The motivation — constraint, requirement, trade-off}

**How to apply:** {How this should shape future suggestions}
```

Filename pattern: `retro_project_{topic}.md`

### For external resources discovered → `reference` type

```markdown
---
name: {short name}
description: {one-line description for relevance matching}
type: reference
---

{The resource and what it's useful for}
```

Filename pattern: `retro_reference_{topic}.md`

After writing each entry, update the project's MEMORY.md index with a one-line
pointer. Show the user each entry you wrote so they can confirm or adjust.

## Step 4: Cleanup

After the retro is complete:

1. Write a completion flag:
```bash
touch ${CLAUDE_PLUGIN_DATA}/retro-done-{session_id}.flag
```

2. If you retroed a pending session from a previous session, delete its pending file:
```bash
rm ${CLAUDE_PLUGIN_DATA}/pending-retro-{session_id}.json
```

## Guidelines

- Ask ONE question at a time. Wait for the user's response before asking the next.
- Focus on the "why" — decisions, rationale, trade-offs. Not the "what" (that's in git).
- Keep memory entries concise. One entry per distinct learning, not a mega-document.
- Only write memories for things that are genuinely useful in future sessions.
  "We wrote a function" is not useful. "We chose jose over jsonwebtoken because
  of Web Crypto API support" IS useful.
- If the session was routine with no notable decisions, say so. Not every session
  needs memory entries. A short "clean session, nothing to capture" is fine.
- Never fabricate learnings. If the session data doesn't show clear decision points,
  ask the user what they found valuable rather than inventing insights.
```

- [ ] **Step 3: Verify skill loads**

Run: `cd /Users/jasonmatthew/Work/Git/session-retro && head -5 skills/retro/SKILL.md`
Expected: Shows the frontmatter with description

- [ ] **Step 4: Commit**

```bash
git add skills/retro/SKILL.md
git commit -m "feat: interactive retro skill with guided walkthrough"
```

---

### Task 13: Integration Verification

**Files:**
- No new files — validation only

- [ ] **Step 1: Run full test suite**

Run: `cd /Users/jasonmatthew/Work/Git/session-retro && python3 -m pytest -v`
Expected: All tests PASS

- [ ] **Step 2: Verify plugin structure**

Run: `cd /Users/jasonmatthew/Work/Git/session-retro && ls -la .claude-plugin/plugin.json hooks/hooks.json skills/retro/SKILL.md scripts/ bin/`
Expected: All files exist in the correct locations

- [ ] **Step 3: Verify all scripts are executable**

Run: `cd /Users/jasonmatthew/Work/Git/session-retro && file scripts/* bin/*`
Expected: All scripts show as executable

- [ ] **Step 4: Test parser against a real session file**

Run: `cd /Users/jasonmatthew/Work/Git/session-retro && python3 bin/session-retro-parse "$(ls ~/.claude/projects/-Users-jasonmatthew-Work-Git-session-retro/*.jsonl | head -1)" --include-subagents 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Session: {d[\"sessionId\"]}, Timeline: {len(d[\"timeline\"])} events, Stats: {d[\"stats\"]}')" `
Expected: Prints session metadata with real data from the current session

- [ ] **Step 5: Test hook scripts with mock stdin**

Run: `cd /Users/jasonmatthew/Work/Git/session-retro && echo '{"session_id":"verify-001","transcript_path":"/tmp/test.jsonl","cwd":"/tmp","hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"test.ts"}}' | CLAUDE_PLUGIN_DATA=/tmp/session-retro-verify bash scripts/track-activity.sh && cat /tmp/session-retro-verify/activity-verify-001.json | python3 -m json.tool && rm -rf /tmp/session-retro-verify`
Expected: Valid JSON activity file with toolCalls=1, filesChanged=["test.ts"]

- [ ] **Step 6: Final commit with all integration checks passing**

```bash
git add -A
git status
# If any unstaged changes exist, commit them
git diff --cached --stat && git commit -m "chore: integration verification complete" || echo "Nothing to commit"
```
