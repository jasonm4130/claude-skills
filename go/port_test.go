package main

import (
	"strings"
	"testing"
)

func TestPatternsAllCompile(t *testing.T) {
	if got, want := len(compilePatterns()), len(scaffoldPatternSources); got != want {
		t.Fatalf("compiled %d of %d scaffold patterns", got, want)
	}
}

// The `(?!-)` → `[^-]` rewrite is equivalence-preserving only because a head can
// never end in whitespace. Heads come from joining tokens with single spaces,
// and the tokenizer never emits a trailing empty token.
func TestDotnetTrailingWhitespaceIsUnreachable(t *testing.T) {
	for _, cmd := range []string{"dotnet new ", "dotnet new\t", "dotnet new  \n"} {
		for _, tokens := range parseSegments(cmd) {
			head := strings.Join(tokens, " ")
			if head != strings.TrimRight(head, " \t\r\n") {
				t.Fatalf("head ended in whitespace: %q", head)
			}
		}
	}
}

func TestIsScaffold(t *testing.T) {
	pats := compilePatterns()
	yes := []string{
		"npm create vite", "cargo new myproj", "create-next-app my-app",
		"npx --yes create-vite", "dotnet new console", "hugo new site blog",
		"NPM CREATE VITE", "FOO=bar sudo npm create vite",
		"mkdir app && cd app && npm create vite",
	}
	for _, c := range yes {
		if !isScaffold(c, pats) {
			t.Errorf("expected scaffold: %q", c)
		}
	}
	no := []string{
		"ls -la", "npm install", "npm init -y", "dotnet new --list",
		"docker create foo", "createdb mydb", "FOO=bar sudo ls",
		`git commit -m "npm create vite"`, "echo 'cargo new x'",
		"cat <<EOF\nnpm create vite\nEOF",
	}
	for _, c := range no {
		if isScaffold(c, pats) {
			t.Errorf("unexpected scaffold: %q", c)
		}
	}
}

// Go's (?i) folds over Unicode; a JS regex without the `u` flag does not. The
// KELVIN SIGN and LATIN SMALL LETTER LONG S are the reachable cases.
func TestASCIIFoldDoesNotMatchUnicodeCaseEquivalents(t *testing.T) {
	pats := compilePatterns()
	for _, c := range []string{"cargo neſ x", "Kargo new x"} {
		if isScaffold(c, pats) {
			t.Errorf("Unicode case folding leaked: %q", c)
		}
	}
}

func TestSignals(t *testing.T) {
	if got := signals("agent('a'); agent ('b')").agentCount; got != 2 {
		t.Errorf("agentCount = %d, want 2", got)
	}
	// `subagent(` must not count — `\b` requires a non-word char before.
	if got := signals("subagent('a')").agentCount; got != 0 {
		t.Errorf("subagent counted: %d", got)
	}
	// JS `\s` is not ASCII-only; a non-breaking space must still count.
	if got := signals("agent ('a')").agentCount; got != 1 {
		t.Errorf("NBSP-separated agent() not counted: %d", got)
	}
	if !signals("while (x) {}").loopy {
		t.Error("NBSP-separated while() not detected")
	}
	for _, s := range []string{"await parallel(xs)", "await pipeline(xs, f)"} {
		if !signals(s).fanout {
			t.Errorf("no fan-out detected in %q", s)
		}
	}
	if signals("const x = 1").loopy {
		t.Error("false loop signal")
	}
}

func TestDescribeOnlyFiredSignals(t *testing.T) {
	cases := []struct {
		in   signalSet
		want string
	}{
		{signalSet{agentCount: 1}, "~1 agent() call"},
		{signalSet{fanout: true}, "parallel/pipeline fan-out"},
		{signalSet{agentCount: 3, fanout: true, loopy: true},
			"~3 agent() calls + parallel/pipeline fan-out + a spawn loop"},
	}
	for _, c := range cases {
		if got := describe(c.in); got != c.want {
			t.Errorf("describe = %q, want %q", got, c.want)
		}
	}
}

func TestJSONStringMatchesStringify(t *testing.T) {
	cases := [][2]string{
		{"a\"b", `"a\"b"`},
		{"a\\b", `"a\\b"`},
		{"a\nb", `"a\nb"`},
		{"a\x01b", `"a` + `\u0001` + `b"`},
		{"a…b", `"a…b"`},
		// SetEscapeHTML(false) semantics: < and > stay literal.
		{"<REDACTED>", `"<REDACTED>"`},
	}
	for _, c := range cases {
		if got := jsonString(c[0]); got != c[1] {
			t.Errorf("jsonString(%q) = %s, want %s", c[0], got, c[1])
		}
	}
}

func TestTruncatesOnUTF16Units(t *testing.T) {
	if got := truncateUTF16("abc", 80, 77); got != "abc" {
		t.Errorf("short string truncated: %q", got)
	}
	long := strings.Repeat("x", 81)
	out := truncateUTF16(long, 80, 77)
	if len([]rune(out)) != 78 || !strings.HasSuffix(out, "…") {
		t.Errorf("long truncation wrong: %q", out)
	}
	// An emoji is two UTF-16 units but one rune — the JS length check counts
	// two, so a string of 41 emoji (82 units) must truncate.
	emoji := strings.Repeat("😀", 41)
	if !strings.HasSuffix(truncateUTF16(emoji, 80, 77), "…") {
		t.Error("emoji string not truncated on UTF-16 units")
	}
}

func TestParsePayload(t *testing.T) {
	// Parsed fine, just not a payload — node agrees there is nothing to do.
	for _, raw := range []string{"[1,2]", "null", `"str"`, "7"} {
		if _, why := parsePayload([]byte(raw)); why != readNotAnObject {
			t.Errorf("%s: why = %v, want readNotAnObject", raw, why)
		}
	}
	if _, why := parsePayload(nil); why != readEmpty {
		t.Error("empty input should be readEmpty")
	}
	if _, why := parsePayload([]byte("{}")); why != readOK {
		t.Error("{} should be readOK")
	}
	// The bypass this exists to close: legal JSON that JSON.parse accepts and
	// this program cannot represent. Exiting 0 here would mean the `|| node`
	// fallback never runs and the guard is silently skipped.
	if _, why := parsePayload([]byte(`{"tool_input":{"command":"npm create vite \ud800"}}`)); why != readUnparseable {
		t.Error("lone surrogate must be declined, not silently substituted")
	}
	// A well-formed pair is representable and must NOT be declined.
	if _, why := parsePayload([]byte(`{"a":"😀"}`)); why != readOK {
		t.Error("a valid surrogate pair was declined")
	}
	// An escaped backslash is not an escape introducer.
	if _, why := parsePayload([]byte(`{"a":"\\ud800"}`)); why != readOK {
		t.Error(`"\\ud800" is a literal, not a lone surrogate`)
	}
	if _, why := parsePayload([]byte("{not json")); why != readUnparseable {
		t.Error("malformed JSON should be readUnparseable")
	}
}
