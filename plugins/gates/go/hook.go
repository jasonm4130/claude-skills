// Shared hook plumbing for every ccguard subcommand.
//
// This is the Go counterpart of the `readStdin` / `safeJsonParse` /
// `emitPermissionDecision` trio that every plugin's `scripts/lib.mjs` carries
// its own copy of, and of `rust/src/hook.rs` which it replaces. There is
// exactly one copy here, because a Go module can do what a Claude Code plugin
// cannot: share code across boundaries.
//
// Every function is written to be panic-free on hostile input. A panic exits
// non-zero and non-2, which Claude Code reads as a non-blocking hook error and
// therefore fails open. That is an acceptable last resort, not a design.
package main

import (
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// Why the payload could not be used. The cases are kept apart because callers
// answer them differently: "not an object" and "empty" are both a legitimate
// "nothing to guard", while "unparseable" means this program cannot represent
// the payload at all and must hand it to the reference implementation.
type readFailure int

const (
	readOK readFailure = iota
	readEmpty
	readUnreadable
	readUnparseable
	readNotAnObject
)

// readStdin reads the whole payload as raw bytes.
//
// The JS original decodes with `Buffer.toString("utf8")`, which replaces
// invalid sequences with U+FFFD rather than throwing. Go's `encoding/json`
// does the same substitution while decoding string values, so malformed input
// reaches the guards in the same shape it would under node. Keeping the raw
// bytes (rather than a pre-decoded string) also means a delegation hands node
// exactly what arrived.
func readStdin() ([]byte, bool) {
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		return nil, false
	}
	return raw, true
}

// parsePayload parses JSON without failing loudly, mirroring `safeJsonParse`.
//
// Returns readEmpty / readNotAnObject — nothing to guard — for empty input and,
// matching the JS contract exactly, for any valid JSON that is not an object.
// `safeJsonParse` rejects `null`, arrays, numbers and strings via its
// `typeof !== "object"` and explicit null checks; a bare `[1,2]` must not be
// treated as a payload here either, or the guards would read fields off
// something that has none. In all those cases node reaches the same "do
// nothing" answer, so exiting 0 is right.
//
// A non-object payload must be rejected explicitly rather than being decoded
// into a zero-valued struct: `json.Unmarshal` of `null` into a struct succeeds
// and silently leaves every field zero, which would make a guard act as though
// it had scanned input it never saw. That was a real shipped bug.
//
// Returns readUnparseable when the parse itself failed, which is NOT the same
// answer. The caller must decline (see delegate) rather than exit 0: under
// `ccguard || node`, a zero exit means node never runs, so treating an
// unparseable payload as "nothing to do" silently disables the guard for it.
// That was a live bypass — a single lone surrogate anywhere in a Bash command
// turned the design gate off.
func parsePayload(raw []byte) (map[string]any, readFailure) {
	if len(raw) == 0 {
		return nil, readEmpty
	}
	// A lone surrogate escape (`"\ud800"`) is legal JSON that `JSON.parse`
	// accepts and carries in a JS string. Go's decoder does not reject it — it
	// silently substitutes U+FFFD, which would make this program answer a
	// *different* question than node did on the same bytes. Detect it up front
	// and decline, so the reference implementation decides instead.
	if hasLoneSurrogateEscape(raw) {
		return nil, readUnparseable
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, readUnparseable
	}
	obj, isObject := v.(map[string]any)
	if !isObject {
		return nil, readNotAnObject
	}
	return obj, readOK
}

// hasLoneSurrogateEscape reports whether the raw JSON text contains a `\uXXXX`
// escape naming a surrogate that is not part of a well-formed pair.
//
// Only escapes count: a backslash that is itself escaped (`\\uD800`) is a
// literal backslash followed by text, not an escape.
func hasLoneSurrogateEscape(raw []byte) bool {
	s := string(raw)
	for i := 0; i < len(s); {
		if s[i] != '\\' {
			i++
			continue
		}
		// Count the run of backslashes; an even-length run escapes itself and
		// leaves the following character unescaped.
		j := i
		for j < len(s) && s[j] == '\\' {
			j++
		}
		if (j-i)%2 == 0 {
			i = j
			continue
		}
		// s[j-1] is an escaping backslash; s[j] is the escaped character.
		if j >= len(s) || (s[j] != 'u' && s[j] != 'U') {
			i = j + 1
			continue
		}
		hi, ok := hex4(s, j+1)
		if !ok {
			i = j + 1
			continue
		}
		next := j + 5
		if hi >= 0xd800 && hi <= 0xdbff {
			// High surrogate — must be followed immediately by a `\uDC00`-`\uDFFF`
			// escape.
			if next+5 < len(s) && s[next] == '\\' && (s[next+1] == 'u' || s[next+1] == 'U') {
				if lo, ok := hex4(s, next+2); ok && lo >= 0xdc00 && lo <= 0xdfff {
					i = next + 6
					continue
				}
			}
			return true
		}
		if hi >= 0xdc00 && hi <= 0xdfff {
			return true // a low surrogate with no high before it
		}
		i = next
	}
	return false
}

func hex4(s string, at int) (int, bool) {
	if at+4 > len(s) {
		return 0, false
	}
	v := 0
	for k := at; k < at+4; k++ {
		c := s[k]
		switch {
		case c >= '0' && c <= '9':
			v = v*16 + int(c-'0')
		case c >= 'a' && c <= 'f':
			v = v*16 + int(c-'a') + 10
		case c >= 'A' && c <= 'F':
			v = v*16 + int(c-'A') + 10
		default:
			return 0, false
		}
	}
	return v, true
}

// outcome is what a guard did with a payload it was handed.
type outcome int

const (
	// outcomeHandled: a decision was reached, or there was legitimately none to
	// make. Exit 0.
	outcomeHandled outcome = iota
	// outcomeDeclined: this guard cannot reproduce the reference
	// implementation's answer for this payload. Exit via delegate having
	// written nothing.
	outcomeDeclined
)

// delegate hands the payload to the `.mjs` guard, forwards its answer, and exits.
//
// **Why this spawns node rather than exiting non-zero.** hooks.json invokes the
// binary as `ccguard <sub> <guard>.mjs || node <guard>.mjs`, and the `||` looks
// like it would do this for free. It cannot. By the time any guard here can tell
// it needs to decline, readStdin has already drained the pipe — the shell has
// no way to rewind it, so the node in that `||` reads zero bytes and decides
// nothing. Measured, not assumed. That `||` earns its place for the one case it
// does handle — a binary that never execs (absent, or built for another
// architecture), where stdin is still untouched — and no other.
//
// So delegation has to be done by the process holding the bytes. Stdout is
// inherited, so node writes its decision straight to the real stdout with no
// re-encoding, and its exit status becomes ours.
//
// Only sound when nothing has been written to stdout yet: node writes its own
// decision, and two decisions on stdout is a protocol violation.
//
// If node cannot be spawned — which is the state this whole binary exists to
// tolerate — there is nothing left to consult, so exit 0 and let the tool call
// proceed. That is the same fail-open the `.mjs` guards already have on a
// machine without node.
func delegate(raw []byte, fallback string) {
	if fallback == "" {
		os.Exit(0)
	}
	cmd := exec.Command("node", fallback)
	cmd.Stdout = os.Stdout
	sink, err := cmd.StdinPipe()
	if err != nil {
		os.Exit(0)
	}
	if err := cmd.Start(); err != nil {
		os.Exit(0)
	}
	// A guard that reads only a prefix and exits would give us EPIPE here. Its
	// decision is still on stdout and still authoritative, so this is not a
	// failure — carry on to the status.
	_, _ = sink.Write(raw)
	_ = sink.Close()
	if err := cmd.Wait(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			os.Exit(ee.ExitCode())
		}
		os.Exit(0)
	}
	os.Exit(0)
}

// nestedStr reads a nested string field, e.g. ("tool_input", "command").
//
// Returns "" when any level is missing or the leaf is not a string, which
// collapses the JS `typeof x?.y === "string" ? x.y : ""` dance into one call.
func nestedStr(payload map[string]any, parent, key string) string {
	p, ok := payload[parent].(map[string]any)
	if !ok {
		return ""
	}
	s, _ := p[key].(string)
	return s
}

// topStr reads a top-level string field.
func topStr(payload map[string]any, key string) string {
	s, _ := payload[key].(string)
	return s
}

// jsonString escapes a string as a JSON string literal, including the
// surrounding quotes.
//
// Hand-rolled rather than delegated to `json.Marshal` so that no output path
// can depend on encoder defaults. The escape set matches `JSON.stringify`:
// quote, backslash, the four named control escapes, and `\u00XX` for every
// other C0 control character. `<` and `>` are NOT escaped — this is
// SetEscapeHTML(false) semantics, and the reason strings are read by a human.
// Non-ASCII is emitted raw, which `JSON.stringify` does too and which matters
// because the guard reasons contain a literal `…`.
func jsonString(s string) string {
	var out strings.Builder
	out.Grow(len(s) + 2)
	out.WriteByte('"')
	for _, c := range s {
		switch c {
		case '"':
			out.WriteString(`\"`)
		case '\\':
			out.WriteString(`\\`)
		case '\n':
			out.WriteString(`\n`)
		case '\r':
			out.WriteString(`\r`)
		case '\t':
			out.WriteString(`\t`)
		case '\b':
			out.WriteString(`\b`)
		case '\f':
			out.WriteString(`\f`)
		default:
			if c < 0x20 {
				const hexdig = "0123456789abcdef"
				out.WriteString(`\u00`)
				out.WriteByte(hexdig[(c>>4)&0xf])
				out.WriteByte(hexdig[c&0xf])
			} else {
				out.WriteRune(c)
			}
		}
	}
	out.WriteByte('"')
	return out.String()
}

// emitPermissionDecision writes a PreToolUse permission-decision envelope on
// stdout.
//
// `deny` feeds `reason` back to Claude as feedback; `ask` prompts the user;
// `allow` skips the interactive prompt.
//
// The object is built by string concatenation rather than through a map and a
// serializer so that key order is pinned by construction, byte-for-byte against
// the `.mjs` references. Go's `encoding/json` sorts map keys alphabetically,
// and while that order happens to coincide with the JS insertion order today,
// depending on the coincidence would make the equivalence tests fragile.
func emitPermissionDecision(decision, reason string) {
	line := `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":` +
		jsonString(decision) + `,"permissionDecisionReason":` + jsonString(reason) + "}}\n"
	// A closed or broken stdout is not worth aborting over: the hook has already
	// decided, and a write failure means nobody is listening.
	_, _ = os.Stdout.WriteString(line)
}

// truncateUTF16 truncates for display exactly the way the JS guards do.
//
// `command.length > 80 ? command.slice(0, 77) + "…" : command` counts UTF-16
// code units, not bytes and not runes. A naive byte slice would both disagree
// with the JS output on any non-ASCII command and risk slicing mid-codepoint,
// so this converts through UTF-16 and back. Lone surrogates produced by cutting
// a pair in half are replaced, matching how such a string would render.
func truncateUTF16(s string, limit, keep int) string {
	units := utf16.Encode([]rune(s))
	if len(units) <= limit {
		return s
	}
	var out strings.Builder
	runes := utf16.Decode(units[:keep])
	for _, r := range runes {
		if r == utf8.RuneError {
			out.WriteRune(0xfffd)
			continue
		}
		out.WriteRune(r)
	}
	out.WriteString("…")
	return out.String()
}
