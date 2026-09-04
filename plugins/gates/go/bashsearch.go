package main

import "strings"

// Auto mode routes every discovery call through Bash: across the 10 most recent
// transcripts on this machine, Grep and Glob were each called 0 times against
// 2,419 Bash calls. A guard matching only `Grep` therefore cannot fire at all,
// which is why this file exists — it re-expresses an `rg`/`grep` shell command
// as the same toolInput a Grep call would have produced, so lspFirst's
// classification rules apply unchanged to both.

// searchTools maps a search command to whether it searches FILES when given no
// path argument. `rg`/`ag`/`ack` default to recursing the working directory;
// `grep` with no path reads STDIN, so a bare `grep foo` is filtering, not
// searching, and LSP has nothing to offer it.
var searchTools = map[string]bool{
	"rg": true, "ag": true, "ack": true,
	"grep": false, "egrep": false, "fgrep": false,
}

// Flags that consume the following argument, so it is never mistaken for the
// pattern or a path. Value-attached forms (`--type=ts`) are handled separately.
var flagTakesValue = map[string]bool{
	"-e": true, "--regexp": true,
	"-t": true, "--type": true,
	"-g": true, "--glob": true, "--include": true, "--exclude": true,
	"-m": true, "--max-count": true,
	"-A": true, "-B": true, "-C": true,
	"--after-context": true, "--before-context": true, "--context": true,
	"--color": true, "--colour": true, "-f": true, "--file": true,
	"--type-not": true, "-T": true, "-M": true, "--max-columns": true,
	"-j": true, "--threads": true, "--sort": true, "--iglob": true,
}

// Wrappers that precede the real command without changing what it does.
var commandPrefixes = map[string]bool{
	"sudo": true, "command": true, "time": true, "nice": true, "builtin": true,
}

// shellTokens splits on unquoted whitespace, honouring single and double quotes.
// Backslash escapes are left in place: the caller's `classify` step already
// unescapes `\(` and `\)`, so `rg fetchData\(` lands on the same classification
// as the quoted form.
func shellTokens(s string) []string {
	var out []string
	var cur strings.Builder
	var quote rune
	started := false
	for _, r := range s {
		switch {
		case quote != 0:
			if r == quote {
				quote = 0
			} else {
				cur.WriteRune(r)
			}
		case r == '\'' || r == '"':
			quote = r
			started = true
		case r == ' ' || r == '\t':
			if started {
				out = append(out, cur.String())
				cur.Reset()
				started = false
			}
		default:
			cur.WriteRune(r)
			started = true
		}
	}
	if started {
		out = append(out, cur.String())
	}
	return out
}

// pipelineHeads returns the commands in a shell string that read from the
// filesystem rather than from another command's stdout. Segments after a `|`
// are excluded on purpose: `ps aux | grep handleSubmit` filters stdout, and
// redirecting that to LSP would be wrong, not merely noisy.
func pipelineHeads(s string) []string {
	var out []string
	var cur strings.Builder
	var quote rune
	afterPipe := false
	flush := func(pipe bool) {
		if !afterPipe {
			if seg := strings.TrimSpace(cur.String()); seg != "" {
				out = append(out, seg)
			}
		}
		cur.Reset()
		afterPipe = pipe
	}
	runes := []rune(s)
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		if quote != 0 {
			if r == quote {
				quote = 0
			}
			cur.WriteRune(r)
			continue
		}
		switch {
		case r == '\'' || r == '"':
			quote = r
			cur.WriteRune(r)
		case r == '|':
			// `||` separates commands; a single `|` pipes stdout onward.
			if i+1 < len(runes) && runes[i+1] == '|' {
				i++
				flush(false)
			} else {
				flush(true)
			}
		case r == '&' && i+1 < len(runes) && runes[i+1] == '&':
			i++
			flush(false)
		case r == ';' || r == '\n':
			flush(false)
		default:
			cur.WriteRune(r)
		}
	}
	flush(false)
	return out
}

// parseBashSearch re-expresses a shell search command as the toolInput an
// equivalent Grep call would have carried. ok is false whenever the command is
// not unambiguously a file search, so every unrecognised shape fails open.
func parseBashSearch(command string) (toolInput, bool) {
	for _, seg := range pipelineHeads(command) {
		if in, ok := parseSearchSegment(shellTokens(seg)); ok {
			return in, true
		}
	}
	return toolInput{}, false
}

func parseSearchSegment(tokens []string) (toolInput, bool) {
	// Strip wrappers and leading `FOO=bar` environment assignments.
	for len(tokens) > 0 {
		t := tokens[0]
		if commandPrefixes[t] || (strings.Contains(t, "=") && !strings.HasPrefix(t, "-")) {
			tokens = tokens[1:]
			continue
		}
		break
	}
	if len(tokens) == 0 {
		return toolInput{}, false
	}

	// `git grep` behaves like a recursive file search over the work tree.
	name := tokens[0]
	if name == "git" && len(tokens) > 1 && tokens[1] == "grep" {
		tokens = tokens[1:]
		searchesFilesByDefault := true
		return parseArgs(tokens[1:], searchesFilesByDefault)
	}
	// Tolerate an absolute or relative path to the tool (`/usr/bin/grep`).
	if i := strings.LastIndex(name, "/"); i >= 0 {
		name = name[i+1:]
	}
	recursiveByDefault, isSearch := searchTools[name]
	if !isSearch {
		return toolInput{}, false
	}
	return parseArgs(tokens[1:], recursiveByDefault)
}

func parseArgs(args []string, recursiveByDefault bool) (toolInput, bool) {
	var in toolInput
	var positional []string
	explicitPattern := ""
	recursive := recursiveByDefault
	sawEndOfFlags := false

	for i := 0; i < len(args); i++ {
		a := args[i]
		if sawEndOfFlags || !strings.HasPrefix(a, "-") || a == "-" {
			positional = append(positional, a)
			continue
		}
		if a == "--" {
			sawEndOfFlags = true
			continue
		}
		// `--type=ts`, `--include=*.py`
		if k, v, found := strings.Cut(a, "="); found && strings.HasPrefix(a, "--") {
			applyFlagValue(&in, k, v)
			continue
		}
		if flagTakesValue[a] {
			if i+1 >= len(args) {
				return toolInput{}, false // malformed; fail open
			}
			i++
			if a == "-e" || a == "--regexp" {
				if explicitPattern != "" {
					return toolInput{}, false // multiple patterns; too ambiguous to judge
				}
				explicitPattern = args[i]
			}
			applyFlagValue(&in, a, args[i])
			continue
		}
		// Bundled short flags, e.g. `-rn`, `-ri`.
		if !strings.HasPrefix(a, "--") {
			if strings.ContainsAny(a, "rR") {
				recursive = true
			}
			// A bundle ending in a value-taking flag (`-rte ts`) would consume
			// the next arg; treating that arg as a path is wrong, so bail.
			if last := a[len(a)-1:]; flagTakesValue["-"+last] {
				return toolInput{}, false
			}
		}
	}

	if explicitPattern != "" {
		in.Pattern = explicitPattern
	} else {
		if len(positional) == 0 {
			return toolInput{}, false
		}
		in.Pattern = positional[0]
		positional = positional[1:]
	}
	if in.Pattern == "" {
		return toolInput{}, false
	}

	// A search with no path that does not recurse the filesystem is reading
	// stdin — `grep foo` in a pipeline head, say — and LSP cannot answer it.
	if len(positional) == 0 && !recursive {
		return toolInput{}, false
	}
	if len(positional) > 0 && in.Path == "" {
		in.Path = positional[0]
	}
	return in, true
}

func applyFlagValue(in *toolInput, flag, value string) {
	switch flag {
	case "-t", "--type":
		in.Type = value
	case "-g", "--glob", "--include", "--iglob":
		if in.Glob == "" {
			in.Glob = value
		}
	}
}
