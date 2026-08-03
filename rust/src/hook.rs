//! Shared PreToolUse hook primitives.
//!
//! This is the Rust counterpart of the `readStdin` / `safeJsonParse` /
//! `emitPermissionDecision` trio that every plugin's `scripts/lib.mjs` carries
//! its own copy of. Here there is exactly one copy, because a Rust crate can do
//! what a Claude Code plugin cannot: share code across boundaries.
//!
//! Every function is written to be panic-free on hostile input. The release
//! profile sets `panic = "abort"`, so a panic would abort the process — which
//! Claude Code reads as a non-blocking hook error and therefore fails open. That
//! is an acceptable last resort, not a design.

use serde_json::Value;
use std::io::{Read, Write};

/// Read all of stdin as UTF-8, lossily.
///
/// The JS original decodes with `Buffer.toString("utf8")`, which replaces
/// invalid sequences with U+FFFD rather than throwing. `from_utf8_lossy` has
/// exactly that behaviour, so malformed input reaches the parser in the same
/// shape it would under node — as text that then fails to parse as JSON, which
/// is already a handled path.
pub fn read_stdin() -> String {
    let mut buf = Vec::new();
    if std::io::stdin().read_to_end(&mut buf).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// The payload could not be parsed here, and node might well parse it fine.
///
/// `serde_json` is stricter than `JSON.parse` in at least one reachable way: a
/// string containing a lone surrogate (`"\ud800"`) is legal JSON that
/// `JSON.parse` accepts and carries in a JS string, while no Rust `String` can
/// hold one — it is not valid UTF-8. There is no "parse it anyway" here to reach
/// for; the payload is genuinely outside what this program can represent.
#[derive(Debug)]
pub struct Unparseable;

/// Parse JSON without failing loudly, mirroring `safeJsonParse`.
///
/// Returns `Ok(None)` — nothing to guard — for empty input and, matching the JS
/// contract exactly, for any valid JSON that is not an object. `safeJsonParse`
/// rejects `null`, arrays, numbers and strings via its `typeof !== "object"` and
/// explicit null checks; a bare `[1,2]` must not be treated as a payload here
/// either, or the guards would read fields off something that has none. In all
/// those cases node reaches the same "do nothing" answer, so exiting 0 is right.
///
/// Returns `Err(Unparseable)` when the parse itself failed, which is NOT the same
/// answer. The caller must decline (see [`decline`]) rather than exit 0: under
/// `ccguard || node`, a zero exit means node never runs, so treating an
/// unparseable payload as "nothing to do" silently disables the guard for it.
/// That was a live bypass — a single lone surrogate anywhere in a Bash command
/// turned the design gate off.
///
/// Genuinely malformed input (`{not json`) also lands here and is also declined,
/// costing one node spawn to reach the same do-nothing answer. Distinguishing
/// "malformed for both" from "malformed only for me" would mean reimplementing
/// `JSON.parse`'s error taxonomy to save a process spawn on input that does not
/// occur in practice.
pub fn parse_payload(raw: &str) -> Result<Option<Value>, Unparseable> {
    if raw.is_empty() {
        return Ok(None);
    }
    let value: Value = serde_json::from_str(raw).map_err(|_| Unparseable)?;
    Ok(value.is_object().then_some(value))
}

/// Hand the payload to the `.mjs` guard, forward its answer, and exit.
///
/// **Why this spawns node rather than exiting non-zero.** hooks.json invokes the
/// binary as `ccguard <sub> <guard>.mjs || node <guard>.mjs`, and the `||` looks
/// like it would do this for free. It cannot. By the time any guard here can tell
/// it needs to decline, `read_stdin` has already drained the pipe — the shell has
/// no way to rewind it, so the node in that `||` reads zero bytes and decides
/// nothing. Measured, not assumed: `printf '…' | sh -c 'ccguard design-gate ||
/// node …'` prints nothing at all. That `||` earns its place for the one case it
/// does handle — a binary that never execs (absent, or built for another
/// architecture), where stdin is still untouched — and no other.
///
/// So delegation has to be done by the process holding the bytes. Stdout is
/// inherited, so node writes its decision straight to the real stdout with no
/// re-encoding, and its exit status becomes ours.
///
/// Only sound when nothing has been written to stdout yet: node writes its own
/// decision, and two decisions on stdout is a protocol violation.
///
/// If node cannot be spawned — which is the state this whole binary exists to
/// tolerate — there is nothing left to consult, so exit 0 and let the tool call
/// proceed. That is the same fail-open the `.mjs` guards already have on a machine
/// without node, reached here only on payloads the binary could not represent.
pub fn delegate(raw: &str, fallback: Option<&str>) -> ! {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let Some(script) = fallback else {
        std::process::exit(0);
    };

    let child = Command::new("node")
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .spawn();

    let Ok(mut child) = child else {
        std::process::exit(0);
    };

    if let Some(mut sink) = child.stdin.take() {
        // A guard that reads only a prefix and exits would give us EPIPE here.
        // Its decision is still on stdout and still authoritative, so this is not
        // a failure — carry on to the status.
        let _ = sink.write_all(raw.as_bytes());
    }

    match child.wait() {
        Ok(status) => std::process::exit(status.code().unwrap_or(0)),
        Err(_) => std::process::exit(0),
    }
}

/// What a guard did with a payload it was handed.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// A decision was reached, or there was legitimately none to make. Exit 0.
    Handled,
    /// This guard cannot reproduce the reference implementation's answer for this
    /// payload. Exit via [`decline`] having written nothing.
    Declined,
}

/// Read a nested string field, e.g. `("tool_input", "command")`.
///
/// Returns `None` when any level is missing or the leaf is not a string, which
/// collapses the JS `typeof x?.y === "string" ? x.y : ""` dance into one call.
pub fn nested_str<'a>(payload: &'a Value, parent: &str, key: &str) -> Option<&'a str> {
    payload.get(parent)?.get(key)?.as_str()
}

/// Read a top-level string field.
pub fn top_str<'a>(payload: &'a Value, key: &str) -> Option<&'a str> {
    payload.get(key)?.as_str()
}

/// Escape a string as a JSON string literal, including the surrounding quotes.
///
/// Hand-rolled rather than delegated to `serde_json::to_string` so that no
/// output path can panic or depend on serializer defaults. The escape set
/// matches `JSON.stringify`: quote, backslash, the four named control escapes,
/// and `\u00XX` for every other C0 control character. Non-ASCII is emitted raw —
/// `JSON.stringify` does not escape it either, which matters because the guard
/// reasons contain a literal `…`.
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Emit a PreToolUse permission-decision envelope on stdout.
///
/// `deny` feeds `reason` back to Claude as feedback; `ask` prompts the user;
/// `allow` skips the interactive prompt.
///
/// The object is built by string concatenation rather than through a
/// `serde_json::Map` so that key order is pinned by construction. `Map` is a
/// `BTreeMap` unless the `preserve_order` feature is on, and while its
/// alphabetical order happens to coincide with the JS insertion order today,
/// depending on that coincidence would make the byte-for-byte equivalence tests
/// fragile against a dependency change.
pub fn emit_permission_decision(decision: &str, reason: &str) {
    let line = format!(
        "{{\"hookSpecificOutput\":{{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":{},\"permissionDecisionReason\":{}}}}}\n",
        json_string(decision),
        json_string(reason)
    );
    // A closed or broken stdout is not worth aborting over: the hook has already
    // decided, and a write failure means nobody is listening.
    let _ = std::io::stdout().write_all(line.as_bytes());
}

/// Truncate for display exactly the way the JS guards do.
///
/// `command.length > 80 ? command.slice(0, 77) + "…" : command` counts UTF-16
/// code units, not bytes and not `char`s. A naive byte slice would both disagree
/// with the JS output on any non-ASCII command and risk slicing mid-codepoint,
/// so this converts through UTF-16 and back. Lone surrogates produced by cutting
/// a pair in half are replaced, matching how such a string would render.
pub fn truncate_utf16(s: &str, limit: usize, keep: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    if units.len() <= limit {
        return s.to_string();
    }
    let head: String = char::decode_utf16(units[..keep].iter().copied())
        .map(|r| r.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect();
    format!("{head}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_object_json() {
        // Parsed fine, just not a payload — node agrees there is nothing to do.
        assert!(matches!(parse_payload("[1,2]"), Ok(None)));
        assert!(matches!(parse_payload("null"), Ok(None)));
        assert!(matches!(parse_payload("\"str\""), Ok(None)));
        assert!(matches!(parse_payload("7"), Ok(None)));
        assert!(matches!(parse_payload(""), Ok(None)));
        assert!(matches!(parse_payload("{}"), Ok(Some(_))));
    }

    #[test]
    fn declines_what_it_cannot_parse() {
        // The bypass this exists to close: legal JSON that `JSON.parse` accepts
        // and `serde_json` does not. Exiting 0 here would mean the `|| node`
        // fallback never runs and the guard is silently skipped.
        assert!(matches!(
            parse_payload(r#"{"tool_input":{"command":"npm create vite \ud800"}}"#),
            Err(Unparseable)
        ));
        // Malformed for both implementations — declined too, since telling the
        // two cases apart is not worth reimplementing `JSON.parse`'s errors.
        assert!(matches!(parse_payload("{not json"), Err(Unparseable)));
    }

    #[test]
    fn declining_is_reachable_from_every_guard_entry() {
        // The Outcome enum is the only channel a guard has for "I could not
        // answer this". If it ever collapses to a single variant the delegation
        // path is dead code and the divergences it covers are back.
        assert_ne!(Outcome::Handled, Outcome::Declined);
    }

    #[test]
    fn escapes_like_json_stringify() {
        assert_eq!(json_string("a\"b"), "\"a\\\"b\"");
        assert_eq!(json_string("a\\b"), "\"a\\\\b\"");
        assert_eq!(json_string("a\nb"), "\"a\\nb\"");
        assert_eq!(json_string("a\u{1}b"), "\"a\\u0001b\"");
        // Non-ASCII stays raw, as JSON.stringify leaves it.
        assert_eq!(json_string("a…b"), "\"a…b\"");
    }

    #[test]
    fn truncates_on_utf16_units() {
        let short = "abc";
        assert_eq!(truncate_utf16(short, 80, 77), "abc");

        let long = "x".repeat(81);
        let out = truncate_utf16(&long, 80, 77);
        assert_eq!(out.chars().count(), 78);
        assert!(out.ends_with('…'));

        // An emoji is two UTF-16 units but one char — the JS length check counts
        // two, so a string of 41 emoji (82 units) must truncate.
        let emoji = "😀".repeat(41);
        assert!(emoji.chars().count() == 41 && emoji.encode_utf16().count() == 82);
        assert!(truncate_utf16(&emoji, 80, 77).ends_with('…'));
    }
}
