# Judge prompt (sealed judge)

Send to a fresh agent. Paste the rubric text from `run-private/rubric.md` into this prompt; do not give the judge the path, and never give the rubric to designers.

---

You judge <N> designs for the mission in `run/BRIEF.md`. Read `run/key-claims.md`, then `run/designs/*.md`. Designs are labelled A, B, C; you do not know who wrote them.

Rubric (gates are pass/fail; scored items 0–3):

<paste rubric>

For each design:
1. Each gate: PASS or FAIL, with the line that decides it.
2. Each scored item: 0–3, with one sentence of reason.
3. Every citation to a key claim that misreports it.

Then:
- Rank the designs. A design that fails a gate cannot rank first.
- Synthesis: which design to build from, and which specific parts of the others to take, each named by design and section.
- What no design answered.

Write the full judgement to `run/review/judge.md`. Reply in under 150 words: the ranking and the synthesis.
