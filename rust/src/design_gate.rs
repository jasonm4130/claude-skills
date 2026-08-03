//! PreToolUse hook (matcher: `Bash`) — the brainstorming HARD-GATE, enforced.
//!
//! Port of `plugins/design-gate-guard/scripts/pretooluse-guard-design-gate.mjs`.
//! Behaviour is intended to be identical; `tests/differential.rs` checks that
//! against the JS implementation over the whole existing test corpus rather than
//! taking this comment's word for it.
//!
//! The gate emits `ask`, never `deny`: a PreToolUse hook cannot see the
//! conversation, so it cannot know whether a design was approved, and a deny the
//! model has no way to resolve would dead-end. `ask` routes the checkpoint to the
//! human, who can see whether design happened.

use crate::hook;
use regex_lite::Regex;
use serde_json::Value;

/// New-project scaffolders, anchored to the START of a cleaned command segment so
/// a match means "this command scaffolds", not "this string mentions a
/// scaffolder". Rare and distinctive by design: an `ask` false-positive costs one
/// cheap confirmation.
///
/// Two patterns differ textually from the JS originals because neither Rust regex
/// crate supports lookaround. Both rewrites are equivalence-preserving, not
/// approximations:
///
///   * `^npm\s+init\s+(?!-)[@\w]` → `^npm\s+init\s+[@\w]`. The `(?!-)` was pure
///     redundancy: `[@\w]` is `[@A-Za-z0-9_]`, which cannot match `-` anyway.
///     Identical language.
///
///   * `^dotnet\s+new\s+(?!-)` → `^dotnet\s+new\s+[^-]`. This one is load-bearing
///     (it is what distinguishes `dotnet new console` from `dotnet new --list`).
///     The rewrite consumes the character the lookahead only peeked at, so the two
///     differ in exactly one case: a head ending in whitespace right after `new`,
///     where `(?!-)` succeeds at end-of-input and `[^-]` has nothing to match.
///     That head cannot occur — heads are built by joining tokens with single
///     spaces, so trailing whitespace is impossible. Asserted in
///     `dotnet_trailing_whitespace_is_unreachable`.
const SCAFFOLD_PATTERNS: &[&str] = &[
    // JS/TS package-manager scaffolders: `npm|pnpm|yarn|bun create <initializer>`.
    r"(?i)^(?:npm|pnpm|yarn|bun)\s+create\b",
    // `npm init <initializer>` (a template name, NOT a flag and NOT bare `npm init`).
    r"(?i)^npm\s+init\s+[@\w]",
    // `npx|bunx|pnpm dlx|yarn dlx [flags…] create-<x>` (optionally @scope/create-<x>).
    r"(?i)^(?:npx|bunx|pnpm\s+dlx|yarn\s+dlx)\s+(?:-{1,2}[\w-]+(?:=\S+)?\s+)*(?:@[\w.-]+/)?create-[\w-]+",
    // A create-* binary invoked directly: `create-next-app my-app`.
    r"(?i)^create-[\w-]+",
    // Other ecosystems' project generators.
    r"(?i)^cargo\s+(?:new|init)\b",
    r"(?i)^django-admin\s+start(?:project|app)\b",
    r"(?i)^rails\s+new\b",
    r"(?i)^ng\s+new\b",
    r"(?i)^nest\s+new\b",
    r"(?i)^vue\s+create\b",
    r"(?i)^expo\s+(?:init|create)\b",
    r"(?i)^flutter\s+create\b",
    r"(?i)^dotnet\s+new\s+[^-]",
    r"(?i)^mix\s+(?:new|phx\.new)\b",
    r"(?i)^laravel\s+new\b",
    r"(?i)^composer\s+create-project\b",
    r"(?i)^gatsby\s+new\b",
    r"(?i)^hugo\s+new\s+site\b",
    r"(?i)^jekyll\s+new\b",
];

/// A pending heredoc: its terminator, and whether `<<-` tab-stripping applies.
struct Heredoc {
    delim: String,
    strip: bool,
}

fn is_word_byte(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Quote-aware shell tokenizer.
///
/// Splits `command` into segments at UNQUOTED shell separators (`&&`, `||`, `;`,
/// `|`, newline); each segment is a list of tokens with quote characters removed
/// and whitespace collapsed. An unquoted `#` at a token boundary starts a comment
/// to end of line. Heredoc bodies (`<<DELIM` … `DELIM`) are skipped entirely —
/// they are literal text being written, not commands.
///
/// This is what makes the gate quote-correct: a separator, `#`, or heredoc-body
/// line is literal text, not structure. So `printf "a && npm create b"` is ONE
/// `printf` command, `FOO="x # y" npm create …` keeps its `#` as data, and
/// `cat <<EOF … npm create vite … EOF` runs only `cat`.
///
/// Iterating `char`s where the JS iterates UTF-16 code units is safe here: every
/// character with structural meaning is ASCII, so the two only differ in how they
/// count the interior of a token, which nothing downstream inspects positionally.
// The `end_tok!` macro always clears `started`, including in the final `end_seg!`
// where nothing reads it again. Keeping the macro uniform is worth more than
// silencing one dead store by special-casing the last call site — the JS original
// has the identical shape, and divergence here is exactly what this port must not
// introduce.
#[allow(unused_assignments)]
pub fn parse_segments(command: &str) -> Vec<Vec<String>> {
    let c: Vec<char> = command.chars().collect();
    let n = c.len();

    let mut segments: Vec<Vec<String>> = Vec::new();
    let mut tokens: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut started = false; // a token is in progress (may be an empty quoted "")
    let mut quote: Option<char> = None;
    let mut heredocs: Vec<Heredoc> = Vec::new();

    macro_rules! end_tok {
        () => {
            if started {
                tokens.push(std::mem::take(&mut cur));
                started = false;
            }
        };
    }
    macro_rules! end_seg {
        () => {
            end_tok!();
            if !tokens.is_empty() {
                segments.push(std::mem::take(&mut tokens));
            }
        };
    }

    let mut i = 0usize;
    while i < n {
        let ch = c[i];

        if let Some(q) = quote {
            // Inside "" a backslash escapes " \ $ ` (so \" is a literal quote, not
            // a close); inside '' nothing is special. Matches bash word-splitting.
            if q == '"' && ch == '\\' && i + 1 < n {
                let next = c[i + 1];
                if next == '"' || next == '\\' || next == '$' || next == '`' {
                    cur.push(next);
                    started = true;
                    i += 2;
                    continue;
                }
                // backslash before a non-special char inside "" stays literal
                cur.push(ch);
                started = true;
                i += 1;
                continue;
            }
            if ch == q {
                quote = None;
            } else {
                cur.push(ch);
                started = true;
            }
            i += 1;
            continue;
        }

        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            started = true;
            i += 1;
            continue;
        }

        if ch == '\\' {
            if i + 1 < n {
                cur.push(c[i + 1]);
                started = true;
                i += 2;
            } else {
                i += 1;
            }
            continue;
        }

        if ch == '#' && !started {
            while i < n && c[i] != '\n' {
                i += 1;
            }
            continue; // the loop re-sees the newline as a separator
        }

        // Heredoc introducer: `<<`, optional `-`, optional ws, an (optionally
        // quoted) delimiter. Record it; the body is consumed at this line's newline.
        if ch == '<' && i + 1 < n && c[i + 1] == '<' {
            let mut k = i + 2;
            let mut strip = false;
            if k < n && c[k] == '-' {
                strip = true;
                k += 1;
            }
            while k < n && (c[k] == ' ' || c[k] == '\t') {
                k += 1;
            }
            let mut q = None;
            if k < n && (c[k] == '\'' || c[k] == '"') {
                q = Some(c[k]);
                k += 1;
            }
            let mut delim = String::new();
            if let Some(qc) = q {
                while k < n && c[k] != qc {
                    delim.push(c[k]);
                    k += 1;
                }
                if k < n && c[k] == qc {
                    k += 1; // consume closing quote
                }
            } else if k < n && (c[k].is_ascii_alphabetic() || c[k] == '_') {
                // bare delimiters look like identifiers — avoids reading
                // `$((1<<2))` as one
                while k < n && (is_word_byte(c[k]) || c[k] == '.' || c[k] == '-') {
                    delim.push(c[k]);
                    k += 1;
                }
            }
            if !delim.is_empty() {
                heredocs.push(Heredoc { delim, strip });
                i = k;
                continue;
            }
            // not a heredoc (e.g. a bare `<<`) → treat as ordinary chars
            cur.push(ch);
            started = true;
            i += 1;
            continue;
        }

        if ch == '\n' {
            end_seg!();
            if !heredocs.is_empty() {
                // Consume each pending heredoc's body: lines up to and including a
                // line equal to its delimiter (leading tabs stripped for `<<-`).
                let mut j = i + 1;
                for hd in &heredocs {
                    while j < n {
                        let mut end = j;
                        while end < n && c[end] != '\n' {
                            end += 1;
                        }
                        let line: String = c[j..end].iter().collect();
                        let cmp = if hd.strip {
                            line.trim_start_matches('\t').to_string()
                        } else {
                            line.clone()
                        };
                        let ran_out = end == n;
                        j = end + 1;
                        if cmp == hd.delim {
                            break;
                        }
                        if ran_out {
                            break; // ran out before the terminator
                        }
                    }
                }
                heredocs.clear();
                i = j;
                continue;
            }
            i += 1;
            continue;
        }

        if ch == ';' {
            end_seg!();
            i += 1;
            continue;
        }
        if ch == '&' && i + 1 < n && c[i + 1] == '&' {
            end_seg!();
            i += 2;
            continue;
        }
        if ch == '|' && i + 1 < n && c[i + 1] == '|' {
            end_seg!();
            i += 2;
            continue;
        }
        if ch == '|' {
            end_seg!();
            i += 1;
            continue;
        }
        if ch == ' ' || ch == '\t' || ch == '\r' {
            end_tok!();
            i += 1;
            continue;
        }

        cur.push(ch);
        started = true;
        i += 1;
    }
    end_seg!();
    segments
}

/// `^[A-Za-z_]\w*=` — a leading environment assignment.
fn is_env_assign(token: &str) -> bool {
    let mut chars = token.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    for c in chars {
        if c == '=' {
            return true;
        }
        if !is_word_byte(c) {
            return false;
        }
    }
    false
}

/// Does any command segment start with a scaffold command?
///
/// For each segment we drop leading env-assignments (`FOO=bar`) and `sudo`, then
/// test the remaining head against the anchored scaffold patterns. Because
/// matching is anchored to the segment head, a scaffolder appearing later in a
/// quoted string (a commit message, an echo/printf argument) never matches — that
/// segment's head is `git`/`echo`/etc.
pub fn is_scaffold(command: &str, patterns: &[Regex]) -> bool {
    for tokens in parse_segments(command) {
        let mut i = 0;
        while i < tokens.len() && (is_env_assign(&tokens[i]) || tokens[i] == "sudo") {
            i += 1;
        }
        if i >= tokens.len() {
            continue;
        }
        let head = tokens[i..].join(" ");
        if patterns.iter().any(|re| re.is_match(&head)) {
            return true;
        }
    }
    false
}

/// Compile the scaffold patterns once.
///
/// A malformed pattern is a build-time authoring bug, not a runtime input
/// problem, so an uncompilable entry is dropped rather than aborting the process:
/// a guard that silently under-matches one scaffolder is a far better failure
/// than one that kills every Bash call. `patterns_all_compile` makes it loud in
/// CI instead.
pub fn compile_patterns() -> Vec<Regex> {
    SCAFFOLD_PATTERNS
        .iter()
        .filter_map(|p| Regex::new(p).ok())
        .collect()
}

pub fn run(payload: Option<Value>) -> hook::Outcome {
    decide(payload);
    // Every path above is reproducible here: this guard reads one string field
    // and matches ASCII patterns against it. Nothing to hand back to node.
    hook::Outcome::Handled
}

fn decide(payload: Option<Value>) {
    // Only guard the Bash tool. Anything else → proceed normally.
    let Some(payload) = payload else { return };
    if hook::top_str(&payload, "tool_name") != Some("Bash") {
        return;
    }

    let command = hook::nested_str(&payload, "tool_input", "command").unwrap_or("");
    if command.trim().is_empty() {
        return;
    }

    // Escape hatch: an explicit ack (scaffold run legitimately after design approval).
    if command.contains("design-gate:ack") {
        return;
    }

    if !is_scaffold(command, &compile_patterns()) {
        return;
    }

    let shown = hook::truncate_utf16(command, 80, 77);
    let reason = format!(
        "design-gate-guard: \"{shown}\" looks like a new-project scaffold. Per the \
brainstorming HARD-GATE, don't scaffold or implement until a design has been \
presented and the user has approved it. If you haven't brainstormed a design \
yet, run the superpowers-core:brainstorming skill first. If the design was already approved (or \
this isn't a fresh project), add `design-gate:ack` to the command to proceed."
    );

    hook::emit_permission_decision("ask", &reason);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scaffold(cmd: &str) -> bool {
        is_scaffold(cmd, &compile_patterns())
    }

    #[test]
    fn patterns_all_compile() {
        assert_eq!(
            compile_patterns().len(),
            SCAFFOLD_PATTERNS.len(),
            "a scaffold pattern failed to compile under regex-lite"
        );
    }

    #[test]
    fn matches_plain_scaffolds() {
        assert!(scaffold("npm create vite"));
        assert!(scaffold("cargo new myproj"));
        assert!(scaffold("create-next-app my-app"));
        assert!(scaffold("npx --yes create-vite"));
        assert!(scaffold("dotnet new console"));
        assert!(scaffold("hugo new site blog"));
    }

    #[test]
    fn ignores_non_scaffolds() {
        assert!(!scaffold("ls -la"));
        assert!(!scaffold("npm install"));
        assert!(!scaffold("npm init -y"));
        assert!(!scaffold("dotnet new --list"));
        assert!(!scaffold("docker create foo"));
        assert!(!scaffold("createdb mydb"));
    }

    #[test]
    fn anchors_to_segment_head() {
        // A scaffolder inside a quoted argument is data, not structure.
        assert!(!scaffold("git commit -m \"npm create vite\""));
        assert!(!scaffold("echo 'cargo new x'"));
        // But a real scaffold later in a chain still fires.
        assert!(scaffold("mkdir app && cd app && npm create vite"));
    }

    #[test]
    fn strips_env_and_sudo() {
        assert!(scaffold("FOO=bar sudo npm create vite"));
        assert!(!scaffold("FOO=bar sudo ls"));
    }

    #[test]
    fn skips_heredoc_bodies() {
        assert!(!scaffold("cat <<EOF\nnpm create vite\nEOF"));
    }

    #[test]
    fn dotnet_trailing_whitespace_is_unreachable() {
        // The `(?!-)` → `[^-]` rewrite is equivalence-preserving only because a
        // head can never end in whitespace. Heads come from joining tokens with
        // single spaces, and the tokenizer never emits a trailing empty token.
        for cmd in ["dotnet new ", "dotnet new\t", "dotnet new  \n"] {
            for tokens in parse_segments(cmd) {
                let head = tokens.join(" ");
                assert_eq!(head, head.trim_end(), "head ended in whitespace: {head:?}");
            }
        }
    }
}
