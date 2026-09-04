package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Config files whose corruption fails silently in the harness.
var guardedConfigs = map[string]bool{
	"settings.json":       true,
	"settings.local.json": true,
	".mcp.json":           true,
}

// resolveGuarded returns the absolute path for a guarded file named in a shell
// token.
func resolveGuarded(token, cwd string) string {
	home, err := os.UserHomeDir()
	if err == nil {
		if strings.HasPrefix(token, "~/") {
			token = home + token[1:]
		} else if strings.HasPrefix(token, "$HOME/") {
			token = home + token[len("$HOME"):]
		}
	}
	if filepath.IsAbs(token) {
		return token
	}
	if cwd == "" {
		if wd, err := os.Getwd(); err == nil {
			cwd = wd
		}
	}
	return filepath.Join(cwd, token)
}

// bashCandidates returns every guarded path merely MENTIONED in a Bash command.
//
// Deliberately no shell parsing: redirections, heredocs and `sed -i` are not
// inspected to work out which of these paths was actually written. Working that
// out correctly means implementing a shell, and getting it subtly wrong means
// the guard goes quiet exactly when it matters. Re-validating a file that was
// only read costs one parse and exits 0, so matching on the basename is the
// intended design — do not "improve" this into a redirect parser.
func bashCandidates(command, cwd string) []string {
	if command == "" {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	for _, raw := range strings.Fields(command) {
		token := strings.TrimSuffix(strings.TrimLeft(raw, `"'`), `"`)
		token = strings.TrimSuffix(token, `'`)
		if token == "" || !guardedConfigs[filepath.Base(token)] {
			continue
		}
		p := resolveGuarded(token, cwd)
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	return out
}

// editCandidate is the single candidate from an Edit/Write/MultiEdit payload.
func editCandidate(filePath string) []string {
	if filePath == "" || !guardedConfigs[filepath.Base(filePath)] {
		return nil
	}
	return []string{filePath}
}

// jsonConfigGuard re-parses a guarded config after it is written and reports a
// syntax error straight back to the model.
//
// Why this exists: Claude Code does not error on a malformed settings.json — it
// drops the block it cannot parse and carries on. A stray comma in the hooks
// object silently disables every guard here, and the failure surfaces a session
// later as "the hook stopped firing", with no error to trace it back to.
//
// PostToolUse runs after the write, so this cannot deny — it exits 2 with the
// parse error on stderr, which Claude Code feeds back to the model to fix now.
//
// This is an ADVISORY hook and fails OPEN: unreadable stdin, an unparseable
// payload, or a missing file exits 0. It exists to surface a mistake the model
// just made, not to wedge the session when the harness surprises it.
func jsonConfigGuard(raw []byte) {
	in, why := readTypedPayload(raw)
	if why != readOK {
		os.Exit(0) // fail open — not our payload to police
	}

	var candidates []string
	if in.ToolName == "Bash" {
		candidates = bashCandidates(in.ToolInput.Command, in.CWD)
	} else {
		candidates = editCandidate(in.ToolInput.FilePath)
	}

	var broken []string
	for _, path := range candidates {
		contents, err := os.ReadFile(path)
		if err != nil {
			// Never written, deleted, or moved between write and hook — not a
			// syntax problem.
			continue
		}
		// An empty file is valid state for a config Claude Code creates lazily.
		if len(strings.TrimSpace(string(contents))) == 0 {
			continue
		}
		var v any
		if err := json.Unmarshal(contents, &v); err != nil {
			broken = append(broken, fmt.Sprintf("%s is no longer valid JSON: %s", path, err))
		}
	}

	if len(broken) > 0 {
		fmt.Fprintf(os.Stderr, "%s\n\nClaude Code does not report this — it silently drops the config it cannot "+
			"parse, so hooks and permissions defined in this file stop applying. Fix the "+
			"syntax before continuing.\n", strings.Join(broken, "\n"))
		os.Exit(2)
	}
	os.Exit(0)
}
