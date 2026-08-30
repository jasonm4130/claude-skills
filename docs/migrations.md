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
| `claude-design` | 2026-08-26 | `frontend-design` | Uninstall, and install `frontend-design` if you don't already have it. Its heavy path now carries the goal/layout/content/audience brief and the `/design-sync` design-system route directly — one skill instead of two that had to agree with each other. |
| `superpowers-core`'s `using-skills` skill and its `SessionStart` hook | 2026-08-26 | Your own global `CLAUDE.md` | Keep `superpowers-core` installed — the five method skills are unchanged. The dispatcher kernel it used to inject every session now belongs in `~/.claude/CLAUDE.md`, which already loads at every session start; injecting it as well stated the same rule twice. Copy the rules you want there. Claude Code will stop prompting for the plugin's hook. |
| `codebase-design` | 2026-08-26 | Nothing | Uninstall. The 2026-08-03 ADR kept it on the condition that an imperative hand-off from `brainstorming` produce invocations by 2026-08-24; it was still at zero, so the review clause fired. The design vocabulary it carried is native to Claude — `brainstorming` and `test-driven-development` now make their boundary and seam points directly. |
| `docs-sync-guard` | 2026-08-26 | `gates` | Uninstall, then `/plugin install gates@jasonm4130-claude-skills`. Both mechanisms moved across unchanged: the commit gate (still `docs-sync:ack`) and the consolidation trigger, whose `/docs-consolidate` skill is now `gates:docs-consolidate`. The `.docs-sync` record and the `.git/docs-sync-defer` marker are per-repo and keep working as they are. |
| `design-gate-guard` | 2026-08-26 | `gates` | Uninstall, then install `gates`. The scaffold gate moved across unchanged, `design-gate:ack` included. |
| `workflow-model-guard` | 2026-08-26 | `gates` | Uninstall, then install `gates`. Both hooks moved across unchanged, `model-guard:ack` included. |

