package main

// JavaScript's `\s`, spelled out.
//
// Go's `regexp` is RE2 with full Unicode support, but its `\s` is still the
// Perl class `[\t\n\f\r ]` — ASCII-only, exactly like `regex-lite`'s, and the
// gap is reachable. `workflow_model` regexes RAW SCRIPT TEXT — unlike
// `design_gate`, which tokenizes first and has therefore already consumed
// exotic whitespace as token content by the time any pattern runs. That
// divergence was once recorded as unreachable on the strength of the tokenizer
// argument; the argument is sound for the guard it was written about and does
// not extend to this one. Cross-family review caught it: `await agent ("x")`
// four times counted as zero `agent()` calls and four in node, so node denied
// the fan-out and the binary allowed it.
//
// Written as Go escapes so the regex engine only ever sees literal characters.
// The set is ECMA-262 `WhiteSpace` ∪ `LineTerminator`, which is exactly what
// JS `\s` matches.
const jsWSChars = "\t\n\v\f\r \u00a0\u1680" +
	"\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a" +
	"\u2028\u2029\u202f\u205f\u3000\ufeff"

const jsWS = "[" + jsWSChars + "]" // JS \s

// `\w` and `\b` are deliberately NOT redefined: JS's are ASCII-only too, and so
// are Go's, so they already agree.
