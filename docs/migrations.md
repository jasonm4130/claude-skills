# Renamed and removed plugins

What moved where, so an install command from an old doc or transcript
resolves to the plugin that replaced it.

A plugin that leaves the marketplace stops receiving updates but stays installed:
its `<name>@jasonm4130-claude-skills` key remains in `enabledPlugins`, and anything
it wrote under `~/.claude/plugins/data/<name>/` stays on disk. Nothing in this repo
deletes that data — uninstall with `/plugin uninstall <name>@jasonm4130-claude-skills`
and remove the data directory by hand if you want it gone.

The marketplace `renames` field is deliberately not used for the three-guards →
`gates` consolidation: it maps one name to one name, and auto-installing the full
`gates` bundle for someone who had only one of the guards would widen what they
opted into. The migration stays manual — the table below says what to run.

| Removed | Date | Replaced by | What to do |
|---|---|---|---|
| `deep-dive` (and its earlier name `deep-research`) | 2026-08-26 | Claude Code's built-in `/deep-research` | Uninstall. The built-in now inherits the session model instead of pinning Opus, and votes on claims adversarially — the two things this plugin existed to add (verified 2026-08-26). |
| `claude-design` | 2026-08-26 | `frontend-design`, itself retired 2026-09-05 | Uninstall, and install `frontend-design` if you don't already have it. Its heavy path now carries the goal/layout/content/audience brief and the `/design-sync` design-system route directly — one skill instead of two that had to agree with each other. |
| `superpowers-core`'s `using-skills` skill and its `SessionStart` hook | 2026-08-26 | Your own global `CLAUDE.md` | At the time, `superpowers-core` stayed installed for its five method skills. The rest of it was retired on 2026-09-05, see below. The dispatcher kernel it used to inject every session now belongs in `~/.claude/CLAUDE.md`, which already loads at every session start; injecting it as well stated the same rule twice. Copy the rules you want there. Claude Code will stop prompting for the plugin's hook. |
| `codebase-design` | 2026-08-26 | Nothing | Uninstall. The 2026-08-03 ADR kept it on the condition that an imperative hand-off from `brainstorming` produce invocations by 2026-08-24; it was still at zero, so the review clause fired. The design vocabulary it carried is native to Claude — `brainstorming` and `test-driven-development` now make their boundary and seam points directly. |
| `docs-sync-guard` | 2026-08-26 | `gates` | Uninstall, then `/plugin install gates@jasonm4130-claude-skills`. Both mechanisms moved across unchanged: the commit gate (still `docs-sync:ack`) and the consolidation trigger, whose `/docs-consolidate` skill is now `gates:docs-consolidate`. The `.docs-sync` record and the `.git/docs-sync-defer` marker are per-repo and keep working as they are. |
| `design-gate-guard` | 2026-08-26 | `gates` | Uninstall, then install `gates`. The scaffold gate moved across unchanged, `design-gate:ack` included. |
| `workflow-model-guard` | 2026-08-26 | `gates` | Uninstall, then install `gates`. Both hooks moved across unchanged, `model-guard:ack` included. |
| `subagent-driven-development` | 2026-09-05 | `nightshift`, itself retired 2026-09-14 | Uninstall. The inner loop never pushed, opened a PR or merged, and its resume died with the session; Nightshift lands one task per CI-gated PR overnight (`/nightshift:init`, `/nightshift:plan`, `/nightshift:morning`). |
| `landing-loop` | 2026-09-05 | `nightshift`, itself retired 2026-09-14 | Uninstall. Replaced the day it merged; same shape (one task per PR, CI as the only gate) now lives in the target repo's `loop/`. |
| `superpowers-core` (brainstorming, writing-plans) | 2026-09-05 | `nightshift:plan`, itself retired 2026-09-14 | Uninstall. `plan` carries brainstorming's size gate and writing-plans' task format in one skill. |
| `frontend-design` | 2026-09-05 | Claude Design (built-in), or Anthropic's `frontend-design` skill | Uninstall. Its heavy path only routed to Claude Design, which Claude Code now offers directly; its light path was design taste the current models carry. Zero invocations in the two weeks of transcripts checked. |
| `superpowers-core` (test-driven-development, systematic-debugging, writing-skills) | 2026-09-05 | Nothing | Uninstall. The conventions writing-skills enforced already live in `scripts/repo-consistency.test.mjs` and `scripts/skill-frontmatter.test.mjs`; TDD and systematic-debugging were never invoked by a hook and are ordinary practice. |
| `nightshift` (and its Nightwatch half) | 2026-09-14 | Nothing | Uninstall, and remove any `~/Library/LaunchAgents/dev.nightshift.*.plist` with `launchctl bootout`. The overnight loop never worked the way it was wanted. A repo that ran `init` keeps its `loop/` directory, which runs without the plugin; delete it if you are not using it. State under `~/.local/state/nightshift/` and `~/.local/state/nightwatch/` and any clone under `~/Work/Git/nightwatch/` are yours to remove. |
| `adr` | 2026-09-14 | Nothing | Uninstall. Its whole purpose was handing a decomposed ADR to `nightshift` to land, and it dead-ends without it. An ADR is still an ordinary document under `docs/adr/`; nothing in this repo defines a format for it any more. |
| `gates`'s design gate | 2026-09-14 | Nothing | Nothing to uninstall — it went in `gates` 0.4.0. It asked before a new-project scaffold command so a design could be approved first, and its ask text named `brainstorming` and `nightshift:plan`, both retired. `design-gate:ack` no longer does anything. |
