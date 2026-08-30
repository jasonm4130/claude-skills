package main

import (
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
)

// File-scope allow: if the search explicitly targets non-code files
// (config/data/docs), LSP cannot index them — let snake_case keys etc. through.
// glob and path are checked separately, each end-anchored, so a code-looking
// substring elsewhere in the path (e.g. `work.log-analyzer/src`) cannot disable
// the guard.
var (
	nonCodeExt  = regexp.MustCompile(`(?i)\.(json|ya?ml|toml|sh|bash|zsh|md|markdown|txt|env|plist|conf|ini|cfg|lock|log|csv|tsv)$`)
	nonCodeType = regexp.MustCompile(`(?i)^(json|yaml|md|markdown|sh|bash|toml|config|txt|csv|log)$`)

	trailingWordBoundary = regexp.MustCompile(`\\b$`)
)

// Patterns that are clearly not code symbol lookups.
func allowPatterns() []*regexp.Regexp {
	return compileAll(
		`^.{1,3}$`, // short patterns (likely text search)
		// TODO/FIXME/HACK comments — case-sensitive, word boundary (so `warnUser`,
		// `NoteEditor` do not slip through as `WARN`/`NOTE`)
		`^(TODO|FIXME|HACK|NOTE|XXX|WARN)\b`,
		`^["'].*["']$`, // string literals / log messages
		// Escape hatch — deliberate: append `(?:)` (an empty non-capturing group)
		// to the end of the original pattern to bypass this guard when LSP cannot
		// help. `(?:)` matches the empty string, so it is a zero-width no-op that
		// does not change what Grep actually matches — unlike wrapping the pattern
		// in quotes (which searches for the literal quoted string instead of the
		// identifier and silently returns nothing).
		`\(\?:\)$`,
		`\.\w{1,4}$`, // file paths and extensions
		// Config keys — all-lowercase dotted form only. Mixed-case dotted patterns
		// (`this.handleSubmit`, `React.Component`) fall through to the method-call
		// rule below instead.
		`^[a-z0-9_-]+(\.[a-z0-9_-]+)+$`,
		`^(import|require|from)\s`, // import/require/from statements
		`^[.#][\w-]+`,              // CSS classes / HTML attributes
		`[\\()\[\]{}|+?*]{3,}`,     // regex-heavy (user is doing a real regex search)
		`^[A-Z][A-Z0-9_]{2,}$`,     // environment variables
		`^(https?:|/|\.\./)`,       // URLs and paths
		// Error messages — message-like only (a word followed by whitespace/colon),
		// not bare identifiers like `handleError` or `ErrorBoundary`
		`(?i)\b(error|warning|failed|exception)\b[\s:]`,
		`^\d+\.\d+`, // version strings
	)
}

// Patterns that look like a code symbol, i.e. something LSP answers better.
func codeSymbolPatterns() []*regexp.Regexp {
	return compileAll(
		`^[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*$`,        // camelCase
		`^[A-Z][a-z]+[A-Z][a-zA-Z0-9]*$`,              // PascalCase
		`^[a-z][a-z0-9]*(_[a-z][a-z0-9]*){1,}$`,       // snake_case, multiple segments
		`^[A-Z][a-zA-Z0-9]*(_[A-Za-z][a-zA-Z0-9]*)+$`, // Pascal_Snake, e.g. `User_Model`
		`^[A-Z][a-zA-Z0-9]{3,}$`,                      // class/type: uppercase, 4+ chars
		`^[a-zA-Z_]\w*\s*\(`,                          // function call
		`^[a-zA-Z_]\w*\.[a-zA-Z_]\w*$`,                // method: word.word
		`^@[a-zA-Z]`,                                  // decorator/annotation
		`^(class|interface|type|enum|struct|trait|fn|def|function|const|let|var)\s+\w+`, // declaration keyword
	)
}

func compileAll(exprs ...string) []*regexp.Regexp {
	out := make([]*regexp.Regexp, 0, len(exprs))
	for _, e := range exprs {
		out = append(out, regexp.MustCompile(e))
	}
	return out
}

func matchesAny(res []*regexp.Regexp, s string) bool {
	for _, re := range res {
		if re.MatchString(s) {
			return true
		}
	}
	return false
}

// The language servers this guard can actually redirect someone to, keyed by
// the file extensions and Grep `type` values that imply them.
var languageServers = map[string]string{
	"rs": "rust-analyzer",

	"ts": "typescript-language-server", "tsx": "typescript-language-server",
	"mts": "typescript-language-server", "cts": "typescript-language-server",
	"js": "typescript-language-server", "jsx": "typescript-language-server",
	"mjs": "typescript-language-server", "cjs": "typescript-language-server",
	"typescript": "typescript-language-server", "javascript": "typescript-language-server",

	"py": "pyright", "pyi": "pyright", "python": "pyright",

	"rust": "rust-analyzer",
}

var extFromScope = regexp.MustCompile(`\.([A-Za-z0-9]+)$`)

// serverFor names the language server implied by a Grep's file scope, or "" if
// the scope does not pin a language.
func serverFor(in toolInput) string {
	if s, ok := languageServers[strings.ToLower(in.Type)]; ok {
		return s
	}
	for _, scope := range []string{in.Glob, in.Path} {
		if m := extFromScope.FindStringSubmatch(scope); m != nil {
			if s, ok := languageServers[strings.ToLower(m[1])]; ok {
				return s
			}
		}
	}
	return ""
}

// lspIsUsable reports whether the guard has a working server to point at.
//
// This is the lesson of the guard's own removal on 2026-08-26: it was deleted
// for "zero LSP adoption" when the real cause was that rust-analyzer and
// tsserver were both dead, so every nudge it emitted was unactionable. A guard
// that redirects to a tool that cannot run is worse than no guard, so it now
// checks before denying.
//
// When the Grep pins a language, that language's server must resolve. When it
// does not, any one of them resolving is enough. exec.LookPath is a PATH stat,
// not an exec, so this stays well under a millisecond.
func lspIsUsable(in toolInput) bool {
	if want := serverFor(in); want != "" {
		_, err := exec.LookPath(want)
		return err == nil
	}
	for _, bin := range []string{"rust-analyzer", "typescript-language-server", "pyright"} {
		if _, err := exec.LookPath(bin); err == nil {
			return true
		}
	}
	return false
}

// lspFirst intercepts Grep calls searching for code symbols and suggests LSP
// instead. It is an ADVISORY guard and fails OPEN throughout: an unreadable or
// unparseable payload, a non-Grep tool, or an unavailable language server all
// exit 0.
func lspFirst(raw []byte) {
	in, why := readTypedPayload(raw)
	if why != readOK {
		os.Exit(0)
	}
	// Grep carries the pattern and scope as fields; Bash carries the same search
	// inside a shell command, which parseBashSearch re-expresses as the identical
	// shape. Everything downstream is then common to both, so the classification
	// rules below have exactly one definition.
	var scope toolInput
	switch in.ToolName {
	case "Grep":
		scope = in.ToolInput
	case "Bash":
		parsed, ok := parseBashSearch(in.ToolInput.Command)
		if !ok {
			os.Exit(0)
		}
		scope = parsed
	default:
		os.Exit(0)
	}

	// The actual pattern as passed to the tool — used verbatim in output. The
	// tool call itself is never altered by this hook.
	pattern := scope.Pattern
	if pattern == "" {
		os.Exit(0)
	}

	// Normalise for classification only: strip one trailing `\b` word-boundary
	// anchor and unescape `\(`/`\)`, so e.g. `getUserData\b` and `fetchData\(`
	// classify the same as their bare forms `getUserData` / `fetchData(`.
	classify := trailingWordBoundary.ReplaceAllString(pattern, "")
	classify = strings.ReplaceAll(classify, `\(`, "(")
	classify = strings.ReplaceAll(classify, `\)`, ")")

	if nonCodeExt.MatchString(scope.Glob) ||
		nonCodeExt.MatchString(scope.Path) ||
		nonCodeType.MatchString(scope.Type) {
		os.Exit(0)
	}

	if matchesAny(allowPatterns(), classify) {
		os.Exit(0)
	}
	if !matchesAny(codeSymbolPatterns(), classify) {
		os.Exit(0)
	}
	if !lspIsUsable(scope) {
		os.Exit(0)
	}

	// The escape hatch is described in terms of what the caller actually ran, so
	// the instruction is executable as written. Naming "Grep" at a Bash caller
	// is the bug class this repo already tests for in hook-emitted skill names:
	// an instruction the agent cannot follow is worse than no instruction.
	noun := "Grep"
	if in.ToolName == "Bash" {
		noun = "search command"
	}
	deny(fmt.Sprintf(`LSP-FIRST: "%s" looks like a code symbol. Use the LSP tool instead:
  - To find where it's defined: LSP goToDefinition
  - To find all usages: LSP findReferences
  - To check its type: LSP hover
  - To list symbols in a file: LSP documentSymbol

  Only use a text search if LSP returns no results or you're searching non-code files.

  If the LSP tool is unavailable for this file type or returned no results, re-run this exact %s with (?:) appended to the end of the pattern (pattern(?:)) to bypass this guard — that's a zero-width match, so it doesn't change what is actually searched for.`, pattern, noun))
}
