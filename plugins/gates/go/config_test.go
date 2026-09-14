package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Every case pairs a disabled run with a control run on the same payload and the
// same environment, differing only in GATES_DISABLE. Without the control a
// disabled case passes vacuously the moment the payload stops triggering — and
// lsp-first makes that concrete, because it fails open when no language server
// is on PATH, so a run with a stripped environment is silent for the wrong
// reason.
func runEnv(t *testing.T, sub, payload string, extra ...string) result {
	t.Helper()
	return run(t, sub, payload, append(os.Environ(), extra...)...)
}

func TestGuardDisabledIn(t *testing.T) {
	cases := []struct {
		raw, name string
		want      bool
	}{
		{"", "lsp-first", false},
		{"lsp-first", "lsp-first", true},
		{"design-gate,lsp-first", "lsp-first", true},
		{" design-gate , lsp-first ", "lsp-first", true},
		{"design-gate,agent-model", "lsp-first", false},
		{"lsp-first", "design-gate", false},
		{"LSP-FIRST", "lsp-first", false},
		{"lsp_first", "lsp-first", false},
		{"lsp-first-extra", "lsp-first", false},
		{",,", "lsp-first", false},
		{"lsp-first,", "lsp-first", true},
	}
	for _, c := range cases {
		if got := guardDisabledIn(c.raw, c.name); got != c.want {
			t.Errorf("guardDisabledIn(%q, %q) = %v, want %v", c.raw, c.name, got, c.want)
		}
	}
}

func TestDisableSilencesEachGuard(t *testing.T) {
	badJSON := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(badJSON, []byte(`{"a":1,}`), 0o644); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		sub, payload string
		// json-config-guard signals by exiting 2 with stderr rather than by
		// writing a decision to stdout.
		signalsOnStderr bool
	}{
		{sub: "design-gate", payload: bashPayload("npm create vite@latest my-app")},
		{sub: "agent-model", payload: `{"tool_name":"Agent","tool_input":{"prompt":"x"}}`},
		{sub: "workflow-model", payload: `{"tool_name":"Workflow","tool_input":{"script":"phase(\"x\"); await parallel(items.map(i => () => agent(\"do \" + i)))"}}`},
		{sub: "lsp-first", payload: grep("handleSubmit")},
		{sub: "json-config-guard", payload: `{"tool_name":"Edit","tool_input":{"file_path":` + mustJSON(badJSON) + `}}`, signalsOnStderr: true},
	}

	for _, c := range cases {
		control := runEnv(t, c.sub, c.payload)
		if c.signalsOnStderr {
			if control.code == 0 {
				t.Fatalf("%s: control run exited 0, so the disabled case would pass vacuously", c.sub)
			}
		} else if strings.TrimSpace(control.stdout) == "" {
			t.Fatalf("%s: control run was silent, so the disabled case would pass vacuously", c.sub)
		}

		off := runEnv(t, c.sub, c.payload, "GATES_DISABLE="+c.sub)
		if off.code != 0 {
			t.Errorf("%s disabled: exit %d, want 0 (stderr: %s)", c.sub, off.code, off.stderr)
		}
		if strings.TrimSpace(off.stdout) != "" {
			t.Errorf("%s disabled: stdout %q, want empty", c.sub, off.stdout)
		}
		if strings.TrimSpace(off.stderr) != "" {
			t.Errorf("%s disabled: stderr %q, want empty", c.sub, off.stderr)
		}
	}
}

func TestDisableIsPerGuard(t *testing.T) {
	// Disabling one guard must not silence its neighbours.
	payload := grep("handleSubmit")
	r := runEnv(t, "lsp-first", payload, "GATES_DISABLE=design-gate,agent-model")
	if strings.TrimSpace(r.stdout) == "" {
		t.Errorf("lsp-first went silent while only design-gate and agent-model were disabled")
	}
}

func bashPayload(command string) string {
	return `{"tool_name":"Bash","tool_input":{"command":` + mustJSON(command) + `}}`
}
