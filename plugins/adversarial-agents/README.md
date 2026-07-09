# adversarial-agents

Configurable adversarial panel review for any artefact — plans, code, design docs, prose, model outputs.

Auto-selects the panel by artefact type, captures a pre-commit defense from you (to prevent sycophantic agreement with the panel's questions), dispatches personas in parallel, then walks every critique one at a time with verbatim quoting and convergence-prioritised ordering.

Generalises the panel-of-personas pattern from Matt Pocock's `grill-me` to arbitrary artefact types.

## Install

```
/plugin marketplace add jasonm4130/claude-skills
/plugin install adversarial-agents@jasonm4130-claude-skills
```

## Use

Trigger phrases the skill recognises: "review my plan", "grill this", "red team", "stress test", "find holes", "devil's advocate", "adversarial-agents".

## Panels

| Artefact | Personas |
|---|---|
| Plan / design doc | YAGNI, Premortem, Hidden Assumptions |
| Code | Saboteur, New Hire, Security Auditor |
| Prose / model output | Hidden Assumptions + artefact-fit picks |

Personas live in `skills/adversarial-agents/personas/` — edit or add to taste.

## How it differs from a vanilla review

- **Pre-commit gate.** You write a 1-paragraph defense before the panel sees anything. The panel attacks the defense too, so questions can't become leading cues.
- **Pure conversation.** No file output, no "recommended answer" — the critique *is* the question.
- **Convergence-first.** When multiple personas independently land on the same hole, that's surfaced first.
