//! PreToolUse hook (matcher: `Agent`) — make ad-hoc subagent dispatches pick a
//! model tier deliberately.
//!
//! Port of `plugins/workflow-model-guard/scripts/pretooluse-guard-agent-model.mjs`.
//!
//! An Agent call with no `model` param inherits the session's main-loop model — on
//! a frontier-tier session that silently runs searches and mechanical work at the
//! most expensive tier. Measured before this guard existed: 73% of 477 dispatches
//! omitted `model`; the built-in Explore agent inherited in 71/75.

use crate::hook;
use regex_lite::Regex;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Frontmatter fields this guard cares about.
struct Frontmatter {
    name: Option<String>,
    model: Option<String>,
}

/// Parse `name:` and `model:` out of a markdown agent definition's frontmatter.
fn parse_frontmatter(text: &str) -> Option<Frontmatter> {
    let block_re = Regex::new(r"^---\r?\n([\s\S]*?)\r?\n---").ok()?;
    let block = block_re.captures(text)?.get(1)?.as_str().to_string();

    let field = |key: &str| -> Option<String> {
        let re = Regex::new(&format!(r"(?m)^{key}:\s*(.+)$")).ok()?;
        Some(re.captures(&block)?.get(1)?.as_str().trim().to_string())
    };

    Some(Frontmatter {
        name: field("name"),
        model: field("model"),
    })
}

/// Find the agent definition for `agent_type` in `dir` (a `.claude/agents` dir).
///
/// Matches frontmatter `name:` first (the authoritative identifier), then
/// filename. A missing or unreadable directory means "no definitions here", not
/// an error — the guard must never fail on a machine that simply has no custom
/// agents.
///
/// Entries are sorted before scanning. The JS original walks `readdirSync` order,
/// which is filesystem-dependent and therefore arbitrary; that only becomes
/// observable if two files both declare the same frontmatter `name`, in which
/// case sorted order at least makes the winner reproducible.
fn find_definition(dir: &Path, agent_type: &str) -> Option<Frontmatter> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "md"))
        .collect();
    files.sort();

    let mut by_filename: Option<Frontmatter> = None;
    for path in files {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Some(fm) = parse_frontmatter(&text) else {
            continue;
        };
        if fm.name.as_deref() == Some(agent_type) {
            return Some(fm);
        }
        if path.file_stem().is_some_and(|s| s == agent_type) {
            by_filename = Some(fm);
        }
    }
    by_filename
}

pub fn run(payload: Option<Value>) -> hook::Outcome {
    // Only guard the Agent tool. (The legacy "Task" matcher also fires for Agent
    // calls, so hooks.json registers this under "Agent" only — never both.)
    let Some(payload) = payload else {
        return hook::Outcome::Handled;
    };
    if hook::top_str(&payload, "tool_name") != Some("Agent") {
        return hook::Outcome::Handled;
    }

    // Explicit tier — any value, including opus/fable — means the choice was
    // deliberate. Setting it IS the ack; there is no separate marker.
    if hook::nested_str(&payload, "tool_input", "model").is_some_and(|m| !m.is_empty()) {
        return hook::Outcome::Handled;
    }

    let agent_type = hook::nested_str(&payload, "tool_input", "subagent_type").unwrap_or("");

    // Forks always inherit the parent model; the model param is ignored for them,
    // so a deny could never be resolved.
    if agent_type == "fork" {
        return hook::Outcome::Handled;
    }

    // A custom definition with a pinned frontmatter model resolves cheap on its
    // own. Precedence mirrors Claude Code's: project `.claude/agents` beats
    // `~/.claude/agents`.
    if !agent_type.is_empty() {
        let mut dirs: Vec<PathBuf> = Vec::new();
        if let Some(cwd) = hook::top_str(&payload, "cwd").filter(|c| !c.is_empty()) {
            dirs.push(Path::new(cwd).join(".claude").join("agents"));
        }

        // `$HOME` is how node's `os.homedir()` answers too — but only when it is
        // set. With it unset, `os.homedir()` falls back to the passwd database
        // and still finds `~/.claude/agents`, while this program has no way to
        // ask without linking libc. Reading no user definitions is not a neutral
        // outcome: it turns a pinned `model: sonnet` into a deny node would not
        // issue. Note it and decline below rather than answer differently.
        let home = std::env::var_os("HOME");
        let home_unreadable = home.is_none();
        if let Some(home) = home {
            dirs.push(Path::new(&home).join(".claude").join("agents"));
        }

        let mut resolved_inheriting = false;
        for dir in dirs {
            if let Some(fm) = find_definition(&dir, agent_type) {
                match fm.model.as_deref() {
                    Some(m) if !m.is_empty() && m != "inherit" => return hook::Outcome::Handled,
                    // First resolving definition decides; it inherits → fall
                    // through to deny.
                    _ => {
                        resolved_inheriting = true;
                        break;
                    }
                }
            }
        }

        // Decline only when the deny would be a guess: no definition resolved in
        // any directory we could read, AND there is a directory we could not.
        // A definition that resolved and said "inherit" has already decided the
        // question — the unreadable user dir is lower precedence and could not
        // have overturned it.
        if home_unreadable && !resolved_inheriting {
            return hook::Outcome::Declined;
        }
    }

    let suffix = if agent_type.is_empty() {
        String::new()
    } else {
        format!(" ({agent_type})")
    };
    let reason = format!(
        "agent-model-guard: this Agent dispatch{suffix} sets no model, \
so the subagent inherits the session's main-loop model — an expensive default on a \
frontier-tier session. Re-dispatch with an explicit tier: model:'sonnet' for \
search/reads/mechanical implementation/verification, model:'haiku' for pure \
enumeration, or model:'opus'/'fable' deliberately if the task genuinely needs \
frontier reasoning. An explicit model always passes this guard."
    );

    hook::emit_permission_decision("deny", &reason);
    hook::Outcome::Handled
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter() {
        let fm = parse_frontmatter("---\nname: rev\nmodel: sonnet\n---\n\nbody").unwrap();
        assert_eq!(fm.name.as_deref(), Some("rev"));
        assert_eq!(fm.model.as_deref(), Some("sonnet"));
    }

    #[test]
    fn tolerates_crlf_and_missing_fields() {
        let fm = parse_frontmatter("---\r\nname: rev\r\n---\r\nbody").unwrap();
        assert_eq!(fm.name.as_deref(), Some("rev"));
        assert_eq!(fm.model, None);
    }

    #[test]
    fn rejects_text_without_frontmatter() {
        assert!(parse_frontmatter("no frontmatter here").is_none());
        assert!(parse_frontmatter("").is_none());
    }
}
