# Benchmark Scorecard — INFORMATIONAL (exit 0)

Population: `91637aa1c0dbe27ff78bdfc925b3bdd70789c434ab97bb41e166cc8c3f4630be` — generated from `cc7625532ddf336269f448e7f95e6d4473a6f3f85c7aecf74a865be5fe33f0cc`

## Adapters

| adapter | catch rate | over-rejection | mech accuracy | flip rate | error rate | coverage | median tokens | median wall (ms) |
|---|---|---|---|---|---|---|---|---|
| code-review | 0.667 | 0 | 1 | 0 | 0 | 1 | 637 | 15394.5 |

## Strata

| adapter | arm | class | attempted | scored | coverage | status |
|---|---|---|---|---|---|---|
| code-review | clean | unsafe-input | 1 | 1 | 1 | ok |
| code-review | clean | wrong-constant | 1 | 1 | 1 | ok |
| code-review | clean | off-by-one | 1 | 1 | 1 | ok |
| code-review | seeded | unsafe-input | 1 | 1 | 1 | ok |
| code-review | seeded | wrong-constant | 1 | 1 | 1 | ok |
| code-review | seeded | off-by-one | 1 | 1 | 1 | ok |

## Floors

No matching baseline — floors not evaluated.
