//! PreToolUse hook (matcher: `Workflow`) — nudge Claude to tier models in
//! high-fan-out Workflow scripts.
//!
//! Port of `plugins/workflow-model-guard/scripts/pretooluse-guard-workflow-model.mjs`.
//!
//! Three invocation forms, three responses:
//!   * inline `script`  → inspect it; deny if it fans out untiered.
//!   * `scriptPath`     → read the file and inspect the same way.
//!   * `name`           → can't read or rewrite a built-in/saved workflow. If it
//!                        is a known high-fan-out one that inherits the session
//!                        model, ASK the user, because a deny-to-Claude cannot be
//!                        resolved — Claude can't edit a built-in, so it would
//!                        dead-end.
//!
//! Scale-gated: small/cheap inline/scriptPath workflows pass silently so the hook
//! doesn't fight the Workflow tool's own "omit model by default" guidance.

use crate::hook;
use regex_lite::Regex;
use serde_json::Value;

/// Named workflows known to spawn a high fan-out of agents on the session model,
/// which Claude cannot edit — e.g. the built-in `deep-research` harness. The ask
/// is a cost speed-bump on a frontier-tier session, not a claim about the
/// workflow's own tiering.
const NAME_DENYLIST: &[&str] = &["deep-research"];

/// Static fan-out signals extracted from a script.
struct Signals {
    agent_count: usize,
    fanout: bool,
    loopy: bool,
}

/// JavaScript's `\s`, spelled out.
///
/// `regex-lite`'s `\s` is ASCII-only; JS's is not, and the gap is reachable here.
/// This guard regexes RAW SCRIPT TEXT — unlike `design_gate`, which tokenizes
/// first and has therefore already consumed exotic whitespace as token content by
/// the time any pattern runs. `Cargo.toml` originally recorded the ASCII-only
/// divergence as unreachable on the strength of that tokenizer argument; the
/// argument is sound for the guard it was written about and does not extend to
/// this one. Cross-family review caught it: `await agent\u{a0}("x")` four times
/// counted as zero `agent()` calls here and four in node, so node denied the
/// fan-out and the binary allowed it.
///
/// Written as Rust escapes so the regex engine only ever sees literal characters
/// — `regex-lite` need not interpret any Unicode escape syntax of its own. The set
/// is ECMA-262 `WhiteSpace` ∪ `LineTerminator`, which is exactly what JS `\s`
/// matches.
const JS_WS: &str = "[\t\n\u{b}\u{c}\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";

/// `agent_count` is a static lower bound: loops and `.map()` over items mean the
/// real spawn count is higher, so fan-out/loop presence is the stronger cue.
fn signals(script: &str) -> Signals {
    let agent_count = Regex::new(&format!(r"\bagent{JS_WS}*\("))
        .map(|re| re.find_iter(script).count())
        .unwrap_or(0);

    let fanout = script.contains("parallel(") || script.contains("pipeline(");

    let matches = |p: &str| Regex::new(p).is_ok_and(|re| re.is_match(script));
    let loopy = matches(&format!(r"\bwhile{JS_WS}*\("))
        || matches(&format!(r"\bfor{JS_WS}*\("))
        || script.contains("budget.remaining");

    Signals {
        agent_count,
        fanout,
        loopy,
    }
}

/// Name only the signals that actually fired, so the reason never reads
/// "~0 agent() calls".
fn describe(s: &Signals) -> String {
    let mut parts: Vec<String> = Vec::new();
    if s.agent_count >= 1 {
        let plural = if s.agent_count == 1 { "" } else { "s" };
        parts.push(format!("~{} agent() call{plural}", s.agent_count));
    }
    if s.fanout {
        parts.push("parallel/pipeline fan-out".to_string());
    }
    if s.loopy {
        parts.push("a spawn loop".to_string());
    }
    parts.join(" + ")
}

pub fn run(payload: Option<Value>) -> hook::Outcome {
    decide(payload);
    // Script inspection is self-contained — no environment lookups, no encoding
    // this program cannot represent (bad bytes are decoded lossily, as node does).
    hook::Outcome::Handled
}

fn decide(payload: Option<Value>) {
    // Only guard the Workflow tool. Anything else → proceed normally.
    let Some(payload) = payload else { return };
    if hook::top_str(&payload, "tool_name") != Some("Workflow") {
        return;
    }

    // Resolve the inspectable script: inline first, then read scriptPath off disk.
    let inline = hook::nested_str(&payload, "tool_input", "script").filter(|s| !s.is_empty());
    let script: Option<String> = match inline {
        Some(s) => Some(s.to_string()),
        None => {
            match hook::nested_str(&payload, "tool_input", "scriptPath").filter(|s| !s.is_empty()) {
                // Read BYTES and decode lossily — do not use `read_to_string`.
                //
                // `read_to_string` fails on invalid UTF-8, but the JS original's
                // `readFileSync(path, "utf8")` replaces bad sequences with U+FFFD
                // and inspects the result. Treating a mis-encoded file as
                // unreadable made the guard fail OPEN on exactly the scripts most
                // likely to be machine-generated — a fan-out script with one stray
                // byte was denied by node and silently allowed here. Found by
                // cross-family review, reproduced, and pinned by a differential
                // case that writes a real file with an invalid byte.
                Some(path) => match std::fs::read(path) {
                    Ok(bytes) => Some(String::from_utf8_lossy(&bytes).into_owned()),
                    // Genuinely unreadable path (missing, no permission) → don't
                    // guess, allow. This matches the JS catch.
                    Err(_) => return,
                },
                None => None,
            }
        }
    };

    // No inspectable script (a `name:` invocation). Ask the user only for the
    // denylisted high-fan-out names; leave every other named/saved workflow alone.
    let Some(script) = script else {
        let name = hook::nested_str(&payload, "tool_input", "name").unwrap_or("");
        if !name.is_empty() && NAME_DENYLIST.contains(&name) {
            let reason = format!(
                "workflow-model-guard: the \"{name}\" workflow sets no per-agent model: override, so \
every agent it spawns inherits this session's model — on a frontier-tier session \
that is an expensive default, and it can't be tiered from here (it's not an \
editable script). Cheaper: switch this session to Sonnet \
(/model sonnet) before running it, or run a model-tiered workflow instead. Proceed anyway?"
            );
            hook::emit_permission_decision("ask", &reason);
        }
        return;
    };

    // Bypass 1: any `model:` means Claude already weighed tiers (even one override
    // counts). Bypass 2: explicit ack that session-model fan-out is intended —
    // prevents an infinite deny loop.
    let has_model =
        Regex::new(&format!(r"\bmodel{JS_WS}*:")).is_ok_and(|re| re.is_match(&script));
    if has_model || script.contains("model-guard:ack") {
        return;
    }

    let s = signals(&script);
    let expensive = s.agent_count >= 4 || s.fanout || (s.loopy && s.agent_count >= 1);
    if !expensive {
        return;
    }

    let what = describe(&s);
    let reason = format!(
        "workflow-model-guard: this workflow has {what} and no per-agent model: override — \
every spawned agent defaults to the main-loop model, which burns usage limits fast \
on frontier-tier sessions. Add model:'sonnet' (or 'haiku') to worker agents that \
don't need the top tier. If the top tier is genuinely required for all of them, add a \
`// model-guard:ack` comment to the script and re-run."
    );

    hook::emit_permission_decision("deny", &reason);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_agent_calls_with_word_boundary() {
        assert_eq!(signals("agent('a'); agent ('b')").agent_count, 2);
        // `subagent(` must not count — `\b` requires a non-word char before.
        assert_eq!(signals("subagent('a')").agent_count, 0);
    }

    #[test]
    fn detects_fanout_and_loops() {
        assert!(signals("await parallel(xs)").fanout);
        assert!(signals("await pipeline(xs, f)").fanout);
        assert!(signals("while (x) {}").loopy);
        assert!(signals("for (const x of xs) {}").loopy);
        assert!(signals("budget.remaining()").loopy);
        assert!(!signals("const x = 1").loopy);
    }

    #[test]
    fn describes_only_fired_signals() {
        let s = Signals {
            agent_count: 1,
            fanout: false,
            loopy: false,
        };
        assert_eq!(describe(&s), "~1 agent() call");

        let s = Signals {
            agent_count: 0,
            fanout: true,
            loopy: false,
        };
        assert_eq!(describe(&s), "parallel/pipeline fan-out");

        let s = Signals {
            agent_count: 3,
            fanout: true,
            loopy: true,
        };
        assert_eq!(
            describe(&s),
            "~3 agent() calls + parallel/pipeline fan-out + a spawn loop"
        );
    }
}
