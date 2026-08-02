---
name: writing-skills
description: Covers the skill-authoring rules specific to this repo and the empirical wording findings that general guidance does not contain — matching guidance form to failure type, micro-testing against a no-guidance control, and the plugin/marketplace conventions a skill must satisfy here. Use when creating, editing, or retiring a skill in this repo. Do NOT use for generic SKILL.md format questions (Claude knows the format natively; the live spec is linked below), and do NOT use for writing prose in durable artifacts (see writing-artifacts:writing-artifacts).
---

# Writing Skills

**Read Anthropic's [skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) for the format itself.** It is the authority on frontmatter validation, progressive disclosure, naming and structure, and it is maintained. This skill deliberately does not restate it — a vendored copy used to live here and had drifted out of date within three weeks. Everything below is what that document does *not* cover: findings from wording tests run in this repo, and conventions enforced by this repo's tests.

The checkable numbers worth remembering: SKILL.md body **under 500 lines**, description **under 1,024 characters**, references **one level deep** from SKILL.md, reference files over 100 lines get a table of contents.

## Do not author guidance until a control exhibits the failure

**Always run a no-guidance control first. If the control doesn't exhibit the failure, there is nothing to fix — stop, and don't author the guidance.**

This is the most load-bearing rule here, and it deletes more text than it writes. Two examples from this repo, both of which removed a rule rather than adding one:

- `test-driven-development` carried "You MUST write the test first" as an absolute. A no-guidance Opus 5 control, given valuable token-bucket logic three hours in, a sprint ending and a blocked colleague, declined to delete the work and instead invented a mutation-testing recovery, disclosed the violation unprompted, and named the limitation itself. The absolutism went; the recovery path it produced became the guidance.
- `systematic-debugging` carried "You MUST complete each phase before proceeding." A control given a confident-but-wrong colleague diagnosis, a one-hour demo deadline and "it's a trivial one-liner" refused the fix, disproved the diagnosis from the snippet, went to root cause and proposed a failing test — unprompted. The mandate had nothing left to enforce and went. The phase *content* was not reproduced by the control, and stayed.

Both are n=1 on one scenario shape. Treat them as the reason to run the control, not as settled results.

## Match the form to the failure

Classify the baseline failure before writing anything. The form that bulletproofs one failure type measurably backfires on another.

| Baseline failure | Right form | Wrong form |
|---|---|---|
| Skips/violates a rule under pressure (knows better, does it anyway) | Prohibition + rationalization table + red flags | Soft guidance ("prefer…", "consider…") |
| Complies, but output has the wrong shape (bloated prompt, buried verdict, restated spec) | Positive recipe or contract: state what the output IS — its parts, in order | Prohibition list ("don't restate", "never narrate") |
| Omits a required element from something they already produce | Structural: REQUIRED field or slot in the template they fill in | Prose reminders near the template |
| Behavior should depend on a condition | Conditional keyed to an observable predicate ("if the brief exists, reference it") | Unconditional rule + exemption clauses |

**Why prohibitions backfire on shaping problems:** under a competing incentive ("make the prompt self-contained"), agents negotiate with "don't X". In head-to-head wording tests on dispatch-prompt guidance, the prohibition arm produced clearly more of the unwanted content than the recipe arm — fully separated distributions — and trended worse than even the no-guidance control. A recipe leaves nothing to negotiate: the output matches the stated shape or it doesn't.

**Rules for whichever form you pick:**

- **No nuance clauses.** "Don't X unless it matters" reopens the negotiation. Appending a single nuance clause to a winning recipe degraded it from consistent to noisy in the same tests. Express a real exception as its own conditional on an observable predicate.
- **Exemption clauses don't scope.** "This limit doesn't apply to code blocks" still suppresses code blocks. If part of the output must be exempt, restructure so the rule cannot reach it.

## Micro-test the wording before the full scenarios

Pressure-scenario runs are the final gate for discipline skills, but they are slow and expensive per iteration. Verify the wording first:

1. **One fresh-context sample per call.** System prompt = the realistic context the guidance will live in (the whole skill, not the guidance in isolation); user message = a task that tempts the failure.
2. **Always include the no-guidance control** (see above).
3. **5+ reps per variant.** Single samples lie.
4. **Read every flagged match manually.** Template echoes and quoted counter-examples masquerade as hits; automated counts overstate both failure and success.
5. **Variance is a metric.** When guidance lands, reps converge on the same shape. Five different interpretations across five reps means the wording isn't binding — tighten the form before adding words.

For discipline skills, follow up with pressure scenarios: see [testing-skills-with-subagents.md](testing-skills-with-subagents.md) for scenario construction, pressure types, and plugging holes systematically. Bulletproofing a discipline skill means closing loopholes explicitly, answering the spirit-vs-letter argument in the text, listing the rationalizations you actually observed alongside their rebuttals, and giving red flags that say STOP.

## Conventions this repo enforces

Each of these is a test that will fail, not a preference.

**Name every skill plugin-qualified in anything a hook emits.** `Skill(retro)` returns `Unknown skill: retro`; `Skill(session-retro:retro)` works. A bare name is one the model resolves by guessing, and across an audit of 8 used skills it guessed wrong in 4. `scripts/repo-consistency.test.mjs` scans hook sources — both `.mjs` and `rust/src/*.rs` — and fails on a bare `"<skill> skill"`. Comments are stripped before scanning, so discussing the bare name in a comment is fine.

**Give every skill exactly one mechanical inbound edge.** Every skill that actually fires has a named CLAUDE.md gate, a hook nudge, an unambiguous user phrase, or a hand-off from a skill that already fires. Five skills that had none were invoked zero times over 6–10 weeks and were deleted. A "see also" cross-reference does not cause invocation; an imperative instruction does.

**Bump the version when shipped payload changes.** `node scripts/bump-plugin.mjs <plugin> <patch|minor|major>` edits both `plugins/<name>/.claude-plugin/plugin.json` and the root `marketplace.json` by targeted string replacement — never hand-edit one and forget the other. `scripts/check-version-bumps.mjs` gates every PR. Exempt from the gate: `.claude-plugin/**`, `tests/`, `*.test.*`, and a plugin's top-level `README.md`/`CLAUDE.md`. Everything else, including `skills/` and `bin/`, is payload.

**Version-pin cached paths to the plugin being resolved, not your own.** A SKILL.md that resolves another plugin's workflow writes `…/cache/jasonm4130-claude-skills/<that-plugin>/<that-plugin's-version>/…`, guards it with `[ -f "$P" ]`, and fails loud with a literal `MISSING:` message. Superseded versions stay on disk, so globbing for the highest cached version silently undoes a rollback. `scripts/cached-path-pin.test.mjs` enforces this, which means bumping a resolved plugin breaks the pin by construction — re-pin in the same change.

**Keep duplicated `lib.mjs` helpers byte-identical.** Plugins cannot share files, so six copies exist. Any function exported by two or more of them must be identical; `scripts/lib-drift.test.mjs` fails otherwise. The hazard is real — a data-dir bug once lived in one copy of five.

**Frontmatter needs a non-empty `description`** (`scripts/skill-frontmatter.test.mjs`). Prefer a plain inline value; the folded `>` form parses fine and is used in a few skills, but it hides the length from a quick scan.

Run everything with `bash scripts/run-node-tests.sh`.

## Retiring a skill

Deleting is a normal outcome, not a failure. Before writing a skill, check whether an existing one already covers the trigger — semantically-overlapping skills hide each other, and two skills colliding on the same phrase means neither reliably fires. Before keeping a skill that has never been invoked, find its inbound edge; if there isn't one, either give it one or delete it.
