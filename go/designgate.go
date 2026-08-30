// PreToolUse hook (matcher: `Bash`) — the brainstorming HARD-GATE, enforced.
//
// Port of `plugins/gates/scripts/pretooluse-guard-design-gate.mjs`. Behaviour is
// intended to be identical; `scripts/ccguard-differential.test.mjs` checks that
// against the JS implementation over the whole existing test corpus rather than
// taking this comment's word for it.
//
// The gate emits `ask`, never `deny`: a PreToolUse hook cannot see the
// conversation, so it cannot know whether a design was approved, and a deny the
// model has no way to resolve would dead-end. `ask` routes the checkpoint to the
// human, who can see whether design happened.
package main

import (
	"regexp"
	"strings"
)

// New-project scaffolders, anchored to the START of a cleaned command segment so
// a match means "this command scaffolds", not "this string mentions a
// scaffolder". Rare and distinctive by design: an `ask` false-positive costs one
// cheap confirmation.
//
// Two patterns differ textually from the JS originals because no
// finite-automata regex engine — RE2 included — supports lookaround. Both
// rewrites are equivalence-preserving, not approximations:
//
//   - `^npm\s+init\s+(?!-)[@\w]` → `^npm\s+init\s+[@\w]`. The `(?!-)` was pure
//     redundancy: `[@\w]` is `[@A-Za-z0-9_]`, which cannot match `-` anyway.
//     Identical language.
//
//   - `^dotnet\s+new\s+(?!-)` → `^dotnet\s+new\s+[^-]`. This one is load-bearing
//     (it is what distinguishes `dotnet new console` from `dotnet new --list`).
//     The rewrite consumes the character the lookahead only peeked at, so the two
//     differ in exactly one case: a head ending in whitespace right after `new`,
//     where `(?!-)` succeeds at end-of-input and `[^-]` has nothing to match.
//     That head cannot occur — heads are built by joining tokens with single
//     spaces, so trailing whitespace is impossible. Asserted in
//     TestDotnetTrailingWhitespaceIsUnreachable.
//
// `\s`/`\S` are written as the explicit JS whitespace set rather than Go's
// ASCII-only classes, and case-insensitivity is spelled out per letter rather
// than via `(?i)` — see jsregex.go for why both differ from the reference JS
// otherwise.
var scaffoldPatternSources = []string{
	// JS/TS package-manager scaffolders: `npm|pnpm|yarn|bun create <initializer>`.
	`^(?:npm|pnpm|yarn|bun)` + jsWS + `+create\b`,
	// `npm init <initializer>` (a template name, NOT a flag and NOT bare `npm init`).
	`^npm` + jsWS + `+init` + jsWS + `+[@\w]`,
	// `npx|bunx|pnpm dlx|yarn dlx [flags…] create-<x>` (optionally @scope/create-<x>).
	`^(?:npx|bunx|pnpm` + jsWS + `+dlx|yarn` + jsWS + `+dlx)` + jsWS + `+(?:-{1,2}[\w-]+(?:=` + jsNWS + `+)?` + jsWS + `+)*(?:@[\w.-]+/)?create-[\w-]+`,
	// A create-* binary invoked directly: `create-next-app my-app`.
	`^create-[\w-]+`,
	// Other ecosystems' project generators.
	`^cargo` + jsWS + `+(?:new|init)\b`,
	`^django-admin` + jsWS + `+start(?:project|app)\b`,
	`^rails` + jsWS + `+new\b`,
	`^ng` + jsWS + `+new\b`,
	`^nest` + jsWS + `+new\b`,
	`^vue` + jsWS + `+create\b`,
	`^expo` + jsWS + `+(?:init|create)\b`,
	`^flutter` + jsWS + `+create\b`,
	`^dotnet` + jsWS + `+new` + jsWS + `+[^-]`,
	`^mix` + jsWS + `+(?:new|phx\.new)\b`,
	`^laravel` + jsWS + `+new\b`,
	`^composer` + jsWS + `+create-project\b`,
	`^gatsby` + jsWS + `+new\b`,
	`^hugo` + jsWS + `+new` + jsWS + `+site\b`,
	`^jekyll` + jsWS + `+new\b`,
}

// compilePatterns compiles the scaffold patterns once.
//
// A malformed pattern is an authoring bug, not a runtime input problem, so an
// uncompilable entry is dropped rather than aborting the process: a guard that
// silently under-matches one scaffolder is a far better failure than one that
// kills every Bash call. TestPatternsAllCompile makes it loud in CI instead.
func compilePatterns() []*regexp.Regexp {
	out := make([]*regexp.Regexp, 0, len(scaffoldPatternSources))
	for _, p := range scaffoldPatternSources {
		if re, err := regexp.Compile(asciiFold(p)); err == nil {
			out = append(out, re)
		}
	}
	return out
}

// A pending heredoc: its terminator, and whether `<<-` tab-stripping applies.
type heredoc struct {
	delim string
	strip bool
}

func isWordByte(c rune) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_'
}

// parseSegments is a quote-aware shell tokenizer.
//
// Splits `command` into segments at UNQUOTED shell separators (`&&`, `||`, `;`,
// `|`, newline); each segment is a list of tokens with quote characters removed
// and whitespace collapsed. An unquoted `#` at a token boundary starts a comment
// to end of line. Heredoc bodies (`<<DELIM` … `DELIM`) are skipped entirely —
// they are literal text being written, not commands.
//
// This is what makes the gate quote-correct: a separator, `#`, or heredoc-body
// line is literal text, not structure. So `printf "a && npm create b"` is ONE
// `printf` command, `FOO="x # y" npm create …` keeps its `#` as data, and
// `cat <<EOF … npm create vite … EOF` runs only `cat`.
//
// Iterating runes where the JS iterates UTF-16 code units is safe here: every
// character with structural meaning is ASCII, so the two only differ in how they
// count the interior of a token, which nothing downstream inspects positionally.
func parseSegments(command string) [][]string {
	c := []rune(command)
	n := len(c)

	var segments [][]string
	var tokens []string
	var cur strings.Builder
	started := false // a token is in progress (may be an empty quoted "")
	var quote rune   // 0 when not inside quotes
	var heredocs []heredoc

	endTok := func() {
		if started {
			tokens = append(tokens, cur.String())
			cur.Reset()
			started = false
		}
	}
	endSeg := func() {
		endTok()
		if len(tokens) > 0 {
			segments = append(segments, tokens)
			tokens = nil
		}
	}

	for i := 0; i < n; {
		ch := c[i]

		if quote != 0 {
			// Inside "" a backslash escapes " \ $ ` (so \" is a literal quote, not
			// a close); inside '' nothing is special. Matches bash word-splitting.
			if quote == '"' && ch == '\\' && i+1 < n {
				next := c[i+1]
				if next == '"' || next == '\\' || next == '$' || next == '`' {
					cur.WriteRune(next)
					started = true
					i += 2
					continue
				}
				// backslash before a non-special char inside "" stays literal
				cur.WriteRune(ch)
				started = true
				i++
				continue
			}
			if ch == quote {
				quote = 0
			} else {
				cur.WriteRune(ch)
				started = true
			}
			i++
			continue
		}

		if ch == '\'' || ch == '"' {
			quote = ch
			started = true
			i++
			continue
		}

		if ch == '\\' {
			if i+1 < n {
				cur.WriteRune(c[i+1])
				started = true
				i += 2
			} else {
				i++
			}
			continue
		}

		if ch == '#' && !started {
			for i < n && c[i] != '\n' {
				i++
			}
			continue // the loop re-sees the newline as a separator
		}

		// Heredoc introducer: `<<`, optional `-`, optional ws, an (optionally
		// quoted) delimiter. Record it; the body is consumed at this line's newline.
		if ch == '<' && i+1 < n && c[i+1] == '<' {
			k := i + 2
			strip := false
			if k < n && c[k] == '-' {
				strip = true
				k++
			}
			for k < n && (c[k] == ' ' || c[k] == '\t') {
				k++
			}
			var q rune
			if k < n && (c[k] == '\'' || c[k] == '"') {
				q = c[k]
				k++
			}
			var delim strings.Builder
			if q != 0 {
				for k < n && c[k] != q {
					delim.WriteRune(c[k])
					k++
				}
				if k < n && c[k] == q {
					k++ // consume closing quote
				}
			} else if k < n && ((c[k] >= 'a' && c[k] <= 'z') || (c[k] >= 'A' && c[k] <= 'Z') || c[k] == '_') {
				// bare delimiters look like identifiers — avoids reading
				// `$((1<<2))` as one
				for k < n && (isWordByte(c[k]) || c[k] == '.' || c[k] == '-') {
					delim.WriteRune(c[k])
					k++
				}
			}
			if delim.Len() > 0 {
				heredocs = append(heredocs, heredoc{delim: delim.String(), strip: strip})
				i = k
				continue
			}
			// not a heredoc (e.g. a bare `<<`) → treat as ordinary chars
			cur.WriteRune(ch)
			started = true
			i++
			continue
		}

		if ch == '\n' {
			endSeg()
			if len(heredocs) > 0 {
				// Consume each pending heredoc's body: lines up to and including a
				// line equal to its delimiter (leading tabs stripped for `<<-`).
				j := i + 1
				for _, hd := range heredocs {
					for j < n {
						end := j
						for end < n && c[end] != '\n' {
							end++
						}
						line := string(c[j:end])
						cmp := line
						if hd.strip {
							cmp = strings.TrimLeft(line, "\t")
						}
						ranOut := end == n
						j = end + 1
						if cmp == hd.delim {
							break
						}
						if ranOut {
							break // ran out before the terminator
						}
					}
				}
				heredocs = nil
				i = j
				continue
			}
			i++
			continue
		}

		if ch == ';' {
			endSeg()
			i++
			continue
		}
		if ch == '&' && i+1 < n && c[i+1] == '&' {
			endSeg()
			i += 2
			continue
		}
		if ch == '|' && i+1 < n && c[i+1] == '|' {
			endSeg()
			i += 2
			continue
		}
		if ch == '|' {
			endSeg()
			i++
			continue
		}
		if ch == ' ' || ch == '\t' || ch == '\r' {
			endTok()
			i++
			continue
		}

		cur.WriteRune(ch)
		started = true
		i++
	}
	endSeg()
	return segments
}

// isEnvAssign matches `^[A-Za-z_]\w*=` — a leading environment assignment.
func isEnvAssign(token string) bool {
	rs := []rune(token)
	if len(rs) == 0 {
		return false
	}
	c := rs[0]
	if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_') {
		return false
	}
	for _, c := range rs[1:] {
		if c == '=' {
			return true
		}
		if !isWordByte(c) {
			return false
		}
	}
	return false
}

// isScaffold reports whether any command segment starts with a scaffold command.
//
// For each segment we drop leading env-assignments (`FOO=bar`) and `sudo`, then
// test the remaining head against the anchored scaffold patterns. Because
// matching is anchored to the segment head, a scaffolder appearing later in a
// quoted string (a commit message, an echo/printf argument) never matches — that
// segment's head is `git`/`echo`/etc.
func isScaffold(command string, patterns []*regexp.Regexp) bool {
	for _, tokens := range parseSegments(command) {
		i := 0
		for i < len(tokens) && (isEnvAssign(tokens[i]) || tokens[i] == "sudo") {
			i++
		}
		if i >= len(tokens) {
			continue
		}
		head := strings.Join(tokens[i:], " ")
		for _, re := range patterns {
			if re.MatchString(head) {
				return true
			}
		}
	}
	return false
}

func designGate(p map[string]any, why readFailure) outcome {
	designGateDecide(p, why)
	// Every path above is reproducible here: this guard reads one string field
	// and matches patterns against it. Nothing to hand back to node.
	return outcomeHandled
}

func designGateDecide(p map[string]any, why readFailure) {
	// Only guard the Bash tool. Anything else → proceed normally.
	if why != readOK {
		return
	}
	if topStr(p, "tool_name") != "Bash" {
		return
	}

	command := nestedStr(p, "tool_input", "command")
	// JS `String.prototype.trim` strips ECMA-262 WhiteSpace ∪ LineTerminator,
	// which is neither Go's `strings.TrimSpace` set (it includes U+0085 and omits
	// U+FEFF) nor Go's `\s`. Use the JS set verbatim.
	if strings.Trim(command, jsWSChars) == "" {
		return
	}

	// Escape hatch: an explicit ack (scaffold run legitimately after design approval).
	if strings.Contains(command, "design-gate:ack") {
		return
	}

	if !isScaffold(command, compilePatterns()) {
		return
	}

	shown := truncateUTF16(command, 80, 77)
	reason := "design-gate-guard: \"" + shown + "\" looks like a new-project scaffold. Per the " +
		"brainstorming HARD-GATE, don't scaffold or implement until a design has been " +
		"presented and the user has approved it. If you haven't brainstormed a design " +
		"yet, run the superpowers-core:brainstorming skill first. If the design was already approved (or " +
		"this isn't a fresh project), add `design-gate:ack` to the command to proceed."

	emitPermissionDecision("ask", reason)
}
