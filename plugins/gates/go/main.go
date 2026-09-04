// ccguard — one compiled binary for the hot-path Claude Code hook guards.
//
// A hook is spawned per tool call, so the cost that matters is process start,
// not the work. The JS guards are ~7ms of work behind ~25ms of node cold start,
// and node is an *undeclared* prerequisite — Claude Code ships a self-contained
// binary whose documented requirements do not include it, so on a machine
// without node every guard silently fails open.
//
// Dispatch is by argv[1] so a single binary replaces several hooks:
//
//	ccguard design-gate       PreToolUse   Bash
//	ccguard agent-model       PreToolUse   Agent
//	ccguard workflow-model    PreToolUse   Workflow
//	ccguard lsp-first         PreToolUse   Grep
//	ccguard json-config-guard PostToolUse  Edit|Write|MultiEdit|Bash
//
// Failure philosophy: every one of these guards fails OPEN. A missing field, an
// unreadable file, or an unavailable language server exits 0 with no output,
// exactly as the JS originals do. A guard that crashes the session is worse than
// a guard that misses. `json-config-guard` is the one that signals by exiting 2
// with stderr rather than by denying, because PostToolUse runs after the write
// and cannot deny.
//
// Malformed payloads are the one place that philosophy needed amending for the
// three ported guards, because it does not transfer unchanged. In JS, "exit 0
// having done nothing" IS the final answer. Here it also means *the `.mjs` guard
// never runs* — silence is not neutral, it is a decision that no guard applies.
// Anything this binary cannot represent is therefore handed to the reference
// implementation, which this process does itself by spawning node on the payload
// it is holding: the `|| node` in hooks.json cannot do it, because stdin is
// already drained by then. See delegate for the measurement behind that.
//
// argv is therefore `ccguard <subcommand> [fallback.mjs]`, where the optional
// second argument is the guard to delegate to. Without it the binary still runs;
// it simply has nothing to fall back to and fails open on payloads it cannot
// represent.
package main

import (
	"fmt"
	"os"
)

const usage = "usage: ccguard <design-gate|agent-model|workflow-model|lsp-first|json-config-guard> [fallback.mjs]"

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	sub := os.Args[1]
	fallback := ""
	if len(os.Args) > 2 {
		fallback = os.Args[2]
	}

	// A liveness probe, answered before stdin is touched, so a caller can tell
	// "this binary runs here" from "this binary is absent or built for another
	// architecture" without having to interpret a guard decision.
	if sub == "--probe" {
		os.Exit(0)
	}

	// Read stdin before dispatching so an unknown subcommand still drains the
	// pipe. Leaving it unread can hand the writer an EPIPE on a payload large
	// enough not to fit the pipe buffer.
	raw, ok := readStdin()
	if !ok {
		raw = nil
	}

	switch sub {
	case "lsp-first":
		lspFirst(raw)
	case "json-config-guard":
		jsonConfigGuard(raw)
	case "design-gate", "agent-model", "workflow-model":
		p, why := parsePayload(raw)
		if why == readUnparseable {
			// Nothing has been written yet, so handing this over is safe.
			delegate(raw, fallback)
		}
		var out outcome
		switch sub {
		case "design-gate":
			out = designGate(p, why)
		case "agent-model":
			out = agentModel(p, why)
		case "workflow-model":
			out = workflowModel(p, why)
		}
		if out == outcomeDeclined {
			delegate(raw, fallback)
		}
		os.Exit(0)
	default:
		fmt.Fprintf(os.Stderr, "ccguard: unknown subcommand %q\n%s\n", sub, usage)
		os.Exit(2)
	}
}
