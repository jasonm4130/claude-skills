# adr

Front-end for **`adr → sdd`**. Turns an intent into one *grounded, cited,
build-ready* ADR at `docs/adr/YYYY-MM-DD-<slug>.md` — every claim cited,
load-bearing decisions surfaced to the human — then hands it to the
`subagent-driven-development` loop. This collapses the
`brainstorm → spec → writing-plans → sdd` chain into `adr → sdd` for "I know what
I want, build it" work, while `brainstorming` stays for exploratory work and
`visual-plan` for visual planning.

## The arc

```
intent → GROUND → ADR (you approve) → SDD loop → you ratify
```

The skill stays thin — a four-phase orchestrator. The determinism lives in the
SDD `sdd.mjs` workflow, not in this prose.

## The four phases

1. **Ground (scaled).** Read the real code and current external practice the
   change touches — LSP, `graphify`, `git`, `context7`, the cloudflare MCP.
   Inline by default; escalate to a `deep-dive` fan-out only when novel,
   cross-cutting, or asked.
2. **Author the ADR.** Write `docs/adr/YYYY-MM-DD-<slug>.md` — Context, Decisions,
   checkable Success criteria, Consequences, Grounding sources, and a thin
   `### Task N` Decomposition last. Every codebase claim cites a file/symbol,
   every external claim a dated source; ungrounded claims are excluded.
3. **Tiered decision gate.** Load-bearing decisions (new dependency, public-API
   change, schema/data-model change, architecture-shaping choice) block on the
   human before anything builds; reversible ones become overridable defaults.
4. **Handoff.** On approval, resolve `sdd.mjs` and invoke the Workflow with the
   ADR; the loop runs per-task implement → review → fix and judges the branch
   against the ADR's Success criteria. Merge stays human-gated.

## See also

- Design spec: `docs/superpowers/specs/2026-06-27-adr-driven-development-design.md`
- The loop it drives: `plugins/subagent-driven-development/`
