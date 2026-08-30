// PreToolUse hook (matcher: `Workflow`) — nudge Claude to tier models in
// high-fan-out Workflow scripts.
//
// Port of `plugins/gates/scripts/pretooluse-guard-workflow-model.mjs`.
//
// Three invocation forms, three responses:
//   - inline `script`  → inspect it; deny if it fans out untiered.
//   - `scriptPath`     → read the file and inspect the same way.
//   - `name`           → can't read or rewrite a built-in/saved workflow. If it
//     is a known high-fan-out one that inherits the session
//     model, ASK the user, because a deny-to-Claude cannot be
//     resolved — Claude can't edit a built-in, so it would
//     dead-end.
//
// Scale-gated: small/cheap inline/scriptPath workflows pass silently so the hook
// doesn't fight the Workflow tool's own "omit model by default" guidance.
package main

import (
	"os"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Named workflows known to spawn a high fan-out of agents on the session model,
// which Claude cannot edit — e.g. the built-in `deep-research` harness. The ask
// is a cost speed-bump on a frontier-tier session, not a claim about the
// workflow's own tiering.
var nameDenylist = []string{"deep-research"}

// Static fan-out signals extracted from a script.
type signalSet struct {
	agentCount int
	fanout     bool
	loopy      bool
}

// The patterns spell JS's `\s` out (see jsregex.go): Go's `\s` is ASCII-only,
// and this guard regexes RAW SCRIPT TEXT — unlike design_gate, which tokenizes
// first and has therefore already consumed exotic whitespace as token content by
// the time any pattern runs. `\w` and `\b` stay as they are, which is faithful
// because JS's `\w`/`\b` are ASCII-only too.
var (
	agentCallRe = regexp.MustCompile(`\bagent` + jsWS + `*\(`)
	whileRe     = regexp.MustCompile(`\bwhile` + jsWS + `*\(`)
	forRe       = regexp.MustCompile(`\bfor` + jsWS + `*\(`)
	modelKeyRe  = regexp.MustCompile(`\bmodel` + jsWS + `*:`)
)

// signals extracts the static fan-out cues. `agentCount` is a static lower
// bound: loops and `.map()` over items mean the real spawn count is higher, so
// fan-out/loop presence is the stronger cue.
func signals(script string) signalSet {
	return signalSet{
		agentCount: len(agentCallRe.FindAllStringIndex(script, -1)),
		fanout:     strings.Contains(script, "parallel(") || strings.Contains(script, "pipeline("),
		loopy: whileRe.MatchString(script) ||
			forRe.MatchString(script) ||
			strings.Contains(script, "budget.remaining"),
	}
}

// describe names only the signals that actually fired, so the reason never reads
// "~0 agent() calls".
func describe(s signalSet) string {
	var parts []string
	if s.agentCount >= 1 {
		plural := "s"
		if s.agentCount == 1 {
			plural = ""
		}
		parts = append(parts, "~"+strconv.Itoa(s.agentCount)+" agent() call"+plural)
	}
	if s.fanout {
		parts = append(parts, "parallel/pipeline fan-out")
	}
	if s.loopy {
		parts = append(parts, "a spawn loop")
	}
	return strings.Join(parts, " + ")
}

func workflowModel(p map[string]any, why readFailure) outcome {
	workflowModelDecide(p, why)
	// Script inspection is self-contained — no environment lookups, no encoding
	// this program cannot represent (bad bytes are decoded lossily, as node does).
	return outcomeHandled
}

func workflowModelDecide(p map[string]any, why readFailure) {
	// Only guard the Workflow tool. Anything else → proceed normally.
	if why != readOK {
		return
	}
	if topStr(p, "tool_name") != "Workflow" {
		return
	}

	// Resolve the inspectable script: inline first, then read scriptPath off disk.
	var script string
	haveScript := false
	if inline := nestedStr(p, "tool_input", "script"); inline != "" {
		script, haveScript = inline, true
	} else if path := nestedStr(p, "tool_input", "scriptPath"); path != "" {
		// Read BYTES and decode lossily — do not require valid UTF-8.
		//
		// The JS original's `readFileSync(path, "utf8")` replaces bad sequences
		// with U+FFFD and inspects the result. Treating a mis-encoded file as
		// unreadable made the guard fail OPEN on exactly the scripts most likely
		// to be machine-generated — a fan-out script with one stray byte was
		// denied by node and silently allowed here. Found by cross-family review,
		// reproduced, and pinned by a differential case that writes a real file
		// with an invalid byte.
		b, err := os.ReadFile(path)
		if err != nil {
			// Genuinely unreadable path (missing, no permission) → don't guess,
			// allow. This matches the JS catch.
			return
		}
		script, haveScript = lossyUTF8(b), true
	}

	// No inspectable script (a `name:` invocation). Ask the user only for the
	// denylisted high-fan-out names; leave every other named/saved workflow alone.
	if !haveScript {
		name := nestedStr(p, "tool_input", "name")
		for _, d := range nameDenylist {
			if name != "" && name == d {
				reason := "workflow-model-guard: the \"" + name + "\" workflow sets no per-agent model: override, so " +
					"every agent it spawns inherits this session's model — on a frontier-tier session " +
					"that is an expensive default, and it can't be tiered from here (it's not an " +
					"editable script). Cheaper: switch this session to Sonnet " +
					"(/model sonnet) before running it, or run a model-tiered workflow instead. Proceed anyway?"
				emitPermissionDecision("ask", reason)
				return
			}
		}
		return
	}

	// Bypass 1: any `model:` means Claude already weighed tiers (even one override
	// counts). Bypass 2: explicit ack that session-model fan-out is intended —
	// prevents an infinite deny loop.
	if modelKeyRe.MatchString(script) || strings.Contains(script, "model-guard:ack") {
		return
	}

	s := signals(script)
	expensive := s.agentCount >= 4 || s.fanout || (s.loopy && s.agentCount >= 1)
	if !expensive {
		return
	}

	reason := "workflow-model-guard: this workflow has " + describe(s) + " and no per-agent model: override — " +
		"every spawned agent defaults to the main-loop model, which burns usage limits fast " +
		"on frontier-tier sessions. Add model:'sonnet' (or 'haiku') to worker agents that " +
		"don't need the top tier. If the top tier is genuinely required for all of them, add a " +
		"`// model-guard:ack` comment to the script and re-run."

	emitPermissionDecision("deny", reason)
}

// lossyUTF8 decodes bytes the way node's `readFileSync(path, "utf8")` does:
// invalid sequences become U+FFFD rather than an error. Done byte-run by
// byte-run rather than with strings.ToValidUTF8, which collapses a whole run of
// bad bytes into a single replacement char where node emits one per maximal
// invalid subpart.
func lossyUTF8(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var out strings.Builder
	out.Grow(len(b))
	for len(b) > 0 {
		r, size := utf8.DecodeRune(b)
		if r == utf8.RuneError && size <= 1 {
			out.WriteRune(0xfffd)
			b = b[1:]
			continue
		}
		out.Write(b[:size])
		b = b[size:]
	}
	return out.String()
}
