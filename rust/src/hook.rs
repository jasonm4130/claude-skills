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

/// Parse JSON without failing loudly, mirroring `safeJsonParse`.
///
/// Returns `None` for empty input, malformed JSON, and — matching the JS
/// contract exactly — any valid JSON that is not an object. `safeJsonParse`
/// rejects `null`, arrays, numbers and strings via its `typeof !== "object"` and
/// explicit null checks; a bare `[1,2]` must not be treated as a payload here
/// either, or the guards would read fields off something that has none.
pub fn parse_payload(raw: &str) -> Option<Value> {
    if raw.is_empty() {
        return None;
    }
    let value: Value = serde_json::from_str(raw).ok()?;
    if value.is_object() {
        Some(value)
    } else {
        None
    }
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
        assert!(parse_payload("[1,2]").is_none());
        assert!(parse_payload("null").is_none());
        assert!(parse_payload("\"str\"").is_none());
        assert!(parse_payload("7").is_none());
        assert!(parse_payload("").is_none());
        assert!(parse_payload("{not json").is_none());
        assert!(parse_payload("{}").is_some());
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
