# Research: Claude Code plugin ecosystem benchmark (mid-2026)

**Date:** 2026-07-11 · **Method:** deep-dive fan-out (5 Sonnet researchers + 5 blind
verifiers, 822k tokens) + parallel repo-hygiene audit agent. Verifier reliability:
platform-changes **high**, other four angles **medium** (partial flags noted inline).

## Verdict for this repo

Ahead of the pack on engineering rigor, was invisible on discovery, now fixed:

- **Testing/CI**: 236-test suite + consistency invariants + 2-OS CI beats most "best in
  class" repos — obra/superpowers (252k stars) has **no CI at all**, anthropics/skills
  (160k stars) has zero tests. Only wshobson/agents (PluginEval + 4 workflows) is ahead.
- **Discovery**: was zero topics + stale 2-plugin description; now 5 topics
  (`claude-code` 46k repos, `claude-code-plugin` ~4k, `claude-skills` ~5.2k are the ones
  with traction), corrected description, `renames` migration for `deep-research→deep-dive`.
- **Stars are a broken signal** (~6M fake stars across 18.6k repos, AI/LLM worst-hit;
  topic pages show 80k-star "niche" plugins). Trust now = real commit history, the
  v2.1.145+ "Will install" pane (driven by our now-aligned metadata), and awesome-list
  inclusion (hesreallyhim/awesome-claude-code, ~50k stars, CONTRIBUTING-gated).

## What's failing ecosystem-wide (verified highlights)

- **Marketplace plumbing**: autoUpdate historically didn't git-pull (#60772); update
  checked stale cache (#36317); failed re-clone wiped the marketplace dir breaking all
  its plugins (#40153 — mitigated locally via `CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE=1`).
  Our cache DID pick up 0.3.0 on 2.1.206, so the no-pull bug doesn't reproduce here.
- **Skills silently stop triggering** past a listing budget (~1% of context window per
  current docs; the older "15k chars as of 2.0.70" figure is stale) — descriptions get
  dropped with no warning. Relevant as our plugin count grows.
- **Community-marketplace submission pipeline** is opaque (8+ week "Published"-but-not-
  listed reports) — argues for GitHub-first distribution, which we already do.
- **Author versioning gotcha**: explicit `version` pins the plugin; pushing commits
  without bumping does nothing for installed users (we bump religiously — fine).

## Docs-drift patterns (what the new docs-sync-guard is built on)

- **Delivery channel is the whole game**: Stop-hook stdout is NOT injected into model
  context (verified post-mortem gist); post-compaction reminders lose to summary
  momentum (#14258). Working designs block at commit (Stafforini's require-ai-config-sync
  denies commits with unpaired config changes) or inject via UserPromptSubmit.
- **Flag, don't rewrite** — advisory/deny with reason; never auto-edit docs.
- **Explicit not-to-flag list** (coder/coder doc-check SKILL.md) is the noise-control
  half; deterministic checks first, LLM only for the gray zone (Dosu freshness scoring).
- Minimalism as prevention: "open your CLAUDE.md six months from now — every line should
  still be true" (+ ETH-Zurich-cited finding that bloated LLM-written context files
  reduce success ~3% and cost 20%+ more).

→ Shipped as `plugins/docs-sync-guard` 0.1.0: PreToolUse commit gate, plugins-monorepo
pairing rule (code dirs ↔ README/CLAUDE.md per plugin), tests/version-bumps/skills-md
never flagged, `docs-sync:ack` escape hatch, fails open.

## Platform changes tracked (high reliability)

`displayName` (2.1.143+), `defaultEnabled` (2.1.154+), `renames` (2.1.193+ — applied),
`CLAUDE_PLUGIN_DATA` (2.1.78+ — session-retro already uses it), monitors/themes must move
under `experimental.*` (deprecation since 2.1.129 — we ship none), no plugin-bundlable
`workflows/` component (deep-dive's fanout.mjs is invoked by path — unaffected), reserved
marketplace names re-checked every load, `claude plugin validate --strict` exists for CI,
`claude plugin tag` (2.1.118) supports a release-tag strategy.

## Open [decide] items for the maintainer

1. CHANGELOG strategy / first GitHub release (`claude plugin tag`); best-in-class uses
   semver releases, but CC's own update UX only reads `version` fields — low urgency.
2. Submit to hesreallyhim/awesome-claude-code (highest-leverage discovery move if
   strangers finding it matters; CONTRIBUTING-gated).
3. Screenshots/demo output in README (shortens stranger evaluation; most top repos also
   lack them).
4. Add 4 missing per-plugin CLAUDE.mds (adr, adversarial-agents, deep-dive, ship-gate) —
   docs-sync-guard now has one from birth; sdd got flagged too.
5. `claude plugin validate --strict` in CI (needs claude CLI install in Actions).
6. mise Node 20 vs CI Node 24 mismatch.
7. CONTRIBUTING.md / issue templates for a public repo.

## Sources (grouped, abridged — full citations in the workflow transcript)

**Pain**: anthropics/claude-code issues #60772, #40153, #36317, #54967, #63174, #6305,
#37988, #16047, #31440 (bot-closed, no maintainer engagement); fsck.com skills-budget post
(2025-12, figures superseded by current docs); claude-plugins-community#14.
**Best-in-class**: github obra/superpowers, anthropics/skills (+discussion #333, PR #83),
wshobson/agents, anthropics/claude-plugins-official, hesreallyhim/awesome-claude-code,
VoltAgent; Snyk 36%-of-skills audit + 6.2/12 rubric (medium.com, single-source);
lysenko.dev superpowers auto-trigger test; ddewhurst.com (Willison token observation).
**Discoverability**: code.claude.com/docs discover-plugins + plugin-marketplaces;
github.com/topics/*; 36kr fake-stars study; t3.gg; claudelab.net vetting guide; polyskill.ai.
**Docs-drift**: code.claude.com/docs/en/hooks; yurukusa/cc-safe-setup; heyclau.de
readme-refresh-validator; ayautomate.com; coder/coder doc-check SKILL.md; dosu.dev freshness
scoring (+Cloudflare AGENTS.md platform); stafforini.com sync setup; FlorianBruniaux/ctxharness
(+InfoQ ETH study); michaelewens gist (Stop-hook stdout post-mortem); claude-code#14258;
Jamie-BitFlight claude_skills; athola/claude-night-market; developersdigest.tech; claudepluginhub.
**Platform**: code.claude.com/docs plugins-reference / plugin-marketplaces / agent-teams;
anthropics/claude-code CHANGELOG (through 2.1.206).
