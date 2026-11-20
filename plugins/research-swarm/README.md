# research-swarm

A lead-run procedure for multi-agent research and design in Claude Code, plus the scripts that keep it honest. The lead session runs fixed phases and parallel researchers fill a shared board. Every quote is string-matched against its fetched source, blind designers compete under a sealed rubric, and a reviewer from a different model family must PASS the result before one writer produces the document.

## Install

```
/plugin marketplace add jasonm4130/claude-skills
/plugin install research-swarm@jasonm4130-claude-skills
```

Requirements: `python3` 3.9 or newer and `git` on `PATH`. The cross-family gate needs either the Codex plugin (`openai/codex-plugin-cc`) or a Grok Build plugin installed and logged in. Without one, the skill stops at the gate rather than substituting a same-family reviewer.

## When to use it

Use it for open-ended research or design questions where the answer is a decision document. The work then splits into breadth (many sources), judgment (competing designs) and synthesis (one coherent write-up). Its premise is that a fixed structure beats free self-organisation for this kind of work. The phases, caps and stopping rules are set in advance, and agents choose only within a phase.

Do not use it for:

- Coding. Use a normal plan, implement and review loop.
- Short factual lookups. One agent with a search tool is cheaper and as good.
- Anything you would not spend a large slice of a weekly allowance on (see Cost).

The skill only runs when asked for explicitly.

## The method

`skills/research-swarm/SKILL.md` is the procedure. Its phases:

1. Scope: one clarifying question to the user.
2. Perspective questions.
3. Capped research: at most 5 researchers and 3 rounds, each time-boxed.
4. Key claims.
5. Outline.
6. 2–3 blind designs.
7. Sealed judge.
8. Cross-family gate with planted controls.
9. One writer.

Each mechanism and the evidence behind it:

| Mechanism | Why |
|---|---|
| Parallel researchers for breadth, one writer for synthesis | On the measured leaderboards, gains come from the harness rather than the agent count. Merging the context-builder and the writer into one agent cost 10 RACE points in the FS-Researcher ablation (ACL 2026). LangChain's Open Deep Research moved from parallel section writers to a single writer after getting "disjoint" reports. |
| Perspective-driven questions before research | STORM (NAACL 2024) improved organisation with this step, as rated by Wikipedia editors, and coverage on automatic metrics. Decomposing a question into core sub-questions raised coverage in Xie et al. (NAACL 2025). |
| Append-only typed board; first TAKE wins | One shared store with typed entries keeps live claims visible to everyone, and the first-TAKE rule settles collisions without a manager. |
| Sources, not summaries; "peer findings may be wrong" | In traced deep-research systems, most errors entered at the agents that synthesised across many documents, not at the ones that summarised one (EMNLP 2026). Passing raw single-document snippets upward lifted citation recall. Handing the aggregator the source cut inherited errors to zero in an adversarial test. |
| Ledger with string-matched excerpts | 3–13% of deep-research citation URLs are fabricated and 5–18% do not resolve. Giving the agent a URL-checking tool cut non-resolving URLs to under 1%. Several open-source deep-research skills check that URLs resolve, but none checks the quoted span. |
| Key claims without authors or confidence | Assigning only claims, not who said them or how many agreed, removes the "majority view" that lets one wrong agent's error spread. |
| Blind designers, sealed rubric, judge is not an author | A tournament with a hidden ranking rubric, as in the AI co-scientist and explorer/evaluator setups. The DheerG/swarms plugin's rule is that the author never signs off its own gate. |
| Cross-family gate | Same-family judges pass their own failures far more often. One same-model review plus one from another family caught more planted errors than two same-model reviews (56.7% against 42.7%). |
| Planted controls | Without a seeded negative control, a verifier's catch rate is unknown, and a high "claims hold" rate says nothing on its own. |
| Run dir as a local git repo, tag per phase | Checkpoint and rollback per phase, borrowed from umar-s/research-pipeline. With no remote, sealed material and private data cannot be pushed by accident. |

The evidence review behind the deep-research design choices is [RESEARCH_what_gives_best_deep_research.md](https://github.com/jasonm4130/claude-skills/blob/main/RESEARCH_what_gives_best_deep_research.md).

## Scripts

All live in `skills/research-swarm/scripts/` and use the Python standard library only. Run any script with `--help` for its full usage.

- **`run.py`** sets up the run directory and its phase tags.
  - `init <dir>` creates `run/`, which agents share, and `run-private/`, which only the lead reads and which has mode 0700. It seeds both from the templates and makes a git repo with no remote. It refuses inside another git work tree.
  - `phase <name>` commits everything and tags `phase/<name>`. It refuses if a remote exists, if the tag exists, or while the review log has an open finding.
- **`ledger.py`** keeps the source ledger, `run/ledger/sources.json`.
  - `add <url | path[:A-B] | file:///path#LA-LB> --excerpt "..."` fetches the source and stores its id, URL, fetch time, sha256, excerpt and status. The status is VERIFIED if the normalised excerpt occurs in the text, UNVERIFIED if not, and NOFETCH if the fetch failed. Normalisation covers whitespace, case, curly quotes and dashes, HTML entities, markdown escapes, inline tags, and `...` elisions. Web excerpts under 5 words are UNVERIFIED, and a line range is matched only within that range. Concurrent `add` calls are locked.
  - `check <board.md>` requires every FACT, MEASURE and CLAIM to cite a VERIFIED `[S#]`, and every `quote:` line to appear in the cited page. It reports counts.
  - `gate <doc.md>` is the writer gate. It fails on any citation to a non-VERIFIED or unknown id, and on any `[K#]` key-claim line that states a number without an `[S#]`.
- **`watch.py <board> <roster> [--idle N] [--undelivered M]`** lists agents with no entry in N minutes and TAKEs with no FACT, MEASURE or FAIL after M minutes. It exits 1 if it flags anything.
- **`gate.py`** handles the cross-family verdict.
  - `parse <reply> [--log review/log.md]` reads a strict `VERDICT: PASS|REJECT` block with numbered `file:line` findings. It exits 0 on PASS, 1 on REJECT and 3 if the reply cannot be parsed. With `--log`, it appends each finding as `Disposition: TODO`.
  - `check-log <log>` fails until every finding is ACCEPTED, REJECTED with a reason, or PLANT.
- **`plant.py`** plants and scores controls.
  - `plant` seeds subtle errors: a number moved by a plausible amount, or a quote swapped for the neighbouring sentence on the same cached page. It never touches ids, dates, versions or URLs, and keeps the line count. The answer key goes to `run-private/planted.json`.
  - `score <findings>` reports which plants a reviewer caught and which findings were plant hits.

Templates in `skills/research-swarm/templates/`: `BRIEF.md` for researchers, with the board and ledger protocol; `DESIGN-BRIEF.md`; `RUBRIC.md` as a skeleton of gates and scores; `JUDGE-PROMPT.md`; and `GATE-PROMPT.md` for the strict verdict format.

## Cost

A swarm is the most expensive thing you can ask Claude Code to do. The figures below come from one measured setup at notional list prices and are good to about ±50%:

- **Per agent.** Opus subagents ran at a median of about $12 per active hour, interquartile range $10–16.
- **A 3-hour run** of 5–8 Opus agents came to roughly $165–440. That was 7–25% of a weekly subscription allowance, and a central case of 6 agents was about 10%.
- **A 17-agent scripted workflow** cost about $96 over 100 minutes.

The skill's guards against overspend are the caps: 5 researchers, 3 rounds, 2–3 designers and 2 gate rounds. On top of them sits a stop rule: halt at any phase gate once usage has risen 20 points or passed 85%. Measure your own rate with a usage reading before and after the first run.

## Tests

```
python3 -m unittest discover -s plugins/research-swarm/skills/research-swarm/scripts/tests
```

The suite makes no network calls; fetches are mocked. `scripts/tests/python.test.mjs` runs the same suite from the repo's node test runner, so CI covers it.

## Known limits

- The `run-private/` seal is an instruction, not a permission boundary. Agents run as the same user.
- The ledger matches text, not meaning. A VERIFIED quote can still fail to support the claim built on it, which is what the spot-check and the gate are for.
- Pages that render with JavaScript, and PDFs, come back UNVERIFIED until a text extract is saved and added as a local file.
- Plant scoring matches a finding to a plant by the value it names, or else to the nearest plant within one line, and plants are kept at least three lines apart. A real finding that happens to sit next to a plant can still be counted as a catch.
- No benchmark yet compares this procedure with a single strong agent at equal spend.
