---
name: research-swarm
description: 'Lead-run, fixed-phase research and design swarm: scope, perspective questions, capped parallel research on an append-only typed board, a source ledger that string-matches every quote, blind designers, a sealed judge, a cross-family PASS/REJECT gate, then one writer. Use only when the user explicitly asks for a research swarm, a multi-agent deep research run, or a researched design for an open-ended question. It spends a large share of a usage allowance, so never auto-trigger it, and never use it for coding tasks.'
---

# Research swarm

You are the lead. You run the phases, keep the state, invoke the gates and talk to the user. You never author research, designs or the final document, and you never let an author own its own gate.

Scripts live in this skill's `scripts/` directory (Python 3.9+, stdlib only). Templates live in `templates/`. Below, `<s>` means that scripts directory and `<run>` means the run directory.

## Before anything: the rules every phase obeys

- **Confirm before dispatch.** Show the user the angles and question list and wait for an explicit go before any researcher starts. A swarm is expensive.
- **Usage stop rule.** Read usage at the start (use a `usage` skill if one is installed, otherwise ask the user to check). At every phase gate, stop and report if usage has risen more than 20 points since the start, or has passed 85%.
- **Every subagent gets an explicit `model`.** Researchers, designers, judge and writer: `opus`. Never hand source reading to a smaller model; a weaker reader drags a strong lead down to its error rate. `haiku` is fine only for mechanical work that reads no sources.
- **Sources, not summaries.** Every FACT carries one source and a verbatim quote, registered in the ledger. Uncited information is not used.
- **Peer findings may be wrong.** Agreement counts for nothing. Anyone relying on a peer's FACT opens its source.
- **Investigate blind.** Researchers do their own question before reading peers' notes. Designers never see each other's designs.
- **The author never owns its gate.** The judge is not a designer. The gate reviewer comes from a different model family from the authors. You invoke that gate yourself; a gate run from inside a teammate loses its result.
- **Privacy.** Name the real data in the brief: personal files, transcripts, private repos, credentials. It never goes to the web, into a search query or URL, or into a public repo. Web searches use generic terms only.
- **Sealed material.** The rubric, answer key and planted-error key live in `<run>/run-private/`. Agents are told never to read it, and you never paste its paths into an agent prompt.

## Phase 0: set up

1. `python3 <s>/run.py init <run>` creates the run dir as its own git repo with no remote, seeds `run/` from the templates, and tags `phase/init`. It refuses inside another git work tree.
2. Write `<run>/run/state.md` as you go: time, phase, usage reading, who is live. It is your checkpoint if the session dies.
3. After each phase below, run `python3 <s>/run.py phase <name> --dir <run>`. It commits and tags `phase/<name>`, and refuses while the review log has an undispositioned finding or the repo has a remote.

## Phase 1: scope (you, with the user)

Ask the user **one** clarifying question: the one whose answer most changes what gets researched. Then write the mission and a decision map (D1..Dn: each decision the output must settle, with its options) into `run/BRIEF.md`. "Change nothing" is always a legitimate option.

## Phase 2: perspective questions (you)

STORM-style: list 3–6 perspectives that would disagree about the decisions, for example a practitioner, a sceptic, a maintainer, a cost owner, or prior art. From each, write the questions that perspective would ask. Classify each question as core (answers a decision), background, or follow-up, and keep the core ones. Tag every question with the D# it can change. Cap at about 4 questions per researcher.

Show the user the perspectives and question list. **Wait for go.** Tag `phase/questions`.

## Phase 3: capped research (≤5 researchers, ≤3 rounds)

- At most 5 researchers per round, flat (no sub-managers), each with a time box (20–30 min). More budget buys depth per question, not more agents.
- Each prompt: "Read `<run>/run/BRIEF.md` and follow it exactly; you are `<agent-id>`; scripts are at `<s>`." Add nothing about what you expect them to find.
- Write each agent and its start time into `run/roster.txt`.
- Researchers post on `run/board.md`: append-only, with typed entries TAKE / FACT / MEASURE / FAIL / CLAIM / OPEN, and the **first TAKE wins**. They register every source with `ledger.py add` and cite its `[S#]` id. The BRIEF template has the format.
- While they run: `python3 <s>/watch.py <run>/run/board.md <run>/run/roster.txt --idle 10 --undelivered 20`. Exit 1 lists quiet agents and TAKEs with no FACT/MEASURE/FAIL. Nudge, or reassign the question.
- After each round: `python3 <s>/ledger.py --ledger <run>/run/ledger/sources.json check <run>/run/board.md`. Every FACT, MEASURE and CLAIM must cite a VERIFIED id. Send failures back to their author once, then drop what still fails.
- Next round (if any) takes only OPEN questions that name a decision they would change. Stop after round 3, or earlier when a round adds no new VERIFIED FACT for any decision. Tag `phase/research-<n>` after each round.

## Phase 4: key claims (fresh agent, `opus`)

A fresh agent reads the board and writes `run/key-claims.md`: 20–40 load-bearing claims, `K1..Kn`. Each claim is one sentence, its D#, and its `[S#]` ids. Leave out authors, confidence and vote counts, so the claims carry no "majority view". Conflicting claims go in side by side under a `Conflicts` heading. Then:

- Run the ledger check again on the board.
- Spot-check: a second fresh agent gets 5–10 claims with only their source page text (`run/ledger/pages/S#.txt`). It returns supported / narrowed / refuted per claim, using at most 3 sub-questions each. Fix or drop what fails.

Tag `phase/claims`.

## Phase 5: outline (you)

Build `run/outline.md` from the key claims: one section per decision, each listing the K ids it rests on. If a section has no claims, either go back for one targeted research round or mark the decision unresolved. Do not fill the gap from your own knowledge. Tag `phase/outline`.

## Phase 6: blind designs (2–3 designers, `opus`)

Before anyone starts, write the rubric into `run-private/rubric.md` (template: `templates/RUBRIC.md`, gates plus 0–3 scores). Do not change it after you have read a design.

Each designer gets: "Read `<run>/run/DESIGN-BRIEF.md` and follow it; you are `<id>`." They write `run/designs/<id>.md` without seeing each other's work. Give designers different starting stances when that helps, for example "smallest change", "fix the measured failures", and "what would a sceptic build". Tag `phase/designs`.

## Phase 7: sealed judge (fresh agent, `opus`)

Relabel the designs A/B/C, keeping the map in `run-private/`. Fill `templates/JUDGE-PROMPT.md` with the rubric text pasted in. The judge scores, ranks and names a synthesis, writing `run/review/judge.md`. A design that fails a gate cannot win. The judge never sees the rubric file path, and designers never see the rubric. Tag `phase/judge`.

## Phase 8: cross-family gate (you invoke it)

1. A writer drafts the design synthesis to `run/out/design.md` (Phase 9 rules apply).
2. Plant controls. Copy the draft to `run-private/design.clean.md`, then run `python3 <s>/plant.py plant <run>/run/out/design.md --out <run>/run/out/design.md --private <run>/run-private/planted.json --n 3 --ledger <run>/run/ledger/sources.json`. This writes 2–4 subtle errors in place: a shifted number, and a real quote from the same page that no longer supports its line.
3. Fill `run/review/GATE-PROMPT.md` and send it to the other family. Use the Codex plugin's task or rescue command if it is installed, otherwise the Grok Build plugin's delegate. **If neither is installed, stop and tell the user. Never substitute a same-family reviewer and call it the gate.** Save the reply to `run/review/gate-<n>.md`.
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
