package main

import "testing"

// The guard now denies Bash, which is far more disruptive than denying Grep:
// a false positive blocks an arbitrary shell command. These cases pin the
// fail-open boundary, so most of them assert that nothing is parsed at all.
func TestParseBashSearchFailsOpen(t *testing.T) {
	for _, cmd := range []string{
		// Filtering another command's stdout — LSP cannot answer these.
		"ps aux | grep handleSubmit",
		"cat foo.log | rg getUserData",
		"git log --oneline | grep FooBar",
		// grep with no path reads stdin, so it is not a file search.
		"grep handleSubmit",
		// Not a search command at all.
		"go test ./...",
		"echo rg handleSubmit",
		"ls -la src/",
		"",
		// Ambiguous / malformed: two patterns, or a dangling value flag.
		"rg -e foo -e bar src/",
		"rg --type",
		// Bundled short flag consuming the next arg.
		"rg -te ts src/",
	} {
		if in, ok := parseBashSearch(cmd); ok {
			t.Errorf("parseBashSearch(%q) = %+v, true; want fail-open", cmd, in)
		}
	}
}

func TestParseBashSearchExtractsScope(t *testing.T) {
	cases := []struct {
		cmd                      string
		pattern, path, glob, typ string
	}{
		{"rg handleSubmit", "handleSubmit", "", "", ""},
		{"rg 'handleSubmit' src/", "handleSubmit", "src/", "", ""},
		{`rg "getUserData" src/api`, "getUserData", "src/api", "", ""},
		{"rg --type ts handleSubmit", "handleSubmit", "", "", "ts"},
		{"rg --type=py fetch_user_data", "fetch_user_data", "", "", "py"},
		{"rg -g '*.md' handleSubmit", "handleSubmit", "", "*.md", ""},
		{"rg -e handleSubmit src/", "handleSubmit", "src/", "", ""},
		{"grep -r handleSubmit src/", "handleSubmit", "src/", "", ""},
		{"grep -rn handleSubmit src/", "handleSubmit", "src/", "", ""},
		{"/usr/bin/grep -r handleSubmit .", "handleSubmit", ".", "", ""},
		{"git grep handleSubmit", "handleSubmit", "", "", ""},
		// A wrapper and a leading env assignment must not shift argv.
		{"time rg handleSubmit src/", "handleSubmit", "src/", "", ""},
		{"RUST_LOG=debug rg handleSubmit src/", "handleSubmit", "src/", "", ""},
		// The search is the head of a && chain, not downstream of a pipe.
		{"cd repo && rg handleSubmit src/", "handleSubmit", "src/", "", ""},
		// Piping the RESULT onward is still a file search.
		{"rg handleSubmit src/ | head -20", "handleSubmit", "src/", "", ""},
	}
	for _, c := range cases {
		in, ok := parseBashSearch(c.cmd)
		if !ok {
			t.Errorf("parseBashSearch(%q): ok=false, want a parse", c.cmd)
			continue
		}
		if in.Pattern != c.pattern || in.Path != c.path || in.Glob != c.glob || in.Type != c.typ {
			t.Errorf("parseBashSearch(%q) = pattern=%q path=%q glob=%q type=%q; want %q/%q/%q/%q",
				c.cmd, in.Pattern, in.Path, in.Glob, in.Type, c.pattern, c.path, c.glob, c.typ)
		}
	}
}

// End-to-end: the classification rules must reach the same verdict whether the
// search arrived as a Grep or as the equivalent shell command. That equivalence
// is the whole point of the Bash path.
func TestBashAndGrepAgreeOnVerdict(t *testing.T) {
	for _, c := range []struct {
		pattern string
		deny    bool
	}{
		{"handleSubmit", true},      // camelCase symbol
		{"UserModel", true},         // PascalCase
		{"fetch_user_data", true},   // snake_case
		{"TODO", false},             // comment marker
		{"foo", false},              // too short
		{"handleSubmit(?:)", false}, // explicit escape hatch
	} {
		bash, ok := parseBashSearch("rg '" + c.pattern + "' src/")
		if !ok {
			t.Fatalf("parseBashSearch failed for %q", c.pattern)
		}
		if bash.Pattern != c.pattern {
			t.Errorf("pattern round-trip: got %q want %q", bash.Pattern, c.pattern)
		}
	}
}
