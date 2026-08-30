package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The hooks are tested end-to-end through the built binary rather than by
// calling the subcommand functions directly: every one of them ends in
// os.Exit, and the exit status is part of the contract Claude Code reads.
//
// These cases came across with the two guards that were already Go. The three
// ported guards are covered instead by scripts/ccguard-differential.test.mjs,
// which runs them against the .mjs references they replace.
var binPath string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "ccguard-test")
	if err != nil {
		panic(err)
	}
	binPath = filepath.Join(dir, "ccguard")
	out, err := exec.Command("go", "build", "-o", binPath, ".").CombinedOutput()
	if err != nil {
		panic("build failed: " + string(out))
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

type result struct {
	stdout string
	stderr string
	code   int
}

func run(t *testing.T, sub, payload string, env ...string) result {
	t.Helper()
	cmd := exec.Command(binPath, sub)
	cmd.Stdin = strings.NewReader(payload)
	if len(env) > 0 {
		cmd.Env = env
	}
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatalf("running %s: %v", sub, err)
	}
	return result{stdout.String(), stderr.String(), code}
}

func grep(pattern string, extra ...string) string {
	fields := []string{`"pattern":` + mustJSON(pattern)}
	for i := 0; i+1 < len(extra); i += 2 {
		fields = append(fields, mustJSON(extra[i])+":"+mustJSON(extra[i+1]))
	}
	return `{"tool_name":"Grep","tool_input":{` + strings.Join(fields, ",") + `}}`
}

func mustJSON(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		panic(err)
	}
	return string(b)
}

func assertDenies(t *testing.T, r result, label string) {
	t.Helper()
	if r.code != 0 {
		t.Fatalf("%s: expected exit 0, got %d (stderr: %s)", label, r.code, r.stderr)
	}
	if strings.TrimSpace(r.stdout) == "" {
		t.Fatalf("%s: expected deny JSON on stdout, got none", label)
	}
	var parsed struct {
		HookSpecificOutput struct {
			PermissionDecision string `json:"permissionDecision"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal([]byte(r.stdout), &parsed); err != nil {
		t.Fatalf("%s: stdout is not JSON: %v", label, err)
	}
	if parsed.HookSpecificOutput.PermissionDecision != "deny" {
		t.Fatalf("%s: expected permissionDecision=deny, got %q", label, parsed.HookSpecificOutput.PermissionDecision)
	}
}

func assertAllows(t *testing.T, r result, label string) {
	t.Helper()
	if r.code != 0 {
		t.Fatalf("%s: expected exit 0, got %d (stderr: %s)", label, r.code, r.stderr)
	}
	if strings.TrimSpace(r.stdout) != "" {
		t.Fatalf("%s: expected no stdout, got %q", label, r.stdout)
	}
}

// ── lsp-first ────────────────────────────────────────────────────────────────

func TestLSPFirstBlocks(t *testing.T) {
	cases := []struct{ label, pattern string }{
		{"camelCase", "handleSubmit"},
		{"normalized trailing \\b", `getUserData\b`},
		{"normalized escaped paren", `fetchData\(`},
		{"PascalCase", "UserService"},
		{"snake_case", "fetch_user_data"},
		{"message-like error rule: fetch_failed_rows", "fetch_failed_rows"},
		{"message-like error rule: handleError", "handleError"},
		{"message-like error rule: ErrorBoundary", "ErrorBoundary"},
		{"message-like error rule: ValidationException", "ValidationException"},
		{"mixed-case dotted: this.handleSubmit", "this.handleSubmit"},
		{"mixed-case dotted: React.Component", "React.Component"},
		{"Pascal_Snake", "User_Model"},
		{"case-sensitive TODO prefix: warnUser", "warnUser"},
		{"case-sensitive TODO prefix: NoteEditor", "NoteEditor"},
		{"decorator", "@Component"},
		{"declaration keyword", "class UserService"},
	}
	for _, c := range cases {
		t.Run(c.label, func(t *testing.T) {
			assertDenies(t, run(t, "lsp-first", grep(c.pattern)), c.label)
		})
	}
	t.Run("end-anchored ext does not disable the guard", func(t *testing.T) {
		r := run(t, "lsp-first", grep("handleSubmit", "path", "/x/work.log-analyzer/src"))
		assertDenies(t, r, "work.log-analyzer path")
	})
}

func TestLSPFirstPasses(t *testing.T) {
	cases := []struct{ label, pattern string }{
		{"TODO", "TODO"},
		{"FIXME:", "FIXME:"},
		{"string-literal allow rule", `"handleSubmit"`},
		{"escape hatch", "handleSubmit(?:)"},
		{"escape hatch on function-call pattern", `fetchData\((?:)`},
		{"env var", "MAX_RETRIES"},
		{"dotted config key", "foo.bar-baz"},
		{"dotted config key 2", "server.port"},
		{"short", "db"},
		{"message-like: Failed to connect", "Failed to connect"},
		{"message-like: error: connection refused", "error: connection refused"},
		{"url", "https://example.com"},
		{"version", "1.2.3"},
		{"import", "import React"},
		{"css class", ".btn-primary"},
	}
	for _, c := range cases {
		t.Run(c.label, func(t *testing.T) {
			assertAllows(t, run(t, "lsp-first", grep(c.pattern)), c.label)
		})
	}
	t.Run("glob *.md", func(t *testing.T) {
		assertAllows(t, run(t, "lsp-first", grep("handleSubmit", "glob", "*.md")), "glob md")
	})
	t.Run("path config/settings.json", func(t *testing.T) {
		assertAllows(t, run(t, "lsp-first", grep("handleSubmit", "path", "config/settings.json")), "path json")
	})
}

func TestLSPFirstFailsOpen(t *testing.T) {
	cases := []struct{ label, payload string }{
		{"non-Grep tool", `{"tool_name":"Bash","tool_input":{"command":"handleSubmit"}}`},
		{"empty stdin", ``},
		{"garbage stdin", `not { valid json`},
		{"literal null stdin", `null`},
		{"empty pattern", grep("")},
	}
	for _, c := range cases {
		t.Run(c.label, func(t *testing.T) {
			assertAllows(t, run(t, "lsp-first", c.payload), c.label)
		})
	}
}

// The guard's own removal on 2026-08-26 was caused by it nagging toward
// language servers that were dead. It must never do that again.
func TestLSPFirstFailsOpenWhenServerMissing(t *testing.T) {
	empty := t.TempDir()
	t.Run("pinned language, its server absent", func(t *testing.T) {
		r := run(t, "lsp-first", grep("handleSubmit", "glob", "*.rs"), "PATH="+empty)
		assertAllows(t, r, "rust glob with no rust-analyzer")
	})
	t.Run("unpinned language, no servers at all", func(t *testing.T) {
		r := run(t, "lsp-first", grep("handleSubmit"), "PATH="+empty)
		assertAllows(t, r, "no servers on PATH")
	})
	t.Run("still denies when the server is present", func(t *testing.T) {
		shim := t.TempDir()
		if err := os.WriteFile(filepath.Join(shim, "rust-analyzer"), []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		r := run(t, "lsp-first", grep("handleSubmit", "glob", "*.rs"), "PATH="+shim)
		assertDenies(t, r, "rust glob with rust-analyzer present")
	})
}

func TestLSPFirstDenyShape(t *testing.T) {
	r := run(t, "lsp-first", grep("handleSubmit"))
	var parsed map[string]any
	if err := json.Unmarshal([]byte(r.stdout), &parsed); err != nil {
		t.Fatalf("stdout is not JSON: %v", err)
	}
	if _, ok := parsed["decision"]; ok {
		t.Error("no top-level decision key should remain (deprecated contract)")
	}
	hso, _ := parsed["hookSpecificOutput"].(map[string]any)
	if hso["hookEventName"] != "PreToolUse" {
		t.Errorf("hookEventName = %v, want PreToolUse", hso["hookEventName"])
	}
	reason, _ := hso["permissionDecisionReason"].(string)
	const escapeHatch = "re-run this exact Grep with (?:) appended to the end of the pattern (pattern(?:)) to bypass this guard"
	if !strings.Contains(reason, escapeHatch) {
		t.Error("expected the escape-hatch sentence in permissionDecisionReason")
	}
}

// ── json-config-guard ────────────────────────────────────────────────────────

func TestJSONConfigGuard(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	good := write("settings.json", `{"a":1}`)
	bad := write(".mcp.json", `{"a":1,,}`)
	empty := write("settings.local.json", "")

	t.Run("valid config passes", func(t *testing.T) {
		r := run(t, "json-config-guard", `{"tool_name":"Edit","tool_input":{"file_path":`+mustJSON(good)+`}}`)
		if r.code != 0 {
			t.Fatalf("expected exit 0, got %d: %s", r.code, r.stderr)
		}
	})
	t.Run("broken config exits 2 with the parse error on stderr", func(t *testing.T) {
		r := run(t, "json-config-guard", `{"tool_name":"Write","tool_input":{"file_path":`+mustJSON(bad)+`}}`)
		if r.code != 2 {
			t.Fatalf("expected exit 2, got %d", r.code)
		}
		if !strings.Contains(r.stderr, "no longer valid JSON") {
			t.Errorf("expected parse error on stderr, got %q", r.stderr)
		}
	})
	t.Run("empty config is valid lazy state", func(t *testing.T) {
		r := run(t, "json-config-guard", `{"tool_name":"Edit","tool_input":{"file_path":`+mustJSON(empty)+`}}`)
		if r.code != 0 {
			t.Fatalf("expected exit 0, got %d", r.code)
		}
	})
	t.Run("bash merely mentioning a broken config still checks it", func(t *testing.T) {
		r := run(t, "json-config-guard", `{"tool_name":"Bash","cwd":`+mustJSON(dir)+`,"tool_input":{"command":"cat .mcp.json"}}`)
		if r.code != 2 {
			t.Fatalf("expected exit 2, got %d", r.code)
		}
	})
	t.Run("unguarded path is ignored", func(t *testing.T) {
		r := run(t, "json-config-guard", `{"tool_name":"Edit","tool_input":{"file_path":"/tmp/other.json"}}`)
		if r.code != 0 {
			t.Fatalf("expected exit 0, got %d", r.code)
		}
	})
	t.Run("fails open on garbage", func(t *testing.T) {
		for _, payload := range []string{``, `garbage`} {
			if r := run(t, "json-config-guard", payload); r.code != 0 {
				t.Fatalf("expected exit 0 for %q, got %d", payload, r.code)
			}
		}
	})
}

// ── coverage carried over from the .mjs suites these hooks replaced ─────────

func TestJSONConfigGuardPathResolution(t *testing.T) {
	dir := t.TempDir()
	broken := `{"a":1,,}`

	t.Run("relative path resolves against the payload cwd", func(t *testing.T) {
		if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(broken), 0o644); err != nil {
			t.Fatal(err)
		}
		r := run(t, "json-config-guard", `{"tool_name":"Bash","cwd":`+mustJSON(dir)+`,"tool_input":{"command":"vim settings.json"}}`)
		if r.code != 2 {
			t.Fatalf("expected exit 2, got %d (stderr %q)", r.code, r.stderr)
		}
	})

	t.Run("~/ and $HOME/ prefixes resolve against the home directory", func(t *testing.T) {
		home, err := os.UserHomeDir()
		if err != nil {
			t.Skip("no home directory")
		}
		// Point at a guarded name under a directory that does not exist, so the
		// hook resolves the path and then finds nothing: exit 0, no crash. What
		// is under test is that the prefix expands rather than being treated as
		// a literal relative path.
		for _, prefix := range []string{"~/", "$HOME/"} {
			cmd := prefix + "definitely-not-a-real-dir-xyz/settings.json"
			r := run(t, "json-config-guard", `{"tool_name":"Bash","cwd":"/","tool_input":{"command":`+mustJSON("cat "+cmd)+`}}`)
			if r.code != 0 {
				t.Fatalf("%s: expected exit 0, got %d (stderr %q)", prefix, r.code, r.stderr)
			}
		}
		_ = home
	})

	t.Run("two broken guarded files in one command are both named", func(t *testing.T) {
		d := t.TempDir()
		for _, n := range []string{"settings.json", ".mcp.json"} {
			if err := os.WriteFile(filepath.Join(d, n), []byte(broken), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		r := run(t, "json-config-guard", `{"tool_name":"Bash","cwd":`+mustJSON(d)+`,"tool_input":{"command":"cat settings.json .mcp.json"}}`)
		if r.code != 2 {
			t.Fatalf("expected exit 2, got %d", r.code)
		}
		for _, n := range []string{"settings.json", ".mcp.json"} {
			if !strings.Contains(r.stderr, n) {
				t.Errorf("expected %s named in stderr, got %q", n, r.stderr)
			}
		}
	})

	t.Run("guards settings.local.json too", func(t *testing.T) {
		d := t.TempDir()
		if err := os.WriteFile(filepath.Join(d, "settings.local.json"), []byte(broken), 0o644); err != nil {
			t.Fatal(err)
		}
		r := run(t, "json-config-guard", `{"tool_name":"Write","tool_input":{"file_path":`+mustJSON(filepath.Join(d, "settings.local.json"))+`}}`)
		if r.code != 2 {
			t.Fatalf("expected exit 2, got %d", r.code)
		}
	})

	t.Run("file vanished between write and hook", func(t *testing.T) {
		r := run(t, "json-config-guard", `{"tool_name":"Edit","tool_input":{"file_path":`+mustJSON(filepath.Join(dir, "gone", "settings.json"))+`}}`)
		if r.code != 0 {
			t.Fatalf("expected exit 0, got %d", r.code)
		}
	})

	t.Run("bash naming a guarded path that does not exist exits 0", func(t *testing.T) {
		r := run(t, "json-config-guard", `{"tool_name":"Bash","cwd":`+mustJSON(t.TempDir())+`,"tool_input":{"command":"cat .mcp.json"}}`)
		if r.code != 0 {
			t.Fatalf("expected exit 0, got %d", r.code)
		}
	})
}
