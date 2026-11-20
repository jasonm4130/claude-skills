# Research brief: <one-line mission>

Run dir: this repo. You work in `run/`. Never open, list or search `run-private/`.

## Mission
<The user's question in their words, plus the one clarification they gave.>

## Decision map
Every question names the decision(s) its answer could change.
- D1 <decision>: <options>
- D2 <decision>: <options>

## Questions
Perspective questions from the scoping pass, one per line, `Q01`–`Qnn`, each tagged with its D#.
- Q01 (D1) <question>
- Q02 (D2) <question>

## Inputs
<Read what your question needs, not everything. Local paths, prior notes, allowed data.>

## Board protocol (`run/board.md`, append-only)
Never edit or delete a line. Append one entry per call: `cat >> run/board.md <<'X' ... X`.

```
### [TAKE] Q07 · inv-a · 14:05

### [FACT] Q07 · short title · inv-a · 14:12
source: [S3] https://example.org/page
quote: "verbatim text from that one source"
note: one line: what it changes for which decision

### [MEASURE] Q07 · short title · inv-a · 14:20
source: [S4] run/kb/inv-a-Q07-count.txt
quote: "the output line"
note: what it measures and why it matters

### [FAIL] Q07 · what was tried · inv-a · 14:25
note: tried X and Y; no evidence either way

### [CLAIM] Q07 · inference · inv-a · 14:30
source: [S3] [S4]
note: the inference, and the scope it holds in

### [OPEN] Q07 · new question · inv-a · 14:31
note: which decision it could change and why
```

- Types: TAKE claims a question; FACT is one verbatim quote from one source; MEASURE is a local measurement; FAIL is a dead end; CLAIM is your inference over cited sources; OPEN is a new question (at most 2 per round).
- The heading always ends `· <agent-id> · HH:MM`. TAKE, FACT, MEASURE and FAIL start with the question id.
- **First TAKE wins.** Read the TAKE lines before taking. If someone took it first, drop yours with a FAIL line and pick another.
- Deliver every TAKE: a FACT, MEASURE or FAIL for that Q before you return.

## Ledger (every FACT, MEASURE and CLAIM cites an id)
Register the source before you post:

```
python3 <scripts>/ledger.py --ledger run/ledger/sources.json add <url> --excerpt "<verbatim quote>"
python3 <scripts>/ledger.py --ledger run/ledger/sources.json add run/kb/<file>:<from>-<to> --excerpt "<line>"
```

It prints `S<n> VERIFIED` or `S<n> UNVERIFIED - <reason>`. Post only VERIFIED ids; an UNVERIFIED one means your quote is not on the page, so re-read the page. For a MEASURE, save the command and its output to `run/kb/<agent-id>-<Q#>-<slug>.txt` and add that file. A PDF needs a text extract saved to `run/kb/` first.

## Rules
- Pass sources upward, not summaries. Do not use uncited information.
- Peer findings may be wrong. Agreement counts for nothing. Before relying on a peer's FACT, open its source yourself.
- Investigate blind: do your own question before reading other agents' kb files. Read the board's TAKE lines only to avoid duplicates.
- Raw excerpts and longer notes go in `run/kb/<agent-id>-<Q#>.md`. Board entries stay short.
- Privacy: <name the real data here>. It never goes to the web, into a URL or search query, or into any public repo. Search with generic terms only.
- Change nothing outside `run/`. No git commands.
- Before you return, re-read board.md from the top. Add anything you can now confirm or refute, and at most 2 OPEN questions.
- Time box: return within <N> minutes. Final reply under 150 words: your TAKEs, their status, the ids you posted.
