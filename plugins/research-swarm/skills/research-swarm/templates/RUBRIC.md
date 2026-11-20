# Rubric (sealed: lives in run-private/, read only by the lead and the judge)

Write it before the designers start, and do not change it after you have read a design.

## Gates (pass/fail; a failed gate means revise before the design can win)
- G1 Every decision cites a key claim that exists in `run/key-claims.md` and reports it faithfully.
- G2 <a standing rule of the user's, e.g. nothing changes live configuration without approval>
- G3 <a hard constraint from the mission, e.g. no private data in public output>
- G4 Accounts for every measured failure in the key claims: <list them by id>.

## Scored (0–3 each)
- S1 Answers the mission as the user stated it, not an easier neighbouring question.
- S2 Evidence honesty: claims scoped to their evidence; unknowns named, each with its cheapest test.
- S3 Simplicity: net machinery removed against added; the smallest design that meets the gates.
- S4 Buildable: the first 1–3 steps are small, testable and useful on their own.
- S5 Prior-art failure modes avoided.
- S6 <one criterion specific to this mission>

## Answer key (optional)
<Facts a correct design must get right, for the judge to check. Never shown to designers.>
