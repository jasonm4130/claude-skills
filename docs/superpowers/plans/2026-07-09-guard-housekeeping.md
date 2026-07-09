# Guard housekeeping (claude-skills)

Source: LSP alignment audit 2026-07-09 (workflow `wf_cf71aaba-7a6`).

## Global Constraints

- Version-sync invariant (test-enforced by `scripts/repo-consistency.test.mjs`):
  the `.claude-plugin/marketplace.json` entry for each plugin must equal that
  plugin's `.claude-plugin/plugin.json` version.
- The marketplace id is `jasonm4130-claude-skills` — every install command must
  use it.
- Test runner: `bash scripts/run-node-tests.sh` (full suite; baseline is
  202 tests / 202 pass). New repo-wide checks belong in
  `scripts/repo-consistency.test.mjs`.

# Task 1: De-stale workflow-model-guard messages

**Files:** `plugins/workflow-model-guard/scripts/pretooluse-guard-workflow-model.mjs`,
`plugins/workflow-model-guard/.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json`,
`plugins/workflow-model-guard/tests/pretooluse-guard-workflow-model.test.mjs`.

The guard's deny/ask messages hardcode a model lineup that rotates — "Opus 4.8",
`claude-sonnet-4-6`, `claude-haiku-4-5` — and are factually wrong on today's
Fable 5 sessions. Make the wording lineup-agnostic; do NOT change the guard's
detection logic or decision mechanics:

- Comment near line 5: refer to "the session's main-loop model (typically a
  frontier-tier model)" instead of naming Opus 4.8.
- Ask reason (near lines 59-60): drop "If you're on Opus 4.8 that's a …" in favor
  of "every agent it spawns inherits this session's model — on a frontier-tier
  session that is an expensive default."
- Deny reason (near lines 95-97): "every spawned agent defaults to the main-loop
  model, which burns usage limits fast on frontier-tier sessions. Add
  model:'sonnet' (or 'haiku') to worker agents …" — the Workflow runtime accepts
  tier aliases (`sonnet`/`haiku`/`opus`), which don't go stale like full model ids.
- Bump the plugin version 0.2.0 → 0.2.1 in BOTH plugin.json and marketplace.json.
- Existing tests don't assert the stale strings (verified by grep), but update any
  message-substring assertions that break, and ADD one assertion that the deny
  reason recommends a tier alias (e.g. matches `model:'sonnet'`).

# Task 2: Fix stale marketplace ids in plugin READMEs, guarded by a consistency test

**Files:** `plugins/deep-dive/README.md` (line 17),
`plugins/adversarial-agents/README.md` (line 13),
`plugins/visual-plan/README.md` (line 23),
`scripts/repo-consistency.test.mjs`.

Three READMEs tell users to `/plugin install <name>@claude-skills`, but the
marketplace name is `jasonm4130-claude-skills` — the commands fail as written.

1. FIRST extend `scripts/repo-consistency.test.mjs` with a check: for every
   `plugins/*/README.md`, any `/plugin install <name>@<id>` occurrence must use
   the marketplace `name` read from `.claude-plugin/marketplace.json`. Run it and
   confirm it fails on the three stale lines (quote the red run).
2. Then fix the three install commands to `@jasonm4130-claude-skills` and confirm
   the suite is green (quote the green run).
