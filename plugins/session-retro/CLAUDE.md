# Session Retro — Claude Code Plugin

## What this is

A Claude Code plugin that provides interactive session retrospectives powered by claude-mem. Queries session observations, walks through key moments with the user, and writes structured memory entries capturing decisions, learnings, and rationale.

## Key differentiators from existing retro tools

1. **claude-mem powered** — reads from claude-mem's continuous observation capture, not raw JSONL parsing
2. **Memory integration** — writes to both native memory (feedback, project, reference types) and claude-mem
3. **Token efficient** — uses claude-mem's 3-layer search pattern (~1,500-3,000 tokens vs 37,000+ for JSONL parsing)
4. **Interactive** — guided walkthrough with the user, not a data dump
5. **Auto-suggest** — skill description primes Claude to suggest retros after substantial sessions

## Plugin structure

```
session-retro/
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json
├── hooks/
│   └── hooks.json
├── scripts/
│   └── mark-session-start.sh   # SessionStart — writes timestamp pointer
├── skills/
│   └── retro/
│       └── SKILL.md
└── README.md
```

## Dependencies

- **claude-mem** plugin must be installed and active
- No Python, no jq, no pip dependencies

## Development workflow

- Test locally: `claude --plugin-dir ./`
- Reload after changes: `/reload-plugins`
- Hook scripts receive JSON on stdin — test with: `echo '{"session_id":"test"}' | ./scripts/mark-session-start.sh`

## Conventions

- Shell scripts: bash, keep minimal (no jq dependency)
- Memory entries follow the frontmatter format: name, description, type + markdown body
