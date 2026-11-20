---
name: research-swarm
description: 'Lead-run, fixed-phase research and design swarm: scope, perspective questions, parallel research sized by a run config on an append-only typed board, a source ledger that string-matches every quote, blind designers, a sealed judge, a cross-family PASS/REJECT gate, then one writer. Use only when the user explicitly asks for a research swarm, a multi-agent deep research run, or a researched design for an open-ended question. It spends a large share of a usage allowance, so never auto-trigger it, and never use it for coding tasks.'
---

# Research swarm

You are the lead. You run the phases, keep the state, invoke the gates and talk to the user. You never author research, designs or the final document, and you never let an author own its own gate.

Scripts live in this skill's `scripts/` directory (Python 3.9+, stdlib only). Templates live in `templates/`. Below, `<s>` means that scripts directory and `<run>` means the run directory.

## Before anything: the rules every phase obeys

- **Confirm before dispatch.** Show the user the angles and question list and wait for an explicit go before any researcher starts. A swarm is expensive.
- **Usage stop rule.** Read usage at the start (use a `usage` skill if one is installed, otherwise ask the user to check) and record it with `run.py config --set budget.start_pct=<n>`. At every phase gate, read it again and run `run.py budget --dir <run> --now <n> --hours <next phase> --agents <planned>`. If the planned agents exceed its max, scale down: fewer researchers next round (`--set researchers=<n>`), fewer designers, or one fewer round. Never overrun. Exit 1 means stop now: usage has risen 20 points or passed 85% (both configurable).
- **Every subagent gets an explicit `model`.** Researchers, designers, judge and writer: `opus`. Never hand source reading to a smaller model; a weaker reader drags a strong lead down to its error rate. `haiku` is fine only for mechanical work that reads no sources.
- **Sources, not summaries.** Every FACT carries one source and a verbatim quote, registered in the ledger. Uncited information is not used.
- **Peer findings may be wrong.** Agreement counts for nothing. Anyone relying on a peer's FACT opens its source.
- **Investigate blind.** Researchers do their own question before reading peers' notes. Designers never see each other's designs.
- **The author never owns its gate.** The judge is not a designer. The gate reviewer comes from a different model family from the authors. You invoke that gate yourself; a gate run from inside a teammate loses its result.
- **Privacy.** Name the real data in the brief: personal files, transcripts, private repos, credentials. It never goes to the web, into a search query or URL, or into a public repo. Web searches use generic terms only.
- **Sealed material.** The rubric, answer key and planted-error key live in `<run>/run-private/`. Agents are told never to read it, and you never paste its paths into an agent prompt.

## How big a swarm

More agents rarely help past a point. Across benchmarks, Kim et al. (Nature Machine Intelligence) found a mean gain from multiple agents of 0.0%, with a 95% CI from −58.7 to +77.2. Above a single-agent baseline of about 45%, extra agents rarely helped. The Claude Code agent-teams docs advise starting with 3–5. So a bigger preset buys **breadth**, more distinct angles with one researcher each, not several agents on the same angle. Put two agents on one question only for a blind cross-check of a claim that decides the outcome.

`run.py init --size small|medium|large` writes `run/swarm.json`:

| | small | medium | large |
|---|---|---|---|
| researchers (one per approved angle, at most) | 3 | 6 | 12 |
| research rounds | 1 | 2 | 3 |
| blind designers | 2 | 3 | 3 |
| claim verifiers | ceil(claims / 10), at least 1 | same | same |
| cross-family reviewers | Codex | Codex | Codex + Grok |

Override any key with `--set key=value` at init or later with `run.py config --set`, for example `--set researchers_max=8` or `--set 'reviewers=["codex","grok"]'`. Add Grok at any size when the user asks for it. `run.py size --dir <run> [--claims N]` prints the counts the config implies. Pick `small` unless the user asks for more, or the question has more than about 4 independent angles.

## Phase 0: set up

1. `python3 <s>/run.py init <run> --size <size>` creates the run dir as its own git repo with no remote, writes `run/swarm.json`, seeds `run/` from the templates, and tags `phase/init`. It refuses inside another git work tree.
2. Write `<run>/run/state.md` as you go: time, phase, usage reading, who is live. It is your checkpoint if the session dies.
3. After each phase below, run `python3 <s>/run.py phase <name> --dir <run>`. It commits and tags `phase/<name>`, and refuses while the review log has an undispositioned finding or the repo has a remote.

## Phase 1: scope (you, with the user)

Ask the user **one** clarifying question: the one whose answer most changes what gets researched. Then write the mission and a decision map (D1..Dn: each decision the output must settle, with its options) into `run/BRIEF.md`. "Change nothing" is always a legitimate option.

## Phase 2: perspective questions (you)

STORM-style: list 3–6 perspectives that would disagree about the decisions, for example a practitioner, a sceptic, a maintainer, a cost owner, or prior art. From each, write the questions that perspective would ask. Classify each question as core (answers a decision), background, or follow-up, and keep the core ones. Tag every question with the D# it can change. Group the questions into angles, at most about 4 questions each.

Show the user the angles, the question list, the preset and its `run.py budget` estimate. **Wait for go.** Record the approved angles with `run.py config --set 'angles=[...]'`. Tag `phase/questions`.

## Phase 3: research (sized by `run/swarm.json`)

- One researcher per approved angle, up to the preset's `researchers_max`, flat (no sub-managers), each with the config's time box. Extra budget buys more angles or another round, not more agents per angle.
- Each prompt: "Read `<run>/run/BRIEF.md` and follow it exactly; you are `<agent-id>`; scripts are at `<s>`." Add nothing about what you expect them to find.
- Register each agent as you dispatch it: `run.py roster <agent-id> --dir <run>`.
- Researchers post on `run/board.md`: append-only, with typed entries TAKE / FACT / MEASURE / FAIL / CLAIM / OPEN, and the **first TAKE wins**. They register every source with `ledger.py add` and cite its `[S#]` id. The BRIEF template has the format.
- While they run: `python3 <s>/watch.py <run>/run/board.md <run>/run/swarm.json --idle 10 --undelivered 20`. Exit 1 lists quiet agents and TAKEs with no FACT/MEASURE/FAIL. Nudge, or reassign the question.
- After each round: `python3 <s>/ledger.py --ledger <run>/run/ledger/sources.json check <run>/run/board.md`. Every FACT, MEASURE and CLAIM must cite a VERIFIED id. Send failures back to their author once, then drop what still fails.
- Next round (if any) takes only OPEN questions that name a decision they would change. Stop after the config's `rounds`, or earlier when a round adds no new VERIFIED FACT for any decision. Check the budget before each round and lower `researchers` rather than overrun. Tag `phase/research-<n>` after each round.

## Phase 4: key claims (fresh agent, `opus`)

A fresh agent reads the board and writes `run/key-claims.md`: 20–40 load-bearing claims, `K1..Kn`. Each claim is one sentence, its D#, and its `[S#]` ids. Leave out authors, confidence and vote counts, so the claims carry no "majority view". Conflicting claims go in side by side under a `Conflicts` heading. Then:

- Run the ledger check again on the board.
- Verify: `run.py size --claims <n>` gives the verifier count (one per 10 claims). Each fresh verifier gets its share of claims with only their source page text (`run/ledger/pages/S#.txt`). It returns supported / narrowed / refuted per claim, using at most 3 sub-questions each. Fix or drop what fails.

Tag `phase/claims`.

## Phase 5: outline (you)

Build `run/outline.md` from the key claims: one section per decision, each listing the K ids it rests on. If a section has no claims, either go back for one targeted research round or mark the decision unresolved. Do not fill the gap from your own knowledge. Tag `phase/outline`.

## Phase 6: blind designs (`designers` from the config, `opus`)

Before anyone starts, write the rubric into `run-private/rubric.md` (template: `templates/RUBRIC.md`, gates plus 0–3 scores). Do not change it after you have read a design.

Each designer gets: "Read `<run>/run/DESIGN-BRIEF.md` and follow it; you are `<id>`." They write `run/designs/<id>.md` without seeing each other's work. Give designers different starting stances when that helps, for example "smallest change", "fix the measured failures", and "what would a sceptic build". Tag `phase/designs`.

## Phase 7: sealed judge (fresh agent, `opus`)

Relabel the designs A/B/C, keeping the map in `run-private/`. Fill `templates/JUDGE-PROMPT.md` with the rubric text pasted in. The judge scores, ranks and names a synthesis, writing `run/review/judge.md`. A design that fails a gate cannot win. The judge never sees the rubric file path, and designers never see the rubric. Tag `phase/judge`.

## Phase 8: cross-family gate (you invoke it)

1. A writer drafts the design synthesis to `run/out/design.md` (Phase 9 rules apply).
2. Plant controls. Copy the draft to `run-private/design.clean.md`, then run `python3 <s>/plant.py plant <run>/run/out/design.md --out <run>/run/out/design.md --private <run>/run-private/planted.json --n 3 --ledger <run>/run/ledger/sources.json`. This writes 2–4 subtle errors in place: a shifted number, and a real quote from the same page that no longer supports its line.
3. Fill `run/review/GATE-PROMPT.md` and send it (never mention planted errors, your own assessment or test results) to the other family. Send it to each reviewer in the config's `reviewers`: Codex through the Codex plugin's task or rescue command, Grok through the Grok Build plugin's delegate. If only one of them is installed, use that one and say so. **If neither is installed, stop and tell the user. Never substitute a same-family reviewer and call it the gate.** Save the reply to `run/review/gate-<n>.md`.
4. `python3 <s>/gate.py parse <run>/run/review/gate-<n>.md --log <run>/run/review/log.md --reviewer <codex|grok>`. Exit 0 is PASS, 1 is REJECT, and 3 is unparseable: ask the reviewer once to resend in the format.
5. `python3 <s>/plant.py score <run>/run/review/gate-<n>.md --private <run>/run-private/planted.json` logs the catch rate and names the findings that hit plants.
6. Open `run/review/log.md` and replace every `Disposition: TODO` with `ACCEPTED - <change>`, `REJECTED - <reason>`, or `PLANT`. Verify each finding against the source before accepting. Restore the clean copy, then apply accepted fixes through the writer.
7. On REJECT, run one more gate round on the fixed document, at most 2 rounds in all. Then tag `phase/gate`; `run.py phase` refuses while any disposition is missing.

## Phase 9: write (one writer, `opus`)

One writer drafts section by section from `outline.md`, `key-claims.md` and the judge's synthesis, with web access off. Every claim line carries its K id. Every number carries its `[S#]`. If a section has nothing to stand on, the writer says "no source found" and does not invent one.

Before the gate and before delivery, run `python3 <s>/ledger.py --ledger <run>/run/ledger/sources.json gate <run>/run/out/<doc>.md`. It exits 1 on any citation to a non-VERIFIED or unknown source, and on any `[K#]` line that states a number without an `[S#]`. Tag `phase/final`.

## Deliver

Give the user: the document path, gate verdicts and the planted-control catch rate, the usage spent, and the decisions marked unresolved. The run dir stays local. Publishing anything from it is a separate step that needs the user's approval and a privacy pass.

## Known limits

- `run-private/` is mode 0700, but agents run as the same user, so the seal is an instruction, not a permission boundary. Keep answer keys small and check transcripts if a score looks too good.
- `ledger.py` matches text, not meaning. A VERIFIED quote can still fail to support the claim built on it. That is what the spot-check and the gate are for.
- Pages that render with JavaScript, and PDFs, come back UNVERIFIED. Save a text extract to `run/kb/` and add the file instead; the extract is then only as trustworthy as whoever made it.
- Board times are HH:MM with no date, so a run must stay under 24 hours.
