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
| Plan / design / spec | YAGNI, Premortem, Hidden Assumptions |
| Code | Saboteur, New Hire, Security Auditor |
| Prose | *none built in* — you supply them with `--personas` |
| Model output | *none built in* — you supply them with `--personas` |

Personas live in `skills/adversarial-agents/personas/` — edit or add to taste. The built-ins are
`yagni`, `premortem`, `hidden_assumptions`, `saboteur`, `new_hire`, `security_auditor`.

**The prose and model-output panels have no default personas.** The skill will not pick them for you —
a critique of writing or of a model's answer depends too much on what you are actually worried about.
Supply your own:

```
adversarial-agents --panel prose --personas "You are a hostile copy editor: cut every sentence that does not earn its place","You are the reader this was NOT written for: say where you get lost"
```

Each `--personas` entry is used as a one-off inline prompt string — there is no registry lookup, so you
can write the persona inline rather than adding a file. (Naming a built-in there does not work; use the
panels above for those.)

## How it differs from a vanilla review

- **Pre-commit gate.** You write a 1-paragraph defense before the panel sees anything. The panel attacks the defense too, so questions can't become leading cues.
- **Pure conversation.** No file output, no "recommended answer" — the critique *is* the question.
- **Convergence-first.** When multiple personas independently land on the same hole, that's surfaced first.
