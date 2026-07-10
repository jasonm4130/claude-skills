# Research: Codifying the orchestrator/delegation pattern + enforcing subagent model tiers

**Date:** 2026-07-11
**Question:** How do people codify "expensive orchestrator, cheap workers" in Claude Code for
small one-off tasks (where SDD/workflows are overkill), and can our workflow-model-guard be
extended from the Workflow tool to ad-hoc Agent dispatches?
**Method:** deep-dive fan-out (4 Sonnet research agents + 4 blind verifiers, 741k tokens), local
transcript mining across all projects, and 3 sandboxed headless probes against Claude Code 2.1.206.

## TL;DR

- Prose alone doesn't hold: Anthropic's own docs call CLAUDE.md "context, not enforced
  configuration" and name hooks/permissions as the deterministic layer. The community that makes
  delegation stick uses **model-pinned agent definitions + enforcement**, not instructions.
- Our own data confirms the leak: **73% of 477 Agent dispatches omitted `model`** and inherited
  the session model (Fable/Opus). The 27% that tiered came almost entirely from codified flows
  (SDD). Worst bucket: the built-in Explore agent — 71 of 75 dispatches inherited.
- The two GitHub issues suggesting Agent-tool hooks are broken (#56151 hook-never-fires,
  #44534 deny-not-enforced) **do not reproduce on 2.1.206** — verified by sandboxed probes.
  PreToolUse on `Agent` fires, sees `subagent_type`/`model`, enforces `deny`, and can silently
  rewrite the model via `updatedInput` (verified end-to-end: subagent transcript showed haiku).
- Recommended: three layers — a short CLAUDE.md delegation calculus (probabilistic), a shadow
  `Explore` agent with pinned cheap model (deterministic, docs-blessed), and an Agent-matcher
  extension to workflow-model-guard (deterministic backstop).

## Local empirics (this machine, all projects)

- 477 `Agent` tool dispatches in transcript history: 346 (73%) set no `model`.
- When set: sonnet ×109, opus ×20, haiku ×2 — overwhelmingly from SDD-style skill-mandated
  dispatches. Codified skills produce tiering; ad-hoc "preserve context" dispatches don't.
- By type: Explore omitted 71/75; general-purpose omitted 221/344.
- No custom agent definitions exist (`~/.claude/agents` empty, no plugin `agents/` dirs), so
  every dispatch resolves to a built-in type → inherits the session model unless the param is set.
- Tool name is `Agent` in hook payloads; a legacy `Task` matcher **also** fires for the same
  call (both sentinel files written in probe A) — so a single `Agent` matcher suffices, and
  anyone still matching `Task` double-fires.

## Probe results (Claude Code 2.1.206, sandboxed `claude -p` sessions)

| Probe | Setup | Result |
|---|---|---|
| A: does the hook fire? | log-only hook, matchers `Agent` + `Task` | **Fires.** Payload: `tool_name: "Agent"`, `tool_input` with `description`/`prompt`/`subagent_type`; `model` key absent when omitted. Also: `permission_mode`, `effort`, `session_id`, `transcript_path` at top level. `Task` matcher fired for the same call. |
| B: is deny enforced? | hook returns `permissionDecision: "deny"` | **Enforced.** Hook fired once, no retry, zero subagent transcripts spawned; the model demonstrably received `permissionDecisionReason` (echoed a sentinel string that existed only there). |
| C: can input be rewritten? | `permissionDecision: "allow"` + `updatedInput` adding `model: "haiku"` | **Works silently.** Main loop ran `claude-sonnet-5`; subagent transcript (`<session>/subagents/agent-*.jsonl`) shows `claude-haiku-4-5-20251001`. The recorded tool_use block still shows the original input — the rewrite is invisible to the conversation. |

This resolves the load-bearing contradiction in the research: issues
[#56151](https://github.com/anthropics/claude-code/issues/56151) (2026-05-04, closed as dup, never
confirmed fixed) and [#44534](https://github.com/anthropics/claude-code/issues/44534) (2026-04-13,
thread self-contradicts on its own workaround) are stale relative to current behavior. Trust the
docs, which the verifier confirmed verbatim.

## Verified findings by angle

### Official levers (verifier reliability: high — every claim verbatim-confirmed against docs)

- Subagent model resolution precedence: **(1) `CLAUDE_CODE_SUBAGENT_MODEL` env var → (2)
  per-invocation `model` param → (3) frontmatter `model:` → (4) main conversation's model.**
  Frontmatter default is `inherit`. Since v2.1.196, env var set to `inherit` = unset.
- The env var **overrides even the per-invocation param** — it's a sledgehammer: setting it to
  sonnet would also downgrade deliberate `model: "opus"` dispatches. Startup-read, global.
- The Agent tool's documented input schema includes `subagent_type` and optional
  `model: "sonnet"|"opus"|"haiku"|"fable"` — both visible to PreToolUse hooks.
- `updatedInput` requires `permissionDecision: "allow"` (auto-approve) or `"ask"`; ignored with
  `"defer"`. Multi-hook precedence: deny > defer > ask > allow. Docs are silent on two hooks
  returning conflicting `updatedInput`.
- **Explore built-in changed in v2.1.198**: it now inherits the main conversation's model
  (capped at Opus on the API) instead of always running Haiku. Docs explicitly bless the fix:
  a user/project agent literally named `Explore` overrides the built-in, so `model: haiku` (or
  sonnet) in a shadow definition pins exploration cheap. Per-invocation param still beats
  frontmatter, so deliberate upgrades remain possible.
- Org `availableModels` allowlist silently skips excluded models and falls back to inherit.

### Community codification patterns (reliability: medium)

Three escalating layers appear repeatedly:

1. **Description-field steering** — "use PROACTIVELY" / "MUST BE USED" phrasing in agent
   `description:` fields to nudge auto-delegation (official docs endorse this; the
   tomas-rampas gist and VoltAgent's 33-agent collection both codify it).
2. **Tiered agent collections** — model-pinned worker definitions mapped to task type:
   plan-agent on opus, maker-agent on sonnet, reader/test/docs agents on haiku
   (tomas-rampas gist, 2025-08→2026-04; VoltAgent "Smart Model Routing" table). The
   published Fable-orchestrator guides (Data Science Dojo, 2026-07-06) are the same shape:
   Fable main session + `deep-reasoner.md` / `fast-worker.md` subagents + CLAUDE.md rules +
   session restart to pick up agent dirs.
3. **Dispatcher-protocol CLAUDE.mds** — "You are a Dispatcher... You MUST NOT attempt to solve
   the user's request on your own" (lst97), "Main agent NEVER executes tools directly" (barkain).
   Maximalist; nobody credible reports these holding without enforcement, and they fight
   the over-delegation failure mode below.

Counterpoint (HatchWorks, single-source opinion but verbatim-verified): "If you're counting on
Claude to automatically reach for the right sub-agent... you'll be disappointed often enough to
lose trust in the system." Their recommended pattern — subagents as **named tools the main
session explicitly calls** — matches what our SDD data shows working.

### Does prose instruction hold? (reliability: medium)

- Anthropic, verbatim, three places: CLAUDE.md is "context, not enforced configuration"; "the
  model can fail to follow a prompted rule. A real guardrail needs to be deterministic, and the
  enforcement methods are hooks and permissions" (claude.com blog, 2026-06-18); "To block an
  action regardless of what Claude decides, use a PreToolUse hook instead" (memory docs).
- Issue #59309 + related family: CLAUDE.md rules don't propagate into subagents and degrade
  after compaction. (Verifier note: the issue's duplicate list was partly overstated and the
  thread has astroturf-quality comments promoting a third-party plugin — the core bug report
  itself checks out.)
- Practitioner consensus: explicit config (frontmatter/env/hooks) is the lever; prose is a
  default-setter at best. One LinkedIn report of a "90% bill cut" via env vars is anecdotal,
  single-source — directionally consistent, don't cite the number.

### Economics (reliability: medium)

- Anthropic multi-agent research post (2025-06-13, primary source, verbatim-verified): Opus
  lead + Sonnet subagents beat single-agent Opus by **90.2%** on their research eval; agents
  ≈4× chat tokens, multi-agent systems ≈15×; "most coding tasks involve fewer truly
  parallelizable tasks than research." Delegation pays when task value clears the token premium.
- Context-preservation numbers are real: Anthropic's context-window walkthrough example has a
  subagent reading ~6,100 tokens and returning 420 to the parent (well-triangulated).
- Docs warn against delegating when **latency matters** and note non-fork subagents start with
  zero conversation context — the "relay loss" cost is real and is why trivial/tightly-coupled
  work shouldn't be delegated.
- The "~40% cheaper with tiered agent teams" figure (CloudZero, 2026-05-18) is a marketing
  blog's unverified arithmetic — direction fine, number unaudited. Issue #42796 ("every single
  one of these agents is now an idiot") is one team's uncorroborated account of delegation
  amplifying a quality regression across 10+ concurrent sessions — a useful cautionary tale
  about scaling delegation without verification layers, not a benchmark.

## Recommended architecture (three layers, mirrors the lsp-first pattern: rule + guard)

1. **CLAUDE.md delegation calculus** (probabilistic default-setter) — short block in
   `~/Work/Git/CLAUDE.md` next to LSP-first: when dispatching the Agent tool, always set
   `model` explicitly — sonnet for search/reads/mechanical implementation/verification, haiku
   only for pure enumeration, opus/fable only when the task genuinely needs frontier reasoning;
   and don't delegate trivial or tightly-coupled work at all (cold-start + relay loss beats the
   context saving).
2. **Shadow `Explore` agent** (`~/.claude/agents/Explore.md`, `model: sonnet`) — deterministic
   fix for the single biggest measured leak (95% of Explore dispatches inherited). Docs-blessed
   shadowing; per-invocation param can still upgrade it when justified. Small risk: the shadow
   replaces the built-in's tuned system prompt, so the definition needs a good read-only search
   prompt. Needs a session restart to take effect.
3. **Agent-matcher guard** (extend workflow-model-guard, same plugin, second hook entry) —
   PreToolUse matcher `Agent`; when `tool_input.model` is absent and `subagent_type` doesn't
   resolve to a definition with pinned frontmatter `model:` (scan `~/.claude/agents`, project
   `.claude/agents`, plugin `agents/` dirs), **deny** with a reason telling Claude to re-dispatch
   with an explicit tier. Explicit `model` — any value, including fable — passes: setting it IS
   the ack, exactly like the workflow guard's `model:` bypass. No scale gate (a single frontier
   dispatch is the unit of waste here; the reason text keeps the re-dispatch cost to one round
   trip). Exempt: shadowed/custom agents with pinned models (auto-detected), and skip when the
   session itself is already cheap — not detectable (session model still isn't in hook stdin/env),
   so accept the false-positive on Sonnet-driven sessions; the deny costs one round trip and the
   explicit model is correct hygiene anyway.

**Enforcement flavor trade-off** (the one open decision):

- *Deny-nudge* (recommended): forces the orchestrator to think per dispatch — matches the goal
  ("they're just spinning up fable instead of thinking about what makes sense"). Costs one
  round trip per untiered dispatch.
- *Silent auto-rewrite* (`updatedInput` → sonnet): zero friction, but removes the thinking and
  silently downgrades genuinely-hard tasks; the conversation record doesn't even show the
  rewrite. Defensible only for Explore — but the shadow agent already covers Explore more
  transparently.
- *Hybrid*: auto-rewrite Explore, deny-nudge the rest — redundant once the shadow agent exists.

**Rejected:** `CLAUDE_CODE_SUBAGENT_MODEL` — overrides even deliberate per-invocation upgrades,
global and startup-read; wrong shape for "think per request". Dispatcher-protocol CLAUDE.md
("never execute directly") — fights the documented over-delegation failure mode and isn't
enforced anyway.

## Open questions

- Does the Agent matcher fire for agents spawned *inside* a Workflow run's `agent()` calls?
  (Untested; the workflow guard already covers that surface, so low stakes either way.)
- Whether a shadow `general-purpose` definition would also be honored is undocumented — not
  needed under the deny-nudge design, and replacing its system prompt is riskier than Explore's.
- Hook-firing/deny bugs were version-sensitive (#56151, #44534, #47488 all report behavior that
  later versions fixed or changed) — re-verify the probes after major Claude Code upgrades.

## Sources

**Official levers:** code.claude.com/docs/en/sub-agents · code.claude.com/docs/en/model-config ·
code.claude.com/docs/en/hooks · code.claude.com/docs/en/agent-sdk/hooks ·
code.claude.com/docs/en/agent-sdk/typescript (all accessed 2026-07-11)

**Community patterns:** github.com/lst97/claude-code-sub-agents (CLAUDE.md dispatch protocol) ·
github.com/barkain/claude-code-workflow-orchestration (delegate.md) ·
gist.github.com/tomas-rampas/a79213bb4cf59722e45eab7aa45f155c (seven-agent setup, upd. 2026-04-28) ·
github.com/VoltAgent/awesome-claude-code-subagents · datasciencedojo.com/blog/claude-code-fable-5-orchestrator-workflow
(2026-07-06) · hatchworks.com/blog/claude/claude-sub-agents-and-agent-teams ·
reddit.com/r/ClaudeAI/comments/1ulcxxb · reddit.com/r/ClaudeCode/comments/1u2toqz

**Instruction-following:** claude.com/blog/steering-claude-code-skills-hooks-rules-subagents-and-more
(2026-06-18) · code.claude.com/docs/en/memory.md · github.com/anthropics/claude-code issues
#59309, #56151, #44534, #47488, #19174 · medium.com/@roanmonteiro (subagent model routing) ·
linkedin.com/pulse (Placona, env-var bill cut — anecdotal)

**Economics:** anthropic.com/engineering/multi-agent-research-system (2025-06-13) ·
cloudzero.com/blog/claude-code-agents (2026-05-18, single-source figures) ·
ocdevel.com/podcaster/claude-code (subagent economics analysis) · github.com/anthropics/claude-code
issue #42796 (anecdotal)

**Local probes:** scratchpad `hook-probe/{a-log,b-deny,c-rewrite}`, Claude Code 2.1.206, 2026-07-11.
