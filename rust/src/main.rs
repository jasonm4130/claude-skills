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
//! Failure philosophy, inherited unchanged from the JS originals: any malformed
//! payload, missing field, unreadable file, or unknown subcommand exits 0 with no
//! output. A guard that crashes the session is worse than a guard that misses.

mod agent_model;
mod design_gate;
mod hook;
mod workflow_model;

fn main() {
    let sub = std::env::args().nth(1).unwrap_or_default();

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
    let payload = hook::parse_payload(&raw);

    match sub.as_str() {
        "design-gate" => design_gate::run(payload),
        "agent-model" => agent_model::run(payload),
        "workflow-model" => workflow_model::run(payload),
        other => {
            // Diagnosable but never blocking: stderr from a hook is surfaced by
            // Claude Code as a non-blocking error, and exit 0 leaves the tool call
            // to proceed.
            eprintln!("ccguard: unknown subcommand {other:?} (expected design-gate, agent-model, or workflow-model)");
        }
    }
}
