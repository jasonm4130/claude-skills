# Design It Twice

When the user wants to explore alternative interfaces for a chosen deepening candidate, use this parallel sub-agent pattern. Based on "Design It Twice" (Ousterhout) — your first idea is unlikely to be the best.

Uses the vocabulary in [SKILL.md](./SKILL.md) — **module**, **interface**, **seam**, **adapter**, **leverage**.

## Model tiers (required)

The design sub-agents produce interface proposals from a clear technical brief — that is **delegated design-from-spec work**, so dispatch them at `model: 'sonnet'`. The **comparison and recommendation in Step 3 stay with you** (the orchestrator) on the session model, where the cross-proposal judgment lives.

Every `Agent` call below **must** set `model:` explicitly. This repo's `workflow-model-guard` denies untiered `Agent`/`Task` dispatches, and the delegation-tiering convention (`~/Work/Git/CLAUDE.md`) requires a deliberate tier. Don't inherit the session model silently — a fan-out of Opus design agents is exactly the waste the guard exists to stop.

## Process

### 1. Frame the problem space

Before spawning sub-agents, write a user-facing explanation of the problem space for the chosen candidate:

- The constraints any new interface would need to satisfy
- The dependencies it would rely on, and which category they fall into (see [DEEPENING.md](./DEEPENING.md))
- A rough illustrative code sketch to ground the constraints — not a proposal, just a way to make the constraints concrete

Show this to the user, then immediately proceed to Step 2. The user reads and thinks while the sub-agents work in parallel.

### 2. Spawn sub-agents (tiered, parallel)

Spawn 3+ `Agent` calls **in a single message** so they run concurrently. Each must produce a **radically different** interface for the deepened module, and each must set `model: 'sonnet'`.

Prompt each sub-agent with a separate technical brief (file paths, coupling details, dependency category from [DEEPENING.md](./DEEPENING.md), what sits behind the seam). The brief is independent of the user-facing problem-space explanation in Step 1. Give each agent a different design constraint:

- **Agent 1 — minimize:** "Minimize the interface — aim for 1–3 entry points max. Maximise leverage per entry point."
- **Agent 2 — flexibility:** "Maximise flexibility — support many use cases and extension."
- **Agent 3 — common case:** "Optimise for the most common caller — make the default case trivial."
- **Agent 4 — ports & adapters:** "Design around ports & adapters for the injected-port dependency." Add this agent whenever a dependency crosses the module's seam as an **injected port** — that is [DEEPENING.md](./DEEPENING.md) **Category 3 (remote but owned)** *or* **Category 4 (true external)**, not only the one literally headed "Ports & Adapters." Both inject a port and swap adapters (real for production, in-memory/mock for tests); the mechanism is identical. Skip this agent only for pure in-process / local-substitutable deps (Categories 1–2), where there's no injected port to design around.

Include both [SKILL.md](./SKILL.md) vocabulary and the project's `CONTEXT.md` domain vocabulary in each brief, so every sub-agent names things consistently with the architecture language *and* the domain language.

Dispatch shape (one per constraint, all in one message):

```
Agent({
  description: "design interface: minimize",
  subagent_type: "general-purpose",
  model: "sonnet",                       // REQUIRED — never omit
  prompt: "<technical brief> + <SKILL.md vocab> + <CONTEXT.md vocab> +
           constraint: minimize the interface to 1–3 entry points …
           Return: (1) interface incl. invariants/ordering/error modes,
           (2) a caller usage example, (3) what the implementation hides,
           (4) dependency strategy + adapters, (5) trade-offs."
})
```

Each sub-agent outputs:

1. Interface (types, methods, params — plus invariants, ordering, error modes)
2. Usage example showing how callers use it
3. What the implementation hides behind the seam
4. Dependency strategy and adapters (see [DEEPENING.md](./DEEPENING.md))
5. Trade-offs — where leverage is high, where it's thin

### 3. Present and compare (you, on the session model)

Present designs sequentially so the user can absorb each one, then compare them in prose. Contrast by **depth** (leverage at the interface), **locality** (where change concentrates), and **seam placement**.

After comparing, give your own recommendation: which design you think is strongest and why. If elements from different designs would combine well, propose a hybrid. Be opinionated — the user wants a strong read, not a menu.
