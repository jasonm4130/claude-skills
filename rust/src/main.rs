//! `ccguard` — the compiled PreToolUse guards.
//!
//! One binary, three hooks, dispatched on argv[1]. It is committed into each
//! consuming plugin (`plugins/<name>/bin/ccguard`) because Claude Code plugins
//! cannot share files, and there is no build step anywhere in the marketplace
//! install path — a plugin is delivered by `git clone` of this repo followed by a
//! copy of the plugin subtree, so whatever ships must already be built.
//!
//! Why compiled at all: the JS guards are ~7ms of work behind ~25ms of node cold
//! start, and node is an *undeclared* prerequisite — Claude Code ships a
//! self-contained binary whose documented requirements do not include it, so on a
//! machine without node every guard silently fails open. See
//! `plugins/*/README.md` for the long-form version of that argument.
//!
//! Failure philosophy: a missing field, an unreadable file, or an unknown
//! subcommand exits 0 with no output, exactly as the JS originals do. A guard
//! that crashes the session is worse than a guard that misses.
//!
//! Malformed payloads are the one place that philosophy needed amending, because
//! it does not transfer unchanged. In JS, "exit 0 having done nothing" IS the
//! final answer. Here it also means *the `.mjs` guard never runs* — silence is
//! not neutral, it is a decision that no guard applies. Anything this binary
//! cannot represent is therefore handed to the reference implementation, which
//! this process does itself by spawning node on the payload it is holding: the
//! `|| node` in hooks.json cannot do it, because stdin is already drained by
//! then. See `hook::delegate` for the measurement behind that.
//!
//! argv is therefore `ccguard <subcommand> [fallback.mjs]`, where the optional
//! second argument is the guard to delegate to. Without it the binary still runs;
//! it simply has nothing to fall back to and fails open on payloads it cannot
//! represent.

mod agent_model;
mod design_gate;
mod hook;
mod workflow_model;

fn main() {
    let sub = std::env::args().nth(1).unwrap_or_default();
    let fallback = std::env::args().nth(2);

    // Answered before stdin is touched, so it works when invoked by hand. See
    // build.rs for why this exists: it is how CI proves the committed binary was
    // built from the committed source, without needing reproducible builds.
    if sub == "--source-fingerprint" {
        println!("{}", env!("CCGUARD_SRC_FINGERPRINT"));
        return;
    }

    // Read stdin before dispatching so an unknown subcommand still drains the
    // pipe. Leaving it unread can hand the writer an EPIPE on a payload large
    // enough not to fit the pipe buffer.
    let raw = hook::read_stdin();
    let payload = match hook::parse_payload(&raw) {
        Ok(payload) => payload,
        // Nothing has been written yet, so handing this over is safe.
        Err(hook::Unparseable) => hook::delegate(&raw, fallback.as_deref()),
    };

    let outcome = match sub.as_str() {
        "design-gate" => design_gate::run(payload),
        "agent-model" => agent_model::run(payload),
        "workflow-model" => workflow_model::run(payload),
        other => {
            // Diagnosable but never blocking: stderr from a hook is surfaced by
            // Claude Code as a non-blocking error, and exit 0 leaves the tool call
            // to proceed. Deliberately not declined — an unknown subcommand is a
            // wiring mistake in hooks.json, and the `.mjs` fallback cannot fix it.
            eprintln!("ccguard: unknown subcommand {other:?} (expected design-gate, agent-model, or workflow-model)");
            hook::Outcome::Handled
        }
    };

    if outcome == hook::Outcome::Declined {
        hook::delegate(&raw, fallback.as_deref());
    }
}
