// PreToolUse hook (matcher: `Agent`) — make ad-hoc subagent dispatches pick a
// model tier deliberately.
//
// Port of `plugins/gates/scripts/pretooluse-guard-agent-model.mjs`.
//
// An Agent call with no `model` param inherits the session's main-loop model — on
// a frontier-tier session that silently runs searches and mechanical work at the
// most expensive tier. Measured before this guard existed: 73% of 477 dispatches
// omitted `model`; the built-in Explore agent inherited in 71/75.
package main

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Frontmatter fields this guard cares about.
type frontmatter struct {
	name     string
	hasName  bool
	model    string
	hasModel bool
}

var frontmatterBlock = regexp.MustCompile(`^---\r?\n([\s\S]*?)\r?\n---`)

// parseFrontmatter pulls `name:` and `model:` out of a markdown agent
// definition's frontmatter.
func parseFrontmatter(text string) (frontmatter, bool) {
	m := frontmatterBlock.FindStringSubmatch(text)
	if m == nil {
		return frontmatter{}, false
	}
	block := m[1]

	field := func(key string) (string, bool) {
		re, err := regexp.Compile(`(?m)^` + regexp.QuoteMeta(key) + `:` + jsWS + `*(.+)$`)
		if err != nil {
			return "", false
		}
		fm := re.FindStringSubmatch(block)
		if fm == nil {
			return "", false
		}
		return strings.TrimSpace(fm[1]), true
	}

	var out frontmatter
	out.name, out.hasName = field("name")
	out.model, out.hasModel = field("model")
	return out, true
}

// findDefinition finds the agent definition for agentType in dir (a
// `.claude/agents` dir).
//
// Matches frontmatter `name:` first (the authoritative identifier), then
// filename. A missing or unreadable directory means "no definitions here", not
// an error — the guard must never fail on a machine that simply has no custom
// agents.
//
// Entries are sorted before scanning. The JS original walks `readdirSync` order,
// which is filesystem-dependent and therefore arbitrary; that only becomes
// observable if two files both declare the same frontmatter `name`, in which
// case sorted order at least makes the winner reproducible.
func findDefinition(dir, agentType string) (frontmatter, bool) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return frontmatter{}, false
	}
	var files []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".md") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)

	var byFilename frontmatter
	var haveByFilename bool
	for _, name := range files {
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		fm, ok := parseFrontmatter(string(b))
		if !ok {
			continue
		}
		if fm.hasName && fm.name == agentType {
			return fm, true
		}
		if strings.TrimSuffix(name, ".md") == agentType {
			byFilename, haveByFilename = fm, true
		}
	}
	return byFilename, haveByFilename
}

// findPluginDefinition resolves a plugin-shipped agent definition.
//
// This is the one deliberate divergence from the `.mjs` reference. That script
// searches only `<cwd>/.claude/agents` and `~/.claude/agents` and then falls
// through to deny, so a plugin agent with a correctly pinned `model:` is denied
// today purely because the guard cannot see where it lives. Plugin agents sit at
// `~/.claude/plugins/marketplaces/<marketplace>/plugins/<plugin>/agents/*.md`
// and are consulted LAST — lowest precedence, matching Claude Code's documented
// order where plugin agents rank below user-level ones.
//
// A scoped `subagent_type` looks like `my-plugin:reviewer`; a subfolder adds a
// segment (`my-plugin:review:security`). Resolution is by construction, not by
// walking: one readdir of the marketplaces directory, then a direct read of the
// one path each marketplace could hold it at. An unscoped type never reaches
// here, so this costs nothing on the common path.
func findPluginDefinition(home, agentType string) (frontmatter, bool) {
	parts := strings.Split(agentType, ":")
	if len(parts) < 2 {
		return frontmatter{}, false
	}
	for _, p := range parts {
		// Reject anything that could escape the constructed path.
		if p == "" || p == "." || p == ".." || strings.ContainsAny(p, `/\`) {
			return frontmatter{}, false
		}
	}
	plugin, rest := parts[0], parts[1:]

	marketplaces := filepath.Join(home, ".claude", "plugins", "marketplaces")
	entries, err := os.ReadDir(marketplaces)
	if err != nil {
		return frontmatter{}, false
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })

	rel := filepath.Join(rest...) + ".md"
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		path := filepath.Join(marketplaces, e.Name(), "plugins", plugin, "agents", rel)
		b, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		if fm, ok := parseFrontmatter(string(b)); ok {
			return fm, true
		}
	}
	return frontmatter{}, false
}

func agentModel(p map[string]any, why readFailure) outcome {
	// Only guard the Agent tool. (The legacy "Task" matcher also fires for Agent
	// calls, so hooks.json registers this under "Agent" only — never both.)
	if why != readOK {
		return outcomeHandled
	}
	if topStr(p, "tool_name") != "Agent" {
		return outcomeHandled
	}

	// Explicit tier — any value, including opus/fable — means the choice was
	// deliberate. Setting it IS the ack; there is no separate marker.
	if nestedStr(p, "tool_input", "model") != "" {
		return outcomeHandled
	}

	agentType := nestedStr(p, "tool_input", "subagent_type")

	// Forks always inherit the parent model; the model param is ignored for them,
	// so a deny could never be resolved.
	if agentType == "fork" {
		return outcomeHandled
	}

	// A custom definition with a pinned frontmatter model resolves cheap on its
	// own. Precedence mirrors Claude Code's: project `.claude/agents` beats
	// `~/.claude/agents`, which beats a plugin-shipped definition.
	if agentType != "" {
		var dirs []string
		if cwd := topStr(p, "cwd"); cwd != "" {
			dirs = append(dirs, filepath.Join(cwd, ".claude", "agents"))
		}

		// `$HOME` is how node's `os.homedir()` answers too — but only when it is
		// set. With it unset, `os.homedir()` falls back to the passwd database
		// and still finds `~/.claude/agents`. Reading no user definitions is not
		// a neutral outcome: it turns a pinned `model: sonnet` into a deny node
		// would not issue. Note it and decline below rather than answer
		// differently.
		home, homeSet := os.LookupEnv("HOME")
		homeUnreadable := !homeSet
		if homeSet {
			dirs = append(dirs, filepath.Join(home, ".claude", "agents"))
		}

		resolvedInheriting := false
		resolved := false
		for _, dir := range dirs {
			fm, ok := findDefinition(dir, agentType)
			if !ok {
				continue
			}
			resolved = true
			if fm.hasModel && fm.model != "" && fm.model != "inherit" {
				return outcomeHandled
			}
			// First resolving definition decides; it inherits → fall through to deny.
			resolvedInheriting = true
			break
		}

		// Lowest precedence: a plugin-shipped agent, which the `.mjs` reference
		// cannot see at all.
		if !resolved && homeSet {
			if fm, ok := findPluginDefinition(home, agentType); ok {
				if fm.hasModel && fm.model != "" && fm.model != "inherit" {
					return outcomeHandled
				}
				resolvedInheriting = true
			}
		}

		// Decline only when the deny would be a guess: no definition resolved in
		// any directory we could read, AND there is a directory we could not.
		// A definition that resolved and said "inherit" has already decided the
		// question — the unreadable user dir is lower precedence and could not
		// have overturned it.
		if homeUnreadable && !resolvedInheriting {
			return outcomeDeclined
		}
	}

	suffix := ""
	if agentType != "" {
		suffix = " (" + agentType + ")"
	}
	reason := "agent-model-guard: this Agent dispatch" + suffix + " sets no model, " +
		"so the subagent inherits the session's main-loop model — an expensive default on a " +
		"frontier-tier session. Re-dispatch with an explicit tier: model:'sonnet' for " +
		"search/reads/mechanical implementation/verification, model:'haiku' for pure " +
		"enumeration, or model:'opus'/'fable' deliberately if the task genuinely needs " +
		"frontier reasoning. An explicit model always passes this guard."

	emitPermissionDecision("deny", reason)
	return outcomeHandled
}
