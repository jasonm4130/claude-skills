# Benchmark Scorecard — UNRELIABLE (exit 2)

Population: `0c08b057256b21e8cb6407b0fd820915281814c71d226c9869a127f3726f8c8f` — generated from `86c52105e4e7c79dbb813037c1218075ba9334d3ff151933b54f63d24e3be782`

## Adapters

| adapter | catch rate | over-rejection | mech accuracy | flip rate | error rate | coverage | median tokens | median wall (ms) |
|---|---|---|---|---|---|---|---|---|
| code-review | 0.885 | 0.474 | 1 | 0.231 | 0.019 | 1 | 1036 | 84877 |
| sdd-reviewer | 0.882 | 1.633 | 0.977 | 0.353 | 0.295 | 0.712 | 10427 | 293009.5 |
| codex | 0.875 | 0.808 | 0.955 | 0 | 0.038 | 0.962 | 78879 | 41213.5 |

## Strata

| adapter | arm | class | attempted | scored | coverage | status |
|---|---|---|---|---|---|---|
| code-review | clean | missing-await | 2 | 2 | 1 | ok |
| code-review | clean | unsafe-input | 2 | 2 | 1 | ok |
| code-review | clean | null-path | 3 | 3 | 1 | ok |
| code-review | clean | wrong-constant | 5 | 5 | 1 | ok |
| code-review | clean | resource-leak | 2 | 2 | 1 | ok |
| code-review | clean | logic-inversion | 3 | 3 | 1 | ok |
| code-review | clean | off-by-one | 4 | 4 | 1 | ok |
| code-review | clean | weakened-test | 1 | 1 | 1 | ok |
| code-review | clean | swallowed-error | 2 | 2 | 1 | ok |
| code-review | clean | api-misuse | 2 | 2 | 1 | ok |
| code-review | seeded | missing-await | 2 | 2 | 1 | ok |
| code-review | seeded | unsafe-input | 2 | 2 | 1 | ok |
| code-review | seeded | null-path | 3 | 3 | 1 | ok |
| code-review | seeded | wrong-constant | 5 | 5 | 1 | ok |
| code-review | seeded | resource-leak | 2 | 2 | 1 | ok |
| code-review | seeded | logic-inversion | 3 | 3 | 1 | ok |
| code-review | seeded | off-by-one | 4 | 4 | 1 | ok |
| code-review | seeded | weakened-test | 1 | 1 | 1 | ok |
| code-review | seeded | swallowed-error | 2 | 2 | 1 | ok |
| code-review | seeded | api-misuse | 2 | 2 | 1 | ok |
| sdd-reviewer | clean | missing-await | 2 | 2 | 1 | ok |
| sdd-reviewer | clean | unsafe-input | 2 | 2 | 1 | ok |
| sdd-reviewer | clean | null-path | 3 | 3 | 1 | ok |
| sdd-reviewer | clean | wrong-constant | 5 | 5 | 1 | ok |
| sdd-reviewer | clean | resource-leak | 2 | 2 | 1 | ok |
| sdd-reviewer | clean | logic-inversion | 3 | 0 | 0 | NOT-SCORED |
| sdd-reviewer | clean | off-by-one | 4 | 3 | 0.75 | NOT-SCORED |
| sdd-reviewer | clean | weakened-test | 1 | 1 | 1 | ok |
| sdd-reviewer | clean | swallowed-error | 2 | 0 | 0 | NOT-SCORED |
| sdd-reviewer | clean | api-misuse | 2 | 2 | 1 | ok |
| sdd-reviewer | seeded | missing-await | 2 | 2 | 1 | ok |
| sdd-reviewer | seeded | unsafe-input | 2 | 1 | 0.5 | NOT-SCORED |
| sdd-reviewer | seeded | null-path | 3 | 3 | 1 | ok |
| sdd-reviewer | seeded | wrong-constant | 5 | 2 | 0.4 | NOT-SCORED |
| sdd-reviewer | seeded | resource-leak | 2 | 2 | 1 | ok |
| sdd-reviewer | seeded | logic-inversion | 3 | 2 | 0.667 | NOT-SCORED |
| sdd-reviewer | seeded | off-by-one | 4 | 2 | 0.5 | NOT-SCORED |
| sdd-reviewer | seeded | weakened-test | 1 | 1 | 1 | ok |
| sdd-reviewer | seeded | swallowed-error | 2 | 1 | 0.5 | NOT-SCORED |
| sdd-reviewer | seeded | api-misuse | 2 | 1 | 0.5 | NOT-SCORED |
| codex | clean | missing-await | 2 | 2 | 1 | ok |
| codex | clean | unsafe-input | 2 | 2 | 1 | ok |
| codex | clean | null-path | 3 | 3 | 1 | ok |
| codex | clean | wrong-constant | 5 | 5 | 1 | ok |
| codex | clean | resource-leak | 2 | 2 | 1 | ok |
| codex | clean | logic-inversion | 3 | 3 | 1 | ok |
| codex | clean | off-by-one | 4 | 4 | 1 | ok |
| codex | clean | weakened-test | 1 | 1 | 1 | ok |
| codex | clean | swallowed-error | 2 | 2 | 1 | ok |
| codex | clean | api-misuse | 2 | 2 | 1 | ok |
| codex | seeded | missing-await | 2 | 2 | 1 | ok |
| codex | seeded | unsafe-input | 2 | 2 | 1 | ok |
| codex | seeded | null-path | 3 | 3 | 1 | ok |
| codex | seeded | wrong-constant | 5 | 4 | 0.8 | NOT-SCORED |
| codex | seeded | resource-leak | 2 | 2 | 1 | ok |
| codex | seeded | logic-inversion | 3 | 3 | 1 | ok |
| codex | seeded | off-by-one | 4 | 4 | 1 | ok |
| codex | seeded | weakened-test | 1 | 1 | 1 | ok |
| codex | seeded | swallowed-error | 2 | 1 | 0.5 | NOT-SCORED |
| codex | seeded | api-misuse | 2 | 2 | 1 | ok |

## Floors

No matching baseline — floors not evaluated.
